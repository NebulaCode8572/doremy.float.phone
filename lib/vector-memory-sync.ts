import type { MemoryEntry } from "@/lib/memory-types";
import { hydrateKvDb, kvGet, kvSetAsync, registerKvMigration } from "@/lib/kv-db";
import { getAllCharacterIdsWithMemories, loadMemoryEntries, saveMemoryEntry } from "@/lib/memory-storage";
import { loadActiveAccountId } from "@/lib/account-client";
import { loadCachedVectorMemoryGeneration, refreshCachedVectorMemoryGeneration } from "@/lib/vector-memory-generation";

export type VectorSyncEntry = Omit<Pick<MemoryEntry, "id" | "characterId" | "sourceApp" | "type" | "content" | "createdAt" | "updatedAt" | "metadata" | "vectorMemoryAccountId" | "vectorMemoryCharacterGeneration" | "vectorMemoryMemoryGeneration" | "vectorMemoryRevision" | "vectorMemoryIndexedFingerprint" | "vectorMemoryConflictRevision" | "vectorMemoryPendingOperationId" | "vectorMemoryPendingFingerprint">, "sourceApp"> & { sourceApp: string; expectedRevision?: number };

function isEligibleVectorMemoryEntry(entry: VectorSyncEntry): boolean {
  return typeof entry.vectorMemoryAccountId === "string" && entry.vectorMemoryAccountId.length > 0
    && typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.characterId === "string" && entry.characterId.length > 0
    && typeof entry.sourceApp === "string" && entry.sourceApp.length > 0
    && typeof entry.content === "string" && entry.content.trim().length > 0
    && entry.metadata?.includesGroupChat !== true
    && entry.metadata?.includesStaleChat !== true
    && entry.metadata?.includesUnverifiedTimeline !== true;
}

function hasValidGeneration(entry: VectorSyncEntry): boolean {
  return isEligibleVectorMemoryEntry(entry)
    && Number.isSafeInteger(entry.vectorMemoryCharacterGeneration)
    && (entry.vectorMemoryCharacterGeneration ?? -1) >= 0
    && Number.isSafeInteger(entry.vectorMemoryMemoryGeneration)
    && (entry.vectorMemoryMemoryGeneration ?? -1) >= 0;
}


export type ImportedMemoryPendingEntry = VectorSyncEntry;
const IMPORT_PENDING_KEY = "ai_phone_vector_memory_import_pending_v1";
registerKvMigration(IMPORT_PENDING_KEY);

export function loadImportedMemoryPending(): ImportedMemoryPendingEntry[] {
  try {
    const raw = kvGet(IMPORT_PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.characterId === "string" && typeof entry.sourceApp === "string" && (entry.type === "core" || entry.type === "long_term") && typeof entry.content === "string" && typeof entry.createdAt === "string" && typeof entry.updatedAt === "string" && isEligibleVectorMemoryEntry(entry)) : [];
  } catch {
    return [];
  }
}

export async function addImportedMemoryPending(entries: ImportedMemoryPendingEntry[]): Promise<number> {
  await hydrateKvDb();
  if (!entries.length) return 0;
  const accountId = loadActiveAccountId();
  if (!accountId) return loadImportedMemoryPending().length;

  // The import was explicitly confirmed. Stamp the local source record as belonging
  // to this account; only attach a generation when a valid cache exists right now.
  const generations = new Map<string, ReturnType<typeof loadCachedVectorMemoryGeneration>>();
  for (const characterId of new Set(entries.map(entry => entry.characterId))) {
    generations.set(characterId, loadCachedVectorMemoryGeneration(accountId, characterId));
  }
  for (const characterId of new Set(entries.map(entry => entry.characterId))) {
    const localEntries = await loadMemoryEntries(characterId);
    const importedIds = new Set(entries.filter(entry => entry.characterId === characterId).map(entry => entry.id));
    for (const localEntry of localEntries) {
      if (!importedIds.has(localEntry.id)) continue;
      const generation = generations.get(characterId);
      const {
        vectorMemoryCharacterGeneration: _oldCharacterGeneration,
        vectorMemoryMemoryGeneration: _oldMemoryGeneration,
        vectorMemoryRevision: _oldRevision,
        vectorMemoryIndexedFingerprint: _oldIndexedFingerprint,
        vectorMemoryConflictRevision: _oldConflictRevision,
        vectorMemoryPendingOperationId: _oldOperationId,
        vectorMemoryPendingFingerprint: _oldFingerprint,
        ...localEntryWithoutOldGeneration
      } = localEntry;
      await saveMemoryEntry({
        ...localEntryWithoutOldGeneration,
        vectorMemoryAccountId: accountId,
        ...(generation ? {
          vectorMemoryCharacterGeneration: generation.characterGeneration,
          vectorMemoryMemoryGeneration: generation.memoryGeneration,
        } : {}),
      });
    }
  }

  const explicitlyImported = entries.map(entry => {
    const current = generations.get(entry.characterId);
    const {
      vectorMemoryRevision: _importedRevision,
      vectorMemoryIndexedFingerprint: _importedIndexedFingerprint,
      vectorMemoryConflictRevision: _importedConflictRevision,
      vectorMemoryPendingOperationId: _importedOperationId,
      vectorMemoryPendingFingerprint: _importedFingerprint,
      ...entryWithoutOldServerState
    } = entry;
    return {
      ...entryWithoutOldServerState,
      vectorMemoryAccountId: accountId,
      ...(current ? {
        vectorMemoryCharacterGeneration: current.characterGeneration,
        vectorMemoryMemoryGeneration: current.memoryGeneration,
      } : {}),
    };
  }).filter(isEligibleVectorMemoryEntry);
  if (!explicitlyImported.length) return loadImportedMemoryPending().length;
  const existing = loadImportedMemoryPending();
  const merged = new Map(existing.map((entry) => [pendingEntryKey(entry), entry]));
  for (const entry of explicitlyImported) merged.set(pendingEntryKey(entry), entry);
  const next = Array.from(merged.values());
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(next));
  return next.length;
}

