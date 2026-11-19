"use client";

import { useContext, useEffect, useState } from "react";
import { SettingsContext } from "@/components/phone-settings-app";
import { kvGet, kvSet } from "@/lib/kv-db";
import { useAccount } from "@/lib/account-context";
import { getStrictLearningStoreKey, migrateLegacyStrictLearningStore } from "@/lib/strict-learning-storage";
import { normalizeStrictLearningStore } from "@/lib/strict-learning-schema";
import { getStrictLearningSyncKey, saveStrictLearningSyncKey } from "@/lib/strict-learning-sync-client";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

type Store = { enabled?: boolean; supervisorId?: string; profile?: Record<string, unknown>; days?: Record<string, unknown>; sleepRules?: { bedtimeDeadline?: string; wakeFrom?: string; wakeUntil?: string; minSleepHours?: string } };

export function StrictLearningSettings() {
  const { setSubpageTitle } = useContext(SettingsContext);
  const { account } = useAccount();
  const storeKey = getStrictLearningStoreKey(account.id);
  const [enabled, setEnabled] = useState(false);
  const [supervisorId, setSupervisorId] = useState("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [bedtimeDeadline, setBedtimeDeadline] = useState("");
  const [wakeFrom, setWakeFrom] = useState("");
  const [wakeUntil, setWakeUntil] = useState("");
  const [minSleepHours, setMinSleepHours] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadedAccountId, setLoadedAccountId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [syncKeyDraft, setSyncKeyDraft] = useState("");
  const [syncKeySaved, setSyncKeySaved] = useState(false);
  const [syncKeyTestStatus, setSyncKeyTestStatus] = useState("");
  const [syncKeyTesting, setSyncKeyTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadedAccountId("");
    setLoadError("");
    setEnabled(false);
    setSupervisorId("");
    setBedtimeDeadline("");
    setWakeFrom("");
    setWakeUntil("");
    setMinSleepHours("");
    setSyncKeyDraft(getStrictLearningSyncKey());
    setSyncKeySaved(Boolean(getStrictLearningSyncKey()));
    setSyncKeyTestStatus("");
    setSyncKeyTesting(false);
    setSubpageTitle("严格学习模式");

    void (async () => {
      const activeStoreKey = await migrateLegacyStrictLearningStore(account.id);
      if (cancelled) return;
      const raw = kvGet(activeStoreKey);
      if (raw) {
        const store = normalizeStrictLearningStore(JSON.parse(raw));
        setEnabled(store.enabled === true);
        setSupervisorId(typeof store.supervisorId === "string" ? store.supervisorId : "");
        setBedtimeDeadline(store.sleepRules?.bedtimeDeadline || "");
        setWakeFrom(store.sleepRules?.wakeFrom || "");
        setWakeUntil(store.sleepRules?.wakeUntil || "");
        setMinSleepHours(store.sleepRules?.minSleepHours || "");
      }
      setCharacters(loadCharacters());
      setLoadedAccountId(account.id);
      setLoaded(true);
    })().catch(error => {
      if (!cancelled) {
        setLoaded(false);
        setLoadError(error instanceof Error
          ? `学习记录无法安全读取（${error.message}）。原记录已保留，没有用空白数据覆盖。`
          : "学习记录加载失败。原记录已保留，没有用空白数据覆盖。");
      }
      // Keep the page hidden on migration or validation failure rather than
      // risk writing defaults over the original record.
    });

    return () => {
      cancelled = true;
      setSubpageTitle(null);
    };
  }, [account.id, setSubpageTitle]);

  const persist = (updates: Partial<Store>) => {
    const raw = kvGet(storeKey);
    let current: Store = {};
    if (raw) {
      try {
        current = normalizeStrictLearningStore(JSON.parse(raw));
      } catch (error) {
        setLoaded(false);
        setLoadError(error instanceof Error
          ? `学习记录无法安全读取（${error.message}）。已停止保存，原记录仍保留。`
          : "学习记录无法安全读取。已停止保存，原记录仍保留。");
        return;
      }
    }
    const next: Store = { ...current, enabled, supervisorId, ...updates };
    if (updates.sleepRules) {
      next.sleepRules = { ...(current.sleepRules || {}), ...updates.sleepRules };
    }
    kvSet(storeKey, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("strict-learning-updated"));
  };

  if (!loaded || loadedAccountId !== account.id) {
    return loadError ? <div role="alert" className="px-4 py-3 text-sm text-red-700">{loadError}</div> : null;
  }
  return (
    <div className="flex flex-col gap-4 px-1 pb-8">
      <section className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4">
        <div className="flex items-center justify-between gap-4">
          <div><div className="text-sm font-semibold text-[var(--c-text-title)]">严格学习模式</div><p className="mt-1 text-xs leading-5 text-[var(--c-text-secondary)]">开启后，桌面会出现学习中心悬浮入口。</p></div>
          <button type="button" role="switch" aria-checked={enabled} onClick={() => { const next = !enabled; setEnabled(next); persist({ enabled: next }); }} className={`relative h-7 w-12 rounded-full transition-colors ${enabled ? "bg-sky-500" : "bg-gray-300"}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} /></button>
        </div>
      </section>
      {account.id === "local_user" ? (
        <section className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4">
          <div className="text-sm font-semibold text-[var(--c-text-title)]">严格模式云同步</div>
          <p className="mt-1 text-xs leading-5 text-[var(--c-text-secondary)]">在每台设备输入同一共享密钥一次，即可同步学习记录。密钥只保存在当前设备，不会上传到学习记录中。</p>
          <label className="mt-3 flex flex-col gap-2 text-sm">
            <span className="font-medium">云同步共享密钥</span>
            <input
              type="password"
              autoComplete="off"
              value={syncKeyDraft}
              onChange={event => { setSyncKeyDraft(event.target.value); setSyncKeySaved(false); }}
              placeholder="粘贴服务端配置的共享密钥"
              className="ui-input w-full"
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="ui-button" disabled={syncKeyDraft.trim().length < 32} onClick={() => {
              saveStrictLearningSyncKey(syncKeyDraft);
              setSyncKeyDraft(syncKeyDraft.trim());
              setSyncKeySaved(true);
              setSyncKeyTestStatus("密钥已保存在本机，可以测试连接");
            }}>保存密钥</button>
            <button type="button" className="ui-button" disabled={syncKeyTesting || syncKeyDraft.trim().length < 32} onClick={async () => {
              setSyncKeyTesting(true);
              setSyncKeyTestStatus("正在验证……");
              try {
                const response = await fetch("/api/strict-learning-sync", {
                  headers: { Authorization: `Bearer ${syncKeyDraft.trim()}` },
                  cache: "no-store",
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || "连接失败");
                setSyncKeyTestStatus(`连接成功，云端版本：${Number(data.revision || 0)}`);
              } catch (error) {
                setSyncKeyTestStatus(error instanceof Error ? `连接失败：${error.message}` : "连接失败");
              } finally {
                setSyncKeyTesting(false);
              }
            }}>{syncKeyTesting ? "测试中…" : "测试连接"}</button>
            <button type="button" className="ui-button" onClick={() => {
              saveStrictLearningSyncKey("");
              setSyncKeyDraft("");
              setSyncKeySaved(false);
              setSyncKeyTestStatus("已清除本机密钥");
            }}>清除</button>
          </div>
          <p className="mt-2 text-xs text-[var(--c-text-secondary)]">{syncKeySaved ? "已保存在本机" : syncKeyDraft.trim().length > 0 && syncKeyDraft.trim().length < 32 ? "密钥至少需要 32 个字符" : "尚未保存"}</p>
          {syncKeyTestStatus ? <p role="status" className="mt-2 text-xs leading-5 text-[var(--c-text-secondary)]">{syncKeyTestStatus}</p> : null}
          <p className="mt-3 text-xs leading-5 text-[var(--c-text-secondary)]">服务端还需配置环境变量 STRICT_LEARNING_SYNC_SECRET，且其值必须与这里填写的密钥完全一致。测试连接只读取云端版本，不会写入或覆盖学习记录。保存后重新打开学习中心以开始同步。</p>
        </section>
      ) : null}
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
          <label className="flex items-center justify-between gap-3 text-sm"><span>最低睡眠时长（可选）</span><input type="number" min="1" max="24" step="0.5" value={minSleepHours} onChange={event => { const value = event.target.value; setMinSleepHours(value); const hours = Number(value); if (value === "" || (Number.isFinite(hours) && hours >= 1 && hours <= 24 && Number.isInteger(hours * 2))) persist({ sleepRules: { bedtimeDeadline, wakeFrom, wakeUntil, minSleepHours: value } }); }} placeholder="不限制" className="ui-input w-32" /></label>
        </div>
        <p className="mt-2 text-xs text-[var(--c-text-secondary)]">审核通过条件：入睡不晚于截止时间，起床处于允许范围内；最低睡眠时长为可选条件。</p>
      </section>
      <div className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4 text-xs leading-6 text-[var(--c-text-secondary)]">
        每日任务：睡眠报告、累计专注 8 小时、晚间主动回忆。专注截图读取手环显示的今日累计时长，新数值审核通过后覆盖旧记录，不做重复累加。
      </div>
    </div>
  );
}
