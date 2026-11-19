import { emitBailoutCancel } from "./bailout-cancel";
import { markBailoutDirty } from "./bailout-dirty";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const TIMED_WAKE_SCHEDULES_KEY = "ai_phone_timed_wake_schedules_v1";

registerKvMigration(TIMED_WAKE_SCHEDULES_KEY);

export type TimedWakeSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    fireAt: number;
    createdAt: number;
    delayMinutes: number;
    intent: string;
    /** 创建来源：tool=角色自己约的（"你当时想着"视角）/ user=用户预约（"TA拜托你"视角）。缺省按 tool。 */
    source?: "tool" | "user";
    /** 用户明确要求到点电话叫醒时启用来电与有限重拨。 */
    wakeCall?: boolean;
    /** 0=首次来电；1~3=最多三次重拨。 */
    wakeAttempt?: number;
};

export function makeTimedWakeId(sessionId: string): string {
    return `timed_wake_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTimedWakeSchedules(): TimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTimedWakeSchedule);
    } catch {
        return [];
    }
}

function saveTimedWakeSchedules(schedules: TimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_SCHEDULES_KEY, JSON.stringify(schedules));
    // 排期一变就请监听方立刻把任务挂到服务端——不能等到「启动 20 秒后」或
    // 「切后台」那两个时点才组装上传，否则新建后很快退出/被杀会整单丢失。
    markBailoutDirty();
}

export function saveTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    const next = all.filter(item => item.sessionId !== schedule.sessionId);
    next.push(schedule);
    saveTimedWakeSchedules(next);
}

export function scheduleNextWakeCallRetry(schedule: TimedWakeSchedule): TimedWakeSchedule | null {
    if (!schedule.wakeCall) return null;
    const attempt = Math.max(0, Math.floor(schedule.wakeAttempt ?? 0));
    if (attempt >= 3) return null;
    const now = Date.now();
    const next: TimedWakeSchedule = {
        ...schedule,
        id: makeTimedWakeId(schedule.sessionId),
        createdAt: now,
        fireAt: now + 2 * 60_000,
        delayMinutes: 2,
        wakeAttempt: attempt + 1,
    };
    saveTimedWakeSchedule(next);
    return next;
}

/** 接通后 30 秒没有有效回应：把当前待重拨任务延后到挂断后 2 分钟。 */
export function postponeWakeCallRetry(sessionId: string): TimedWakeSchedule | null {
    const current = loadTimedWakeSchedules().find(item => item.sessionId === sessionId && item.wakeCall);
    if (!current) return null;
    removeTimedWakeSchedule(current.id);
    const now = Date.now();
    const next: TimedWakeSchedule = {
        ...current,
        id: makeTimedWakeId(sessionId),
        createdAt: now,
        fireAt: now + 2 * 60_000,
        delayMinutes: 2,
    };
    saveTimedWakeSchedule(next);
    return next;
}

export function clearTimedWakeSchedule(sessionId: string): void {
    // 先取出被清掉的条目，逐个撤销服务端预约——只改本地会让那条已经挂上去的
    // 任务照常在原定时刻触发，用户看到「已经取消了，通知还是弹了」。
    const removing = loadTimedWakeSchedules().filter(item => item.sessionId === sessionId);
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.sessionId !== sessionId));
    for (const item of removing) emitBailoutCancel({ key: `timedwake:${item.id}` });
}

export function removeTimedWakeSchedule(id: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.id !== id));
    // 同上：本地删除必须同步撤销服务端预约。
    emitBailoutCancel({ key: `timedwake:${id}` });
}

function isTimedWakeSchedule(value: unknown): value is TimedWakeSchedule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<TimedWakeSchedule>;
    return typeof item.id === "string"
        && typeof item.sessionId === "string"
        && typeof item.characterId === "string"
        && typeof item.fireAt === "number"
        && typeof item.createdAt === "number"
        && typeof item.delayMinutes === "number"
        && typeof item.intent === "string";
}