export async function clearImportedMemoryPending(): Promise<void> {
  const accountId = loadActiveAccountId();
  const remaining = loadImportedMemoryPending().filter(entry => entry.vectorMemoryAccountId !== accountId);
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(remaining));
}

async function removeImportedMemoryPendingWhere(predicate: (entry: ImportedMemoryPendingEntry) => boolean): Promise<void> {
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  const remaining = loadImportedMemoryPending().filter(entry => entry.vectorMemoryAccountId !== accountId || !predicate(entry));
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(remaining));
}

async function removeImportedMemoryPendingEntries(entries: ImportedMemoryPendingEntry[]): Promise<void> {
  if (!entries.length) return;
  await hydrateKvDb();
  const keys = new Set(entries.map(pendingEntryKey));
  const remaining = loadImportedMemoryPending().filter(entry => !keys.has(pendingEntryKey(entry)));
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(remaining));
}

function pendingEntryKey(entry: ImportedMemoryPendingEntry): string {
  return (entry.vectorMemoryAccountId ?? "") + ":" + entry.characterId + ":" + entry.id + ":" + entry.sourceApp + ":" + entry.type;
}

export async function removeSyncedImportedMemoryPending(entries: ImportedMemoryPendingEntry[]): Promise<void> {
  if (!entries.length) return;
  const current = loadImportedMemoryPending();
  const synced = new Map(entries.map((entry) => [pendingEntryKey(entry), entry]));
  const remaining = current.filter((entry) => {
    const uploaded = synced.get(pendingEntryKey(entry));
    // Preserve a record changed or re-imported while the upload was in flight.
    // Content/timestamps alone are insufficient: metadata can affect retrieval scope.
    return !uploaded ||
      uploaded.content !== entry.content ||
      uploaded.createdAt !== entry.createdAt ||
      uploaded.updatedAt !== entry.updatedAt ||
      (uploaded.vectorMemoryCharacterGeneration !== undefined
        && entry.vectorMemoryCharacterGeneration !== undefined
        && uploaded.vectorMemoryCharacterGeneration !== entry.vectorMemoryCharacterGeneration) ||
      (uploaded.vectorMemoryMemoryGeneration !== undefined
        && entry.vectorMemoryMemoryGeneration !== undefined
        && uploaded.vectorMemoryMemoryGeneration !== entry.vectorMemoryMemoryGeneration) ||
      JSON.stringify(uploaded.metadata ?? {}) !== JSON.stringify(entry.metadata ?? {});
  });
  await kvSetAsync(IMPORT_PENDING_KEY, JSON.stringify(remaining));
}

function vectorSourceKind(entry: VectorSyncEntry): "summary" | "core_memory" | "long_term_memory" {
  return entry.type === "core" ? "core_memory" : entry.type === "long_term" ? "long_term_memory" : "summary";
}

// Serialize cloud mutations so an in-flight upsert cannot overtake a deletion.
let vectorCloudMutationQueue: Promise<void> = Promise.resolve();
function withVectorCloudMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = vectorCloudMutationQueue.then(operation, operation);
  vectorCloudMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}
