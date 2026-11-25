import { loadMemoryConfig } from "@/lib/memory-storage";
import { hydrateKvDb, kvGet, kvSetAsync, registerKvMigration, registerDynamicPrefix } from "@/lib/kv-db";
import { loadActiveAccountId } from "@/lib/account-client";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";

const CHUNK_SIZE = 4;
const MAX_CHUNK_CONTENT = 10_000;

const chunkOperationQueues = new Map<string, Promise<void>>();
// A deleted session must not be re-indexed by stale refresh calls.
const deletedChatSessions = new Set<string>();

const CHAT_CHUNK_PENDING_KEY = "ai_phone_vector_memory_chat_chunk_pending_v1";
const CHAT_SESSION_DELETE_PENDING_KEY = "ai_phone_vector_memory_chat_session_delete_pending_v1";
const ACTIVE_CHUNK_PREFIX = "ai_phone_vector_memory_chat_chunk_active_v1:";
registerKvMigration(CHAT_CHUNK_PENDING_KEY);
registerKvMigration(CHAT_SESSION_DELETE_PENDING_KEY);
registerDynamicPrefix(ACTIVE_CHUNK_PREFIX);

type ActiveChunkState = { version: number; sourceId?: string; fingerprint?: string };

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
    };
  } catch { return { version: 0 }; }
}

async function saveActiveChunkState(key: string, value: ActiveChunkState): Promise<void> {
  await kvSetAsync(key, JSON.stringify(value));
}

function fingerprintChunk(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36) + ":" + content.length;
}
type PendingChatChunk = { accountId: string; characterId: string; sessionId: string; bucket: number; characterGeneration: number; operation: "upsert" | "delete" };
let pendingStateQueue: Promise<void> = Promise.resolve();

