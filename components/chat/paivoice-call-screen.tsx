"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, LoaderCircle, Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";

import type { Character } from "@/lib/character-types";
import type { ChatSession } from "@/lib/chat-storage";
import { getLatestCharacterStateValues, loadChatMessages, pushChatMessage } from "@/lib/chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { suspendBailoutsForCall } from "@/lib/push-bailout-client";
import { setCallAudioSessionActive } from "@/lib/tts-service";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { useCallScreenSounds } from "@/lib/chat-sound";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { VoiceCall } from "@/lib/paivoice/voice-call.js";
import { clearTimedWakeSchedule, postponeWakeCallRetry } from "@/lib/timed-wake-storage";

type PaiVoiceCallScreenProps = {
  session: ChatSession;
  character: Character;
  onEnd: () => void;
  initiator?: "user" | "character";
  wakeCall?: boolean;
  minimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
};

type CallPhase = "ready" | "incoming" | "connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "ended";

const PHASE_LABELS: Record<CallPhase, string> = {
  ready: "准备通话",
  incoming: "来电…",
  connecting: "正在连接",
  listening: "正在聆听",
  thinking: "正在思考",
  speaking: "正在说话",
  reconnecting: "连接中断，正在尝试恢复",
  ended: "通话已结束",
};

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function PaiVoiceCallScreen({
  session,
  character,
  onEnd,
  initiator = "user",
  wakeCall = false,
  minimized = false,
  onMinimize,
  onRestore,
}: PaiVoiceCallScreenProps) {
  const callRef = useRef<VoiceCall | null>(null);
  const generationControllersRef = useRef(new Map<string, AbortController>());
  const savedAssistantTurnIdsRef = useRef(new Set<string>());
  const cancelledGenerationTurnIdsRef = useRef(new Set<string>());
  const startedAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState<CallPhase>(initiator === "character" ? "incoming" : "ready");
  const pendingHangupAfterPlaybackRef = useRef(false);
  const hangupAfterPlaybackTimerRef = useRef<number | null>(null);
  const wakeCallTimerRef = useRef<number | null>(null);
  const wakeCallUserRespondedRef = useRef(false);
  const wakeGreetingStartedRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [error, setError] = useState("");
  const isIncoming = initiator === "character" && phase === "incoming";

  useCallScreenSounds({
    initiator,
    callState: isIncoming ? "CONNECTING" : started ? "IDLE" : "IDLE",
    session,
  });

  useEffect(() => {
    if (!isIncoming) return;
    return startIncomingCallVibration();
  }, [isIncoming]);

  const saveTranscript = useCallback((role: "user" | "assistant", rawText: unknown) => {
    const content = typeof rawText === "string" ? rawText.trim() : "";
    if (!content) return;
    pushChatMessage({
      sessionId: session.id,
      role,
      content,
      origin: "call",
    });
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
      detail: { sessionId: session.id },
    }));
  }, [session.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (hangupAfterPlaybackTimerRef.current !== null) {
        window.clearTimeout(hangupAfterPlaybackTimerRef.current);
        hangupAfterPlaybackTimerRef.current = null;
      }
      if (wakeCallTimerRef.current !== null) {
        window.clearTimeout(wakeCallTimerRef.current);
        wakeCallTimerRef.current = null;
      }
      for (const [turnId, controller] of generationControllersRef.current) {
        cancelledGenerationTurnIdsRef.current.add(turnId);
        controller.abort();
      }
      generationControllersRef.current.clear();
      callRef.current?.hangup();
      callRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (initiator !== "character") return;
    const latest = loadChatMessages(session.id).at(-1);
    if (latest?.content.includes("发起了语音通话")) return;
    saveTranscript("assistant", "[我向你发起了语音通话]");
  }, [initiator, saveTranscript, session.id]);

  useEffect(() => {
    cancelFollowUp(session.id);
    void suspendBailoutsForCall(session.id);
  }, [session.id]);

  useEffect(() => {
    suspendKeepAliveForCall();
    setCallAudioSessionActive(true);
    return () => {
      resumeKeepAliveAfterCall();
      setCallAudioSessionActive(false);
    };
  }, []);

  useEffect(() => {
    if (!started || !startedAtRef.current) return;
    const timer = window.setInterval(() => {
      const start = startedAtRef.current;
      if (start !== null) setDuration(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [started]);

  const startCall = useCallback(async () => {
    if (callRef.current || started) return;

    const url = process.env.NEXT_PUBLIC_PAIVOICE_WS_URL?.trim();
    if (!url) {
      setError("尚未配置 NEXT_PUBLIC_PAIVOICE_WS_URL。");
      return;
    }
    try {
      const parsedUrl = new URL(url);
      if (!["wss:", "ws:"].includes(parsedUrl.protocol) || (process.env.NODE_ENV === "production" && parsedUrl.protocol !== "wss:")) {
        setError("正式环境必须使用 wss:// 通话地址。");
        return;
      }
    } catch {
      setError("PaiVoice WebSocket 地址格式无效。");
      return;
    }

    setError("");
    setPhase("connecting");

    const call = new VoiceCall({
      url,
      video: false,
      pushToTalk: false,
      getAuthTicket: async () => {
        const response = await fetch("/api/paivoice/ticket", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({})) as {
          ticket?: unknown;
          error?: unknown;
        };
        if (!response.ok || typeof data.ticket !== "string") {
          throw new Error(typeof data.error === "string" ? data.error : "获取通话授权失败。");
        }
        return data.ticket;
      },
      on: {
        state: (mode) => {
          if (!mountedRef.current) return;
          if (mode === "listening" || mode === "thinking" || mode === "speaking" || mode === "reconnecting") {
            setPhase(mode);
          }
        },
        proactiveTurn: (message) => {
          const turnId = typeof message?.turn_id === "string" ? message.turn_id : "";
          if (!turnId || initiator !== "character") return;
          const controller = new AbortController();
          generationControllersRef.current.set(turnId, controller);
          const timeoutId = window.setTimeout(() => controller.abort(), 100_000);
          void (async () => {
            try {
              const result = await generateChatCompletion(
                session,
                loadChatMessages(session.id),
                {
                  appTags: ["chat", "voice", ...(wakeCall ? ["wake_call"] : ["character_initiated_call"])],
                  signal: controller.signal,
                  ephemeralSystemNote: wakeCall
                    ? "你刚刚拨通了用户预约的起床电话。接通后由你先开口，简短自然地问候并叫醒对方，可以结合你们平时的相处方式。不要等用户先说话，不要说自己是 AI 或解释系统任务。说完后停下来等用户回应；除非用户明确要求结束，否则不要在叫醒开场白里主动挂断。"
                    : "这是你主动发起的一对一语音电话。接通后由你先开口，结合你们最近的聊天自然地打招呼、说明来意或开启话题，然后停下来等用户回应。不要等待用户先说话。如果你确实想自然结束通话，先正常告别，再在回复末尾输出 [结束通话]。";
                },
              );
              if (controller.signal.aborted || callRef.current !== call) return;
              const rawText = flattenCompletionResult(result).trim();
              if (!rawText) throw new Error("角色没有生成可用的开场白。");
              const shouldHangupAfterReply = /\[(?:结束通话|挂断电话)\]/.test(rawText);
              const cleanRawText = rawText.replace(/\[(?:结束通话|挂断电话)\]/g, "").trim();
              if (shouldHangupAfterReply) pendingHangupAfterPlaybackRef.current = true;
              const parsed = parseAIResponse(cleanRawText, getLatestCharacterStateValues(session.contactId));
              const chatParts = parsed.parts.filter(part =>
                !part.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(part.mediaType)
              );
              const speechText = chatParts
                .filter(part => !part.mediaType && part.content.trim())
                .map(part => part.content)
                .join("\n")
                .trim();
              if (chatParts.length === 0 && (parsed.statusPanel || parsed.innerMonologue)) {
                pushChatMessage({
                  sessionId: session.id,
                  role: "assistant",
                  content: "",
                  statusPanel: parsed.statusPanel,
                  innerMonologue: parsed.innerMonologue,
                  stateValues: parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
                  freshStateValues: parsed.freshStateValues,
                  origin: "call",
                });
              } else {
                chatParts.forEach((part, index) => {
                  pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: index === 0 ? parsed.statusPanel : undefined,
                    innerMonologue: index === 0 ? parsed.innerMonologue : undefined,
                    stateValues: index === 0 && parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
                    freshStateValues: index === 0 ? parsed.freshStateValues : undefined,
                    origin: "call",
                  });
                });
              }
              window.dispatchEvent(new CustomEvent("chat-messages-updated", {
                detail: { sessionId: session.id },
              }));
              savedAssistantTurnIdsRef.current.add(turnId);
              call.sendReply(speechText || (wakeCall ? "早上好，该起床啦。" : "我想先和你说句话。"), turnId);
            } catch (cause) {
              if (controller.signal.aborted) return;
              const fallback = wakeCall ? "早上好，该起床啦。" : "我想先和你说句话。";
              saveTranscript("assistant", fallback);
              savedAssistantTurnIdsRef.current.add(turnId);
              call.sendReply(fallback, turnId);
              if (mountedRef.current) setError(cause instanceof Error ? cause.message : "角色开场白生成失败。");
            } finally {
              window.clearTimeout(timeoutId);
              generationControllersRef.current.delete(turnId);
              cancelledGenerationTurnIdsRef.current.delete(turnId);
            }
          })();
        },
        transcript: (message) => {
          const turnId = typeof message?.turn_id === "string" ? message.turn_id : "";
          const userText = typeof message?.text === "string" ? message.text.trim() : "";
          if (initiator === "character" && userText) wakeCallUserRespondedRef.current = true;
          if (wakeCall && userText) {
            if (wakeCallTimerRef.current !== null) {
              window.clearTimeout(wakeCallTimerRef.current);
              wakeCallTimerRef.current = null;
            }
            clearTimedWakeSchedule(session.id);
          }
          saveTranscript("user", userText);
          if (!turnId || !userText) return;

          const controller = new AbortController();
          let timedOut = false;
          cancelledGenerationTurnIdsRef.current.delete(turnId);
          generationControllersRef.current.set(turnId, controller);
          const timeoutId = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, 100_000);
          const sendTimeoutFallback = () => {
            if (callRef.current !== call || cancelledGenerationTurnIdsRef.current.has(turnId)) return;
            const fallback = "这轮回复生成时间过长，我们稍后再继续。";
            saveTranscript("assistant", fallback);
            savedAssistantTurnIdsRef.current.add(turnId);
            call.sendReply(fallback, turnId);
            if (mountedRef.current) setError("角色回复生成超时，本轮已结束。");
          };
          void (async () => {
            try {
              const result = await generateChatCompletion(
                session,
                loadChatMessages(session.id),
                {
                  appTags: ["chat", "voice"],
                  signal: controller.signal,
                  ephemeralSystemNote: "你现在正在实时语音通话。你可以像真人一样决定何时自然结束通话；只有当你确实想结束本次通话时，先用正常语言向对方告别，再在回复末尾单独输出控制标记 [结束通话]。不要向用户解释这个标记；不想挂断时绝对不要输出它。用户打断你时，取消本次挂断意图。",
                },
              );
              if (controller.signal.aborted || callRef.current !== call) {
                if (timedOut) sendTimeoutFallback();
                return;
              }

              const rawText = flattenCompletionResult(result).trim();
              if (!rawText) throw new Error("角色没有生成可用回复。");
              const shouldHangupAfterReply = /\[(?:结束通话|挂断电话)\]/.test(rawText);
              const cleanRawText = rawText.replace(/\[(?:结束通话|挂断电话)\]/g, "").trim();
              if (shouldHangupAfterReply) pendingHangupAfterPlaybackRef.current = true;

              const parsed = parseAIResponse(cleanRawText, getLatestCharacterStateValues(session.contactId));
              const chatParts = parsed.parts.filter(part =>
                !part.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(part.mediaType)
              );
              const speechText = chatParts
                .filter(part => !part.mediaType && part.content.trim())
                .map(part => part.content)
                .join("\n")
                .trim();

              if (chatParts.length === 0 && (parsed.statusPanel || parsed.innerMonologue)) {
                pushChatMessage({
                  sessionId: session.id,
                  role: "assistant",
                  content: "",
                  statusPanel: parsed.statusPanel,
                  innerMonologue: parsed.innerMonologue,
                  stateValues: parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
                  freshStateValues: parsed.freshStateValues,
                  origin: "call",
                });
              } else {
                chatParts.forEach((part, index) => {
                  pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: index === 0 ? parsed.statusPanel : undefined,
                    innerMonologue: index === 0 ? parsed.innerMonologue : undefined,
                    stateValues: index === 0 && parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
                    freshStateValues: index === 0 ? parsed.freshStateValues : undefined,
                    origin: "call",
                  });
                });
              }

              window.dispatchEvent(new CustomEvent("chat-messages-updated", {
                detail: { sessionId: session.id },
              }));
              savedAssistantTurnIdsRef.current.add(turnId);
              call.sendReply(speechText || "我这轮没有可朗读的内容。", turnId);
            } catch (cause) {
              if (controller.signal.aborted) {
                if (timedOut) sendTimeoutFallback();
                return;
              }
              const fallback = "我这边暂时没能生成回复，请稍后再试。";
              saveTranscript("assistant", fallback);
              savedAssistantTurnIdsRef.current.add(turnId);
              call.sendReply(fallback, turnId);
              if (mountedRef.current) {
                setError(cause instanceof Error ? cause.message : "角色回复生成失败。");
              }
            } finally {
              window.clearTimeout(timeoutId);
              generationControllersRef.current.delete(turnId);
              cancelledGenerationTurnIdsRef.current.delete(turnId);
            }
          })();
        },
        reply: (message) => {
          const turnId = typeof message?.turn_id === "string" ? message.turn_id : "";
          if (turnId && savedAssistantTurnIdsRef.current.has(turnId)) {
            savedAssistantTurnIdsRef.current.delete(turnId);
            return;
          }
          saveTranscript("assistant", message?.text);
        },
        speech: (speaking) => {
          if (!mountedRef.current) return;
          if (speaking) {
            pendingHangupAfterPlaybackRef.current = false;
            for (const [turnId, controller] of generationControllersRef.current) {
              cancelledGenerationTurnIdsRef.current.add(turnId);
              controller.abort();
            }
            if (hangupAfterPlaybackTimerRef.current !== null) {
              window.clearTimeout(hangupAfterPlaybackTimerRef.current);
              hangupAfterPlaybackTimerRef.current = null;
            }
            if (call.mode === "thinking") {
              for (const [turnId, controller] of generationControllersRef.current) {
                cancelledGenerationTurnIdsRef.current.add(turnId);
                controller.abort();
              }
            }
            setPhase("listening");
          }
        },
        playing: (playing) => {
          if (!mountedRef.current) return;
          if (playing) {
            if (wakeCall) {
              wakeGreetingStartedRef.current = true;
              if (wakeCallTimerRef.current !== null) {
                window.clearTimeout(wakeCallTimerRef.current);
                wakeCallTimerRef.current = null;
              }
            }
            setPhase("speaking");
            return;
          }
          if (wakeCall && wakeGreetingStartedRef.current && !wakeCallUserRespondedRef.current && wakeCallTimerRef.current === null) {
            wakeCallTimerRef.current = window.setTimeout(() => {
              wakeCallTimerRef.current = null;
              if (!mountedRef.current || callRef.current !== call || wakeCallUserRespondedRef.current) return;
              postponeWakeCallRetry(session.id);
              saveTranscript("assistant", "[我挂断了语音通话]");
              call.hangup();
              callRef.current = null;
              startedAtRef.current = null;
              setStarted(false);
              setPhase("ended");
              onEnd();
            }, 30_000);
          }
          if (pendingHangupAfterPlaybackRef.current && callRef.current === call) {
            pendingHangupAfterPlaybackRef.current = false;
            hangupAfterPlaybackTimerRef.current = window.setTimeout(() => {
              hangupAfterPlaybackTimerRef.current = null;
              if (!mountedRef.current || callRef.current !== call) return;
              if (wakeCall && !wakeCallUserRespondedRef.current) postponeWakeCallRetry(session.id);
              pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: "[我挂断了语音通话]",
                origin: "call",
              });
              window.dispatchEvent(new CustomEvent("chat-messages-updated", {
                detail: { sessionId: session.id },
              }));
              call.hangup();
              callRef.current = null;
              startedAtRef.current = null;
              onEnd();
            }, 450);
          }
        },
        reconnecting: () => {
          if (mountedRef.current) setPhase("reconnecting");
        },
        resumed: () => {
          if (!mountedRef.current) return;
          setError("");
          setPhase("listening");
        },
        closed: () => {
          if (!mountedRef.current) return;
          for (const [turnId, controller] of generationControllersRef.current) {
            cancelledGenerationTurnIdsRef.current.add(turnId);
            controller.abort();
          }
          generationControllersRef.current.clear();
          savedAssistantTurnIdsRef.current.clear();
          callRef.current = null;
          startedAtRef.current = null;
          setDuration(0);
          setPhase("ended");
          setStarted(false);
          setError("通话连接已关闭。");
        },
        error: (message) => {
          if (mountedRef.current) setError(String(message || "通话服务发生错误。"));
        },
        nothingHeard: () => {
          if (mountedRef.current) setPhase("listening");
        },
        replyTimeout: (message) => {
          const turnId = typeof message?.turn_id === "string" ? message.turn_id : "";
          const controller = turnId ? generationControllersRef.current.get(turnId) : undefined;
          if (controller) {
            cancelledGenerationTurnIdsRef.current.add(turnId);
            controller.abort();
          }
          if (mountedRef.current) setError("本轮回复超时，已停止等待。");
        },
      },
    });

    callRef.current = call;
    if (initiator === "character") wakeCallUserRespondedRef.current = false;
    try {
      // start() is called directly from this button's click handler so the
      // browser can grant microphone access and unlock audio in the gesture.
      await call.start();
      if (!mountedRef.current || callRef.current !== call) {
        call.hangup();
        return;
      }
      startedAtRef.current = Date.now();
      setStarted(true);
      setPhase("listening");
      if (wakeCall && initiator === "character") {
        wakeCallTimerRef.current = window.setTimeout(() => {
          wakeCallTimerRef.current = null;
          if (!wakeCallUserRespondedRef.current && mountedRef.current && callRef.current === call) {
            postponeWakeCallRetry(session.id);
            saveTranscript("assistant", "[我挂断了语音通话]");
            call.hangup();
            callRef.current = null;
            startedAtRef.current = null;
            setStarted(false);
            setPhase("ended");
            onEnd();
          }
        }, 90_000);
      }
      if (initiator === "character" && !wakeCallUserRespondedRef.current) call.startProactiveTurn();
    } catch (cause) {
      call.hangup();
      if (callRef.current === call) callRef.current = null;
      if (!mountedRef.current) return;
      setPhase(initiator === "character" ? "incoming" : "ready");
      setError(cause instanceof Error ? cause.message : "通话启动失败。");
    }
  }, [initiator, onEnd, saveTranscript, session, started, wakeCall]);

  const toggleMic = useCallback(async () => {
    const call = callRef.current;
    if (!call) return;
    const next = !micMuted;
    try {
      await call.setMuted(next);
      setMicMuted(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "麦克风状态切换失败。");
    }
  }, [micMuted]);

  const toggleSpeaker = useCallback(() => {
    const next = !speakerMuted;
    callRef.current?.setSpeakerMuted(next);
    setSpeakerMuted(next);
  }, [speakerMuted]);

  const endCall = useCallback(() => {
    for (const [turnId, controller] of generationControllersRef.current) {
      cancelledGenerationTurnIdsRef.current.add(turnId);
      controller.abort();
    }
    generationControllersRef.current.clear();
    savedAssistantTurnIdsRef.current.clear();
    if (wakeCall) clearTimedWakeSchedule(session.id);
    if (wakeCallTimerRef.current !== null) {
      window.clearTimeout(wakeCallTimerRef.current);
      wakeCallTimerRef.current = null;
    }
    callRef.current?.hangup();
    callRef.current = null;
    startedAtRef.current = null;
    onEnd();
  }, [onEnd, session.id, wakeCall]);

  if (minimized) {
    return (
      <div className="fixed bottom-5 right-4 z-[120] flex items-center gap-3 rounded-full border border-white/15 bg-slate-950/95 px-3 py-2 text-white shadow-2xl">
        <button type="button" onClick={onRestore} className="flex min-w-0 items-center gap-3 text-left">
          {character.avatar ? (
            <img src={character.avatar} alt="" className="h-10 w-10 rounded-full object-cover" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg">{character.name.slice(0, 1)}</span>
          )}
          <span className="min-w-0">
            <span className="block max-w-28 truncate text-sm font-medium">{character.name}</span>
            <span className="block text-xs text-white/65">{started ? formatDuration(duration) : PHASE_LABELS[phase]}</span>
          </span>
        </button>
        <button type="button" aria-label="挂断" onClick={endCall} className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600">
          <PhoneOff size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[110] flex flex-col items-center justify-between overflow-hidden bg-[radial-gradient(ellipse_at_top,_#334155_0%,_#111827_42%,_#030712_100%)] px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-white">
      <div className="flex w-full items-center justify-between">
        <span className="text-xs tracking-[0.18em] text-white/50">PAIVOICE</span>
        {onMinimize && (
          <button type="button" aria-label="缩小通话窗口" onClick={onMinimize} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
            <ArrowDown size={19} />
          </button>
        )}
      </div>

      <div className="flex w-full flex-1 flex-col items-center justify-center">
        {character.avatar ? (
          <img src={character.avatar} alt={character.name} className="mb-7 h-32 w-32 rounded-full border border-white/20 object-cover shadow-2xl" />
        ) : (
          <div className="mb-7 flex h-32 w-32 items-center justify-center rounded-full border border-white/20 bg-white/10 text-5xl shadow-2xl">
            {character.name.slice(0, 1)}
          </div>
        )}
        <h1 className="text-2xl font-semibold">{character.name}</h1>
        <p className="mt-3 text-sm text-white/65">{started ? formatDuration(duration) : "语音通话"}</p>
        <p className="mt-2 min-h-6 text-sm text-white/75">{PHASE_LABELS[phase]}</p>
        <p className="mt-4 max-w-xs text-center text-xs leading-5 text-white/45">
          通话期间自动检测你的语音；停顿后自动结束本轮。看剧建议戴耳机，外部电视声音不一定能被回声消除过滤；也可随时静音。
        </p>
        {error && <p role="alert" className="mt-4 max-w-sm text-center text-sm text-rose-300">{error}</p>}
      </div>

      <div className="flex w-full max-w-sm flex-col items-center gap-7">
        {started ? (
          <div className="flex h-24 w-24 flex-col items-center justify-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-500/15 text-emerald-100">
            <Mic size={30} />
            <span className="text-xs">自动聆听</span>
          </div>
        ) : phase === "incoming" ? (
          <div className="flex items-center justify-center gap-10">
            <button
              type="button"
              onClick={() => {
                if (wakeCall) clearTimedWakeSchedule(session.id);
                saveTranscript("user", "[我拒绝了语音通话]");
                onEnd();
              }}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 shadow-lg"
              aria-label="拒接"
            >
              <PhoneOff size={24} />
            </button>
            <button
              type="button"
              onClick={startCall}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 shadow-lg"
              aria-label="接听"
            >
              <Mic size={24} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={startCall}
            disabled={phase === "connecting"}
            className="flex min-h-14 min-w-48 items-center justify-center gap-2 rounded-full bg-emerald-600 px-8 text-base font-semibold shadow-lg disabled:opacity-60"
          >
            {phase === "connecting" && <LoaderCircle size={18} className="animate-spin" />}
            {phase === "connecting" ? "正在连接…" : "开始通话"}
          </button>
        )}
        {started && <span className="text-xs text-white/55">{micMuted ? "麦克风已静音" : "自动收音已开启"}</span>}
        {phase === "incoming" && <span className="text-xs text-white/60">语音来电</span>}
        <div className="flex items-center justify-center gap-8">
          <button
            type="button"
            disabled={!started}
            onClick={toggleMic}
            aria-label={micMuted ? "取消麦克风静音" : "麦克风静音"}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-white/12 disabled:opacity-35"
          >
            {micMuted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          <button
            type="button"
            disabled={!started}
            onClick={toggleSpeaker}
            aria-label={speakerMuted ? "打开通话声音" : "关闭通话声音"}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-white/12 disabled:opacity-35"
          >
            {speakerMuted ? <VolumeX size={22} /> : <Volume2 size={22} />}
          </button>
          <button
            type="button"
            onClick={endCall}
            aria-label="挂断"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 shadow-lg"
          >
            <PhoneOff size={22} />
          </button>
        </div>
        <a
          href="https://github.com/NebulaCode8572/pai-voice/tree/feature/vps-deployment-hardening"
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-white/35 underline underline-offset-2"
        >
          PaiVoice 开源组件 · 查看对应源码
        </a>
      </div>
    </div>
  );
}
