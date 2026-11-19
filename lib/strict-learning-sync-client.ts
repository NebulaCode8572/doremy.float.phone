const STORAGE_KEY = "strict_learning_sync_key_v1";

export function getStrictLearningSyncKey(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
}

export function saveStrictLearningSyncKey(value: string): void {
  if (typeof window === "undefined") return;
  const normalized = value.trim();
  if (normalized) window.localStorage.setItem(STORAGE_KEY, normalized);
  else window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent("strict-learning-sync-key-updated"));
}