function readPendingChatChunks(): PendingChatChunk[] {
  try {
    const parsed = JSON.parse(kvGet(CHAT_CHUNK_PENDING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is PendingChatChunk =>
      item && typeof item.accountId === "string" && item.accountId.length > 0
      && typeof item.characterId === "string" && typeof item.sessionId === "string"
      && Number.isInteger(item.bucket) && item.bucket >= 0
      && Number.isSafeInteger(item.characterGeneration) && item.characterGeneration >= 0
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
  const indexingEnabled = loadMemoryConfig().vectorMemoryEnabled;
  let queued = 0;
  for (const entry of pending) {
    const session = sessions.find(item => item.id === entry.sessionId && item.contactId === entry.characterId && item.vectorMemoryAccountId === accountId && !item.isGroup);
    if (entry.operation === "delete" && (!indexingEnabled || !session)) {
      try {
        const stateKey = activeChunkStateKey(entry.accountId, entry.characterId, entry.sessionId, entry.bucket, entry.characterGeneration);
        const state = loadActiveChunkState(stateKey);
        if (state.sourceId) await deleteChatChunk(entry.accountId, entry.characterId, state.sourceId);
        await saveActiveChunkState(stateKey, { version: state.version });
        await clearChatChunkPending(entry);
      } catch {
        await markChatChunkPending(entry);
      }
      continue;
    }
    if (!indexingEnabled) continue;
    if (!session) {
      await clearChatChunkPending(entry);
      continue;
    }
    refreshChatMessageBucketsToVectorCloud(session, loadMessages(session.id), [entry.bucket], entry.characterGeneration);
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

function chunkQueueKey(characterId: string, sessionId: string, bucket: number, characterGeneration?: number, accountId = loadActiveAccountId()): string {
  return `${accountId}:${characterId}:${sessionId}:${characterGeneration ?? "legacy"}:${bucket}`;
}

function cleanMessageText(message: ChatMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (message.isRetracted || message.mediaType || message.status === "rejected") return "";
  const text = typeof message.content === "string" ? message.content.trim() : "";
  if (!text || text.length < 2) return "";
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
    const generation = session.vectorMemoryCharacterGeneration;
    const queueEntry: PendingChatChunk | null = generation === undefined
      ? null
      : { accountId, characterId: session.contactId, sessionId: session.id, bucket, characterGeneration: generation, operation: "delete" };
    enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, generation, accountId), async () => {
      try {
        if (generation === undefined) {
          await deleteChatChunk(accountId, session.contactId!, `session:${session.id}:chunk:${bucket}`);
          return;
        }
        const stateKey = activeChunkStateKey(accountId, session.contactId!, session.id, bucket, generation);
        const state = loadActiveChunkState(stateKey);
        if (state.sourceId) await deleteChatChunk(accountId, session.contactId!, state.sourceId);
        await saveActiveChunkState(stateKey, { version: state.version });
        if (queueEntry) await clearChatChunkPending(queueEntry);
      } catch (error) {
        if (queueEntry) await markChatChunkPending(queueEntry);
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
  const uniqueBuckets = [...new Set(buckets.filter(bucket => Number.isInteger(bucket) && bucket >= 0))];

  for (const bucket of uniqueBuckets) {
    const bucketMessages = allMessages
      .filter(item => item.sessionId === session.id && item.vectorMemoryAccountId === accountId && bucketForOrder(item.order) === bucket);
    const affectedInBucket = affectedMessages
      .filter(item => item.sessionId === session.id && item.vectorMemoryAccountId === accountId && bucketForOrder(item.order) === bucket);
    const generations = [...new Set(bucketMessages
      .map(item => item.vectorMemoryCharacterGeneration)
      .concat(affectedInBucket.map(item => item.vectorMemoryCharacterGeneration))
      .filter((value): value is number => Number.isSafeInteger(value) && (value ?? -1) >= 0)
      .filter(value => generationFilter === undefined || value === generationFilter))];

    if (generationFilter === undefined && affectedInBucket.some(item => !Number.isSafeInteger(item.vectorMemoryCharacterGeneration))) {
      enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, undefined, accountId), async () => {
        await deleteChatChunk(accountId, session.contactId!, `session:${session.id}:chunk:${bucket}`);
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

      // Deletions must reach the cloud even when new Vector Memory indexing is disabled.
      if (selected.length === 0) {
        enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, characterGeneration, accountId), async () => {
          try {
            const state = loadActiveChunkState(stateKey);
            if (state.sourceId) await deleteChatChunk(accountId, session.contactId!, state.sourceId);
            await saveActiveChunkState(stateKey, { version: state.version });
            await clearChatChunkPending(queueEntry);
          } catch (error) {
            await markChatChunkPending(queueEntry);
            throw error;
          }
        });
        continue;
      }

      if (!loadMemoryConfig().vectorMemoryEnabled) continue;

      const content = selected
        .map(({ item, text }) => `${item.role === "user" ? "用户" : "角色"}：${text}`)
        .join("\n")
        .slice(0, MAX_CHUNK_CONTENT);
      if (!content.trim()) continue;

      const sourceUpdatedAt = selected.reduce((latest, entry) => {
        const candidate = entry.item.updatedAt ?? entry.item.createdAt;
        return candidate > latest ? candidate : latest;
      }, "");
      const fingerprint = fingerprintChunk(content);
      const payloadBase = {
        characterId: session.contactId,
        sourceApp: "chat",
        sourceKind: "chat_chunk",
        content,
        updatedAt: sourceUpdatedAt,
        characterGeneration,
        memoryGeneration: 0,
        metadata: {
          sessionId: session.id,
          chunkIndex: bucket,
          messageIds: selected.map(entry => entry.item.id),
          updatedAt: sourceUpdatedAt,
        },
      };

      enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket, characterGeneration, accountId), async () => {
        if (deletedChatSessions.has(chatSessionKey(accountId, session.contactId!, session.id))) return;
        if (loadActiveAccountId() !== accountId) {
          await markChatChunkPending(queueEntry);
          return;
        }
        if (!loadMemoryConfig().vectorMemoryEnabled) return;
        try {
          const state = loadActiveChunkState(stateKey);
          let sourceId: string;
          if (state.sourceId && state.fingerprint === fingerprint) {
            sourceId = state.sourceId;
          } else {
            const nextVersion = state.version + 1;
            sourceId = `session:${session.id}:g:${characterGeneration}:chunk:${bucket}:v:${nextVersion}`;
            if (state.sourceId) await deleteChatChunk(accountId, session.contactId!, state.sourceId);
            await saveActiveChunkState(stateKey, { version: nextVersion, sourceId, fingerprint });
          }

          const response = await fetch("/api/vector-memory-index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ entries: [{ ...payloadBase, id: sourceId }] }),
          });
          if (!response.ok) {
            await markChatChunkPending(queueEntry);
            console.warn(`[VectorMemory] Chat chunk indexing returned HTTP ${response.status}`);
            return;
          }
          const result = await response.json().catch(() => null);
          const itemResult = Array.isArray(result?.results) ? result.results[0] : null;
          if (!itemResult || itemResult.success !== true) {
            await markChatChunkPending(queueEntry);
            console.warn("[VectorMemory] Chat chunk indexing endpoint returned HTTP 200 but did not confirm indexing success.");
          } else {
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

/** Refresh the fixed four-message bucket containing the saved assistant turn. */
export function syncChatMessageChunkToVectorCloud(session: ChatSession, message: ChatMessage, allMessages: ChatMessage[]): void {
  if (message.sessionId !== session.id || message.role !== "assistant") return;
  refreshChatMessageBucketsToVectorCloud(session, allMessages, [bucketForOrder(message.order)]);
}
