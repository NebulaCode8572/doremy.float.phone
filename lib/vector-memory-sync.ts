import type { MemoryEntry } from "@/lib/memory-types";
import { hydrateKvDb, kvGet, kvSetAsync, registerKvMigration } from "@/lib/kv-db";
import { loadMemoryConfig, loadMemoryEntries, saveMemoryEntry } from "@/lib/memory-storage";
import { loadActiveAccountId } from "@/lib/account-client";
import { loadCachedVectorMemoryGeneration, refreshCachedVectorMemoryGeneration } from "@/lib/vector-memory-generation";

export type VectorSyncEntry = Omit<Pick<MemoryEntry, "id" | "characterId" | "sourceApp" | "type" | "content" | "createdAt" | "updatedAt" | "metadata" | "vectorMemoryAccountId" | "vectorMemoryCharacterGeneration" | "vectorMemoryMemoryGeneration" | "vectorMemoryRevision" | "vectorMemoryConflictRevision" | "vectorMemoryPendingOperationId" | "vectorMemoryPendingFingerprint">, "sourceApp"> & { sourceApp: string };

function hasValidGeneration(entry: VectorSyncEntry): boolean {
  return typeof entry.vectorMemoryAccountId === "string" && entry.vectorMemoryAccountId.length > 0
    && Number.isSafeInteger(entry.vectorMemoryCharacterGeneration)
    && (entry.vectorMemoryCharacterGeneration ?? -1) >= 0
    && Number.isSafeInteger(entry.vectorMemoryMemoryGeneration)
    && (entry.vectorMemoryMemoryGeneration ?? -1) >= 0
    && entry.metadata?.includesGroupChat !== true
    && entry.metadata?.includesStaleChat !== true
    && entry.metadata?.includesUnverifiedTimeline !== true;
}


export type ImportedMemoryPendingEntry = VectorSyncEntry;
const IMPORT_PENDING_KEY = "ai_phone_vector_memory_import_pending_v1";
registerKvMigration(IMPORT_PENDING_KEY);

export function loadImportedMemoryPending(): ImportedMemoryPendingEntry[] {
  try {
    const raw = kvGet(IMPORT_PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.characterId === "string" && typeof entry.sourceApp === "string" && (entry.type === "core" || entry.type === "long_term") && typeof entry.content === "string" && typeof entry.createdAt === "string" && typeof entry.updatedAt === "string" && hasValidGeneration(entry)) : [];
  } catch {
    return [];
  }
}

export async function addImportedMemoryPending(entries: ImportedMemoryPendingEntry[]): Promise<number> {
  await hydrateKvDb();
  if (!entries.length || !loadMemoryConfig().vectorMemoryEnabled) return 0;
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

  const explicitlyImported = entries.flatMap(entry => {
    const current = generations.get(entry.characterId);
    // If offline/no cache, the import remains local-only and is not queued.
    if (!current) return [];
    const {
      vectorMemoryRevision: _importedRevision,
      vectorMemoryConflictRevision: _importedConflictRevision,
      vectorMemoryPendingOperationId: _importedOperationId,
      vectorMemoryPendingFingerprint: _importedFingerprint,
      ...entryWithoutOldServerState
    } = entry;
    return [{
      ...entryWithoutOldServerState,
      vectorMemoryAccountId: accountId,
      vectorMemoryCharacterGeneration: current.characterGeneration,
      vectorMemoryMemoryGeneration: current.memoryGeneration,
    }];
  });
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
      uploaded.vectorMemoryCharacterGeneration !== entry.vectorMemoryCharacterGeneration ||
      uploaded.vectorMemoryMemoryGeneration !== entry.vectorMemoryMemoryGeneration ||
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
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.characterId === "string" && typeof item.id === "string" && typeof item.sourceApp === "string" && (item.type === "core" || item.type === "long_term" || item.type === "summary") && typeof item.content === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && hasValidGeneration(item)) : [];
  } catch { return []; }
}
async function enqueuePendingMemoryIndexes(entries: VectorSyncEntry[]): Promise<void> {
  entries = entries.filter(hasValidGeneration);
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
        body: JSON.stringify({ characterId: entry.characterId, sourceApp: entry.sourceApp, sourceId: entry.id, sourceKind: vectorSourceKind(entry) }),
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
    await removePendingMemoryIndexes(entries);
    await removeImportedMemoryPendingEntries(entries);

    const failed: PendingMemoryDelete[] = [];
    for (const entry of entries) {
      const ownerAccountId = entry.vectorMemoryAccountId!;
      if (loadActiveAccountId() !== ownerAccountId) {
        failed.push({
          accountId: ownerAccountId,
          characterId: entry.characterId,
          id: entry.id,
          sourceApp: entry.sourceApp,
          type: entry.type,
        });
        continue;
      }
      try {
        const response = await fetch("/api/vector-memory-entry", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ characterId: entry.characterId, sourceApp: entry.sourceApp, sourceId: entry.id, sourceKind: vectorSourceKind(entry) }),
        });
        if (!response.ok) failed.push({
          accountId: ownerAccountId,
          characterId: entry.characterId,
          id: entry.id,
          sourceApp: entry.sourceApp,
          type: entry.type,
        });
      } catch {
        failed.push({
          accountId: ownerAccountId,
          characterId: entry.characterId,
          id: entry.id,
          sourceApp: entry.sourceApp,
          type: entry.type,
        });
      }
    }
    if (failed.length) await enqueuePendingMemoryDeletes(failed);
  });
}


