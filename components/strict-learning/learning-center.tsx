"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Camera, Check, ClipboardList, Moon, Pencil, Sparkles, Timer, Upload, X } from "lucide-react";
import "./learning-center.css";
import { kvGet, kvSet } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import { createOrGetSession, hydrateChatStorage, loadChatMessages, pushChatMessage } from "@/lib/chat-storage";
import { useAccount } from "@/lib/account-context";
import { getStrictLearningStoreKey, migrateLegacyStrictLearningStore } from "@/lib/strict-learning-storage";

type StrictProfile = { nickname: string; lineOne: string; lineTwo: string; avatar: string; banner: string };
type StrictDay = {
  date: string;
  sleep?: { status: string; result?: Record<string, unknown>; feedback?: string };
  focus?: { status: string; minutes?: number; result?: Record<string, unknown>; feedback?: string; pendingMinutes?: number; pendingResult?: Record<string, unknown> };
  recall?: { text: string; notes: string; completedAt: number; feedback?: string };
  charNote?: { date: string; characterId: string; text: string };
};
type StrictStore = { enabled: boolean; supervisorId: string; profile: StrictProfile; days: Record<string, StrictDay>; streak: { count: number; lastCheckinDate: string; boatUnlocked: boolean }; sleepRules: { bedtimeDeadline: string; wakeFrom: string; wakeUntil: string; minSleepHours: string } };
type VisionResult = Record<string, unknown>;

