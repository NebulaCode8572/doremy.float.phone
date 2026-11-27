import { hydrateKvDb, kvGet, kvSetAsync, registerKvMigration, registerDynamicPrefix } from "@/lib/kv-db";
import { loadActiveAccountId } from "@/lib/account-client";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { loadCachedVectorMemoryGeneration, refreshCachedVectorMemoryGeneration } from "@/lib/vector-memory-generation";

const CHUNK_SIZE = 4;
const MAX_CHUNK_CONTENT = 10_000;

const chunkOperationQueues = new Map<string, Promise<void>>();
// A deleted session must not be re-indexed by stale refresh calls.
const deletedChatSessions = new Set<string>();
const characterGenerationRefreshes = new Map<string, Promise<void>>();

function refreshCharacterGenerationOnce(accountId: string, characterId: string): Promise<void> {
  const key = accountId + ":" + characterId;
  const existing = characterGenerationRefreshes.get(key);
  if (existing) return existing;
  const pending = refreshCachedVectorMemoryGeneration(characterId).finally(() => {
    if (characterGenerationRefreshes.get(key) === pending) characterGenerationRefreshes.delete(key);
  });
  characterGenerationRefreshes.set(key, pending);
  return pending;
}

const CHAT_CHUNK_PENDING_KEY = "ai_phone_vector_memory_chat_chunk_pending_v1";
const CHAT_SESSION_DELETE_PENDING_KEY = "ai_phone_vector_memory_chat_session_delete_pending_v1";
const ACTIVE_CHUNK_PREFIX = "ai_phone_vector_memory_chat_chunk_active_v1:";
const CHAT_DEVICE_ID_KEY = "ai_phone_vector_memory_chat_device_id_v1";
registerKvMigration(CHAT_CHUNK_PENDING_KEY);
registerKvMigration(CHAT_SESSION_DELETE_PENDING_KEY);
registerDynamicPrefix(ACTIVE_CHUNK_PREFIX);
registerKvMigration(CHAT_DEVICE_ID_KEY);
let chatVectorDeviceIdPromise: Promise<string> | null = null;
function getChatVectorDeviceId(): Promise<string> {
  if (!chatVectorDeviceIdPromise) {
    chatVectorDeviceIdPromise = (async () => {
      const existing = kvGet(CHAT_DEVICE_ID_KEY);
      if (existing && /^[A-Za-z0-9_-]{12,80}$/.test(existing)) return existing;
      const created = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
        : "d" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await kvSetAsync(CHAT_DEVICE_ID_KEY, created);
      return created;
    })().catch(error => {
      chatVectorDeviceIdPromise = null;
      throw error;
    });
  }
  return chatVectorDeviceIdPromise;
}
function createChatVectorSourceNonce(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14).padEnd(12, "0");
}
function createChatVectorOperationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "op" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}


type ActiveChunkState = { version: number; sourceId?: string; fingerprint?: string; revision?: number; operationId?: string };

function activeChunkStateKey(accountId: string, characterId: string, sessionId: string, bucket: number, generation: number): string {
  return ACTIVE_CHUNK_PREFIX + [
    encodeURIComponent(accountId), encodeURIComponent(characterId),
    encodeURIComponent(sessionId), String(generation), String(bucket),
  ].join(":");
}

function loadActiveChunkState(key: string): ActiveChunkState {
  try {
    const raw = kvGet(key);
    if (!raw) return { version: 0 };
    const value = JSON.parse(raw) as Partial<ActiveChunkState>;
    return {
      version: Number.isSafeInteger(value.version) && (value.version ?? -1) >= 0 ? value.version! : 0,
      ...(typeof value.sourceId === "string" ? { sourceId: value.sourceId } : {}),
      ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
      ...(Number.isSafeInteger(value.revision) && (value.revision ?? -1) >= 0 ? { revision: value.revision } : {}),
      ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
    };
  } catch { return { version: 0 }; }
}

async function saveActiveChunkState(key: string, value: ActiveChunkState): Promise<void> {
  await kvSetAsync(key, JSON.stringify(value));
}

