"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowDown, LoaderCircle, Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";

import type { Character } from "@/lib/character-types";
import type { ChatSession } from "@/lib/chat-storage";
import { getLatestCharacterStateValues, loadChatMessages, pushChatMessage } from "@/lib/chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { VoiceCall } from "@/lib/paivoice/voice-call.js";

type PaiVoiceCallScreenProps = {
  session: ChatSession;
  character: Character;
  onEnd: () => void;
  minimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
};

type CallPhase = "ready" | "connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "ended";

const PHASE_LABELS: Record<CallPhase, string> = {
  ready: "准备通话",
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
  minimized = false,
  onMinimize,
  onRestore,
}: PaiVoiceCallScreenProps) {
  const callRef = useRef<VoiceCall | null>(null);
  const generationControllersRef = useRef(new Map<string, AbortController>());
  const savedAssistantTurnIdsRef = useRef(new Set<string>());
  const startedAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState<CallPhase>("ready");
  const [started, setStarted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [holdingToTalk, setHoldingToTalk] = useState(false);
  const [error, setError] = useState("");

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

  const releaseTalkButton = useCallback(() => {
    callRef.current?.setPushToTalk(false);
    setHoldingToTalk(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of generationControllersRef.current.values()) controller.abort();
      generationControllersRef.current.clear();
      callRef.current?.hangup();
      callRef.current = null;
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

  useEffect(() => {
    if (!holdingToTalk) return;
    const release = () => releaseTalkButton();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [holdingToTalk, releaseTalkButton]);

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
      pushToTalk: true,
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
        transcript: (message) => {
          const turnId = typeof message?.turn_id === "string" ? message.turn_id : "";
          const userText = typeof message?.text === "string" ? message.text.trim() : "";
          saveTranscript("user", userText);
          if (!turnId || !userText) return;

          const controller = new AbortController();
          generationControllersRef.current.set(turnId, controller);
          void (async () => {
            try {
              const result = await generateChatCompletion(
                session,
                loadChatMessages(session.id),
                { appTags: ["chat", "voice"], signal: controller.signal },
              );
              if (controller.signal.aborted || callRef.current !== call) return;

              const rawText = flattenCompletionResult(result).trim();
              if (!rawText) throw new Error("角色没有生成可用回复。");

              const parsed = parseAIResponse(rawText, getLatestCharacterStateValues(session.contactId));
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
              if (controller.signal.aborted) return;
              const fallback = "我这边暂时没能生成回复，请稍后再试。";
              saveTranscript("assistant", fallback);
              savedAssistantTurnIdsRef.current.add(turnId);
              call.sendReply(fallback, turnId);
              if (mountedRef.current) {
                setError(cause instanceof Error ? cause.message : "角色回复生成失败。");
              }
            } finally {
              generationControllersRef.current.delete(turnId);
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
            if (call.mode === "thinking") {
              for (const controller of generationControllersRef.current.values()) controller.abort();
            }
            setPhase("listening");
          }
        },
        playing: (playing) => {
          if (!mountedRef.current) return;
          if (playing) setPhase("speaking");
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
          for (const controller of generationControllersRef.current.values()) controller.abort();
          generationControllersRef.current.clear();
          savedAssistantTurnIdsRef.current.clear();
          callRef.current = null;
          startedAtRef.current = null;
          setDuration(0);
          setPhase("ended");
          setStarted(false);
          setHoldingToTalk(false);
          setError("通话连接已关闭。");
        },
        error: (message) => {
          if (mountedRef.current) setError(String(message || "通话服务发生错误。"));
        },
        nothingHeard: () => {
          if (mountedRef.current) setPhase("listening");
        },
      },
    });

    callRef.current = call;
    try {
      // start() is called directly from this button's click handler so the
      // browser can grant microphone access and unlock audio in the gesture.
      await call.start();
      if (!mountedRef.current) {
        call.hangup();
        return;
      }
      startedAtRef.current = Date.now();
      setStarted(true);
      setPhase("listening");
    } catch (cause) {
      call.hangup();
      if (callRef.current === call) callRef.current = null;
      if (!mountedRef.current) return;
      setPhase("ready");
      setError(cause instanceof Error ? cause.message : "通话启动失败。");
    }
  }, [saveTranscript, started, session]);

  const toggleMic = useCallback(async () => {
    const call = callRef.current;
    if (!call) return;
    const next = !micMuted;
    try {
      await call.setMuted(next);
      setMicMuted(next);
      if (next) releaseTalkButton();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "麦克风状态切换失败。");
    }
  }, [micMuted, releaseTalkButton]);

  const toggleSpeaker = useCallback(() => {
    const next = !speakerMuted;
    callRef.current?.setSpeakerMuted(next);
    setSpeakerMuted(next);
  }, [speakerMuted]);

  const beginTalk = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (micMuted || !started || !callRef.current) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in every embedded browser.
    }
    callRef.current.setPushToTalk(true);
    setHoldingToTalk(true);
  }, [micMuted, started]);

  const endCall = useCallback(() => {
    releaseTalkButton();
    callRef.current?.hangup();
    callRef.current = null;
    onEnd();
  }, [onEnd, releaseTalkButton]);

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
        <p className="mt-2 min-h-6 text-sm text-white/75">
          {holdingToTalk ? "正在发送你的语音" : PHASE_LABELS[phase]}
        </p>
        <p className="mt-4 max-w-xs text-center text-xs leading-5 text-white/45">
          按住下方按钮时才会向通话服务发送麦克风音频；松开即结束本轮。
        </p>
        {error && <p role="alert" className="mt-4 max-w-sm text-center text-sm text-rose-300">{error}</p>}
      </div>

      <div className="flex w-full max-w-sm flex-col items-center gap-7">
        {started ? (
          <button
            type="button"
            disabled={micMuted || phase === "reconnecting" || phase === "ended"}
            onPointerDown={beginTalk}
            onPointerUp={releaseTalkButton}
            onPointerCancel={releaseTalkButton}
            onLostPointerCapture={releaseTalkButton}
            onContextMenu={(event) => event.preventDefault()}
            className={`flex h-24 w-24 select-none touch-none items-center justify-center rounded-full border border-white/20 shadow-xl transition ${holdingToTalk ? "scale-95 bg-sky-500" : "bg-white/15"} disabled:opacity-40`}
            aria-label="按住说话"
          >
            <Mic size={34} />
          </button>
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
        {started && <span className="text-xs text-white/55">{micMuted ? "麦克风已静音" : holdingToTalk ? "松开结束本轮" : "按住说话"}</span>}

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
