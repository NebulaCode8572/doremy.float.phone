import { emitBailoutCancel } from "./bailout-cancel";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const DAILY_ALARM_STORAGE_KEY = "ai_phone_daily_alarm_v1";
registerKvMigration(DAILY_ALARM_STORAGE_KEY);

export type DailyAlarmConfig = {
    id: string;
    enabled: boolean;
    sessionId: string;
    characterId: string;
    localTime: string;
    timeZone: string;
    updatedAt: number;
};

export function loadDailyAlarmConfig(): DailyAlarmConfig | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(DAILY_ALARM_STORAGE_KEY);
        const item = raw ? JSON.parse(raw) : null;
        if (!item || typeof item !== "object") return null;
        if (typeof item.id !== "string" || typeof item.sessionId !== "string"
            || typeof item.characterId !== "string" || typeof item.localTime !== "string"
            || typeof item.timeZone !== "string" || typeof item.updatedAt !== "number") return null;
        if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(item.localTime)) return null;
        return { ...item, enabled: item.enabled === true } as DailyAlarmConfig;
    } catch {
        return null;
    }
}

export function saveDailyAlarmConfig(config: DailyAlarmConfig): void {
    if (typeof window === "undefined") return;
    const previous = loadDailyAlarmConfig();
    kvSet(DAILY_ALARM_STORAGE_KEY, JSON.stringify(config));
    if (previous?.id && previous.id !== config.id) {
        emitBailoutCancel({ prefix: `dailyalarm:${previous.id}:` });
    }
}

export function clearDailyAlarmConfig(): void {
    if (typeof window === "undefined") return;
    const previous = loadDailyAlarmConfig();
    kvSet(DAILY_ALARM_STORAGE_KEY, "");
    if (previous?.id) emitBailoutCancel({ prefix: `dailyalarm:${previous.id}:` });
}

function zonedParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
    return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function localDateTimeToEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let guess = targetUtc;
    for (let index = 0; index < 3; index += 1) {
        const local = zonedParts(new Date(guess), timeZone);
        const representedUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
        guess += targetUtc - representedUtc;
    }
    return guess;
}

/** Resolve the next wall-clock occurrence in the configured IANA timezone. */
export function nextDailyAlarmAt(nowMs: number, localTime: string, timeZone: string): { fireAt: number; dateKey: string } {
    const [hour, minute] = localTime.split(":").map(Number);
    const today = zonedParts(new Date(nowMs), timeZone);
    let year = today.year, month = today.month, day = today.day;
    let fireAt = localDateTimeToEpoch(year, month, day, hour, minute, timeZone);
    if (fireAt <= nowMs + 5_000) {
        const next = new Date(Date.UTC(year, month - 1, day + 1));
        year = next.getUTCFullYear(); month = next.getUTCMonth() + 1; day = next.getUTCDate();
        fireAt = localDateTimeToEpoch(year, month, day, hour, minute, timeZone);
    }
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { fireAt, dateKey };
}