function fingerprintChunk(content: string, messageIds: string[]): string {
  const snapshot = JSON.stringify([content, messageIds]);
  let hashA = 2166136261;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < snapshot.length; index++) {
    const code = snapshot.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 16777619);
    hashB = Math.imul(hashB ^ code, 2246822519);
  }
  return (hashA >>> 0).toString(36) + ":" + (hashB >>> 0).toString(36) + ":" + snapshot.length;
}
type PendingChatChunk = { accountId: string; characterId: string; sessionId: string; bucket: number; characterGeneration?: number; operation: "upsert" | "delete" };
let pendingStateQueue: Promise<void> = Promise.resolve();

function readPendingChatChunks(): PendingChatChunk[] {
  try {
    const parsed = JSON.parse(kvGet(CHAT_CHUNK_PENDING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is PendingChatChunk =>
      item && typeof item.accountId === "string" && item.accountId.length > 0
      && typeof item.characterId === "string" && typeof item.sessionId === "string"
      && Number.isInteger(item.bucket) && item.bucket >= 0
      && (item.characterGeneration === undefined
        || (Number.isSafeInteger(item.characterGeneration) && item.characterGeneration >= 0))
    ).map(item => ({ ...item, operation: item.operation === "delete" ? "delete" as const : "upsert" as const })) : [];
  } catch { return []; }
}

function updatePendingChatChunks(change: (items: PendingChatChunk[]) => PendingChatChunk[]): Promise<void> {
  const next = pendingStateQueue.catch(() => undefined).then(async () => {
    await hydrateKvDb();
    const items = change(readPendingChatChunks());
    await kvSetAsync(CHAT_CHUNK_PENDING_KEY, JSON.stringify(items.slice(-2000)));
  });
  pendingStateQueue = next;
  return next;
}

function markChatChunkPending(entry: PendingChatChunk): Promise<void> {
  return updatePendingChatChunks(items => {
    const key = chunkQueueKey(entry.characterId, entry.sessionId, entry.bucket, entry.characterGeneration, entry.accountId);
    const next = items.filter(item => chunkQueueKey(item.characterId, item.sessionId, item.bucket, item.characterGeneration, item.accountId) !== key);
    next.push(entry);
    return next;
  });
}

function clearChatChunkPending(entry: PendingChatChunk): Promise<void> {
  const key = chunkQueueKey(entry.characterId, entry.sessionId, entry.bucket, entry.characterGeneration, entry.accountId);
  return updatePendingChatChunks(items => items.filter(item => chunkQueueKey(item.characterId, item.sessionId, item.bucket, item.characterGeneration, item.accountId) !== key));
}

function clearChatSessionPending(accountId: string, characterId: string, sessionId: string): Promise<void> {
  return updatePendingChatChunks(items => items.filter(item =>
    item.accountId !== accountId || item.characterId !== characterId || item.sessionId !== sessionId
  ));
}

type PendingChatSessionDelete = { accountId: string; characterId: string; sessionId: string };

function readPendingChatSessionDeletes(): PendingChatSessionDelete[] {
  try {
    const parsed = JSON.parse(kvGet(CHAT_SESSION_DELETE_PENDING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(item =>
      item && typeof item.accountId === "string" && item.accountId.length > 0
      && typeof item.characterId === "string" && typeof item.sessionId === "string"
    ) : [];
  } catch { return []; }
}

async function enqueuePendingChatSessionDelete(entry: PendingChatSessionDelete): Promise<void> {
  await hydrateKvDb();
  const key = (item: PendingChatSessionDelete) => item.accountId + ":" + item.characterId + ":" + item.sessionId;
  const merged = new Map(readPendingChatSessionDeletes().map(item => [key(item), item]));
  merged.set(key(entry), entry);
  await kvSetAsync(CHAT_SESSION_DELETE_PENDING_KEY, JSON.stringify(Array.from(merged.values()).slice(-1000)));
}

async function removePendingChatSessionDelete(entry: PendingChatSessionDelete): Promise<void> {
  await hydrateKvDb();
  const key = entry.accountId + ":" + entry.characterId + ":" + entry.sessionId;
  const remaining = readPendingChatSessionDeletes().filter(item =>
    item.accountId + ":" + item.characterId + ":" + item.sessionId !== key
  );
  await kvSetAsync(CHAT_SESSION_DELETE_PENDING_KEY, JSON.stringify(remaining));
}

async function performPendingChatSessionDelete(entry: PendingChatSessionDelete): Promise<boolean> {
  if (loadActiveAccountId() !== entry.accountId) return false;
  const response = await fetch("/api/vector-memory-chat-chunks", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ characterId: entry.characterId, sessionId: entry.sessionId }),
  });
  if (!response.ok) return false;
  await clearChatSessionPending(entry.accountId, entry.characterId, entry.sessionId);
  await removePendingChatSessionDelete(entry);
  return true;
}