const DELETE_PENDING_KEY = "ai_phone_vector_memory_delete_pending_v1";
registerKvMigration(DELETE_PENDING_KEY);
type PendingMemoryDelete = { accountId: string; characterId: string; id: string; sourceApp: string; type: "core" | "long_term" };
function pendingDeleteKey(entry: PendingMemoryDelete): string {
  return entry.accountId + ":" + entry.characterId + ":" + entry.id + ":" + entry.sourceApp + ":" + entry.type;
}
function loadPendingMemoryDeletes(): PendingMemoryDelete[] {
  try {
    const raw = kvGet(DELETE_PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.characterId === "string" && typeof item.id === "string" && typeof item.sourceApp === "string" && typeof item.accountId === "string" && item.accountId.length > 0 && (item.type === "core" || item.type === "long_term")) : [];
  } catch { return []; }
}
async function enqueuePendingMemoryDeletes(entries: PendingMemoryDelete[]): Promise<void> {
  if (!entries.length) return;
  await hydrateKvDb();
  const merged = new Map(loadPendingMemoryDeletes().map((item) => [pendingDeleteKey(item), item]));
  for (const item of entries) merged.set(pendingDeleteKey(item), item);
  await kvSetAsync(DELETE_PENDING_KEY, JSON.stringify(Array.from(merged.values()).slice(-1000)));
}
async function removePendingMemoryDeletes(entries: PendingMemoryDelete[]): Promise<void> {
  if (!entries.length) return;
  await hydrateKvDb();
  const keys = new Set(entries.map(pendingDeleteKey));
  const remaining = loadPendingMemoryDeletes().filter(item => !keys.has(pendingDeleteKey(item)));
  await kvSetAsync(DELETE_PENDING_KEY, JSON.stringify(remaining));
}
async function cancelPendingMemoryDeletesForEntries(entries: VectorSyncEntry[]): Promise<void> {
  if (!entries.length) return;
  await hydrateKvDb();
  const keys = new Set(entries
    .filter(entry => typeof entry.vectorMemoryAccountId === "string" && entry.vectorMemoryAccountId.length > 0)
    .map(entry => pendingDeleteKey({
      accountId: entry.vectorMemoryAccountId!,
      characterId: entry.characterId,
      id: entry.id,
      sourceApp: entry.sourceApp,
      type: entry.type,
    })));
  const remaining = loadPendingMemoryDeletes().filter(item => !keys.has(pendingDeleteKey(item)));
  await kvSetAsync(DELETE_PENDING_KEY, JSON.stringify(remaining));
}


