export type StrictProfile = {
  nickname: string;
  lineOne: string;
  lineTwo: string;
  avatar: string;
  banner: string;
};

export type StrictDay = {
  date: string;
  sleep?: { status: "recognized" | "approved" | "not-met" | "date-mismatch" | "needs-reupload"; result?: Record<string, unknown>; feedback?: string };
  focus?: { status: "approved" | "date-mismatch" | "needs-reupload"; minutes?: number; result?: Record<string, unknown>; feedback?: string; pendingMinutes?: number; pendingResult?: Record<string, unknown> };
  recall?: { text: string; images?: string[]; completedAt: number; feedback?: string };
  charNote?: { date: string; characterId: string; text: string };
  [key: string]: unknown;
};

export type StrictStore = {
  enabled: boolean;
  supervisorId: string;
  profile: StrictProfile;
  days: Record<string, StrictDay>;
  streak: { count: number; lastCheckinDate: string; boatUnlocked: boolean };
  sleepRules: { bedtimeDeadline: string; wakeFrom: string; wakeUntil: string; minSleepHours: string };
  [key: string]: unknown;
};

export const DEFAULT_STRICT_STORE: StrictStore = {
  enabled: false,
  supervisorId: "",
  profile: { nickname: "小玉", lineOne: "@白衣魔法使", lineTwo: "把今天过成值得骄傲的一天。", avatar: "", banner: "" },
  days: {},
  streak: { count: 0, lastCheckinDate: "", boatUnlocked: false },
  sleepRules: { bedtimeDeadline: "", wakeFrom: "", wakeUntil: "", minSleepHours: "" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function assertSafeJsonTree(input: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > 100000 || current.depth > 16) throw new Error("学习记录结构过于复杂");
    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (value.length > 8000000) throw new Error("学习记录文本字段过长");
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("学习记录包含无效数字");
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key.length > 256) throw new Error("学习记录字段名称过长");
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    throw new Error("学习记录包含不支持的数据");
  }
}

function assertString(record: Record<string, unknown>, key: string, maxLength: number, label: string): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || value.length > maxLength)) {
    throw new Error(`${label}格式无效`);
  }
}

function assertOptionalInteger(record: Record<string, unknown>, key: string, min: number, max: number, label: string): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)) {
    throw new Error(`${label}格式无效`);
  }
}

function assertResult(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label}格式无效`);
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 80) throw new Error(`${label}字段过长`);
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`${label}包含不支持的数据`);
    }
    if (typeof item === "string" && item.length > 4000) throw new Error(`${label}字段过长`);
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${label}包含无效数字`);
  }
}

function assertVisionResult(value: unknown, label: string, expectedKind: "sleep" | "focus"): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label}格式无效`);
  assertResult(value, label);
  if (value.kind !== undefined && value.kind !== expectedKind) {
    throw new Error(`${label}类型不匹配`);
  }
  for (const key of ["recordDate", "phoneLockDate"]) {
    const field = value[key];
    if (field !== undefined && field !== null && field !== "" && !isDateKey(field)) {
      throw new Error(`${label}中的日期无效`);
    }
  }
  for (const key of ["sleepStart", "wakeTime", "phoneLockTime"]) {
    const field = value[key];
    if (field !== undefined && field !== null && field !== "" &&
      (typeof field !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(field))) {
      throw new Error(`${label}中的时间无效`);
    }
  }
  for (const key of ["sleepDurationMinutes", "focusDurationMinutes"]) {
    const field = value[key];
    if (field !== undefined && field !== null &&
      (typeof field !== "number" || !Number.isInteger(field) || field < 0 || field > 1440)) {
      throw new Error(`${label}中的时长无效`);
    }
  }
  for (const key of ["deviceVisible", "phoneLockVisible"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${label}中的凭证可见状态无效`);
    }
  }
  if (value.confidence !== undefined && !["high", "medium", "low"].includes(String(value.confidence))) {
    throw new Error(`${label}的置信度无效`);
  }
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length > 300)) {
    throw new Error(`${label}的说明过长或格式无效`);
  }
}