async function retryPendingChatSessionDeletes(): Promise<number> {
  await hydrateKvDb();
  const accountId = loadActiveAccountId();
  if (!accountId) return 0;
  let completed = 0;
  for (const entry of readPendingChatSessionDeletes().filter(item => item.accountId === accountId)) {
    try {
      if (await performPendingChatSessionDelete(entry)) completed++;
    } catch { /* Keep failed session deletion for a later retry. */ }
  }
  return completed;
}

export async function retryPendingChatVectorChunks(
  sessions: ChatSession[],
  loadMessages: (sessionId: string) => ChatMessage[],
): Promise<number> {
  await hydrateKvDb();
  await retryPendingChatSessionDeletes();
  const accountId = loadActiveAccountId();
  if (!accountId) return 0;
  const pending = readPendingChatChunks().filter(entry => entry.accountId === accountId);
  let queued = 0;
  for (const entry of pending) {
    const session = sessions.find(item => item.id === entry.sessionId && item.contactId === entry.characterId && item.vectorMemoryAccountId === accountId && !item.isGroup);
    if (entry.characterGeneration === undefined) {
      if (entry.operation !== "delete") continue;
      enqueueChatChunkOperation(chunkQueueKey(entry.characterId, entry.sessionId, entry.bucket, undefined, accountId), async () => {
        try {
          await markChatChunkPending(entry);
          await deleteChatChunk(accountId, entry.characterId, `session:${entry.sessionId}:chunk:${entry.bucket}`);
          await clearChatChunkPending(entry);
        } catch (error) {
          await markChatChunkPending(entry);
          throw error;
        }
      });
      queued++;
      continue;
    }
    if (entry.operation === "delete" && !session) {
      try {
        const stateKey = activeChunkStateKey(entry.accountId, entry.characterId, entry.sessionId, entry.bucket, entry.characterGeneration);
        const state = loadActiveChunkState(stateKey);
        await deleteChatChunk(entry.accountId, entry.characterId, state.sourceId || `session:${entry.sessionId}:chunk:${entry.bucket}`);
        await saveActiveChunkState(stateKey, { version: state.version });
        await clearChatChunkPending(entry);
      } catch {
        await markChatChunkPending(entry);
      }
      continue;
    }
    if (!session) {
      // An upsert may belong to a legacy session that has not been stamped yet.
      // Keep it pending until historical backfill can attach the current account
      // and rebuild the bucket; absence of the current marker is not proof of deletion.
      continue;
    }
    const sessionMessages = loadMessages(session.id);
    const hasCurrentGenerationMessages = sessionMessages.some(message =>
      message.sessionId === session.id
      && message.vectorMemoryAccountId === accountId
      && message.vectorMemoryCharacterGeneration === entry.characterGeneration
      && bucketForOrder(message.order) === entry.bucket
    );
    if (!hasCurrentGenerationMessages) {
      // The bucket may have been emptied or moved to a newer character generation
      // while the app was offline. Rebuild must delete the old generation's source,
      // otherwise its stale content remains searchable forever.
      const stateKey = activeChunkStateKey(entry.accountId, entry.characterId, entry.sessionId, entry.bucket, entry.characterGeneration);
      enqueueChatChunkOperation(chunkQueueKey(entry.characterId, entry.sessionId, entry.bucket, entry.characterGeneration, accountId), async () => {
        try {
          await markChatChunkPending(entry);
          const state = loadActiveChunkState(stateKey);
          await deleteChatChunk(accountId, entry.characterId, state.sourceId || `session:${entry.sessionId}:chunk:${entry.bucket}`);
          await saveActiveChunkState(stateKey, { version: state.version });
          await clearChatChunkPending(entry);
        } catch (error) {
          await markChatChunkPending(entry);
          throw error;
        }
      });
      queued++;
      continue;
    }
    refreshChatMessageBucketsToVectorCloud(session, sessionMessages, [entry.bucket], entry.characterGeneration);
    queued++;
  }
  return queued;
}