const INDEX_PENDING_KEY = "ai_phone_vector_memory_index_pending_v1";
registerKvMigration(INDEX_PENDING_KEY);
function loadPendingMemoryIndexes(): VectorSyncEntry[] {
  try {
    const raw = kvGet(INDEX_PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.characterId === "string" && typeof item.id === "string" && typeof item.sourceApp === "string" && (item.type === "core" || item.type === "long_term" || item.type === "summary") && typeof item.content === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && isEligibleVectorMemoryEntry(item)) : [];
  } catch { return []; }
}
async function enqueuePendingMemoryIndexes(entries: VectorSyncEntry[]): Promise<void> {
  entries = entries.filter(isEligibleVectorMemoryEntry);
  if (!entries.length) return;
  await hydrateKvDb();
  const merged = new Map(loadPendingMemoryIndexes().map(entry => [pendingEntryKey(entry), entry]));
  for (const entry of entries) merged.set(pendingEntryKey(entry), entry);
  await kvSetAsync(INDEX_PENDING_KEY, JSON.stringify(Array.from(merged.values()).slice(-2000)));
}
async function removePendingMemoryIndexesForCharacter(characterId: string, memoryOnly = false): Promise<void> {
  if (!characterId) return;
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  const remaining = loadPendingMemoryIndexes().filter(entry => entry.vectorMemoryAccountId !== accountId || entry.characterId !== characterId || (memoryOnly && entry.type !== "core" && entry.type !== "long_term"));
  await kvSetAsync(INDEX_PENDING_KEY, JSON.stringify(remaining));
}
async function removePendingMemoryIndexes(entries: VectorSyncEntry[]): Promise<void> {
  if (!entries.length) return;
  await hydrateKvDb();
  // All callers run inside vectorCloudMutationQueue. Once this serialized operation
  // succeeds (or a delete is accepted), its stable source IDs supersede every older
  // queued snapshot for those IDs, even when the queued content differs.
  const keys = new Set(entries.map(pendingEntryKey));
  const remaining = loadPendingMemoryIndexes().filter(current => !keys.has(pendingEntryKey(current)));
  await kvSetAsync(INDEX_PENDING_KEY, JSON.stringify(remaining));
}
const BULK_DELETE_PENDING_KEY = "ai_phone_vector_memory_bulk_delete_pending_v1";
registerKvMigration(BULK_DELETE_PENDING_KEY);
type PendingBulkVectorDelete = { accountId: string; characterId: string; memoryOnly: boolean };
function bulkDeleteKey(item: PendingBulkVectorDelete): string { return item.accountId + ":" + item.characterId + ":" + (item.memoryOnly ? "memoryOnly" : "all"); }
function loadPendingBulkVectorDeletes(): PendingBulkVectorDelete[] {
  try {
    const raw = kvGet(BULK_DELETE_PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.accountId === "string" && item.accountId.length > 0 && typeof item.characterId === "string" && typeof item.memoryOnly === "boolean") : [];
  } catch { return []; }
}
async function enqueuePendingBulkVectorDelete(item: PendingBulkVectorDelete): Promise<void> {
  await hydrateKvDb();
  const merged = new Map(loadPendingBulkVectorDeletes().map((entry) => [bulkDeleteKey(entry), entry]));
  merged.set(bulkDeleteKey(item), item);
  await kvSetAsync(BULK_DELETE_PENDING_KEY, JSON.stringify(Array.from(merged.values()).slice(-500)));
}
async function cancelPendingBulkVectorDeletesForEntries(entries: VectorSyncEntry[]): Promise<void> {
  if (!entries.length) return;
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  const characterIds = new Set(entries.filter(entry => entry.vectorMemoryAccountId === accountId).map(entry => entry.characterId));
  const hasMemoryEntries = entries.some(entry => entry.type === "core" || entry.type === "long_term");
  const remaining = loadPendingBulkVectorDeletes().filter(item => {
    if (item.accountId !== accountId || !characterIds.has(item.characterId)) return true;
    // Re-indexing supersedes queued cleanup for that character.
    return item.memoryOnly ? !hasMemoryEntries : false;
  });
  await kvSetAsync(BULK_DELETE_PENDING_KEY, JSON.stringify(remaining));
}
async function removePendingBulkVectorDelete(item: PendingBulkVectorDelete): Promise<void> {
  await hydrateKvDb();
  const remaining = loadPendingBulkVectorDeletes().filter(entry => bulkDeleteKey(entry) !== bulkDeleteKey(item));
  await kvSetAsync(BULK_DELETE_PENDING_KEY, JSON.stringify(remaining));
}
async function retryPendingBulkVectorDeletesUnlocked(): Promise<number> {
  if (typeof window === "undefined") return 0;
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  const pending = loadPendingBulkVectorDeletes().filter(item => item.accountId === accountId);
  let completed = 0;
  for (const item of pending) {
    if (loadActiveAccountId() !== accountId) break;
    try {
      const response = await fetch("/api/vector-memory-entry", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify(item.memoryOnly ? { characterId: item.characterId, memoryOnly: true } : { characterId: item.characterId }),
      });
      if (response.ok) {
        await removePendingBulkVectorDelete(item);
        if (loadActiveAccountId() === accountId) await refreshCachedVectorMemoryGeneration(item.characterId);
        completed++;
      }
    } catch { /* Keep the item queued for a later attempt. */ }
  }
  return completed;
}

async function retryPendingMemoryVectorDeletesUnlocked(): Promise<number> {
  if (typeof window === "undefined") return 0;
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  const pending = loadPendingMemoryDeletes().filter(item => item.accountId === accountId);
  if (!pending.length) return 0;
  const completed: PendingMemoryDelete[] = [];
  for (const entry of pending) {
    if (loadActiveAccountId() !== accountId) break;
    try {
      const response = await fetch("/api/vector-memory-entry", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ characterId: entry.characterId, sourceApp: entry.sourceApp, sourceId: entry.id, sourceKind: entry.type === "core" ? "core_memory" : "long_term_memory" }),
      });
      if (response.ok) completed.push(entry);
    } catch { /* Retain failed deletion for a later retry. */ }
  }
  if (completed.length) {
    const done = new Set(completed.map(pendingDeleteKey));
    const remaining = loadPendingMemoryDeletes().filter(item => !done.has(pendingDeleteKey(item)));
    await kvSetAsync(DELETE_PENDING_KEY, JSON.stringify(remaining));
  }
  return completed.length;
}

