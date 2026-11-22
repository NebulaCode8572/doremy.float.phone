import type { MemoryEntry } from "@/lib/memory-types";
import { kvGet, kvSetAsync, registerKvMigration } from "@/lib/kv-db";
import { loadMemoryConfig } from "@/lib/memory-storage";

export type VectorSyncEntry = Omit<Pick<MemoryEntry, "id" | "characterId" | "sourceApp" | "type" | "content" | "createdAt" | "updatedAt" | "metadata">, "sourceApp"> & { sourceApp: string };


export type ImportedMemoryPendingEntry = VectorSyncEntry;
const IMPORT_PENDING_KEY = "ai_phone_vector_memory_import_pending_v1";
registerKvMigration(IMPORT_PENDING_KEY);

export function loadImportedMemoryPending(): ImportedMemoryPendingEntry[] {
  try {
    const raw = kvGet(IMPORT_PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.characterId === "string" && typeof entry.sourceApp === "string" && (entry.type === "core" || entry.type === "long_term") && typeof entry.content === "string" && typeof entry.createdAt === "string" && typeof entry.updatedAt === "string") : [];
  } catch {
    return [];
  }
}

export async function addImportedMemoryPending(entries: ImportedMemoryPendingEntry[]): Promise<number> {
  if (!entries.length || !loadMemoryConfig().vectorMemoryEnabled) return 0;
  const existing = loadImportedMemoryPending();
  const merged = new Map(existing.map((entry) => [entry.characterId + ":" + entry.id + ":" + entry.sourceApp + ":" + entry.type, entry]));
  for (const entry of entries) merged.set(entry.characterId + ":" + entry.id + ":" + entry.sourceApp + ":" + entry.type, entry);
  const next = Array.from(merged.values());
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(next));
  return next.length;
}

export async function clearImportedMemoryPending(): Promise<void> {
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify([]));
}

function pendingEntryKey(entry: ImportedMemoryPendingEntry): string {
  return entry.characterId + ":" + entry.id + ":" + entry.sourceApp + ":" + entry.type;
}

export async function removeSyncedImportedMemoryPending(entries: ImportedMemoryPendingEntry[]): Promise<void> {
  if (!entries.length) return;
  const current = loadImportedMemoryPending();
  const synced = new Map(entries.map((entry) => [pendingEntryKey(entry), entry]));
  const remaining = current.filter((entry) => {
    const uploaded = synced.get(pendingEntryKey(entry));
    // Preserve a record changed or re-imported while the upload was in flight.
    return !uploaded || uploaded.content !== entry.content || uploaded.updatedAt !== entry.updatedAt;
  });
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(remaining));
}

function vectorSourceKind(entry: VectorSyncEntry): "summary" | "core_memory" | "long_term_memory" {
  return entry.type === "core" ? "core_memory" : entry.type === "long_term" ? "long_term_memory" : "summary";
}

export async function deleteMemoryEntriesFromVectorCloud(entries: VectorSyncEntry[]): Promise<void> {
  if (!entries.length || typeof window === "undefined") return;
  for (const entry of entries) {
    try {
      const response = await fetch("/api/vector-memory-entry", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ characterId: entry.characterId, sourceApp: entry.sourceApp, sourceId: entry.id, sourceKind: vectorSourceKind(entry) }),
      });
      if (!response.ok) console.warn("[VectorMemory] Memory deletion endpoint returned HTTP " + response.status);
    } catch (error) {
      console.warn("[VectorMemory] Cloud memory deletion failed; local delete remains unaffected.", error);
    }
  }
}

export async function deleteCharacterMemoryVectorsFromVectorCloud(characterId: string): Promise<void> {
  if (!characterId || typeof window === "undefined") return;
  try {
    const response = await fetch("/api/vector-memory-entry", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ characterId, memoryOnly: true }),
    });
    if (!response.ok) console.warn("[VectorMemory] Memory cleanup endpoint returned HTTP " + response.status);
  } catch (error) {
    console.warn("[VectorMemory] Memory vector cleanup failed; local cleanup remains unaffected.", error);
  }
}

export async function deleteCharacterVectorsFromVectorCloud(characterId: string): Promise<void> {
  if (!characterId || typeof window === "undefined") return;
  try {
    const response = await fetch("/api/vector-memory-entry", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ characterId }),
    });
    if (!response.ok) console.warn("[VectorMemory] Character cleanup endpoint returned HTTP " + response.status);
  } catch (error) {
    console.warn("[VectorMemory] Character vector cleanup failed; local character deletion remains unaffected.", error);
  }
}

export async function syncMemoryEntriesToVectorCloud(entries: VectorSyncEntry[]): Promise<boolean> {
  if (!entries.length || typeof window === "undefined") return false;
  let allSucceeded = true;
  // Incremental and idempotent: only newly saved entries are sent, and source IDs
  // are stable for upsert. Keep indexing non-blocking for ordinary memory writes.
  const batches: VectorSyncEntry[][] = [];
  for (let i = 0; i < entries.length; i += 3) batches.push(entries.slice(i, i + 3));
  for (const batch of batches) {
    try {
      const response = await fetch("/api/vector-memory-index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ entries: batch.map(entry => ({
          id: entry.id,
          characterId: entry.characterId,
          sourceApp: entry.sourceApp,
          sourceKind: vectorSourceKind(entry),
          content: entry.content,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          metadata: entry.metadata ?? {},
        })) }),
      });
      if (!response.ok) {
        allSucceeded = false;
        console.warn("[VectorMemory] Index endpoint returned HTTP " + response.status);
      } else {
        const payload = await response.json().catch(() => null);
        const results = payload && Array.isArray(payload.results) ? payload.results : null;
        if (!results || results.length !== batch.length || results.some((item: unknown) => !item || typeof item !== "object" || (item as { success?: unknown }).success !== true) {
          allSucceeded = false;
          console.warn("[VectorMemory] Index endpoint reported partial or malformed batch success");
        }
      }
    } catch (error) {
      allSucceeded = false;
      console.warn("[VectorMemory] Incremental indexing failed; chat/memory save remains unaffected.", error);
    }
  }
  return allSucceeded;
}

export async function syncImportedMemoryPending(): Promise<{ synced: number; success: boolean }> {
  const pending = loadImportedMemoryPending();
  if (!pending.length) return { synced: 0, success: true };
  if (!loadMemoryConfig().vectorMemoryEnabled) return { synced: 0, success: false };
  const success = await syncMemoryEntriesToVectorCloud(pending);
  if (success) await removeSyncedImportedMemoryPending(pending);
  return { synced: success ? pending.length : 0, success };
}