function chatSessionKey(accountId: string, characterId: string, sessionId: string): string {
  return accountId + ":" + characterId + ":" + sessionId;
}

function enqueueChatChunkOperation(key: string, operation: () => Promise<void>): void {
  const previous = chunkOperationQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation).catch(error => {
    console.warn("[VectorMemory] Chat chunk operation failed; chat save remains unaffected.", error);
  });
  chunkOperationQueues.set(key, next);
  void next.finally(() => {
    if (chunkOperationQueues.get(key) === next) chunkOperationQueues.delete(key);
  });
}

/** Wait until every queued chat-chunk write/delete currently in flight has settled. */
export async function waitForChatVectorChunkQueue(): Promise<void> {
  while (chunkOperationQueues.size > 0) {
    await Promise.all([...chunkOperationQueues.values()]);
  }
}

function chunkQueueKey(characterId: string, sessionId: string, bucket: number, characterGeneration?: number, accountId = loadActiveAccountId()): string {
  return `${accountId}:${characterId}:${sessionId}:${characterGeneration ?? "legacy"}:${bucket}`;
}

function cleanMessageText(message: ChatMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (message.isRetracted || message.status === "rejected") return "";
  const text = typeof message.content === "string" ? message.content.trim() : "";
  if (!text) return "";
  return text.slice(0, 5000);
}

function bucketForOrder(order: number | undefined): number {
  return Math.floor(Math.max(0, typeof order === "number" && Number.isFinite(order) ? order : 0) / CHUNK_SIZE);
}

async function deleteChatChunk(accountId: string, characterId: string, sourceId: string): Promise<void> {
  if (!accountId || loadActiveAccountId() !== accountId) throw new Error("[VectorMemory] Account changed before chat chunk deletion.");
  const response = await fetch("/api/vector-memory-chat-chunks", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ characterId, sourceId }),
  });
  if (!response.ok) throw new Error(`[VectorMemory] Chat chunk deletion returned HTTP ${response.status}`);
}

export function deleteChatSessionVectorsFromCloud(session: ChatSession): void {
  const accountId = loadActiveAccountId();
  if (typeof window === "undefined" || !accountId || session.vectorMemoryAccountId !== accountId || session.isGroup || !session.contactId) return;
  // Block stale refreshes immediately, then wait for already queued chunk operations.
  deletedChatSessions.add(chatSessionKey(accountId, session.contactId, session.id));
  const prefix = accountId + ":" + session.contactId + ":" + session.id + ":";
  const pending = [...chunkOperationQueues.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, promise]) => promise);
  const deletion = { accountId, characterId: session.contactId, sessionId: session.id };
  void enqueuePendingChatSessionDelete(deletion).then(async () => {
    await Promise.all(pending);
    await performPendingChatSessionDelete(deletion);
  }).catch(error => console.warn("[VectorMemory] Session vector cleanup failed; retry is preserved.", error));
}