export async function deleteMemoryEntriesFromVectorCloud(entries: VectorSyncEntry[]): Promise<void> {
  return withVectorCloudMutation(async () => {
    if (!entries.length || typeof window === "undefined") return;
    // A local delete can be initiated after an account switch. Persist the delete
    // under the source's owner account, but never send it using another account's cookie.
    entries = entries.filter(entry => typeof entry.vectorMemoryAccountId === "string" && entry.vectorMemoryAccountId.length > 0);
    if (!entries.length) return;
    await hydrateKvDb();
    const pendingDeletes: PendingMemoryDelete[] = entries.map(entry => ({
      accountId: entry.vectorMemoryAccountId!,
      characterId: entry.characterId,
      id: entry.id,
      sourceApp: entry.sourceApp,
      type: entry.type === "core" ? "core" : "long_term",
    }));
    // Persist deletion intent before removing stale upsert retries or sending
    // the first network request, so an interruption cannot orphan cloud data.
    await enqueuePendingMemoryDeletes(pendingDeletes);
    await removePendingMemoryIndexes(entries);
    await removeImportedMemoryPendingEntries(entries);
    const completed: PendingMemoryDelete[] = [];
    for (const entry of entries) {
      const ownerAccountId = entry.vectorMemoryAccountId!;
      const pendingEntry: PendingMemoryDelete = {
        accountId: ownerAccountId,
        characterId: entry.characterId,
        id: entry.id,
        sourceApp: entry.sourceApp,
        type: entry.type === "core" ? "core" : "long_term",
      };
      if (loadActiveAccountId() !== ownerAccountId) continue;
      try {
        const response = await fetch("/api/vector-memory-entry", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ characterId: entry.characterId, sourceApp: entry.sourceApp, sourceId: entry.id, sourceKind: vectorSourceKind(entry) }),
        });
        if (response.ok) completed.push(pendingEntry);
      } catch {
        // Keep the pre-persisted deletion marker for a later retry.
      }
    }
    if (completed.length) await removePendingMemoryDeletes(completed);
  });
}


export async function deleteCharacterMemoryVectorsFromVectorCloud(characterId: string): Promise<void> {
  return withVectorCloudMutation(async () => {
  if (!characterId || typeof window === "undefined") return;
  const accountId = loadActiveAccountId();
  if (!accountId) return;
  const pendingDelete = { accountId, characterId, memoryOnly: true };
  await enqueuePendingBulkVectorDelete(pendingDelete);
  await removePendingMemoryIndexesForCharacter(characterId, true);
  await removeImportedMemoryPendingWhere(entry => entry.characterId === characterId && (entry.type === "core" || entry.type === "long_term"));
  try {
    if (loadActiveAccountId() !== accountId) {
      await enqueuePendingBulkVectorDelete(pendingDelete);
      return;
    }
    const response = await fetch("/api/vector-memory-entry", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ characterId, memoryOnly: true }),
    });
    if (response.ok) {
      await removePendingBulkVectorDelete(pendingDelete);
      if (loadActiveAccountId() === accountId) await refreshCachedVectorMemoryGeneration(characterId);
    } else {
      await enqueuePendingBulkVectorDelete(pendingDelete);
      console.warn("[VectorMemory] Memory cleanup endpoint returned HTTP " + response.status);
    }
  } catch (error) {
    await enqueuePendingBulkVectorDelete(pendingDelete);
    console.warn("[VectorMemory] Memory vector cleanup failed; local cleanup remains unaffected.", error);
  }
  });
}


export async function deleteCharacterVectorsFromVectorCloud(characterId: string): Promise<void> {
  return withVectorCloudMutation(async () => {
  if (!characterId || typeof window === "undefined") return;
  const accountId = loadActiveAccountId();
  if (!accountId) return;
  const pendingDelete = { accountId, characterId, memoryOnly: false };
  await enqueuePendingBulkVectorDelete(pendingDelete);
  await removePendingMemoryIndexesForCharacter(characterId);
  await removeImportedMemoryPendingWhere(entry => entry.characterId === characterId);
  try {
    if (loadActiveAccountId() !== accountId) {
      await enqueuePendingBulkVectorDelete(pendingDelete);
      return;
    }
    const response = await fetch("/api/vector-memory-entry", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ characterId }),
    });
    if (response.ok) {
      await removePendingBulkVectorDelete(pendingDelete);
      if (loadActiveAccountId() === accountId) await refreshCachedVectorMemoryGeneration(characterId);
    } else {
      await enqueuePendingBulkVectorDelete(pendingDelete);
      console.warn("[VectorMemory] Character cleanup endpoint returned HTTP " + response.status);
    }
  } catch (error) {
    await enqueuePendingBulkVectorDelete(pendingDelete);
    console.warn("[VectorMemory] Character vector cleanup failed; local character deletion remains unaffected.", error);
  }
  });
}


function vectorMemoryPayloadFingerprint(entry: VectorSyncEntry): string {
  const raw = JSON.stringify({
    accountId: entry.vectorMemoryAccountId,
    id: entry.id, characterId: entry.characterId, sourceApp: entry.sourceApp,
    type: entry.type, content: entry.content, metadata: entry.metadata ?? {},
    characterGeneration: entry.vectorMemoryCharacterGeneration,
    memoryGeneration: entry.vectorMemoryMemoryGeneration,
  });
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36) + ":" + raw.length;
}

function createVectorMemoryOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "vm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

