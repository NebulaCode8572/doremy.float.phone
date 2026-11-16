import { kvGet, kvSet } from "./kv-db";

const STORAGE_PREFIX = "proactive_interaction_state_v1:";

export type ProactiveMode = "normal" | "study" | "sleep" | "paused";
export type ProactiveInteractionState = {
    enabled: boolean;
    mode: ProactiveMode;
    updatedAt: number;
};

const DEFAULT_STATE: ProactiveInteractionState = {
    enabled: true,
    mode: "normal",
    updatedAt: 0,
};

function storageKey(sessionId: string): string {
    return STORAGE_PREFIX + sessionId;
}

export function loadProactiveInteractionState(sessionId: string): ProactiveInteractionState {
    if (typeof window === "undefined" || !sessionId) return { ...DEFAULT_STATE };
    try {
        const raw = kvGet(storageKey(sessionId));
        if (!raw) return { ...DEFAULT_STATE };
        const parsed = JSON.parse(raw) as Partial<ProactiveInteractionState>;
        const mode: ProactiveMode = parsed.mode === "study" || parsed.mode === "sleep" || parsed.mode === "paused"
            ? parsed.mode
            : "normal";
        return {
            enabled: parsed.enabled !== false,
            mode,
            updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0,
        };
    } catch {
        return { ...DEFAULT_STATE };
    }
}

function saveState(sessionId: string, patch: Partial<ProactiveInteractionState>): ProactiveInteractionState {
    const next = { ...loadProactiveInteractionState(sessionId), ...patch, updatedAt: Date.now() };
    if (typeof window !== "undefined" && sessionId) {
        kvSet(storageKey(sessionId), JSON.stringify(next));
        window.dispatchEvent(new CustomEvent("proactive-interaction-state-updated", {
            detail: { sessionId, state: next },
        }));
    }
    return next;
}

export function setProactivePermission(sessionId: string, enabled: boolean): ProactiveInteractionState {
    return saveState(sessionId, { enabled });
}

export function isProactiveInteractionAllowed(sessionId: string, options?: { allowScheduledWake?: boolean }): boolean {
    const state = loadProactiveInteractionState(sessionId);
    if (!state.enabled || state.mode === "paused") return false;
    if (options?.allowScheduledWake && state.mode === "sleep") return true;
    return state.mode !== "sleep";
}

/**
 * Interpret the user's latest natural-language status update.
 * This deliberately recognizes families of expressions rather than requiring
 * one exact command. Ambiguous or negated statements leave the current state intact.
 */
export function applyProactiveIntentFromUserText(sessionId: string, rawText: string): ProactiveInteractionState {
    const text = rawText.replace(/\s+/g, "").trim();
    if (!sessionId || !text) return loadProactiveInteractionState(sessionId);

    const negated = /(?:不|没|没有|并不|还没|暂时不)(?:是|在|想|打算|准备)?(?:睡|学习|复习|工作|忙)/.test(text);
    if (negated) return loadProactiveInteractionState(sessionId);

    // Explicitly asking for quiet takes priority over ordinary study/busy wording.
    if (/(?:别|不要|不用|先别|暂时别).{0,8}(?:提醒|打扰|主动联系|主动找我|主动搭话)|(?:安静点|让我安静|暂停主动|不要主动发消息)/.test(text)) {
        return saveState(sessionId, { mode: "paused" });
    }

    // Sleep has higher priority than study/busy states. A scheduled wake call is handled separately.
    if (/(?:准备睡|要睡了|先睡了|去睡了|睡觉了|睡下了|已经睡|我睡了|晚安|困得要睡|休息睡觉)/.test(text)) {
        return saveState(sessionId, { mode: "sleep" });
    }

    // End-of-task / free-time expressions restore ordinary interaction.
    if (/(?:学完|复习完|作业写完|忙完|工作结束|下班了|下课了|结束学习|歇会|休息会|休息一下|放松一下|现在有空|有空了|不忙了|空下来了|可以聊了|先不学了)/.test(text)) {
        return saveState(sessionId, { mode: "normal" });
    }

    // Busy / focus expressions switch to a quieter, low-frequency companionship mode.
    if (/(?:正在|在|得|要)?(?:学习|复习|自习|上课|写作业|工作|开会|赶作业|赶进度|专注|忙|忙着|忙碌|处理事情)|(?:我有点忙|现在比较忙|先忙一会|暂时没空|需要专心)/.test(text)) {
        return saveState(sessionId, { mode: "study" });
    }

    return loadProactiveInteractionState(sessionId);
}