export function deleteChatMessageBucketsFromVectorCloud(session: ChatSession, buckets: number[]): void {
  const accountId = loadActiveAccountId();
  if (typeof window === "undefined" || !accountId || session.vectorMemoryAccountId !== accountId || session.isGroup || !session.contactId) return;
  for (const bucket of [...new Set(buckets.filter(value => Number.isInteger(value) && value >= 0))]) {
    const generation = Number.isSafeInteger(session.vectorMemoryCharacterGeneration)
      && (session.vectorMemoryCharacterGeneration ?? -1) >= 0
      ? session.vectorMemoryCharacterGeneration
      : undefined;
    const queueEntry: PendingChatChunk = {
      accountId, characterId: session.contactId, sessionId: session.id, bucket,
      ...(generation !== undefined ? { characterGeneration: generation } : {}),
      operation: "delete",
    };
    enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, generation, accountId), async () => {
      try {
        await markChatChunkPending(queueEntry);
        if (generation === undefined) {
          await deleteChatChunk(accountId, session.contactId!, `session:${session.id}:chunk:${bucket}`);
          await clearChatChunkPending(queueEntry);
          return;
        }
        const stateKey = activeChunkStateKey(accountId, session.contactId!, session.id, bucket, generation);
        const state = loadActiveChunkState(stateKey);
        await deleteChatChunk(accountId, session.contactId!, state.sourceId || `session:${session.id}:chunk:${bucket}`);
        await saveActiveChunkState(stateKey, { version: state.version });
        await clearChatChunkPending(queueEntry);
      } catch (error) {
        await markChatChunkPending(queueEntry);
        throw error;
      }
    });
  }
}