async function persistVectorMemoryRevision(entry: VectorSyncEntry, revision: number): Promise<void> {
  const local = await loadMemoryEntries(entry.characterId);
  const current = local.find(item => item.id === entry.id && item.sourceApp === entry.sourceApp);
  if (!current) return;
  const sameOperation = current.vectorMemoryPendingOperationId === entry.vectorMemoryPendingOperationId;
  await saveMemoryEntry({
    ...current,
    // Persist the server generation with the acknowledged revision so subsequent
    // local edits can immediately create valid CAS snapshots.
    vectorMemoryAccountId: entry.vectorMemoryAccountId,
    vectorMemoryCharacterGeneration: entry.vectorMemoryCharacterGeneration,
    vectorMemoryMemoryGeneration: entry.vectorMemoryMemoryGeneration,
    vectorMemoryIndexedFingerprint: vectorMemoryPayloadFingerprint(entry),
    // Even if the user edited the local source while the request was in flight,
    // this revision is the server-acknowledged base that the newer edit must CAS
    // against. Preserve the newer content and any newer pending operation.
    vectorMemoryRevision: revision,
    vectorMemoryConflictRevision: undefined,
    ...(sameOperation ? {
      vectorMemoryPendingOperationId: undefined,
      vectorMemoryPendingFingerprint: undefined,
    } : {}),
  });
}

async function persistVectorMemoryConflict(entry: VectorSyncEntry, currentRevision: number): Promise<void> {
  const local = await loadMemoryEntries(entry.characterId);
  const current = local.find(item => item.id === entry.id && item.sourceApp === entry.sourceApp);
  if (!current) return;
  await saveMemoryEntry({
    ...current,
    vectorMemoryConflictRevision: currentRevision,
    vectorMemoryPendingOperationId: undefined,
    vectorMemoryPendingFingerprint: undefined,
  });
}

async function clearVectorMemoryConflict(entry: VectorSyncEntry): Promise<void> {
  const local = await loadMemoryEntries(entry.characterId);
  const current = local.find(item => item.id === entry.id && item.sourceApp === entry.sourceApp);
  if (!current || current.vectorMemoryConflictRevision === undefined) return;
  await saveMemoryEntry({
    ...current,
    vectorMemoryConflictRevision: undefined,
    vectorMemoryPendingOperationId: undefined,
    vectorMemoryPendingFingerprint: undefined,
  });
}

