"use client";

import { findChatSessionById, loadChatAppSettings, loadChatSessions, resolveChatSoundConfig } from "./chat-storage";
import { getChatAudioFromIndexedDB } from "./chat-asset-storage";
import type { ChatSession, ChatSoundConfig } from "./chat-storage";
import { isShellEnvironment } from "./shell-detect";

type NativeRingtoneBridge = {
    beginCallRingtoneUpload: (key: string, mimeType: string, expectedBytes: number) => boolean;
    appendCallRingtoneUploadChunk: (key: string, base64Chunk: string) => boolean;
    finishCallRingtoneUpload: (key: string) => boolean;
    setCallRingtoneMuted: (key: string, muted: boolean) => boolean;
    deleteCallRingtone: (key: string) => boolean;
    scheduleDailyAlarmWatchdog?: (id: string, sessionId: string, characterName: string, localTime: string, timeZone: string) => boolean;
    cancelDailyAlarmWatchdog?: () => boolean;
};

declare global {
    interface Window {
        AndroidShell?: NativeRingtoneBridge;
    }
}

const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 48 * 1024;
const syncVersions = new Map<string, number>();
const syncQueues = new Map<string, Promise<void>>();

function bridge(): NativeRingtoneBridge | null {
    if (typeof window === "undefined" || !isShellEnvironment()) return null;
    const native = window.AndroidShell;
    return native
        && typeof native.beginCallRingtoneUpload === "function"
        && typeof native.appendCallRingtoneUploadChunk === "function"
        && typeof native.finishCallRingtoneUpload === "function"
        && typeof native.setCallRingtoneMuted === "function"
        && typeof native.deleteCallRingtone === "function"
        ? native
        : null;
}

async function resolveAudioBlob(config: ChatSoundConfig): Promise<Blob | null> {
    if (!config.value) return null;
    let blob: Blob;
    if (config.sourceType === "file" && !/^(?:https?:|data:|blob:)/i.test(config.value)) {
        const dataUrl = await getChatAudioFromIndexedDB(config.value);
        if (!dataUrl) return null;
        const response = await fetch(dataUrl);
        blob = await response.blob();
    } else {
        const response = await fetch(config.value);
        if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
        blob = await response.blob();
    }
    if (!blob.type.toLowerCase().startsWith("audio/")) {
        throw new Error("The selected ringtone is not an audio resource");
    }
    if (blob.size <= 0 || blob.size > MAX_BYTES) {
        throw new Error("Ringtone must be between 1 byte and 8 MB");
    }
    return blob;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return btoa(binary);
}

async function uploadRingtone(native: NativeRingtoneBridge, key: string, config: ChatSoundConfig): Promise<boolean> {
    const blob = await resolveAudioBlob(config);
    if (!blob) return false;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!native.beginCallRingtoneUpload(key, blob.type || "audio/mpeg", bytes.length)) return false;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
        if (!native.appendCallRingtoneUploadChunk(key, bytesToBase64(chunk))) return false;
    }
    return native.finishCallRingtoneUpload(key);
}

async function syncKeyNow(key: string, config: ChatSoundConfig, fallbackConfig: ChatSoundConfig | undefined, version: number): Promise<void> {
    const native = bridge();
    if (!native) return;
    if (!config.enabled || !config.value) {
        native.deleteCallRingtone(key);
        native.setCallRingtoneMuted(key, true);
        return;
    }

    // Same effective audio as global: remove any stale per-session copy and inherit global.
    if (key !== "global" && fallbackConfig?.enabled && fallbackConfig.value
        && config.value === fallbackConfig.value && config.sourceType === fallbackConfig.sourceType) {
        native.deleteCallRingtone(key);
        native.setCallRingtoneMuted(key, false);
        return;
    }

    try {
        const uploaded = await uploadRingtone(native, key, config);
        if (syncVersions.get(key) !== version) return;
        if (uploaded) native.setCallRingtoneMuted(key, false);
    } catch (error) {
        console.warn("[CallRingtoneSync] Native ringtone sync failed; keeping previous cached audio.", error);
    }
}

/** Serialize writes per key: concurrent uploads must never interleave chunks in one temp file. */
async function syncKey(key: string, config: ChatSoundConfig, fallbackConfig?: ChatSoundConfig): Promise<void> {
    const version = (syncVersions.get(key) || 0) + 1;
    syncVersions.set(key, version);
    const previous = syncQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(
        () => syncKeyNow(key, config, fallbackConfig, version),
    );
    syncQueues.set(key, current);
    try {
        await current;
    } finally {
        if (syncQueues.get(key) === current) syncQueues.delete(key);
    }
}

/** Synchronize the effective incoming-call ringtone for one chat session. */
export async function syncNativeCallRingtoneForSession(session: ChatSession): Promise<void> {
    const global = loadChatAppSettings().globalChatSounds?.incomingCall || {};
    const effective = resolveChatSoundConfig("incomingCall", session);
    await syncKey(session.id, effective, global);
}

/** Synchronize global fallback and all current sessions after global ringtone changes. */
export async function syncNativeCallRingtones(): Promise<void> {
    if (!bridge()) return;
    const global = loadChatAppSettings().globalChatSounds?.incomingCall || {};
    await syncKey("global", global);
    const sessions = loadChatSessions();
    await Promise.all(sessions.map(session => syncNativeCallRingtoneForSession(session)));
}

/** Synchronize one session by ID after its sound settings are persisted. */
export async function syncNativeCallRingtoneById(sessionId: string): Promise<void> {
    const session = findChatSessionById(sessionId);
    if (session) await syncNativeCallRingtoneForSession(session);
}

/** Arm the Android-only local watchdog. Null means this is not the native shell. */
export function scheduleNativeDailyAlarmWatchdog(
    config: { id: string; sessionId: string; localTime: string; timeZone: string },
    characterName: string,
): boolean | null {
    if (typeof window === "undefined" || !isShellEnvironment()) return null;
    const native = window.AndroidShell;
    if (typeof native?.scheduleDailyAlarmWatchdog !== "function") return false;
    return native.scheduleDailyAlarmWatchdog(config.id, config.sessionId, characterName, config.localTime, config.timeZone);
}

export function cancelNativeDailyAlarmWatchdog(): boolean | null {
    if (typeof window === "undefined" || !isShellEnvironment()) return null;
    const native = window.AndroidShell;
    if (typeof native?.cancelDailyAlarmWatchdog !== "function") return false;
    return native.cancelDailyAlarmWatchdog();
}