export function refreshChatMessageBucketsToVectorCloud(
  session: ChatSession,
  allMessages: ChatMessage[],
  buckets: number[],
  generationFilter?: number,
  affectedMessages: ChatMessage[] = [],
): void {
  const accountId = loadActiveAccountId();
  if (typeof window === "undefined" || !accountId || session.vectorMemoryAccountId !== accountId || session.isGroup || !session.contactId) return;
  if (deletedChatSessions.has(chatSessionKey(accountId, session.contactId, session.id))) return;
  const currentGeneration = loadCachedVectorMemoryGeneration(accountId, session.contactId);
  const uniqueBuckets = [...new Set(buckets.filter(bucket => Number.isInteger(bucket) && bucket >= 0))];

  for (const bucket of uniqueBuckets) {
    const affectedInBucket = affectedMessages
      .filter(item => item.sessionId === session.id && item.vectorMemoryAccountId === accountId && bucketForOrder(item.order) === bucket);
    const bucketMessagesById = new Map(allMessages
      .filter(item => item.sessionId === session.id && item.vectorMemoryAccountId === accountId && bucketForOrder(item.order) === bucket)
      .map(item => [item.id, item]));
    // The affected snapshot is authoritative when a caller has edited/replaced
    // a message but its updated object is not yet present in allMessages.
    for (const message of affectedInBucket) bucketMessagesById.set(message.id, message);
    const bucketMessages = [...bucketMessagesById.values()];
    const generations = [...new Set(bucketMessages
      .map(item => item.vectorMemoryCharacterGeneration)
      .filter((value): value is number => Number.isSafeInteger(value) && (value ?? -1) >= 0)
      .filter(value => generationFilter === undefined || value === generationFilter))];
    // Deleting the last message in a bucket leaves no message from which to
    // infer its generation. Fall back to the session's current generation so
    // the persisted active source is still deleted from the cloud.
    if (generations.length === 0
      && Number.isSafeInteger(session.vectorMemoryCharacterGeneration)
      && (session.vectorMemoryCharacterGeneration ?? -1) >= 0
      && (generationFilter === undefined || session.vectorMemoryCharacterGeneration === generationFilter)) {
      generations.push(session.vectorMemoryCharacterGeneration!);
    }

    if (generationFilter === undefined && affectedInBucket.some(item => !Number.isSafeInteger(item.vectorMemoryCharacterGeneration))) {
      const legacyDelete: PendingChatChunk = {
        accountId, characterId: session.contactId, sessionId: session.id, bucket, operation: "delete",
      };
      enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, undefined, accountId), async () => {
        try {
          await markChatChunkPending(legacyDelete);
          await deleteChatChunk(accountId, session.contactId!, `session:${session.id}:chunk:${bucket}`);
          await clearChatChunkPending(legacyDelete);
        } catch (error) {
          await markChatChunkPending(legacyDelete);
          throw error;
        }
      });
    }

    for (const characterGeneration of generations) {
      const selected = bucketMessages
        .filter(item => item.vectorMemoryCharacterGeneration === characterGeneration)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(item => ({ item, text: cleanMessageText(item) }))
        .filter(entry => entry.text);
      const queueEntry: PendingChatChunk = {
        accountId, characterId: session.contactId, sessionId: session.id, bucket, characterGeneration,
        operation: selected.length === 0 ? "delete" : "upsert",
      };
      const stateKey = activeChunkStateKey(accountId, session.contactId, session.id, bucket, characterGeneration);

      // Empty buckets must still be deleted from the cloud.
      if (selected.length === 0) {
        enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, characterGeneration, accountId), async () => {
          try {
            await markChatChunkPending(queueEntry);
            const state = loadActiveChunkState(stateKey);
            await deleteChatChunk(accountId, session.contactId!, state.sourceId || `session:${session.id}:chunk:${bucket}`);
            await saveActiveChunkState(stateKey, { version: state.version });
            await clearChatChunkPending(queueEntry);
          } catch (error) {
            await markChatChunkPending(queueEntry);
            throw error;
          }
        });
        continue;
      }

      const content = selected
        .map(({ item, text }) => `${item.role === "user" ? "用户" : "角色"}：${text}`)
        .join("\n")
        .slice(0, MAX_CHUNK_CONTENT);
      if (!content.trim()) continue;

      // A cold generation cache must trigger a refresh, not permanently block
      // this bucket. Re-enter indexing after the authoritative generation arrives.
      if (!currentGeneration) {
        enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, characterGeneration, accountId), async () => {
          try {
            await markChatChunkPending(queueEntry);
            await refreshCharacterGenerationOnce(accountId, session.contactId!);
            if (loadActiveAccountId() !== accountId) return;
            if (!loadCachedVectorMemoryGeneration(accountId, session.contactId!)) {
              throw new Error("[VectorMemory] Character generation refresh did not return a usable generation.");
            }
            refreshChatMessageBucketsToVectorCloud(session, allMessages, [bucket], generationFilter, affectedMessages);
          } catch (error) {
            await markChatChunkPending(queueEntry);
            throw error;
          }
        });
        continue;
      }

      const messageIds = selected.map(entry => entry.item.id);
      const fingerprint = fingerprintChunk(content, messageIds);
      const payloadBase = {
        characterId: session.contactId,
        sourceApp: "chat",
        sourceKind: "chat_chunk",
        content,
        characterGeneration,
        memoryGeneration: currentGeneration.memoryGeneration,
        metadata: {
          sessionId: session.id,
          chunkIndex: bucket,
          messageIds,
        },
      };

      enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, characterGeneration, accountId), async () => {
        if (deletedChatSessions.has(chatSessionKey(accountId, session.contactId!, session.id))) return;
        if (loadActiveAccountId() !== accountId) {
          await markChatChunkPending(queueEntry);
          return;
        }
        try {
          await hydrateKvDb();
          const state = loadActiveChunkState(stateKey);
          if (state.sourceId && state.fingerprint === fingerprint
            && Number.isSafeInteger(state.revision) && !state.operationId) {
            // The current snapshot is already committed for this device/bucket.
            // A pending marker may have survived a crash after the commit but
            // before its cleanup, so clear it when the committed fingerprint matches.
            await clearChatChunkPending(queueEntry);
            return;
          }
          const deviceId = await getChatVectorDeviceId();
          let sourceId: string;
          let nextState: ActiveChunkState;
          if (state.sourceId && state.fingerprint === fingerprint) {
            sourceId = state.sourceId;
            nextState = { ...state };
          } else {
            const nextVersion = state.version + 1;
            // Device-scoped identity prevents two devices with independent local
            // counters from overwriting or reserving the same chat source.
            sourceId = `session:${session.id}:g:${characterGeneration}:device:${deviceId}:chunk:${bucket}:v:${nextVersion}-${createChatVectorSourceNonce()}`;
            nextState = { version: nextVersion, sourceId, fingerprint };
          }
          const operationId = nextState.operationId ?? createChatVectorOperationId();
          nextState = { ...nextState, operationId };
          // Persist retry intent before deleting the previous source, saving the
          // new CAS operation, or sending the request. A crash at any point after
          // this marker can safely retry the idempotent source deletion and upsert.
          await markChatChunkPending(queueEntry);
          if (state.sourceId && state.fingerprint !== fingerprint) {
            await deleteChatChunk(accountId, session.contactId!, state.sourceId);
          }
          await saveActiveChunkState(stateKey, nextState);

          if (loadActiveAccountId() !== accountId) {
            return;
          }
          const response = await fetch("/api/vector-memory-index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            signal: AbortSignal.timeout(45_000),
            body: JSON.stringify({ entries: [{
              ...payloadBase,
              id: sourceId,
              operationId,
              expectedRevision: nextState.revision ?? 0,
            }] }),
          });
          if (!response.ok) {
            const failure = await response.json().catch(() => null) as { errorCode?: string; error?: string } | null;
            await markChatChunkPending(queueEntry);
            console.warn("[VectorMemory] Chat chunk indexing request failed.", {
              httpStatus: response.status,
              errorCode: failure?.errorCode,
              error: failure?.error,
            });
            return;
          }
          const result = await response.json().catch(() => null);
          const itemResult = Array.isArray(result?.results) ? result.results[0] : null;
          if (itemResult?.success === true && ["deleted", "stale_generation"].includes(itemResult.status)) {
            await saveActiveChunkState(stateKey, { version: nextState.version });
            await clearChatChunkPending(queueEntry);
          } else if (!itemResult || itemResult.success !== true
            || !["committed", "already_committed"].includes(itemResult.status)
            || !Number.isSafeInteger(itemResult.revision)) {
            await markChatChunkPending(queueEntry);
            console.warn("[VectorMemory] Chat chunk CAS was not committed; pending state is retained.", {
              status: itemResult?.status,
              errorCode: itemResult?.errorCode,
              error: itemResult?.error,
            });
          } else {
            await saveActiveChunkState(stateKey, {
              ...nextState,
              revision: Number(itemResult.revision),
              operationId: undefined,
            });
            await clearChatChunkPending(queueEntry);
          }
        } catch (error) {
          await markChatChunkPending(queueEntry);
          throw error;
        }
      });
    }
  }
}

