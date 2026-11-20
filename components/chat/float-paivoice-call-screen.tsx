"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, MicOff, Phone, Volume2, VolumeX, PictureInPicture2, Plus } from "lucide-react";

import type { Character } from "@/lib/character-types";
import type { ChatSession } from "@/lib/chat-storage";
import { getLatestCharacterStateValues, loadChatMessages, pushChatMessage } from "@/lib/chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { cancelFollowUp, suspendProactiveActions } from "@/lib/follow-up-service";
import { suspendBailoutsForCall } from "@/lib/push-bailout-client";
import { resolveVoiceConfig, setCallAudioSessionActive } from "@/lib/tts-service";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { useCallScreenSounds } from "@/lib/chat-sound";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { VoiceCall } from "@/lib/paivoice/voice-call.js";
import { clearTimedWakeSchedule, postponeWakeCallRetry } from "@/lib/timed-wake-storage";
import { applyProactiveIntentFromUserText, isProactiveInteractionAllowed, loadProactiveInteractionState, setProactivePermission } from "@/lib/proactive-interaction-state";

type FloatVoiceCallScreenProps = {
  session: ChatSession;
  character: Character;
  onEnd: () => void;
  initiator?: "user" | "character";
  wakeCall?: boolean;
  initiallyAccepted?: boolean;
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

export function FloatVoiceCallScreen({
  session,
  character,
  onEnd,
  initiator = "user",
  wakeCall = false,
  initiallyAccepted = false,
  minimized = false,
  onMinimize,
  onRestore,
}: FloatVoiceCallScreenProps) {
  const callRef = useRef<VoiceCall | null>(null);
  const generationControllersRef = useRef(new Map<string, AbortController>());
  const savedAssistantTurnIdsRef = useRef(new Set<string>());
  const cancelledGenerationTurnIdsRef = useRef(new Set<string>());
  const proactiveGenerationTurnIdsRef = useRef(new Set<string>());
  const proactiveTurnRequestedRef = useRef(false);
  const initialCharacterGreetingPendingRef = useRef(initiator === "character");
  const lastCallActivityAtRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState<CallPhase>(initiallyAccepted ? "connecting" : initiator === "character" ? "incoming" : "ready");
  const pendingHangupAfterPlaybackRef = useRef(false);
  const hangupAfterPlaybackTimerRef = useRef<number | null>(null);
  const wakeCallTimerRef = useRef<number | null>(null);
  const wakeCallUserRespondedRef = useRef(false);
  const wakeGreetingStartedRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const recitationModeRef = useRef(false);
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

    let finishCharacterHangup = () => {};
    let armCharacterHangupFallback = () => {};
    const selectedVoiceConfig = resolveVoiceConfig(character.id, "chat");
    // Pass only public synthesis settings. MiniMax credentials remain in PaiVoice's server environment.
    const ttsConfig = selectedVoiceConfig?.provider === "Minimax" && selectedVoiceConfig.enableTTS
      ? {
          model: selectedVoiceConfig.model || "speech-01-turbo",
          voice_id: selectedVoiceConfig.defaultVoice || "male-qn-qingse",
          speed: selectedVoiceConfig.speechSpeed ?? 1,
          pitch: selectedVoiceConfig.speechPitch ?? 0,
          language_boost: selectedVoiceConfig.languageBoost || "",
        }
      : null;
    const call = new VoiceCall({
      url,
      video: false,
      pushToTalk: false,
      ttsConfig,
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
          if (!turnId || !isProactiveInteractionAllowed(session.id, { allowScheduledWake: wakeCall })) return;
          proactiveTurnRequestedRef.current = true;
          const isInitialCharacterGreeting = initiator === "character" && initialCharacterGreetingPendingRef.current;
          initialCharacterGreetingPendingRef.current = false;
          const controller = new AbortController();
          proactiveGenerationTurnIdsRef.current.add(turnId);
          generationControllersRef.current.set(turnId, controller);
          const timeoutId = window.setTimeout(() => controller.abort(), 100_000);
          void (async () => {
            try {
              const result = await generateChatCompletion(
                session,
                loadChatMessages(session.id),
                {
                  appTags: ["chat", "voice", ...(wakeCall ? ["wake_call"] : initiator === "character" ? ["character_initiated_call"] : ["voice_auto_chat"])],
                  signal: controller.signal,
                  ephemeralSystemNote: [
                    wakeCall
                      ? "你刚刚拨通了用户预约的起床电话。接通后由你先开口，简短自然地问候并叫醒对方，可以结合你们平时的相处方式。不要等用户先说话，不要说自己是 AI 或解释系统任务。说完后停下来等用户回应；除非用户明确要求结束，否则不要在叫醒开场白里主动挂断。"
                      : isInitialCharacterGreeting
                        ? "这是你主动发起的一对一语音电话。接通后由你先开口，结合你们最近的聊天自然地打招呼、说明来意或开启话题，然后停下来等用户回应。不要等待用户先说话。如果你确实想自然结束通话，先正常告别，再在回复末尾输出 [结束通话]。"
                        : "这是实时语音通话中的自然空闲时段。你可以结合当前对话和最近的共同话题，偶尔自然地开启一段简短交流；不要重复刚说过的话，也不要为了填补沉默而频繁说话。",
                    loadProactiveInteractionState(session.id).mode === "study"
                      ? "用户目前处于学习或忙碌状态。只在确实合适时进行低频、简短、温和的陪伴；可以结合情境提醒喝水、调整坐姿或休息眼睛，但不要像清单一样机械提醒，不要在短时间重复同类提醒，不要打断专注，也不要要求用户回应。"
                      : "",
                  ].filter(Boolean).join("\n"),
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
              const finalSpeech = speechText || (shouldHangupAfterReply ? "那我先挂了。" : wakeCall ? "早上好，该起床啦。" : "我想先和你说句话。");
              if (!speechText) saveTranscript("assistant", finalSpeech);
              savedAssistantTurnIdsRef.current.add(turnId);
              const sent = call.sendReply(finalSpeech, turnId);
              if (shouldHangupAfterReply && sent) armCharacterHangupFallback();
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
              proactiveGenerationTurnIdsRef.current.delete(turnId);
              cancelledGenerationTurnIdsRef.current.delete(turnId);
            }
          })();
        },
        transcript: (message) => {
          const turnId = typeof message?.turn_id === "string" ? message.turn_id : "";
          const userText = typeof message?.text === "string" ? message.text.trim() : "";
          if (userText) lastCallActivityAtRef.current = Date.now();
          if (initiator === "character" && userText) wakeCallUserRespondedRef.current = true;
          if (wakeCall && userText) {
            if (wakeCallTimerRef.current !== null) {
              window.clearTimeout(wakeCallTimerRef.current);
              wakeCallTimerRef.current = null;
            }
            clearTimedWakeSchedule(session.id);
          }
          if (userText) {
            applyProactiveIntentFromUserText(session.id, userText);
            if (!isProactiveInteractionAllowed(session.id, { allowScheduledWake: wakeCall })) {
              for (const proactiveTurnId of proactiveGenerationTurnIdsRef.current) {
                cancelledGenerationTurnIdsRef.current.add(proactiveTurnId);
                generationControllersRef.current.get(proactiveTurnId)?.abort();
              }
              proactiveGenerationTurnIdsRef.current.clear();
              proactiveTurnRequestedRef.current = false;
            }
          }
          saveTranscript("user", userText);
          if (!turnId || !userText) return;

          const startsRecitation = /(?:开始复述|开始背书|开始学习复述|我开始复述了)/.test(userText);
          const endsRecitation = /(?:我复述完了|我背完了|复述结束|结束复述|我讲完了)/.test(userText);
          let recitationCompletion = false;

          if (startsRecitation) {
            recitationModeRef.current = true;
            call.setRecitationMode(true);
            savedAssistantTurnIdsRef.current.add(turnId);
            call.sendReply("嗯，开始吧。", turnId);
            return;
          }

          if (recitationModeRef.current && endsRecitation) {
            recitationModeRef.current = false;
            call.setRecitationMode(false);
            recitationCompletion = true;
          } else if (recitationModeRef.current) {
            // A long retrieval pause ends the audio turn, but not the recitation session.
            // Use a fixed, minimal backchannel instead of invoking the tutor-like chat path.
            savedAssistantTurnIdsRef.current.add(turnId);
            call.sendReply("嗯，继续。", turnId);
            return;
          }

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
                  ephemeralSystemNote: [
                    "你现在正在实时语音通话。你可以像真人一样决定何时自然结束通话；当用户明确让你挂断，或你确实想结束本次通话时，先用正常语言向对方告别，再在回复末尾单独输出控制标记 [结束通话]。不要向用户解释这个标记；不想挂断时绝对不要输出它。用户打断你时，取消本次挂断意图。",
                    recitationCompletion
                      ? "用户刚结束了一段学习复述。你是熟悉用户的聊天对象，不是老师或阅卷者。不要判断学科知识、术语、公式或事实是否正确；语音转写可能把专业词和公式识别错。只根据用户实际表达，简短自然地回应表达是否连贯、有没有明显遗漏或前后矛盾；不要补充标准答案、讲课或主动纠错。保持角色原本的性格，不要像评估报告一样总结。"
                      : "",
                  ].filter(Boolean).join("\n"),
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
              const finalSpeech = speechText || (shouldHangupAfterReply ? "那我先挂了。" : "我这轮没有可朗读的内容。");
              if (!speechText) saveTranscript("assistant", finalSpeech);
              savedAssistantTurnIdsRef.current.add(turnId);
              const sent = call.sendReply(finalSpeech, turnId);
              if (shouldHangupAfterReply && sent) armCharacterHangupFallback();
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
          proactiveTurnRequestedRef.current = false;
          lastCallActivityAtRef.current = Date.now();
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
            lastCallActivityAtRef.current = Date.now();
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
            proactiveTurnRequestedRef.current = true;
            if (pendingHangupAfterPlaybackRef.current && hangupAfterPlaybackTimerRef.current !== null) {
              window.clearTimeout(hangupAfterPlaybackTimerRef.current);
              hangupAfterPlaybackTimerRef.current = null;
            }
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
          lastCallActivityAtRef.current = Date.now();
          proactiveTurnRequestedRef.current = false;
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
            if (hangupAfterPlaybackTimerRef.current !== null) {
              window.clearTimeout(hangupAfterPlaybackTimerRef.current);
            }
            hangupAfterPlaybackTimerRef.current = window.setTimeout(() => {
              hangupAfterPlaybackTimerRef.current = null;
              finishCharacterHangup();
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

    finishCharacterHangup = () => {
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
      if (wakeCallTimerRef.current !== null) {
        window.clearTimeout(wakeCallTimerRef.current);
        wakeCallTimerRef.current = null;
      }
      call.hangup();
      callRef.current = null;
      startedAtRef.current = null;
      setStarted(false);
      setPhase("ended");
      onEnd();
    };
    armCharacterHangupFallback = () => {
      if (!pendingHangupAfterPlaybackRef.current) return;
      if (hangupAfterPlaybackTimerRef.current !== null) {
        window.clearTimeout(hangupAfterPlaybackTimerRef.current);
      }
      hangupAfterPlaybackTimerRef.current = window.setTimeout(() => {
        hangupAfterPlaybackTimerRef.current = null;
        if (!pendingHangupAfterPlaybackRef.current) return;
        pendingHangupAfterPlaybackRef.current = false;
        finishCharacterHangup();
      }, 45_000);
    };

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
      lastCallActivityAtRef.current = startedAtRef.current;
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
        }, 110_000);
      }
      if (initiator === "character" && !wakeCallUserRespondedRef.current && isProactiveInteractionAllowed(session.id, { allowScheduledWake: wakeCall })) {
        proactiveTurnRequestedRef.current = true;
        call.startProactiveTurn();
      } else {
        initialCharacterGreetingPendingRef.current = false;
      }
    } catch (cause) {
      call.hangup();
      if (callRef.current === call) callRef.current = null;
      if (!mountedRef.current) return;
      setPhase(initiator === "character" ? "incoming" : "ready");
      setError(cause instanceof Error ? cause.message : "通话启动失败。");
    }
  }, [initiator, onEnd, saveTranscript, session, started, wakeCall]);

  // Android 锁屏来电页已经由用户接听后，进入通话页应直接启动实时音频，
  // 不再显示第二次“接听”按钮。
  useEffect(() => {
    if (!initiallyAccepted || initiator !== "character") return;
    void startCall();
  }, [initiallyAccepted, initiator, startCall]);

  useEffect(() => {
    if (!started) return;
    const timer = window.setInterval(() => {
      const call = callRef.current;
      if (!call || call.mode !== "listening" || proactiveTurnRequestedRef.current) return;
      if (generationControllersRef.current.size > 0 || !isProactiveInteractionAllowed(session.id)) return;

      const state = loadProactiveInteractionState(session.id);
      const quietWindowMs = state.mode === "study" ? 15 * 60_000 : 4 * 60_000;
      const lastActivityAt = lastCallActivityAtRef.current || startedAtRef.current || Date.now();
      if (Date.now() - lastActivityAt < quietWindowMs) return;

      proactiveTurnRequestedRef.current = true;
      lastCallActivityAtRef.current = Date.now();
      call.startProactiveTurn();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [started, session.id]);

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

  if (started) {
    return (
      <div className="fixed inset-0 z-[110] overflow-hidden bg-[#080809] text-white" style={{ backgroundColor: "#080809" }}>
        {/* Soft, blurred avatar wallpaper with the reference's nearly-black treatment */}
        {character.avatar ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <img
              src={character.avatar}
              alt=""
              className="h-full w-full scale-125 object-cover blur-[48px]" style={{ opacity: 0.65 }}
              aria-hidden="true"
            />
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_30%_40%,#28282b_0%,#111112_48%,#050506_100%)]" aria-hidden="true" />
        )}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "linear-gradient(180deg, rgba(0,0,0,0.88) 0%, rgba(7,7,8,0.70) 35%, rgba(24,24,26,0.70) 72%, rgba(0,0,0,0.86) 100%)",
          }}
        />

        {/* Screenshot-matched top row */}
        <div className="absolute left-0 right-0 top-[7.1%] flex items-center justify-between px-[6.2%]">
          {onMinimize ? (
            <button type="button" aria-label="缩小通话窗口" onClick={onMinimize} className="flex h-12 w-12 items-center justify-center text-white">
              <svg viewBox="0 0 48 48" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4.5" y="4.5" width="27" height="27" rx="2.5" />
                <rect x="16.5" y="16.5" width="27" height="27" rx="2.5" />
              </svg>
            </button>
          ) : <span className="h-12 w-12" />}
          <span className="absolute left-1/2 -translate-x-1/2 flex h-12 items-center justify-center text-[18px] font-light tabular-nums tracking-wide">
            {formatDuration(duration)}
          </span>
          <button type="button" aria-label="添加通话成员（暂不可用）" disabled className="flex h-12 w-12 cursor-not-allowed items-center justify-center text-white/95">
            <Plus size={34} strokeWidth={1.7} />
          </button>
        </div>

        {/* Avatar and name: reference starts around one quarter down the screen */}
        <div className="absolute left-1/2 top-[25.5%] flex -translate-x-1/2 flex-col items-center">
          {character.avatar ? (
            <img src={character.avatar} alt={character.name} className="object-cover" style={{ width: "24vw", height: "24vw", maxWidth: 168, maxHeight: 168, minWidth: 112, minHeight: 112, borderRadius: 16, aspectRatio: "1 / 1", objectFit: "cover" }} />
          ) : (
            <div className="flex items-center justify-center bg-white/15 text-4xl font-medium" style={{ width: "24vw", height: "24vw", maxWidth: 168, maxHeight: 168, minWidth: 112, minHeight: 112, borderRadius: 16, aspectRatio: "1 / 1" }}>
              {character.name.slice(0, 1)}
            </div>
          )}
          <h1 className="mt-3.5 text-[22px] font-normal tracking-wide">{character.name}</h1>
          {error && <p role="alert" className="mt-3 max-w-[80vw] text-center text-sm text-rose-200">{error}</p>}
        </div>

        {/* Bottom control row aligned to the screenshot */}
        <div className="absolute bottom-[calc(env(safe-area-inset-bottom)+14.8vh)] left-1/2 flex w-[76vw] max-w-[520px] -translate-x-1/2 items-start justify-between">
          <div className="flex w-[18vw] max-w-[126px] flex-shrink-0 flex-col items-center gap-5">
            <button type="button" onClick={toggleMic} aria-label={micMuted ? "取消麦克风静音" : "麦克风静音"} className={`flex aspect-square w-full min-w-[76px] items-center justify-center rounded-full shadow-md transition-colors ${micMuted ? "bg-[#242426] text-white" : "bg-white text-black"}`}>
              {micMuted ? <MicOff size={40} strokeWidth={2.1} /> : <Mic size={40} strokeWidth={2.1} />}
            </button>
            <span className="whitespace-nowrap text-center text-[16px] text-white/85">{micMuted ? "麦克风已关" : "麦克风已开"}</span>
          </div>
          <div className="flex w-[18vw] max-w-[126px] flex-shrink-0 flex-col items-center gap-5">
            <button type="button" onClick={endCall} aria-label="挂断" className="flex aspect-square w-full min-w-[76px] items-center justify-center rounded-full bg-[#e34850] text-white shadow-md">
              <Phone size={38} strokeWidth={2} className="rotate-[135deg]" />
            </button>
            <span className="whitespace-nowrap text-center text-[16px] text-white/85">挂断</span>
          </div>
          <div className="flex w-[18vw] max-w-[126px] flex-shrink-0 flex-col items-center gap-5">
            <button type="button" onClick={toggleSpeaker} aria-label={speakerMuted ? "开启扬声器" : "关闭扬声器"} className={`flex aspect-square w-full min-w-[76px] items-center justify-center rounded-full shadow-md transition-colors ${speakerMuted ? "bg-[#1c1c1e] text-white" : "bg-[#1c1c1e] text-white"}`}>
              {speakerMuted ? <VolumeX size={40} strokeWidth={2.1} /> : <Volume2 size={40} strokeWidth={2.1} />}
            </button>
            <span className="whitespace-nowrap text-center text-[16px] text-white/85">{speakerMuted ? "扬声器已关" : "扬声器已开"}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[110] flex flex-col items-center justify-between overflow-hidden bg-[radial-gradient(ellipse_at_50%_38%,_#292a2d_0%,_#141516_48%,_#050506_100%)] px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-white">
      <div className="flex w-full items-center justify-between">
        {onMinimize ? (
          <button type="button" aria-label="缩小通话窗口" onClick={onMinimize} className="flex h-10 w-10 items-center justify-center">
            <PictureInPicture2 size={28} />
          </button>
        ) : <span />}
        <span className="text-lg tabular-nums">{PHASE_LABELS[phase]}</span>
        <button type="button" aria-label="添加通话成员（暂不可用）" disabled className="flex h-10 w-10 cursor-not-allowed items-center justify-center text-white/55">
          <Plus size={32} />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center">
        {character.avatar ? (
          <img src={character.avatar} alt={character.name} className="mb-5 h-28 w-28 rounded-full object-cover" />
        ) : (
          <div className="mb-5 flex h-24 w-24 items-center justify-center rounded-xl bg-white/15 text-4xl">{character.name.slice(0, 1)}</div>
        )}
        <h1 className="text-2xl font-normal">{character.name}</h1>
        {error && <p role="alert" className="mt-4 text-center text-sm text-rose-200">{error}</p>}
      </div>
      {phase === "incoming" ? (
        <div className="flex items-center justify-center gap-12">
          <button type="button" onClick={() => { if (wakeCall) clearTimedWakeSchedule(session.id); saveTranscript("user", "[我拒绝了语音通话]"); onEnd(); }} className="flex h-20 w-20 items-center justify-center rounded-full bg-[#e34850]" aria-label="拒接">
            <PhoneOff size={30} />
          </button>
          <button type="button" onClick={startCall} className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-600" aria-label="接听">
            <Mic size={30} />
          </button>
        </div>
      ) : (
        <button type="button" onClick={startCall} disabled={phase === "connecting"} className="flex min-h-14 min-w-48 items-center justify-center gap-2 rounded-full bg-emerald-600 px-8 text-base font-semibold disabled:opacity-60">
          {phase === "connecting" && <LoaderCircle size={18} className="animate-spin" />}
          {phase === "connecting" ? "正在连接…" : "开始通话"}
        </button>
      )}
    </div>
  );
}