async function syncMemoryEntriesToVectorCloudUnlocked(entries: VectorSyncEntry[]): Promise<boolean> {
  const accountId = loadActiveAccountId();
  entries = entries.filter(entry => entry.vectorMemoryAccountId === accountId && isEligibleVectorMemoryEntry(entry));
  if (!entries.length || typeof window === "undefined") return false;

  // Cloud mutations are serialized, but callers may have captured an entry before
  // an earlier queued upload acknowledged a newer revision. Refresh from IndexedDB
  // inside the serialized operation so the next snapshot uses the latest local
  // content and the latest server-acknowledged CAS base.
  const localByIdentity = new Map<string, MemoryEntry>();
  for (const characterId of new Set(entries.map(entry => entry.characterId))) {
    for (const local of await loadMemoryEntries(characterId)) {
      localByIdentity.set(JSON.stringify([local.characterId, local.sourceApp, local.id]), local);
    }
  }
  entries = entries.map(entry => {
    const local = localByIdentity.get(JSON.stringify([entry.characterId, entry.sourceApp, entry.id]));
    return local ? {
      ...entry,
      ...local,
      // Keep the durable retry token/snapshot base from the queue. If the local
      // content changed, the fingerprint comparison below discards this token.
      vectorMemoryPendingOperationId: entry.vectorMemoryPendingOperationId,
      vectorMemoryPendingFingerprint: entry.vectorMemoryPendingFingerprint,
      expectedRevision: entry.expectedRevision,
    } : entry;
  }).filter(entry => entry.vectorMemoryAccountId === accountId && isEligibleVectorMemoryEntry(entry))
    .map(entry => {
      if (hasValidGeneration(entry)) return entry;
      const generation = loadCachedVectorMemoryGeneration(accountId, entry.characterId);
      return generation ? {
        ...entry,
        vectorMemoryCharacterGeneration: generation.characterGeneration,
        vectorMemoryMemoryGeneration: generation.memoryGeneration,
      } : entry;
    });

  // Keep account-owned entries durable while generation bootstrap is unavailable.
  // Once a fresh generation is cached, retryPendingMemoryIndexes can promote them.
  const waitingForGeneration = entries.filter(entry => !hasValidGeneration(entry));
  if (waitingForGeneration.length) await enqueuePendingMemoryIndexes(waitingForGeneration);
  entries = entries.filter(hasValidGeneration);
  if (!entries.length) return false;

  const prepared = entries.map(entry => {
    const fingerprint = vectorMemoryPayloadFingerprint(entry);
    const samePendingSnapshot = entry.vectorMemoryPendingFingerprint === fingerprint
      && typeof entry.vectorMemoryPendingOperationId === "string";
    const operationId = samePendingSnapshot
      ? entry.vectorMemoryPendingOperationId!
      : createVectorMemoryOperationId();
    const expectedRevision = samePendingSnapshot
      && Number.isSafeInteger(entry.expectedRevision) && (entry.expectedRevision ?? -1) >= 0
      ? entry.expectedRevision!
      : Number.isSafeInteger(entry.vectorMemoryRevision) && (entry.vectorMemoryRevision ?? -1) >= 0
        ? entry.vectorMemoryRevision! : 0;
    return {
      ...entry,
      vectorMemoryPendingOperationId: operationId,
      vectorMemoryPendingFingerprint: fingerprint,
      expectedRevision,
    };
  });

  // Persist the exact operation snapshot before the request. A retry reuses both
  // operationId and expectedRevision; changed content receives a new operationId.
  await enqueuePendingMemoryIndexes(prepared);
  await cancelPendingMemoryDeletesForEntries(prepared);
  await cancelPendingBulkVectorDeletesForEntries(prepared);
  await retryPendingMemoryVectorDeletesUnlocked();
  await retryPendingBulkVectorDeletesUnlocked();

  let allSucceeded = true;
  const batches: typeof prepared[] = [];
  for (let i = 0; i < prepared.length; i += 3) batches.push(prepared.slice(i, i + 3));
  for (const batch of batches) {
    if (loadActiveAccountId() !== accountId) {
      allSucceeded = false;
      continue;
    }
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
          operationId: entry.vectorMemoryPendingOperationId,
          expectedRevision: entry.expectedRevision,
          characterGeneration: entry.vectorMemoryCharacterGeneration,
          memoryGeneration: entry.vectorMemoryMemoryGeneration,
          metadata: entry.metadata ?? {},
        })) }),
      });
      if (!response.ok) {
        allSucceeded = false;
        console.warn("[VectorMemory] Index endpoint returned HTTP " + response.status);
        continue;
      }
      const payload = await response.json().catch(() => null);
      const results = payload && Array.isArray(payload.results) ? payload.results : null;
      if (!results || results.length !== batch.length) {
        allSucceeded = false;
        console.warn("[VectorMemory] Index endpoint returned malformed CAS results");
        continue;
      }
      for (let index = 0; index < batch.length; index++) {
        const entry = batch[index];
        const result = results[index] as { success?: unknown; status?: unknown; revision?: unknown; currentRevision?: unknown } | null;
        if (result?.success === true && (result.status === "committed" || result.status === "already_committed")
          && Number.isSafeInteger(result.revision) && Number(result.revision) > 0) {
          await persistVectorMemoryRevision(entry, Number(result.revision));
          await removePendingMemoryIndexes([entry]);
        } else if (result?.success === true && (result.status === "deleted" || result.status === "stale_generation")) {
          await clearVectorMemoryConflict(entry);
          await removePendingMemoryIndexes([entry]);
        } else {
          allSucceeded = false;
          if (result?.status === "conflict" && Number.isSafeInteger(result.currentRevision)
            && Number(result.currentRevision) >= 0) {
            await persistVectorMemoryConflict(entry, Number(result.currentRevision));
            // Stop automatic retries in both ordinary and explicit-import queues.
            // The user must explicitly choose whether the local snapshot should
            // replace the newer cloud revision.
            await removePendingMemoryIndexes([entry]);
            await removeImportedMemoryPendingEntries([entry]);
          }
          console.warn("[VectorMemory] CAS did not commit source " + entry.id + ": " + String(result?.status ?? "unknown"));
        }
      }
    } catch (error) {
      allSucceeded = false;
      console.warn("[VectorMemory] Incremental CAS indexing failed; local save remains unaffected.", error);
    }
  }
  return allSucceeded;
}
export async function syncMemoryEntriesToVectorCloud(entries: VectorSyncEntry[]): Promise<boolean> {
  return withVectorCloudMutation(async () => {
    return syncMemoryEntriesToVectorCloudUnlocked(entries);
  });
}
/**
 * Recover cloud indexing for older local core/long-term memories that predate
 * durable pending-index records. Only the current account's eligible, verified
 * memories are stamped and uploaded; unsafe/unverified timeline summaries remain local.
 */
