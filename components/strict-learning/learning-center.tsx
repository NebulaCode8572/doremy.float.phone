"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Camera, Check, ClipboardList, Moon, Pencil, Sparkles, Timer, Upload, X } from "lucide-react";
import "./learning-center.css";
import { kvGet, kvSet } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";

type StrictProfile = { nickname: string; lineOne: string; lineTwo: string; avatar: string; banner: string };
type StrictDay = {
  date: string;
  sleep?: { status: string; result?: Record<string, unknown> };
  focus?: { status: string; minutes?: number; result?: Record<string, unknown> };
  recall?: { text: string; notes: string; completedAt: number };
  charNote?: { date: string; characterId: string; text: string };
};
type StrictStore = { enabled: boolean; supervisorId: string; profile: StrictProfile; days: Record<string, StrictDay> };
type VisionResult = Record<string, unknown>;

const STORE_KEY = "strict_learning_center_v1";
const DEFAULT_STORE: StrictStore = {
  enabled: false,
  supervisorId: "",
  profile: { nickname: "小玉", lineOne: "@白衣魔法使", lineTwo: "把今天过成值得骄傲的一天。", avatar: "", banner: "" },
  days: {},
};
const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
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
  const [open, setOpen] = useState(false);
  const [store, setStore] = useState<StrictStore>(DEFAULT_STORE);
  const [loaded, setLoaded] = useState(false);
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
  const completed = Number(day.sleep?.status === "approved") + Number((day.focus?.minutes || 0) >= 480) + Number(Boolean(day.recall?.completedAt));
  const focusMinutes = day.focus?.minutes || 0;

  useEffect(() => {
    const raw = kvGet(STORE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StrictStore>;
        setStore({
          ...DEFAULT_STORE,
          ...parsed,
          profile: { ...DEFAULT_STORE.profile, ...(parsed.profile || {}) },
          days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
        });
      } catch { /* retain defaults */ }
    }
    setCharacters(loadCharacters());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) kvSet(STORE_KEY, JSON.stringify(store));
  }, [loaded, store]);

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
        if (result.deviceVisible !== true || result.phoneLockVisible !== true || !result.phoneLockDate || !result.phoneLockTime) {
          updateDay({ focus: { status: "needs-reupload", result } });
          setNotice("没有同时确认手环累计时长和手机锁屏日期时间，请重新拍摄同框凭证。");
          return;
        }
        const oldMinutes = store.days[today]?.focus?.minutes || 0;
        if (String(result.phoneLockDate) !== today) {
          updateDay({ focus: { status: "date-mismatch", minutes: oldMinutes, result } });
          setNotice(`锁屏日期识别为 ${String(result.phoneLockDate)}，与今天（${today}）不一致。请核对设备日期后再提交。`);
          return;
        }
        const newMinutes = Number(result.focusDurationMinutes);
        if (!Number.isFinite(newMinutes) || newMinutes < 0) {
          updateDay({ focus: { status: "needs-reupload", result } });
          setNotice("未能识别今日累计专注时长，请上传更清晰的截图。");
          return;
        }
        if (oldMinutes > 0 && newMinutes < oldMinutes) {
          updateDay({ focus: { status: "needs-confirmation", minutes: oldMinutes, result } });
          setNotice(`新截图识别为 ${formatMinutes(newMinutes)}，低于已审核的 ${formatMinutes(oldMinutes)}。请核对后再提交，系统暂不覆盖旧记录。`);
          return;
        }
        updateDay({ focus: { status: "approved", minutes: newMinutes, result } });
        setNotice(`已审核：今日累计专注 ${formatMinutes(newMinutes)}。记录已更新，不会重复累加。`);
      } else {
        const sleepMinutes = Number(result.sleepDurationMinutes);
        if (!result.sleepStart || !result.wakeTime || !Number.isFinite(sleepMinutes)) {
          updateDay({ sleep: { status: "needs-reupload", result } });
          setNotice("睡眠时间信息不完整，请重新上传完整睡眠报告。");
          return;
        }
        updateDay({ sleep: { status: "recognized", result } });
        setNotice(`已识别睡眠报告：${formatMinutes(sleepMinutes)}。达标规则尚未配置，暂不计入完成项。`);
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
      const result = await simpleLLMCall(config, [
        { role: "system", content: `你正在以角色身份给用户写一条每日学习留言。保持角色性格和说话方式。角色名：${supervisor.name}。角色人设：${supervisor.persona || supervisor.personality || "保持自然、简洁"}。只写一两句话，像熟悉的角色对用户说话，不要像老师训话，不要使用标题或列表。` },
        { role: "user", content: `今天是 ${today}。请写一条今天专属的学习督促或鼓励留言，不要复用泛泛的口号。` },
      ], { temperature: 0.85, max_tokens: 120 });
      if (result.error || !result.content?.trim()) throw new Error(result.error || "模型没有返回留言");
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

  const saveRecall = () => {
    if (!recallText.trim()) { setNotice("请填写“今天学了什么？”。"); return; }
    updateDay({ recall: { text: recallText.trim(), notes: recallNotes.trim(), completedAt: Date.now() } });
    setNotice("晚间主动回忆已记录。");
  };

  if (!loaded) return null;
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
                <button type="button" className="strict-edit-button" onClick={() => { setProfileDraft(store.profile); setEditingProfile(true); }} aria-label="编辑资料"><Pencil size={17} /></button>
              </div>
            </section>

            <section className="strict-progress-card">
              <div className="flex items-center justify-between"><strong>今日进度</strong><span className="font-semibold">{Math.round(completed / 3 * 100)}%</span></div>
              <div className="mt-1 text-sm text-slate-600">{completed} / 3 项</div>
              <div className="strict-progress-track"><div className="strict-progress-fill" style={{ width: `${completed / 3 * 100}%` }} /></div>
            </section>

            <section className="strict-message-card">
              <div className="flex items-center gap-2"><Sparkles size={20} /><strong>Char 的留言</strong><span className="ml-auto text-xs text-slate-500">每日更新</span></div>
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
              <div className="flex items-start gap-3"><Moon className="strict-task-icon" size={34} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between"><strong>睡眠报告</strong><span className="strict-status">{day.sleep?.status === "approved" ? "已审核" : day.sleep?.status === "recognized" ? "待规则审核" : day.sleep?.status === "needs-reupload" ? "请重新上传" : "待提交"}</span></div><p className="text-xs text-slate-500 mt-1">上传手环睡眠截图，识别昨晚信息。</p></div></div>
              {day.sleep?.result ? <div className="strict-result">入睡 {String(day.sleep.result.sleepStart || "—")} · 起床 {String(day.sleep.result.wakeTime || "—")} · 睡眠 {formatMinutes(day.sleep.result.sleepDurationMinutes)}</div> : null}
              <label className="strict-upload-button"><Upload size={18} />{busy === "sleep" ? "正在识别…" : "上传睡眠报告"}<input type="file" accept="image/*" disabled={busy !== null} onChange={event => { void submitEvidence("sleep", event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            </section>

            <section className="strict-task-card">
              <div className="flex items-start gap-3"><Timer className="strict-task-icon" size={36} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between"><strong>专注学习</strong><span className="strict-status">{day.focus?.status === "approved" ? "已审核" : day.focus?.status === "needs-confirmation" ? "待核对" : day.focus?.status === "needs-reupload" ? "请重新上传" : "待审核"}</span></div><p className="text-xs text-slate-500 mt-1">手环番茄钟 + 手机锁屏同框。</p></div></div>
              <div className="mt-3 text-sm font-medium">{formatMinutes(focusMinutes)} / 08:00</div>
              <div className="strict-progress-track"><div className="strict-progress-fill" style={{ width: `${Math.min(100, focusMinutes / 480 * 100)}%` }} /></div>
              {day.focus?.result ? <div className="strict-result">识别到今日累计专注 {formatMinutes(day.focus.result.focusDurationMinutes)} · 锁屏 {String(day.focus.result.phoneLockDate || "—")} {String(day.focus.result.phoneLockTime || "")}</div> : null}
              {day.focus?.status === "needs-confirmation" && day.focus.result ? <button type="button" className="strict-upload-button" onClick={() => { const minutes = Number(day.focus?.result?.focusDurationMinutes); if (Number.isFinite(minutes) && minutes >= 0) { updateDay({ focus: { status: "approved", minutes, result: day.focus?.result } }); setNotice(`已确认并更新为 ${formatMinutes(minutes)}，采用覆盖而非累加。`); } }}>确认并以新截图覆盖记录</button> : null}
              <label className="strict-upload-button"><Camera size={18} />{busy === "focus" ? "正在识别…" : "拍摄学习凭证"}<input type="file" accept="image/*" capture="environment" disabled={busy !== null} onChange={event => { void submitEvidence("focus", event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            </section>

            <section className="strict-task-card">
              <div className="flex items-center gap-3"><ClipboardList className="strict-task-icon" size={34} /><div className="flex-1"><strong>晚间主动回忆</strong><div className="text-xs text-slate-500 mt-1">不看笔记，回忆今天学到的内容。</div></div><span className="strict-status">{day.recall?.completedAt ? "已完成" : "未完成"}</span></div>
              <textarea value={recallText} onChange={event => setRecallText(event.target.value)} placeholder="今天学了什么？" className="strict-recall-input" rows={3} />
              <textarea value={recallNotes} onChange={event => setRecallNotes(event.target.value)} placeholder="可选：补充笔记、易错点或资料说明" className="strict-recall-input mt-2" rows={2} />
              <button type="button" onClick={saveRecall} className="strict-upload-button"><Check size={18} />保存今日回忆</button>
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