function normalizeDay(key: string, value: unknown): StrictDay {
  if (!isDateKey(key) || !isRecord(value) || value.date !== key) {
    throw new Error(`学习记录日期 ${key} 格式无效`);
  }
  const day = value;
  if (day.sleep !== undefined) {
    if (!isRecord(day.sleep) || !["recognized", "approved", "not-met", "date-mismatch", "needs-reupload"].includes(String(day.sleep.status))) {
      throw new Error(`${key} 的睡眠记录格式无效`);
    }
    if (!isRecord(day.sleep.result)) throw new Error(`${key} 缺少睡眠凭证识别结果`);
    assertVisionResult(day.sleep.result, `${key} 的睡眠识别结果`, "sleep");
    if (day.sleep.status === "approved") {
      const result = day.sleep.result;
      if (result.recordDate !== key ||
        typeof result.sleepStart !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result.sleepStart) ||
        typeof result.wakeTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result.wakeTime) ||
        typeof result.sleepDurationMinutes !== "number" || !Number.isInteger(result.sleepDurationMinutes) ||
        result.sleepDurationMinutes <= 0 || result.sleepDurationMinutes > 1440) {
        throw new Error(`${key} 的已审核睡眠记录与凭证数据不一致`);
      }
    }
    assertString(day.sleep, "feedback", 4000, `${key} 的睡眠反馈`);
  }
  if (day.focus !== undefined) {
    if (!isRecord(day.focus) || !["approved", "date-mismatch", "needs-reupload"].includes(String(day.focus.status))) {
      throw new Error(`${key} 的专注记录格式无效`);
    }
    if (!isRecord(day.focus.result)) throw new Error(`${key} 缺少专注凭证识别结果`);
    assertVisionResult(day.focus.result, `${key} 的专注识别结果`, "focus");
    if (day.focus.status === "approved") {
      const result = day.focus.result;
      if (day.focus.minutes === undefined) throw new Error(`${key} 的已审核专注记录缺少时长`);
      if (result.phoneLockDate !== key || result.deviceVisible !== true || result.phoneLockVisible !== true ||
        typeof result.phoneLockTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result.phoneLockTime) ||
        result.focusDurationMinutes !== day.focus.minutes) {
        throw new Error(`${key} 的已审核专注记录与凭证数据不一致`);
      }
    }
    if ((day.focus.pendingMinutes === undefined) !== (day.focus.pendingResult === undefined)) {
      throw new Error(`${key} 的待确认专注记录不完整`);
    }
    assertOptionalInteger(day.focus, "minutes", 0, 1440, `${key} 的专注时长`);
    assertOptionalInteger(day.focus, "pendingMinutes", 0, 1440, `${key} 的待确认专注时长`);
    assertVisionResult(day.focus.pendingResult, `${key} 的待确认识别结果`, "focus");
    if (day.focus.pendingResult != null) {
      if (!isRecord(day.focus.pendingResult)) {
        throw new Error(`${key} 的待确认识别结果格式无效`);
      }
      const pendingResult = day.focus.pendingResult;
      if (pendingResult.phoneLockDate !== key ||
        pendingResult.deviceVisible !== true || pendingResult.phoneLockVisible !== true ||
        pendingResult.focusDurationMinutes !== day.focus.pendingMinutes) {
        throw new Error(`${key} 的待确认专注记录与凭证数据不一致`);
      }
    }
    assertString(day.focus, "feedback", 4000, `${key} 的专注反馈`);
  }
  if (day.recall !== undefined) {
    if (!isRecord(day.recall)) throw new Error(`${key} 的回忆记录格式无效`);
    if (typeof day.recall.text !== "string" || day.recall.text.length > 20000) {
      throw new Error("回忆内容格式无效：" + key);
    }
    if (typeof day.recall.notes !== "string" || day.recall.notes.length > 20000) {
      throw new Error("补充笔记格式无效：" + key);
    }
    assertString(day.recall, "feedback", 4000, `${key} 的角色反馈`);
    if (day.recall.images !== undefined && (!Array.isArray(day.recall.images) || day.recall.images.length > 3 || day.recall.images.some((image) => typeof image !== "string" || image.length > 500000))) throw new Error(`${key} 的回忆资料图片格式无效`);
    if (typeof day.recall.completedAt !== "number" || !Number.isFinite(day.recall.completedAt) || day.recall.completedAt < 0) {
      throw new Error(`${key} 的回忆完成时间无效`);
    }
  }
  if (day.charNote !== undefined) {
    if (!isRecord(day.charNote) || day.charNote.date !== key || !isDateKey(day.charNote.date) || typeof day.charNote.characterId !== "string" || day.charNote.characterId.length > 256 || typeof day.charNote.text !== "string" || day.charNote.text.length > 4000) {
      throw new Error(`${key} 的每日留言格式无效`);
    }
  }
  return day as unknown as StrictDay;
}

