import { emitBailoutCancel } from "./bailout-cancel";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const PROACTIVE_CALL_SCHEDULES_KEY = "ai_phone_proactive_call_schedules_v1";
registerKvMigration(PROACTIVE_CALL_SCHEDULES_KEY);

export type ProactiveCallSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    createdAt: number;
    fireAt: number;
    delayMinutes: number;
    intent: string;
};

export function makeProactiveCallId(sessionId: string): string {
    return `proactive_call_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadProactiveCallSchedules(): ProactiveCallSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(PROACTIVE_CALL_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is ProactiveCallSchedule =>
            Boolean(item)
            && typeof item.id === "string"
            && typeof item.sessionId === "string"
            && typeof item.characterId === "string"
            && typeof item.createdAt === "number"
            && typeof item.fireAt === "number"
            && typeof item.delayMinutes === "number"
            && typeof item.intent === "string"
        );
    } catch {
        return [];
    }
}

export function saveProactiveCallSchedule(schedule: ProactiveCallSchedule): void {
    if (typeof window === "undefined") return;
    const schedules = loadProactiveCallSchedules().filter(item => item.id !== schedule.id);
    schedules.push(schedule);
    kvSet(PROACTIVE_CALL_SCHEDULES_KEY, JSON.stringify(schedules));
}

export function removeProactiveCallSchedule(id: string): void {
    if (typeof window === "undefined") return;
    kvSet(
        PROACTIVE_CALL_SCHEDULES_KEY,
        JSON.stringify(loadProactiveCallSchedules().filter(item => item.id !== id)),
    );
    emitBailoutCancel({ key: `proactivecall:${id}` });
}

export function clearProactiveCallSchedules(sessionId: string): void {
    const removing = loadProactiveCallSchedules().filter(item => item.sessionId === sessionId);
    if (typeof window === "undefined") return;
    kvSet(
        PROACTIVE_CALL_SCHEDULES_KEY,
        JSON.stringify(loadProactiveCallSchedules().filter(item => item.sessionId !== sessionId)),
    );
    for (const item of removing) emitBailoutCancel({ key: `proactivecall:${item.id}` });
}