const DEFAULT_STORE: StrictStore = {
  enabled: false,
  supervisorId: "",
  profile: { nickname: "小玉", lineOne: "@白衣魔法使", lineTwo: "把今天过成值得骄傲的一天。", avatar: "", banner: "" },
  days: {},
  streak: { count: 0, lastCheckinDate: "", boatUnlocked: false },
  sleepRules: { bedtimeDeadline: "", wakeFrom: "", wakeUntil: "", minSleepHours: "" },
};
const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const isDateKey = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dayDistance = (from: string, to: string) => {
  if (!from || !to) return Number.POSITIVE_INFINITY;
  const parse = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86400000);
};
const clockMinutes = (value: unknown) => { const match = typeof value === "string" ? /^(\d{2}):(\d{2})$/.exec(value) : null; if (!match) return null; const hours = Number(match[1]); const minutes = Number(match[2]); return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null; };
const beforeBedtimeDeadline = (actual: number, deadline: number) => (actual < 720 ? actual + 1440 : actual) <= (deadline < 720 ? deadline + 1440 : deadline);
const formatMinutes = (value: unknown) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  return `${Math.floor(minutes / 60)}小时${String(minutes % 60).padStart(2, "0")}分`;
};
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export function StrictLearningCenter() {
  const { account } = useAccount();
  const storeKey = useMemo(() => getStrictLearningStoreKey(account.id), [account.id]);
  const [open, setOpen] = useState(false);
  const [store, setStore] = useState<StrictStore>(DEFAULT_STORE);
  const [loaded, setLoaded] = useState(false);
  const [loadedAccountId, setLoadedAccountId] = useState("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [recallText, setRecallText] = useState("");
  const [recallNotes, setRecallNotes] = useState("");
  const [busy, setBusy] = useState<"sleep" | "focus" | "note" | null>(null);
  const [notice, setNotice] = useState("");
  const noteAttemptedRef = useRef("");
  const [profileDraft, setProfileDraft] = useState<StrictProfile>(DEFAULT_STORE.profile);

  const today = todayKey();
  const day = store.days[today] || { date: today };
  const supervisor = useMemo(() => characters.find(character => character.id === store.supervisorId) || null, [characters, store.supervisorId]);
  const completed = Number(day.sleep?.status === "approved") + Number(day.focus?.status === "approved" && (day.focus?.minutes || 0) >= 480) + Number(Boolean(day.recall?.completedAt));
  const streakGap = dayDistance(store.streak.lastCheckinDate, today);
  const currentStreak = streakGap >= 0 && streakGap <= 1 ? store.streak.count : 0;
  const focusMinutes = day.focus?.minutes || 0;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadedAccountId("");
    setOpen(false);
    setStore(DEFAULT_STORE);
    setRecallText("");
    setRecallNotes("");

    void (async () => {
      const activeStoreKey = await migrateLegacyStrictLearningStore(account.id);
      if (cancelled) return;
      const raw = kvGet(activeStoreKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<StrictStore>;
          setStore({
            ...DEFAULT_STORE,
            ...parsed,
            profile: { ...DEFAULT_STORE.profile, ...(parsed.profile || {}) },
            days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
            streak: { ...DEFAULT_STORE.streak, ...(parsed.streak || {}) },
            sleepRules: { ...DEFAULT_STORE.sleepRules, ...(parsed.sleepRules || {}) },
          });
        } catch { /* retain defaults */ }
      }
      setCharacters(loadCharacters());
      setLoadedAccountId(account.id);
      setLoaded(true);
    })().catch(() => {
      if (!cancelled) {
        setNotice("学习记录迁移失败，请重新打开学习中心。");
      }
    });

    return () => { cancelled = true; };
  }, [account.id]);

  useEffect(() => {
    if (loaded && loadedAccountId === account.id) kvSet(storeKey, JSON.stringify(store));
  }, [loaded, loadedAccountId, account.id, store, storeKey]);

  useEffect(() => {
    const refresh = () => {
      const raw = kvGet(storeKey);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Partial<StrictStore>;
        setStore(previous => ({
          ...previous,
          ...parsed,
          profile: { ...DEFAULT_STORE.profile, ...(parsed.profile || {}) },
          days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
          streak: { ...DEFAULT_STORE.streak, ...(parsed.streak || {}) },
          sleepRules: { ...DEFAULT_STORE.sleepRules, ...(parsed.sleepRules || {}) },
        }));
      } catch { /* ignore malformed external updates */ }
    };
    window.addEventListener("strict-learning-updated", refresh);
    return () => window.removeEventListener("strict-learning-updated", refresh);
  }, [storeKey]);

  useEffect(() => {
    if (!loaded || completed !== 3 || store.streak.lastCheckinDate === today) return;
    setStore(previous => {
      if (previous.streak.lastCheckinDate === today) return previous;
      const nextCount = dayDistance(previous.streak.lastCheckinDate, today) === 1 ? previous.streak.count + 1 : 1;
      return { ...previous, streak: { count: nextCount, lastCheckinDate: today, boatUnlocked: previous.streak.boatUnlocked || nextCount >= 30 } };
    });
  }, [loaded, completed, today, store.streak.lastCheckinDate]);

  useEffect(() => {
    if (!open) return;
    const current = store.days[today];
    if (current?.recall) {
      setRecallText(current.recall.text);
      setRecallNotes(current.recall.notes);
    } else {
      setRecallText("");
      setRecallNotes("");
    }
  }, [open, today, store.days]);

  const updateDay = useCallback((updates: Partial<StrictDay>) => {
    setStore(previous => ({
      ...previous,
      days: { ...previous.days, [today]: { ...(previous.days[today] || { date: today }), ...updates } },
    }));
  }, [today]);

  const updateProfile = (key: keyof StrictProfile, value: string) => {
    setProfileDraft(previous => ({ ...previous, [key]: value }));
  };

  const uploadImage = async (kind: "avatar" | "banner", file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setNotice("请选择图片文件。"); return; }
    if (file.size > 5 * 1024 * 1024) { setNotice("图片请控制在 5 MB 以内。"); return; }
    try {
      const dataUrl = await readImage(file);
      setProfileDraft(previous => ({ ...previous, [kind]: dataUrl }));
    } catch { setNotice("图片读取失败。"); }
  };

  const askCharToReviewEvidence = async (kind: "sleep" | "focus", result: VisionResult, verdict: string): Promise<string> => {
    if (!supervisor) return "";
    const apiConfigs = loadApiConfigs();
    const binding = resolveBinding(loadBindingConfig(), supervisor.id, "chat");
    const config = apiConfigs.find(item => item.id === binding.apiConfigId);
    if (!config) return "";
    try {
      await hydrateChatStorage();
      const session = createOrGetSession(supervisor.id);
      const fields = kind === "sleep"
        ? { reportWakeDate: result.recordDate, sleepStart: result.sleepStart, wakeTime: result.wakeTime, sleepDurationMinutes: result.sleepDurationMinutes }
        : { todayCumulativeFocusMinutes: result.focusDurationMinutes, phoneLockDate: result.phoneLockDate, phoneLockTime: result.phoneLockTime };
      pushChatMessage({
        sessionId: session.id,
        role: "user",
        content: `【学习中心·${kind === "sleep" ? "睡眠报告" : "专注学习"}审核】\n识别数据：${JSON.stringify(fields)}\n规则审核结论：${verdict}\n请基于这些文字数据简短回应，不要改变审核结论，也不要推测未识别的信息。`,
        origin: "custom_app",
      });
      const context = loadChatMessages(session.id, 16)
        .filter(message => message.role === "user" || message.role === "assistant")
        .map(message => ({ role: message.role as "user" | "assistant", content: message.content }));
      const response = await simpleLLMCall(config, [
        { role: "system", content: `你正在以角色身份给用户反馈学习凭证审核。角色名：${supervisor.name}。角色人设：${supervisor.persona || supervisor.personality || "自然、简洁"}。请尊重系统给出的规则审核结论，不得改判；只针对已提供的识别文字数据简短回应，不要假装看过原图，不要编造数据。保持角色语气，最多两句话。` },
        ...context,
      ], { temperature: 0.65, max_tokens: 120 });
      if (response.error || !response.content?.trim()) return "";
      pushChatMessage({ sessionId: session.id, role: "assistant", content: response.content.trim(), origin: "custom_app" });
      return response.content.trim();
    } catch { return ""; }
  };

  const recordSleepAttempt = (candidate: NonNullable<StrictDay["sleep"]>) => {
    if (store.days[today]?.sleep?.status !== "approved") updateDay({ sleep: candidate });
  };

  const recordFocusAttempt = (candidate: NonNullable<StrictDay["focus"]>) => {
    if (store.days[today]?.focus?.status !== "approved") updateDay({ focus: candidate });
  };

  const submitEvidence = async (kind: "sleep" | "focus", file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setNotice("请上传图片凭证。"); return; }
    if (file.size > 8 * 1024 * 1024) { setNotice("截图不能超过 8 MB。"); return; }
    setBusy(kind); setNotice("");
    try {
      const imageDataUrl = await readImage(file);
      const response = await fetch("/api/vision-recognition", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, imageDataUrl }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "识别失败");
      const result = data.result as VisionResult;
      if (kind === "focus") {
        if (result.deviceVisible !== true || result.phoneLockVisible !== true || !isDateKey(result.phoneLockDate) || clockMinutes(result.phoneLockTime) === null) {
          recordFocusAttempt({ status: "needs-reupload", result });
          setNotice("没有同时确认手环累计时长和手机锁屏日期时间，请重新拍摄同框凭证。");
          return;
        }
        const oldMinutes = store.days[today]?.focus?.minutes || 0;
        if (String(result.phoneLockDate) !== today) {
          recordFocusAttempt({ status: "date-mismatch", minutes: oldMinutes, result });
          setNotice(`锁屏日期识别为 ${String(result.phoneLockDate)}，与今天（${today}）不一致。请核对设备日期后再提交。`);
          return;
        }
        const newMinutes = result.focusDurationMinutes;
        if (typeof newMinutes !== "number" || !Number.isInteger(newMinutes) || newMinutes < 0 || newMinutes > 1440) {
          recordFocusAttempt({ status: "needs-reupload", result });
          setNotice("未能识别今日累计专注时长，请上传更清晰的截图。");
          return;
        }
        if (oldMinutes > 0 && newMinutes < oldMinutes) {
          updateDay({ focus: { ...store.days[today]?.focus, status: "approved", minutes: oldMinutes, pendingMinutes: newMinutes, pendingResult: result } });
          setNotice(`新截图识别为 ${formatMinutes(newMinutes)}，低于已审核的 ${formatMinutes(oldMinutes)}。请核对后再提交，系统暂不覆盖旧记录。`);
          return;
        }
        const feedback = await askCharToReviewEvidence("focus", result, newMinutes >= 480 ? "审核通过，今日累计专注达到 8 小时目标。" : "凭证有效，但今日累计专注尚未达到 8 小时目标。");
        updateDay({ focus: { status: "approved", minutes: newMinutes, result, feedback } });
        setNotice(`已审核：今日累计专注 ${formatMinutes(newMinutes)}。记录已更新，不会重复累加。`);
      } else {
        const sleepMinutes = result.sleepDurationMinutes;
        if (clockMinutes(result.sleepStart) === null || clockMinutes(result.wakeTime) === null || typeof sleepMinutes !== "number" || !Number.isInteger(sleepMinutes) || sleepMinutes <= 0 || sleepMinutes > 1440) {
          recordSleepAttempt({ status: "needs-reupload", result });
          setNotice("睡眠时间信息不完整，请重新上传完整睡眠报告。");
          return;
        }
        const sleepDate = result.recordDate;
        if (!isDateKey(sleepDate) || sleepDate !== today) {
          recordSleepAttempt({ status: "date-mismatch", result });
          setNotice(sleepDate ? `报告日期为 ${sleepDate}，与今天 ${today} 不一致，暂不通过审核。` : "未能识别报告对应的起床日期，请上传包含日期的完整睡眠报告。");
          return;
        }
        const bedtime = clockMinutes(result.sleepStart);
        const wake = clockMinutes(result.wakeTime);
        const deadline = clockMinutes(store.sleepRules.bedtimeDeadline);
        const wakeFrom = clockMinutes(store.sleepRules.wakeFrom);
        const wakeUntil = clockMinutes(store.sleepRules.wakeUntil);
        const minSleepHours = store.sleepRules.minSleepHours ? Number(store.sleepRules.minSleepHours) : null;
        if ([deadline, wakeFrom, wakeUntil].some(value => value === null)) {
          recordSleepAttempt({ status: "recognized", result });
          setNotice("睡眠数据已识别。请先在系统设置中填写入睡截止时间和起床时间范围，再进行达标审核。");
          return;
        }
        const bedtimeOk = bedtime !== null && beforeBedtimeDeadline(bedtime, deadline as number);
        const wakeOk = wake !== null && ((wakeFrom as number) <= (wakeUntil as number) ? wake >= (wakeFrom as number) && wake <= (wakeUntil as number) : wake >= (wakeFrom as number) || wake <= (wakeUntil as number));
        const durationOk = minSleepHours === null || (Number.isFinite(minSleepHours) && minSleepHours >= 1 && minSleepHours <= 24 && sleepMinutes >= minSleepHours * 60);
        if (bedtimeOk && wakeOk && durationOk) {
          const feedback = await askCharToReviewEvidence("sleep", result, "审核通过，睡眠时间符合已配置规则。");
          updateDay({ sleep: { status: "approved", result, feedback } });
          setNotice(`睡眠审核通过：入睡 ${String(result.sleepStart)}，起床 ${String(result.wakeTime)}。`);
        } else {
          const feedback = await askCharToReviewEvidence("sleep", result, "未达标，识别数据未满足已配置的睡眠规则。");
          recordSleepAttempt({ status: "not-met", result, feedback });
          setNotice(`睡眠记录已识别，但未达到设定时间：入睡需不晚于 ${store.sleepRules.bedtimeDeadline}，起床需在 ${store.sleepRules.wakeFrom}–${store.sleepRules.wakeUntil}${store.sleepRules.minSleepHours ? `，睡眠不少于 ${store.sleepRules.minSleepHours} 小时` : ""}。`);
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "凭证审核失败");
    } finally { setBusy(null); }
  };

  const generateDailyNote = async () => {
    if (!supervisor) { setNotice("请先选择监督 Char。"); return; }
    if (day.charNote?.date === today && day.charNote.characterId === supervisor.id) {
      setNotice("今天的留言已经生成，每天更新一次。");
      return;
    }
    const apiConfigs = loadApiConfigs();
    const binding = resolveBinding(loadBindingConfig(), supervisor.id, "chat");
    const config = apiConfigs.find(item => item.id === binding.apiConfigId);
    if (!config) { setNotice("当前 Char 没有可用的文本模型配置，请先检查配置绑定。"); return; }
    setBusy("note"); setNotice("");
    try {
      await hydrateChatStorage();
      const session = createOrGetSession(supervisor.id);
      const context = loadChatMessages(session.id, 20)
        .filter(message => message.role === "user" || message.role === "assistant")
        .map(message => ({ role: message.role as "user" | "assistant", content: message.content }));
      const result = await simpleLLMCall(config, [
        { role: "system", content: `你正在以角色身份给用户写一条每日学习留言。保持角色性格和说话方式。角色名：${supervisor.name}。角色人设：${supervisor.persona || supervisor.personality || "保持自然、简洁"}。结合此前聊天上下文，写一两句话，像熟悉的角色对用户说话，不要像老师训话，不要使用标题或列表。` },
        ...context,
        { role: "user", content: `今天是 ${today}。请写一条今天专属的学习督促或鼓励留言，不要复用泛泛的口号。` },
      ], { temperature: 0.85, max_tokens: 120 });
      if (result.error || !result.content?.trim()) throw new Error(result.error || "模型没有返回留言");
      pushChatMessage({ sessionId: session.id, role: "assistant", content: result.content.trim(), origin: "custom_app" });
      updateDay({ charNote: { date: today, characterId: supervisor.id, text: result.content.trim() } });
    } catch (error) { setNotice(error instanceof Error ? error.message : "生成留言失败"); }
    finally { setBusy(null); }
  };

  useEffect(() => {
    const attemptKey = supervisor ? `${today}:${supervisor.id}` : "";
    if (!open || !attemptKey || busy !== null || day.charNote?.date === today && day.charNote.characterId === supervisor?.id || noteAttemptedRef.current === attemptKey) return;
    noteAttemptedRef.current = attemptKey;
    void generateDailyNote();
  }, [open, supervisor?.id, busy, day.charNote?.date, day.charNote?.characterId, today]);

  const saveRecall = async () => {
    if (!recallText.trim()) { setNotice("请填写“今天学了什么？”。"); return; }
    const recall = { text: recallText.trim(), notes: recallNotes.trim(), completedAt: Date.now() };
    updateDay({ recall });
    if (!supervisor) { setNotice("回忆已保存。选择监督 Char 后，可获得角色反馈。"); return; }
    const apiConfigs = loadApiConfigs();
    const binding = resolveBinding(loadBindingConfig(), supervisor.id, "chat");
    const config = apiConfigs.find(item => item.id === binding.apiConfigId);
    if (!config) { setNotice("回忆已保存，但当前 Char 没有可用的文本模型配置。"); return; }
    setBusy("note"); setNotice("回忆已保存，正在联系监督 Char…");
    try {
      await hydrateChatStorage();
      const session = createOrGetSession(supervisor.id);
      pushChatMessage({
        sessionId: session.id,
        role: "user",
        content: `【学习中心·晚间主动回忆】\n今天学了什么：${recall.text}\n补充记录：${recall.notes || "无"}`,
        origin: "custom_app",
      });
      const context = loadChatMessages(session.id, 20)
        .filter(message => message.role === "user" || message.role === "assistant")
        .map(message => ({ role: message.role as "user" | "assistant", content: message.content }));
      const result = await simpleLLMCall(config, [
        { role: "system", content: `你正在以角色身份回应用户的晚间学习回忆。角色名：${supervisor.name}。角色人设：${supervisor.persona || supervisor.personality || "自然、简洁"}。这是角色与用户原有的聊天会话，请结合此前对话保持连续性。保持角色语气，像陪伴者一样回应。不要判卷、不要纠正学科知识、不要给标准答案。只简短回应用户今天学了什么，指出一个值得肯定的努力或一个可继续留意的地方，最多三句话。` },
        ...context,
      ], { temperature: 0.75, max_tokens: 180 });
      if (result.error || !result.content?.trim()) throw new Error(result.error || "模型没有返回反馈");
      pushChatMessage({
        sessionId: session.id,
        role: "assistant",
        content: result.content.trim(),
        origin: "custom_app",
      });
      updateDay({ recall: { ...recall, feedback: result.content.trim() } });
      setNotice("回忆已保存，Char 已在原聊天记录中回复。");
    } catch (error) { setNotice(error instanceof Error ? `回忆已保存，但 Char 暂时无法回复：${error.message}` : "回忆已保存，但 Char 暂时无法回复。"); }
    finally { setBusy(null); }
  };

  if (!loaded || loadedAccountId !== account.id) return null;
  return (
    <>
      {store.enabled ? <button
        type="button"
        aria-label="打开学习中心"
        onClick={() => setOpen(true)}
        style={{ position: "fixed", right: 16, bottom: "calc(28px + env(safe-area-inset-bottom))", zIndex: 1200, width: 58, height: 58, borderRadius: 999, border: "2px solid rgba(255,255,255,.92)", background: "#b8dce9", color: "#315766", boxShadow: "0 4px 16px rgba(49,87,102,.22)", display: "grid", placeItems: "center" }}
      ><BookOpen size={27} /></button> : null}
      {open ? (
        <div className="strict-learning-overlay" role="dialog" aria-modal="true" aria-label="学习中心">
          <div className="strict-learning-page">
            <button type="button" onClick={() => setOpen(false)} className="strict-close-float" aria-label="关闭学习中心"><X size={19} /></button>

            <section className="strict-profile">
              <div className="strict-crt">
                <div className="strict-crt-screen" style={store.profile.banner ? { backgroundImage: `url(${store.profile.banner})` } : undefined}>
                  <div className="strict-crt-status"><span>9:41</span><span>▮▮▮　◉　▰</span></div>
                  <div className="strict-crt-quote">今天也向前走了一点。</div>
                  <div className="strict-crt-bottom"><span>↳<br />{today}</span><span className="strict-crt-face">૮ ˶ᵔ ᵕ ᵔ˶ ა</span></div>
                </div>
                <div className="strict-crt-brand">TINY TYPE</div>
                <div className="strict-crt-decoration">★　✿　🌈</div>
              </div>
              <div className="strict-profile-row">
                <div className="strict-avatar-wrap">{store.profile.avatar ? <img src={store.profile.avatar} alt="用户头像" /> : <span>小玉</span>}</div>
                <div className="strict-profile-copy">
                  <div className="text-2xl font-bold">{store.profile.nickname || "用户"}</div>
                  <div className="text-sm text-slate-600">{store.profile.lineOne}</div>
                  <div className="text-xs text-slate-500 mt-1">{store.profile.lineTwo}</div>
                </div>
                <div className="strict-streak-mini" aria-label={`连续打卡 ${currentStreak} 天，${store.streak.boatUnlocked ? "已获得轮船" : `轮船进度 ${Math.min(currentStreak, 30)} / 30 天`}`}>
                  <div className="strict-streak-item"><span className="strict-streak-icon" aria-hidden="true">🔥</span><span>{currentStreak}天</span></div>
                  <div className={`strict-streak-item ${store.streak.boatUnlocked ? "is-unlocked" : "is-locked"}`}><span className="strict-streak-icon" aria-hidden="true">🚢</span><span>{store.streak.boatUnlocked ? "已获得" : `${Math.min(currentStreak, 30)}/30`}</span></div>
                </div>
                <button type="button" className="strict-edit-button" onClick={() => { setProfileDraft(store.profile); setEditingProfile(true); }} aria-label="编辑资料"><Pencil size={17} /></button>
              </div>
            </section>

            <section className="strict-progress-card">
              <div className="flex items-center justify-between"><strong>今日进度</strong><span className="font-semibold">{Math.round(completed / 3 * 100)}%</span></div>
              <div className="mt-1 text-sm text-slate-600">{completed} / 3 项</div>
              <div className="strict-progress-track"><div className="strict-progress-fill" style={{ width: `${completed / 3 * 100}%` }} /></div>
            </section>

            <section className="strict-message-card">
              <div className="flex items-center gap-2"><Sparkles size={20} /><strong>留言板</strong><span className="ml-auto text-xs text-slate-500">每日更新</span></div>
              <div className="mt-3 text-sm leading-7">{day.charNote?.date === today ? day.charNote.text : "今天的留言还没有写好。"}</div>
              <div className="mt-3 flex items-center gap-2">
                <select value={store.supervisorId} onChange={event => setStore(previous => ({ ...previous, supervisorId: event.target.value }))} className="strict-select">
                  <option value="">选择监督 Char</option>
                  {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                </select>
                <button type="button" onClick={() => void generateDailyNote()} disabled={busy !== null} className="strict-small-button">{busy === "note" ? "生成中…" : "生成今日留言"}</button>
              </div>
            </section>

            <section className="strict-task-card">
              <div className="flex items-start gap-3"><Moon className="strict-task-icon" size={34} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between"><strong>睡眠报告</strong><span className="strict-status">{day.sleep?.status === "approved" ? "已审核" : day.sleep?.status === "recognized" ? "待规则审核" : day.sleep?.status === "not-met" ? "未达标" : day.sleep?.status === "date-mismatch" ? "日期不符" : day.sleep?.status === "needs-reupload" ? "请重新上传" : "待提交"}</span></div><p className="text-xs text-slate-500 mt-1">上传手环睡眠截图，识别昨晚信息。</p></div></div>
              {day.sleep?.result ? <div className="strict-result">入睡 {String(day.sleep.result.sleepStart || "—")} · 起床 {String(day.sleep.result.wakeTime || "—")} · 睡眠 {formatMinutes(day.sleep.result.sleepDurationMinutes)}</div> : null}
              {day.sleep?.feedback ? <div className="strict-result"><strong>Char：</strong>{day.sleep.feedback}</div> : null}
              <label className="strict-upload-button"><Upload size={18} />{busy === "sleep" ? "正在识别…" : "上传睡眠报告"}<input type="file" accept="image/*" disabled={busy !== null} onChange={event => { void submitEvidence("sleep", event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            </section>

            <section className="strict-task-card">
              <div className="flex items-start gap-3"><Timer className="strict-task-icon" size={36} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between"><strong>专注学习</strong><span className="strict-status">{day.focus?.pendingResult ? "已审核 · 新记录待核对" : day.focus?.status === "approved" ? "已审核" : day.focus?.status === "date-mismatch" ? "日期不符" : day.focus?.status === "needs-reupload" ? "请重新上传" : "待审核"}</span></div><p className="text-xs text-slate-500 mt-1">手环番茄钟 + 手机锁屏同框。</p></div></div>
              <div className="mt-3 text-sm font-medium">{formatMinutes(focusMinutes)} / 08:00</div>
              <div className="strict-progress-track"><div className="strict-progress-fill" style={{ width: `${Math.min(100, focusMinutes / 480 * 100)}%` }} /></div>
              {day.focus?.result ? <div className="strict-result">识别到今日累计专注 {formatMinutes(day.focus.result.focusDurationMinutes)} · 锁屏 {String(day.focus.result.phoneLockDate || "—")} {String(day.focus.result.phoneLockTime || "")}</div> : null}
              {day.focus?.feedback ? <div className="strict-result"><strong>Char：</strong>{day.focus.feedback}</div> : null}
              {day.focus?.pendingResult ? <div className="strict-result">新截图识别为 {formatMinutes(day.focus.pendingMinutes)}，低于当前已审核记录。原记录暂时保留。</div> : null}
              {day.focus?.pendingResult ? <button type="button" className="strict-upload-button" onClick={() => { const minutes = Number(day.focus?.pendingMinutes); const result = day.focus?.pendingResult; if (Number.isFinite(minutes) && minutes >= 0 && result) { updateDay({ focus: { status: "approved", minutes, result } }); setNotice(`已确认并更新为 ${formatMinutes(minutes)}，采用覆盖而非累加。`); } }}>确认并以新截图覆盖记录</button> : null}
              <label className="strict-upload-button"><Camera size={18} />{busy === "focus" ? "正在识别…" : "拍摄学习凭证"}<input type="file" accept="image/*" capture="environment" disabled={busy !== null} onChange={event => { void submitEvidence("focus", event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            </section>

            <section className="strict-task-card">
              <div className="flex items-center gap-3"><ClipboardList className="strict-task-icon" size={34} /><div className="flex-1"><strong>晚间主动回忆</strong><div className="text-xs text-slate-500 mt-1">不看笔记，回忆今天学到的内容。</div></div><span className="strict-status">{day.recall?.completedAt ? "已完成" : "未完成"}</span></div>
              <textarea value={recallText} onChange={event => setRecallText(event.target.value)} placeholder="今天学了什么？" className="strict-recall-input" rows={3} />
              <textarea value={recallNotes} onChange={event => setRecallNotes(event.target.value)} placeholder="可选：补充笔记、易错点或资料说明" className="strict-recall-input mt-2" rows={2} />
              {day.recall?.feedback ? <div className="strict-result"><strong>Char：</strong>{day.recall.feedback}</div> : null}
              <button type="button" onClick={() => void saveRecall()} disabled={busy !== null} className="strict-upload-button"><Check size={18} />{busy === "note" ? "Char 正在回复…" : "保存今日回忆"}</button>
            </section>

            <section className="strict-audit-card"><Sparkles size={20} /><div><strong>Char 审核状态</strong><p className="text-xs text-slate-600 mt-1">提交凭证后，识别结果和简短反馈会显示在对应任务卡片中。</p></div></section>
            {notice ? <div className="strict-notice" role="status">{notice}</div> : null}
          </div>
          {editingProfile ? (
            <div className="strict-edit-backdrop" onClick={() => setEditingProfile(false)}>
              <div className="strict-edit-sheet" onClick={event => event.stopPropagation()}>
                <div className="flex items-center justify-between"><strong>编辑个人资料</strong><button type="button" onClick={() => setEditingProfile(false)}><X size={20} /></button></div>
                <label className="strict-edit-label">昵称<input value={profileDraft.nickname} onChange={event => updateProfile("nickname", event.target.value)} /></label>
                <label className="strict-edit-label">第一行文字<input value={profileDraft.lineOne} onChange={event => updateProfile("lineOne", event.target.value)} /></label>
                <label className="strict-edit-label">第二行文字<input value={profileDraft.lineTwo} onChange={event => updateProfile("lineTwo", event.target.value)} /></label>
                <label className="strict-upload-button">上传头像<input type="file" accept="image/*" onChange={event => { void uploadImage("avatar", event.target.files?.[0]); }} /></label>
                <label className="strict-upload-button">上传顶部横幅<input type="file" accept="image/*" onChange={event => { void uploadImage("banner", event.target.files?.[0]); }} /></label>
                <button type="button" className="strict-save-button" onClick={() => { setStore(previous => ({ ...previous, profile: profileDraft })); setEditingProfile(false); }}>保存资料</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
