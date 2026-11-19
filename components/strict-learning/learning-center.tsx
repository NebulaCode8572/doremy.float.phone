"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Camera, Check, ClipboardList, Moon, Pencil, Sparkles, Timer, Upload, X } from "lucide-react";
import "./learning-center.css";
import { kvGet, kvSetAsync } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import { createOrGetSession, hydrateChatStorage, loadChatMessages, pushChatMessage } from "@/lib/chat-storage";
import { useAccount } from "@/lib/account-context";
import { getStrictLearningStoreKey, migrateLegacyStrictLearningStore } from "@/lib/strict-learning-storage";
import { getStrictLearningSyncKey } from "@/lib/strict-learning-sync-client";
import { DEFAULT_STRICT_STORE, normalizeStrictLearningStore, type StrictDay, type StrictProfile, type StrictStore } from "@/lib/strict-learning-schema";

type VisionResult = Record<string, unknown>;

const DEFAULT_STORE = DEFAULT_STRICT_STORE;
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
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function cropLauncherImage(file: File): Promise<string> {
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法读取这张图片"));
      image.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = Math.floor((image.naturalWidth - side) / 2);
    const sy = Math.floor((image.naturalHeight - side) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持图片处理");
    context.drawImage(image, sx, sy, side, side, 0, 0, 320, 320);
    const blob = await canvasToBlob(canvas, "image/webp", 0.86);
    if (blob.size > 240 * 1024) throw new Error("图片处理后仍然过大，请换一张图片");
    return blobToDataUrl(blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片压缩失败")), type, quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("压缩后的图片读取失败"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

async function readProfileImage(file: File): Promise<string> {
  const targetBytes = 320 * 1024;
  if (file.size <= targetBytes) return readImage(file);

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法读取这张图片"));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const maxDimension = 1280;
  let scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持图片压缩");

  for (let attempt = 0; attempt < 7; attempt += 1) {
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const quality = Math.max(0.42, 0.84 - attempt * 0.07);
    let blob = await canvasToBlob(canvas, "image/webp", quality);
    if (blob.type !== "image/webp") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await canvasToBlob(canvas, "image/jpeg", quality);
    }
    if (blob.size <= targetBytes) return blobToDataUrl(blob);
    scale *= 0.82;
  }

  throw new Error("图片压缩后仍然过大，请换一张尺寸较小的图片");
}

export function StrictLearningCenter() {
  const { account } = useAccount();
  const storeKey = useMemo(() => getStrictLearningStoreKey(account.id), [account.id]);
  const [open, setOpen] = useState(false);
  const [store, setStore] = useState<StrictStore>(DEFAULT_STORE);
  const [loaded, setLoaded] = useState(false);
  const [loadedAccountId, setLoadedAccountId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [recallText, setRecallText] = useState("");
  const [recallImages, setRecallImages] = useState<string[]>([]);
  const recallImageInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"sleep" | "focus" | "note" | null>(null);
  const [notice, setNotice] = useState("");
  const noteAttemptedRef = useRef("");
  const syncRevisionRef = useRef(0);
  const syncGenerationRef = useRef(0);
  const syncReadyRef = useRef(false);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastQueuedSnapshotRef = useRef("");
  const [syncStatus, setSyncStatus] = useState("仅保存在本机");
  const [persistenceError, setPersistenceError] = useState("正在保存…");
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceSnapshotRef = useRef("");
  const [syncKeyVersion, setSyncKeyVersion] = useState(0);
  const [syncConflict, setSyncConflict] = useState<{ payload: StrictStore; revision: number } | null>(null);
  const [profileDraft, setProfileDraft] = useState<StrictProfile>(DEFAULT_STORE.profile);
  const [launcherPosition, setLauncherPosition] = useState<{ left: number; top: number } | null>(null);
  const [launcherImage, setLauncherImage] = useState("");
  const [launcherPickerOpen, setLauncherPickerOpen] = useState(false);
  const launcherPointerRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null>(null);
  const launcherLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const launcherFileRef = useRef<HTMLInputElement>(null);

  const today = todayKey();
  const day = store.days[today] || { date: today };
  const supervisor = useMemo(() => characters.find(character => character.id === store.supervisorId) || null, [characters, store.supervisorId]);
  const completed = Number(day.sleep?.status === "approved") + Number(day.focus?.status === "approved" && (day.focus?.minutes || 0) >= 480) + Number(Boolean(day.recall?.completedAt));
  const streakGap = dayDistance(store.streak.lastCheckinDate, today);
  const currentStreak = streakGap >= 0 && streakGap <= 1 ? store.streak.count : 0;
  const focusMinutes = day.focus?.minutes || 0;

  useEffect(() => {
    try {
      const rawPosition = localStorage.getItem("strict_learning_launcher_position_v1");
      if (rawPosition) {
        const parsed = JSON.parse(rawPosition) as { left?: number; top?: number };
        if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          setLauncherPosition({ left: Number(parsed.left), top: Number(parsed.top) });
        }
      }
      setLauncherImage(localStorage.getItem("strict_learning_launcher_image_v1") || "");
    } catch {}
  }, []);

  useEffect(() => {
    const handleSyncKeyUpdated = () => setSyncKeyVersion(version => version + 1);
    window.addEventListener("strict-learning-sync-key-updated", handleSyncKeyUpdated);
    return () => window.removeEventListener("strict-learning-sync-key-updated", handleSyncKeyUpdated);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = ++syncGenerationRef.current;
    syncReadyRef.current = false;
    syncRevisionRef.current = 0;
    lastQueuedSnapshotRef.current = "";
    setSyncStatus("云端同步准备中");
    setSyncConflict(null);
    setLoaded(false);
    setLoadedAccountId("");
    setLoadError("");
    setOpen(false);
    setStore(DEFAULT_STORE);
    setRecallText("");

    void (async () => {
      const activeStoreKey = await migrateLegacyStrictLearningStore(account.id);
      if (cancelled) return;
      const raw = kvGet(activeStoreKey);
      let initialStore = DEFAULT_STORE;
      if (raw) {
        try {
          initialStore = normalizeStrictLearningStore(JSON.parse(raw));
        } catch (error) {
          throw new Error(error instanceof Error
            ? "本机学习记录无法安全读取（" + error.message + "）。原记录已保留，没有用空白数据覆盖。"
            : "本机学习记录无法安全读取。原记录已保留，没有用空白数据覆盖。");
        }
      }

      const syncKey = getStrictLearningSyncKey();
      if (account.id === "local_user" && syncKey) {
        try {
          const response = await fetch("/api/strict-learning-sync", {
            headers: { Authorization: `Bearer ${syncKey}` },
            cache: "no-store",
          });
          const remote = await response.json();
          if (cancelled || generation !== syncGenerationRef.current) return;
          if (!response.ok) throw new Error(remote.error || "云端读取失败");
          syncRevisionRef.current = Number(remote.revision || 0);
          // Compare the full normalized snapshot so future schema fields
          // cannot be silently dropped merely because this list was not updated.
          const localHasData = stableStringify(initialStore) !== stableStringify(DEFAULT_STORE);
          if (remote.payload && typeof remote.payload === "object") {
            const remoteStore = normalizeStrictLearningStore(remote.payload);
            if (localHasData && stableStringify(initialStore) !== stableStringify(remoteStore)) {
              syncReadyRef.current = false;
              setSyncConflict({ payload: remoteStore, revision: Number(remote.revision || 0) });
              setSyncStatus("云端与本机均有不同记录，请选择保留哪一份");
            } else {
              initialStore = remoteStore;
              setSyncStatus("已从云端载入");
              syncReadyRef.current = true;
            }
          } else {
            syncReadyRef.current = true;
            if (localHasData) {
              const upload = await fetch("/api/strict-learning-sync", {
                method: "PUT",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncKey}` },
                body: JSON.stringify({ expectedRevision: 0, payload: initialStore }),
              });
              const saved = await upload.json();
              if (cancelled || generation !== syncGenerationRef.current) return;
              if (upload.status === 409 && saved.payload && typeof saved.payload === "object") {
                const remoteStore = normalizeStrictLearningStore(saved.payload);
                syncReadyRef.current = false;
                setSyncConflict({ payload: remoteStore, revision: Number(saved.revision || 0) });
                setSyncStatus("首次备份时发现其他设备已写入云端，请选择保留哪一份");
              } else if (!upload.ok) {
                throw new Error(saved.error || "首次云端备份失败");
              } else {
                syncRevisionRef.current = Number(saved.revision || 1);
                setSyncStatus("已完成首次云端备份");
              }
            } else {
              setSyncStatus("云同步已连接，等待学习记录");
            }
          }
        } catch (error) {
          if (!cancelled && generation === syncGenerationRef.current) {
            syncReadyRef.current = false;
            setSyncStatus(error instanceof Error ? `云同步不可用：${error.message}` : "云同步不可用，记录仍保存在本机");
          }
        }
      } else {
        setSyncStatus(account.id === "local_user" ? "请先在严格学习设置中填写共享密钥" : "当前账号模式不支持此云同步");
      }
      if (cancelled || generation !== syncGenerationRef.current) return;
      lastQueuedSnapshotRef.current = JSON.stringify(initialStore);
      setStore(initialStore);
      setCharacters(loadCharacters());
      setLoadedAccountId(account.id);
      setLoaded(true);
    })().catch((error) => {
      if (!cancelled) {
        setLoadError(error instanceof Error
          ? error.message
          : "学习记录加载失败。请检查本机存储状态后重试。");
      }
    });

    return () => { cancelled = true; };
  }, [account.id, syncKeyVersion]);

  useEffect(() => {
    if (!loaded || loadedAccountId !== account.id) return;
    const snapshot = JSON.stringify(store);
    let cancelled = false;
    persistenceSnapshotRef.current = snapshot;
    setPersistenceError("正在保存…");
    persistenceQueueRef.current = persistenceQueueRef.current
      .catch(() => undefined)
      .then(() => kvSetAsync(storeKey, snapshot));
    void persistenceQueueRef.current.then(() => {
      if (!cancelled && persistenceSnapshotRef.current === snapshot) setPersistenceError("");
    }).catch(error => {
      if (!cancelled && persistenceSnapshotRef.current === snapshot) {
        setPersistenceError(error instanceof Error ? error.message : "本机数据库写入失败");
      }
    });
    if (!syncReadyRef.current || account.id !== "local_user" || snapshot === lastQueuedSnapshotRef.current) {
      return () => { cancelled = true; };
    }
    lastQueuedSnapshotRef.current = snapshot;
    const syncKey = getStrictLearningSyncKey();
    const generation = syncGenerationRef.current;
    if (!syncKey) {
      syncReadyRef.current = false;
      setSyncStatus("请先在严格学习设置中填写共享密钥");
      return;
    }
    syncQueueRef.current = syncQueueRef.current.then(async () => {
      // Do not report a cloud snapshot as synced before its local write settles.
      await persistenceQueueRef.current;
      // A newer local snapshot may have been queued while this task waited for
      // IndexedDB. Never upload this older closure after the newer snapshot;
      // its own effect has queued the corresponding cloud write.
      if (persistenceSnapshotRef.current !== snapshot) return;
      if (!syncReadyRef.current || generation !== syncGenerationRef.current) return;
      const response = await fetch("/api/strict-learning-sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncKey}` },
        body: JSON.stringify({ expectedRevision: syncRevisionRef.current, payload: store }),
      });
      const data = await response.json();
      if (generation !== syncGenerationRef.current) return;
      if (response.status === 409) {
        syncReadyRef.current = false;
        if (data.payload && typeof data.payload === "object") {
          const remoteStore = normalizeStrictLearningStore(data.payload);
          setSyncConflict({
            payload: remoteStore,
            revision: Number(data.revision || 0),
          });
        }
        setSyncStatus("检测到其他设备更新，请选择保留哪一份");
        return;
      }
      if (!response.ok) throw new Error(data.error || "云端同步失败");
      syncRevisionRef.current = Number(data.revision || syncRevisionRef.current);
      setSyncStatus("已同步到云端");
    }).catch(error => {
      if (generation !== syncGenerationRef.current) return;
      syncReadyRef.current = false;
      setSyncStatus(error instanceof Error ? `云端同步失败：${error.message}` : "云端同步失败");
    });
    return () => { cancelled = true; };
  }, [loaded, loadedAccountId, account.id, store, storeKey]);

  useEffect(() => {
    const refresh = () => {
      const raw = kvGet(storeKey);
      if (!raw) return;
      try {
        setStore(normalizeStrictLearningStore(JSON.parse(raw)));
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
      setRecallImages(current.recall.images || []);
    } else {
      setRecallText("");
      setRecallImages([]);
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
      const dataUrl = await readProfileImage(file);
      setProfileDraft(previous => ({ ...previous, [kind]: dataUrl }));
    } catch (error) { setNotice(error instanceof Error ? error.message : "图片读取失败。"); }
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
      if (result.confidence === "low") {
        if (kind === "focus") recordFocusAttempt({ status: "needs-reupload", result });
        else recordSleepAttempt({ status: "needs-reupload", result });
        setNotice("图片中的关键数据识别置信度较低，暂不通过审核。请上传更清晰、信息完整的截图。");
        return;
      }
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
    if (recallText.length > 20000) {
      setNotice("回忆内容不能超过 20000 个字符。");
      return;
    }
    const recall = { text: recallText.trim(), images: recallImages, completedAt: Date.now() };
    updateDay({ recall });
    if (!supervisor) { setNotice("回忆已保存。选择监督 Char 后，可获得角色反馈。"); return; }
    const apiConfigs = loadApiConfigs();
    const binding = resolveBinding(loadBindingConfig(), supervisor.id, "chat");
    const config = apiConfigs.find(item => item.id === binding.apiConfigId);
    if (!config) { setNotice("回忆已保存，但当前 Char 没有可用的文本模型配置。"); return; }
    setBusy("note"); setNotice("回忆已保存，正在联系监督 Char…");
    try {
      await hydrateChatStorage();
      let imageSummary = "";
      if (recall.images.length) {
        const visionResponse = await fetch("/api/vision-recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images: recall.images }) });
        const visionData = await visionResponse.json();
        if (!visionResponse.ok || !visionData?.ok) throw new Error(visionData?.error || "回忆图片识别失败");
        imageSummary = String(visionData.summary || "");
      }
      const session = createOrGetSession(supervisor.id);
      pushChatMessage({ sessionId: session.id, role: "user", content: `【学习中心·晚间主动回忆】\n今天学了什么：${recall.text}\n学习资料图片识别摘要：${imageSummary || "无"}`, origin: "custom_app" });
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

  const launcherStyle: React.CSSProperties = launcherPosition
    ? { left: launcherPosition.left, top: launcherPosition.top, right: "auto", bottom: "auto" }
    : { right: 16, bottom: "calc(28px + env(safe-area-inset-bottom))" };

  const handleLauncherPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    launcherPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    suppressLauncherClickRef.current = false;
    if (launcherLongPressRef.current) clearTimeout(launcherLongPressRef.current);
    launcherLongPressRef.current = setTimeout(() => {
      if (!launcherPointerRef.current?.moved) {
        suppressLauncherClickRef.current = true;
        setLauncherPickerOpen(true);
      }
      launcherLongPressRef.current = null;
    }, 650);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };

  const handleLauncherPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = launcherPointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      drag.moved = true;
      suppressLauncherClickRef.current = true;
      if (launcherLongPressRef.current) {
        clearTimeout(launcherLongPressRef.current);
        launcherLongPressRef.current = null;
      }
    }
    if (!drag.moved) return;
    const size = event.currentTarget.offsetWidth || 58;
    const left = Math.max(0, Math.min(window.innerWidth - size, drag.left + dx));
    const top = Math.max(0, Math.min(window.innerHeight - size, drag.top + dy));
    setLauncherPosition({ left, top });
    try { localStorage.setItem("strict_learning_launcher_position_v1", JSON.stringify({ left, top })); } catch {}
  };

  const handleLauncherPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (launcherLongPressRef.current) {
      clearTimeout(launcherLongPressRef.current);
      launcherLongPressRef.current = null;
    }
    if (launcherPointerRef.current?.pointerId === event.pointerId) launcherPointerRef.current = null;
  };

  const handleLauncherImageChange = async (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const image = await cropLauncherImage(file);
      localStorage.setItem("strict_learning_launcher_image_v1", image);
      setLauncherImage(image);
      setLauncherPickerOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "悬浮球图片处理失败");
    } finally {
      if (launcherFileRef.current) launcherFileRef.current.value = "";
    }
  };

  if (!loaded || loadedAccountId !== account.id) {
    return loadError ? <div role="alert" className="p-4 text-sm text-red-700">{loadError}</div> : null;
  }
  return (
    <>
      {store.enabled ? <>
        <button
          type="button"
          aria-label="打开学习中心；拖动可移动，长按可更换图片"
          onPointerDown={handleLauncherPointerDown}
          onPointerMove={handleLauncherPointerMove}
          onPointerUp={handleLauncherPointerEnd}
          onPointerCancel={handleLauncherPointerEnd}
          onClick={() => {
            if (suppressLauncherClickRef.current) {
              suppressLauncherClickRef.current = false;
              return;
            }
            setOpen(true);
          }}
          style={{ position: "fixed", ...launcherStyle, zIndex: 1200, width: 58, height: 58, padding: 0, overflow: "hidden", touchAction: "none", userSelect: "none", borderRadius: 999, border: "2px solid rgba(255,255,255,.92)", background: "#b8dce9", color: "#315766", boxShadow: "0 4px 16px rgba(49,87,102,.22)", display: "grid", placeItems: "center" }}
        >{launcherImage ? <img src={launcherImage} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%", pointerEvents: "none" }} /> : <BookOpen size={27} />}</button>
        {launcherPickerOpen ? <div role="dialog" aria-modal="true" aria-label="更换悬浮球图片" style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(18,35,42,.32)", display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 18 }} onClick={() => setLauncherPickerOpen(false)}>
          <div style={{ width: "min(100%, 360px)", padding: 20, borderRadius: 22, background: "#f8fcfd", color: "#315766", display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 12px 36px rgba(0,0,0,.18)" }} onClick={event => event.stopPropagation()}>
            <strong>更换悬浮球图片</strong>
            <span style={{ fontSize: 13, lineHeight: 1.6, color: "#6b8790" }}>选择图片后会自动居中裁剪，并显示为圆形。</span>
            <button type="button" onClick={() => launcherFileRef.current?.click()} style={{ border: 0, borderRadius: 14, padding: 12, background: "#b8dce9", color: "#315766", fontWeight: 700 }}>选择图片</button>
            <button type="button" onClick={() => setLauncherPickerOpen(false)} style={{ border: 0, borderRadius: 14, padding: 12, background: "#edf4f6", color: "#315766" }}>取消</button>
            <input ref={launcherFileRef} type="file" accept="image/*" hidden onChange={event => { void handleLauncherImageChange(event.target.files?.[0]); }} />
          </div>
        </div> : null}
      </> : null}
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
              <div className="flex items-center gap-2"><Sparkles size={20} /><strong>留言板</strong></div>
              <div className="mt-3 text-sm leading-7">{day.charNote?.date === today ? day.charNote.text : "今天的留言还没有写好。"}</div>
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
              <textarea value={recallText} onChange={event => setRecallText(event.target.value)} placeholder="今天学了什么？" className="strict-recall-input" rows={3} maxLength={20000} />
              <div className="mt-2">
                 <button type="button" className="strict-upload-button" onClick={() => recallImageInputRef.current?.click()} disabled={busy !== null}><Upload size={18} />{recallImages.length ? `已添加 ${recallImages.length} 张资料图片` : "上传资料图片（可选）"}</button>
                 <input ref={recallImageInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={async event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (recallImages.length + files.length > 3) { setNotice("最多上传 3 张资料图片。"); return; } try { const images = await Promise.all(files.map(readProfileImage)); setRecallImages(previous => [...previous, ...images].slice(0, 3)); } catch (error) { setNotice(error instanceof Error ? error.message : "图片读取失败。"); } }} />
                 {recallImages.length ? <div className="mt-2 flex flex-wrap gap-2">{recallImages.map((src, index) => <div key={index} className="relative"><img src={src} alt={`资料图片 ${index + 1}`} className="h-20 w-20 rounded-xl object-cover" /><button type="button" aria-label={`删除第 ${index + 1} 张图片`} onClick={() => setRecallImages(previous => previous.filter((_, i) => i !== index))} className="absolute -right-2 -top-2 rounded-full bg-slate-700 p-1 text-white"><X size={13} /></button></div>)}</div> : null}
               </div>
              {day.recall?.feedback ? <div className="strict-result"><strong>Char：</strong>{day.recall.feedback}</div> : null}
              <button type="button" onClick={() => void saveRecall()} disabled={busy !== null} className="strict-upload-button"><Check size={18} />{busy === "note" ? "Char 正在回复…" : "保存今日回忆"}</button>
            </section>

            <div className="px-2 py-1 text-xs text-slate-500">
              <span>本机保存：{persistenceError ? (persistenceError === "正在保存…" ? persistenceError : `失败：${persistenceError}`) : "已写入数据库"}</span>
              <span className="ml-3">云端同步：{syncStatus}</span>
              {!syncConflict && (syncStatus.startsWith("云端同步失败") || syncStatus.startsWith("云同步不可用")) ? <button type="button" className="ml-2 underline" onClick={() => setSyncKeyVersion(value => value + 1)}>重试</button> : null}
              {syncConflict ? <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="strict-save-button" onClick={() => { syncRevisionRef.current = syncConflict.revision; syncReadyRef.current = true; lastQueuedSnapshotRef.current = JSON.stringify(syncConflict.payload); setStore(syncConflict.payload); setSyncConflict(null); setSyncStatus("已载入云端版本"); }}>载入云端版本</button><button type="button" className="strict-save-button" onClick={() => { syncRevisionRef.current = syncConflict.revision; syncReadyRef.current = true; lastQueuedSnapshotRef.current = ""; setSyncConflict(null); setSyncStatus("准备将本机版本覆盖到云端"); setStore(previous => ({ ...previous })); }}>保留本机版本并覆盖云端</button></div> : null}
            </div>
            {notice ? <div className="strict-notice" role="status">{notice}</div> : null}
          </div>
          {editingProfile ? (
            <div className="strict-edit-backdrop" onClick={() => setEditingProfile(false)}>
              <div className="strict-edit-sheet" onClick={event => event.stopPropagation()}>
                <div className="flex items-center justify-between"><strong>编辑个人资料</strong><button type="button" onClick={() => setEditingProfile(false)}><X size={20} /></button></div>
                <label className="strict-edit-label">昵称<input maxLength={200} value={profileDraft.nickname} onChange={event => updateProfile("nickname", event.target.value)} /></label>
                <label className="strict-edit-label">第一行文字<input maxLength={2000} value={profileDraft.lineOne} onChange={event => updateProfile("lineOne", event.target.value)} /></label>
                <label className="strict-edit-label">第二行文字<input maxLength={2000} value={profileDraft.lineTwo} onChange={event => updateProfile("lineTwo", event.target.value)} /></label>
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