/**
 * Validate and normalize persisted or remote learning data.
 * Invalid data is rejected rather than replaced with defaults, so callers can
 * stop before writing a blank snapshot over the original record.
 */
export function normalizeStrictLearningStore(input: unknown): StrictStore {
  if (!isRecord(input)) throw new Error("学习记录必须是 JSON 对象");
  assertSafeJsonTree(input);
  const source = input;

  if (source.enabled !== undefined && typeof source.enabled !== "boolean") throw new Error("学习中心开关格式无效");
  assertString(source, "supervisorId", 256, "监督角色");

  const profileInput = source.profile === undefined ? {} : source.profile;
  if (!isRecord(profileInput)) throw new Error("个人资料格式无效");
  assertString(profileInput, "nickname", 200, "昵称");
  assertString(profileInput, "lineOne", 2000, "个人资料第一行");
  assertString(profileInput, "lineTwo", 2000, "个人资料第二行");
  assertString(profileInput, "avatar", 8000000, "头像");
  assertString(profileInput, "banner", 8000000, "顶部横幅");

  const daysInput = source.days === undefined ? {} : source.days;
  if (!isRecord(daysInput) || Object.keys(daysInput).length > 5000) throw new Error("每日学习记录格式无效");
  const days: Record<string, StrictDay> = {};
  for (const [key, value] of Object.entries(daysInput)) days[key] = normalizeDay(key, value);

  const streakInput = source.streak === undefined ? {} : source.streak;
  if (!isRecord(streakInput)) throw new Error("连续学习记录格式无效");
  assertOptionalInteger(streakInput, "count", 0, 1000000, "连续学习天数");
  if (streakInput.lastCheckinDate !== undefined && streakInput.lastCheckinDate !== "" && !isDateKey(streakInput.lastCheckinDate)) {
    throw new Error("最近打卡日期格式无效");
  }
  if (streakInput.boatUnlocked !== undefined && typeof streakInput.boatUnlocked !== "boolean") throw new Error("奖励状态格式无效");

  const rulesInput = source.sleepRules === undefined ? {} : source.sleepRules;
  if (!isRecord(rulesInput)) throw new Error("睡眠规则格式无效");
  for (const key of ["bedtimeDeadline", "wakeFrom", "wakeUntil", "minSleepHours"]) {
    assertString(rulesInput, key, 32, "睡眠规则");
  }
  for (const key of ["bedtimeDeadline", "wakeFrom", "wakeUntil"]) {
    const value = rulesInput[key];
    if (value !== undefined && value !== "" &&
      (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) {
      throw new Error("睡眠规则时间格式无效");
    }
  }
  const minSleepHours = rulesInput.minSleepHours;
  if (minSleepHours !== undefined && minSleepHours !== "") {
    const hours = Number(minSleepHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 || !Number.isInteger(hours * 2)) {
      throw new Error("最低睡眠时长必须为 1 至 24 小时，且以半小时为单位");
    }
  }

  return {
    ...DEFAULT_STRICT_STORE,
    ...source,
    profile: { ...DEFAULT_STRICT_STORE.profile, ...profileInput } as StrictProfile,
    days,
    streak: { ...DEFAULT_STRICT_STORE.streak, ...streakInput } as StrictStore["streak"],
    sleepRules: { ...DEFAULT_STRICT_STORE.sleepRules, ...rulesInput } as StrictStore["sleepRules"],
  };
}