export async function backfillLocalMemoryVectors(allowedCharacterIds?: string[]): Promise<number> {
  if (typeof window === "undefined") return 0;
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  if (!accountId) return 0;
  const allowed = allowedCharacterIds ? new Set(allowedCharacterIds) : null;
  const characterIds = (await getAllCharacterIdsWithMemories()).filter(characterId => !allowed || allowed.has(characterId));
  let queued = 0;
  for (const characterId of characterIds) {
    if (loadActiveAccountId() !== accountId) break;
    const generation = loadCachedVectorMemoryGeneration(accountId, characterId);
    if (!generation) continue;
    const localEntries = await loadMemoryEntries(characterId);
    const candidates: VectorSyncEntry[] = [];
    for (const entry of localEntries) {
      if ((entry.type !== "core" && entry.type !== "long_term")
        || (!entry.vectorMemoryAccountId && entry.sourceApp !== "chat")
        || (entry.vectorMemoryAccountId && entry.vectorMemoryAccountId !== accountId)
        || (Number.isSafeInteger(entry.vectorMemoryCharacterGeneration)
          && entry.vectorMemoryCharacterGeneration !== generation.characterGeneration)
        || (Number.isSafeInteger(entry.vectorMemoryMemoryGeneration)
          && entry.vectorMemoryMemoryGeneration !== generation.memoryGeneration)
        || entry.metadata?.includesGroupChat === true
        || entry.metadata?.includesStaleChat === true
        || entry.metadata?.includesUnverifiedTimeline === true
        || entry.vectorMemoryConflictRevision !== undefined) continue;
      const stamped: MemoryEntry = {
        ...entry,
        vectorMemoryAccountId: accountId,
        vectorMemoryCharacterGeneration: generation.characterGeneration,
        vectorMemoryMemoryGeneration: generation.memoryGeneration,
      };
      if (entry.vectorMemoryIndexedFingerprint === vectorMemoryPayloadFingerprint(stamped as VectorSyncEntry)
        && Number.isSafeInteger(entry.vectorMemoryRevision)
        && entry.vectorMemoryCharacterGeneration === generation.characterGeneration
        && entry.vectorMemoryMemoryGeneration === generation.memoryGeneration
        && !entry.vectorMemoryPendingOperationId) continue;
      if (entry.vectorMemoryAccountId !== accountId
        || entry.vectorMemoryCharacterGeneration !== generation.characterGeneration
        || entry.vectorMemoryMemoryGeneration !== generation.memoryGeneration) {
        await saveMemoryEntry(stamped);
      }
      if (isEligibleVectorMemoryEntry(stamped)) candidates.push(stamped as VectorSyncEntry);
    }
    if (candidates.length && loadActiveAccountId() === accountId) {
      await syncMemoryEntriesToVectorCloud(candidates).catch(error => {
        console.warn("[VectorMemory] Historical memory backfill remains queued.", error);
        return false;
      });
      queued += candidates.length;
    }
  }
  return queued;
}

export async function retryPendingMemoryIndexes(allowedCharacterIds?: string[]): Promise<number> {
  return withVectorCloudMutation(async () => {
    await hydrateKvDb();
    const accountId = loadActiveAccountId();
    const allowed = allowedCharacterIds ? new Set(allowedCharacterIds) : null;
    const pending = loadPendingMemoryIndexes().filter(entry =>
      entry.vectorMemoryAccountId === accountId && (!allowed || allowed.has(entry.characterId))
    );
    if (!pending.length) return 0;
    const ready = pending.filter(entry =>
      hasValidGeneration(entry) || Boolean(loadCachedVectorMemoryGeneration(accountId, entry.characterId))
    );
    if (!ready.length) return 0;
    const success = await syncMemoryEntriesToVectorCloudUnlocked(ready);
    if (success) {
      await removePendingMemoryIndexes(ready);
      await removeSyncedImportedMemoryPending(ready);
    }
    return success ? ready.length : 0;
  });
}

export async function retryPendingMemoryVectorDeletes(): Promise<number> {
  return withVectorCloudMutation(async () => {
    const individual = await retryPendingMemoryVectorDeletesUnlocked();
    const bulk = await retryPendingBulkVectorDeletesUnlocked();
    return individual + bulk;
  });
}

export async function syncImportedMemoryPending(allowedCharacterIds?: string[]): Promise<{ synced: number; success: boolean }> {
  return withVectorCloudMutation(async () => {
    await hydrateKvDb();
    const accountId = loadActiveAccountId();
    const allowed = allowedCharacterIds ? new Set(allowedCharacterIds) : null;
    const pending = loadImportedMemoryPending().filter(entry =>
      entry.vectorMemoryAccountId === accountId && (!allowed || allowed.has(entry.characterId))
    );
    if (!pending.length) return { synced: 0, success: true };
    const ready = pending.filter(entry =>
      hasValidGeneration(entry) || Boolean(loadCachedVectorMemoryGeneration(accountId, entry.characterId))
    );
    if (!ready.length) return { synced: 0, success: false };
    const success = await syncMemoryEntriesToVectorCloudUnlocked(ready);
    if (success) await removeSyncedImportedMemoryPending(ready);
    return {
      synced: success ? ready.length : 0,
      success: success && ready.length === pending.length,
    };
  });
}
