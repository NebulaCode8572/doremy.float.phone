"use client";

import { useContext, useEffect, useState } from "react";
import { SettingsContext } from "@/components/phone-settings-app";
import { kvGet, kvSet } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

const STORE_KEY = "strict_learning_center_v1";
type Store = { enabled?: boolean; supervisorId?: string; profile?: Record<string, unknown>; days?: Record<string, unknown>; sleepRules?: { bedtimeDeadline?: string; wakeFrom?: string; wakeUntil?: string; minSleepHours?: string } };

export function StrictLearningSettings() {
  const { setSubpageTitle } = useContext(SettingsContext);
  const [enabled, setEnabled] = useState(false);
  const [supervisorId, setSupervisorId] = useState("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [bedtimeDeadline, setBedtimeDeadline] = useState("");
  const [wakeFrom, setWakeFrom] = useState("");
  const [wakeUntil, setWakeUntil] = useState("");
  const [minSleepHours, setMinSleepHours] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSubpageTitle("严格学习模式");
    const raw = kvGet(STORE_KEY);
    if (raw) {
      try {
        const store = JSON.parse(raw) as Store;
        setEnabled(store.enabled === true);
        setSupervisorId(typeof store.supervisorId === "string" ? store.supervisorId : "");
        setBedtimeDeadline(store.sleepRules?.bedtimeDeadline || "");
        setWakeFrom(store.sleepRules?.wakeFrom || "");
        setWakeUntil(store.sleepRules?.wakeUntil || "");
        setMinSleepHours(store.sleepRules?.minSleepHours || "");
      } catch { /* defaults */ }
    }
    setCharacters(loadCharacters());
    setLoaded(true);
    return () => setSubpageTitle(null);
  }, [setSubpageTitle]);

  const persist = (updates: Partial<Store>) => {
    const raw = kvGet(STORE_KEY);
    let current: Store = {};
    if (raw) { try { current = JSON.parse(raw) as Store; } catch { current = {}; } }
    const next: Store = { ...current, enabled, supervisorId, ...updates };
    if (updates.sleepRules) {
      next.sleepRules = { ...(current.sleepRules || {}), ...updates.sleepRules };
    }
    kvSet(STORE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("strict-learning-updated"));
  };

  if (!loaded) return null;
  return (
    <div className="flex flex-col gap-4 px-1 pb-8">
      <section className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4">
        <div className="flex items-center justify-between gap-4">
          <div><div className="text-sm font-semibold text-[var(--c-text-title)]">严格学习模式</div><p className="mt-1 text-xs leading-5 text-[var(--c-text-secondary)]">开启后，桌面会出现学习中心悬浮入口。</p></div>
          <button type="button" role="switch" aria-checked={enabled} onClick={() => { const next = !enabled; setEnabled(next); persist({ enabled: next }); }} className={`relative h-7 w-12 rounded-full transition-colors ${enabled ? "bg-sky-500" : "bg-gray-300"}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} /></button>
        </div>
      </section>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">监督 Char</span>
        <select value={supervisorId} onChange={event => { setSupervisorId(event.target.value); persist({ supervisorId: event.target.value }); }} className="ui-select">
          <option value="">请选择现有角色</option>
          {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select>
        <span className="text-xs leading-5 text-[var(--c-text-secondary)]">更换监督者只影响之后提交的凭证；此前审核记录不会迁移或删除。</span>
      </label>
      <section className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4">
        <div className="text-sm font-semibold text-[var(--c-text-title)]">睡眠达标规则</div>
        <p className="mt-1 text-xs leading-5 text-[var(--c-text-secondary)]">设置你的入睡截止时间和起床允许范围。留空时只识别数据，不判定达标。</p>
        <div className="mt-3 grid grid-cols-1 gap-3">
          <label className="flex items-center justify-between gap-3 text-sm"><span>入睡截止时间</span><input type="time" value={bedtimeDeadline} onChange={event => { setBedtimeDeadline(event.target.value); persist({ sleepRules: { bedtimeDeadline: event.target.value, wakeFrom, wakeUntil } }); }} className="ui-input w-32" /></label>
          <label className="flex items-center justify-between gap-3 text-sm"><span>最早起床时间</span><input type="time" value={wakeFrom} onChange={event => { setWakeFrom(event.target.value); persist({ sleepRules: { bedtimeDeadline, wakeFrom: event.target.value, wakeUntil } }); }} className="ui-input w-32" /></label>
          <label className="flex items-center justify-between gap-3 text-sm"><span>最晚起床时间</span><input type="time" value={wakeUntil} onChange={event => { setWakeUntil(event.target.value); persist({ sleepRules: { bedtimeDeadline, wakeFrom, wakeUntil: event.target.value } }); }} className="ui-input w-32" /></label>
          <label className="flex items-center justify-between gap-3 text-sm"><span>最低睡眠时长（可选）</span><input type="number" min="1" max="24" step="0.5" value={minSleepHours} onChange={event => { setMinSleepHours(event.target.value); persist({ sleepRules: { bedtimeDeadline, wakeFrom, wakeUntil, minSleepHours: event.target.value } }); }} placeholder="不限制" className="ui-input w-32" /></label>
        </div>
        <p className="mt-2 text-xs text-[var(--c-text-secondary)]">审核通过条件：入睡不晚于截止时间，起床处于允许范围内；最低睡眠时长为可选条件。</p>
      </section>
      <div className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4 text-xs leading-6 text-[var(--c-text-secondary)]">
        每日任务：睡眠报告、累计专注 8 小时、晚间主动回忆。专注截图读取手环显示的今日累计时长，新数值审核通过后覆盖旧记录，不做重复累加。
      </div>
    </div>
  );
}