export async function deleteCharacterMemoryVectorsFromVectorCloud(characterId: string): Promise<void> {
  return withVectorCloudMutation(async () => {
  if (!characterId || typeof window === "undefined") return;
  const accountId = loadActiveAccountId();
  if (!accountId) return;
  const pendingDelete = { accountId, characterId, memoryOnly: true };
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

async function syncMemoryEntriesToVectorCloudUnlocked(entries: VectorSyncEntry[]): Promise<boolean> {
  const accountId = loadActiveAccountId();
  entries = entries.filter(entry => entry.vectorMemoryAccountId === accountId && hasValidGeneration(entry));
  if (!entries.length || typeof window === "undefined") return false;

  const prepared = entries.map(entry => {
    const fingerprint = vectorMemoryPayloadFingerprint(entry);
    const operationId = entry.vectorMemoryPendingFingerprint === fingerprint
      && typeof entry.vectorMemoryPendingOperationId === "string"
      ? entry.vectorMemoryPendingOperationId
      : createVectorMemoryOperationId();
    return {
      ...entry,
      vectorMemoryPendingOperationId: operationId,
      vectorMemoryPendingFingerprint: fingerprint,
      expectedRevision: Number.isSafeInteger(entry.vectorMemoryRevision) && (entry.vectorMemoryRevision ?? -1) >= 0
        ? entry.vectorMemoryRevision! : 0,
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
        const result = results[index] as { success?: unknown; status?: unknown; revision?: unknown } | null;
        if (result?.success === true && (result.status === "committed" || result.status === "already_committed")
          && Number.isSafeInteger(result.revision) && Number(result.revision) > 0) {
          await persistVectorMemoryRevision(entry, Number(result.revision));
          await removePendingMemoryIndexes([entry]);
        } else if (result?.success === true && result.status === "deleted") {
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
    // The Vector Memory toggle is the master gate for ordinary indexing.
    // Keep local saves unaffected and preserve any queued retries while disabled.
    if (!loadMemoryConfig().vectorMemoryEnabled) return false;
    return syncMemoryEntriesToVectorCloudUnlocked(entries);
  });
}
export async function retryPendingMemoryIndexes(): Promise<number> {
  return withVectorCloudMutation(async () => {
    await hydrateKvDb();
    if (!loadMemoryConfig().vectorMemoryEnabled) return 0;
    const accountId = loadActiveAccountId();
    const pending = loadPendingMemoryIndexes().filter(entry => entry.vectorMemoryAccountId === accountId);
    if (!pending.length) return 0;
    const success = await syncMemoryEntriesToVectorCloudUnlocked(pending);
    if (success) await removePendingMemoryIndexes(pending);
    return success ? pending.length : 0;
  });
}

export async function retryPendingMemoryVectorDeletes(): Promise<number> {
  return withVectorCloudMutation(async () => {
    const individual = await retryPendingMemoryVectorDeletesUnlocked();
    const bulk = await retryPendingBulkVectorDeletesUnlocked();
    return individual + bulk;
  });
}

export async function syncImportedMemoryPending(): Promise<{ synced: number; success: boolean }> {
  return withVectorCloudMutation(async () => {
    await hydrateKvDb();
    const accountId = loadActiveAccountId();
    const pending = loadImportedMemoryPending().filter(entry => entry.vectorMemoryAccountId === accountId);
    if (!pending.length) return { synced: 0, success: true };
    if (!loadMemoryConfig().vectorMemoryEnabled) return { synced: 0, success: false };
    const success = await syncMemoryEntriesToVectorCloudUnlocked(pending, false);
    if (success) await removeSyncedImportedMemoryPending(pending);
    return { synced: success ? pending.length : 0, success };
  });
}