const chatSyncDiagnosticSessions = new Set<string>();

/** Refresh the fixed four-message bucket containing the saved assistant turn. */
export function syncChatMessageChunkToVectorCloud(session: ChatSession, message: ChatMessage, allMessages: ChatMessage[]): void {
  if (message.sessionId !== session.id || (message.role !== "user" && message.role !== "assistant")) return;
  const accountId = loadActiveAccountId();
  const diagnosticKey = accountId + ":" + session.id;
  if (!chatSyncDiagnosticSessions.has(diagnosticKey)) {
    chatSyncDiagnosticSessions.add(diagnosticKey);
    console.info("[VectorMemory] Chat message reached the cloud-sync entry point.", {
      accountMode: accountId === "local_user" ? "self_hosted" : accountId ? "account" : "none",
      isPrivateSession: !session.isGroup,
      hasCharacterId: Boolean(session.contactId),
      sessionAccountMatches: Boolean(accountId && session.vectorMemoryAccountId === accountId),
      messageAccountMatches: Boolean(accountId && message.vectorMemoryAccountId === accountId),
      hasCharacterGeneration: Number.isSafeInteger(message.vectorMemoryCharacterGeneration),
      cachedGenerationAvailable: Boolean(accountId && session.contactId && loadCachedVectorMemoryGeneration(accountId, session.contactId)),
      role: message.role,
    });
  }
  refreshChatMessageBucketsToVectorCloud(session, allMessages, [bucketForOrder(message.order)]);
}
