import { loadMemoryConfig } from "@/lib/memory-storage";
import { hydrateKvDb, kvGet, kvSetAsync, registerKvMigration } from "@/lib/kv-db";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";

const CHUNK_SIZE = 4;
const MAX_CHUNK_CONTENT = 10_000;

const chunkOperationQueues = new Map<string, Promise<void>>();
// A deleted session must not be re-indexed by stale refresh calls.
const deletedChatSessions = new Set<string>();

const CHAT_CHUNK_PENDING_KEY = "ai_phone_vector_memory_chat_chunk_pending_v1";
registerKvMigration(CHAT_CHUNK_PENDING_KEY);
type PendingChatChunk = { characterId: string; sessionId: string; bucket: number };
let pendingStateQueue: Promise<void> = Promise.resolve();

function readPendingChatChunks(): PendingChatChunk[] {
  try {
    const parsed = JSON.parse(kvGet(CHAT_CHUNK_PENDING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is PendingChatChunk =>
      item && typeof item.characterId === "string" && typeof item.sessionId === "string"
      && Number.isInteger(item.bucket) && item.bucket >= 0
    ) : [];
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
    const key = chunkQueueKey(entry.characterId, entry.sessionId, entry.bucket);
    const next = items.filter(item => chunkQueueKey(item.characterId, item.sessionId, item.bucket) !== key);
    next.push(entry);
    return next;
  });
}

function clearChatChunkPending(entry: PendingChatChunk): Promise<void> {
  const key = chunkQueueKey(entry.characterId, entry.sessionId, entry.bucket);
  return updatePendingChatChunks(items => items.filter(item => chunkQueueKey(item.characterId, item.sessionId, item.bucket) !== key));
}

function clearChatSessionPending(characterId: string, sessionId: string): Promise<void> {
  return updatePendingChatChunks(items => items.filter(item => item.characterId !== characterId || item.sessionId !== sessionId));
}

export async function retryPendingChatVectorChunks(
  sessions: ChatSession[],
  loadMessages: (sessionId: string) => ChatMessage[],
): Promise<number> {
  await hydrateKvDb();
  if (!loadMemoryConfig().vectorMemoryEnabled) return 0;
  const pending = readPendingChatChunks();
  let queued = 0;
  for (const entry of pending) {
    const session = sessions.find(item => item.id === entry.sessionId && item.contactId === entry.characterId && !item.isGroup);
    if (!session) {
      await clearChatChunkPending(entry);
      continue;
    }
    refreshChatMessageBucketsToVectorCloud(session, loadMessages(session.id), [entry.bucket]);
    queued++;
  }
  return queued;
}

function chatSessionKey(characterId: string, sessionId: string): string {
  return characterId + ":" + sessionId;
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

function chunkQueueKey(characterId: string, sessionId: string, bucket: number): string {
  return `${characterId}:${sessionId}:${bucket}`;
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

async function deleteChatChunk(characterId: string, sessionId: string, bucket: number): Promise<void> {
  const response = await fetch("/api/vector-memory-chat-chunks", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ characterId, sourceId: `session:${sessionId}:chunk:${bucket}` }),
  });
  if (!response.ok) console.warn(`[VectorMemory] Chat chunk deletion returned HTTP ${response.status}`);
}

export function deleteChatSessionVectorsFromCloud(session: ChatSession): void {
  if (typeof window === "undefined" || session.isGroup || !session.contactId) return;
  // Mark synchronously before taking the queue snapshot. Stale UI callbacks
  // arriving after this point cannot enqueue work that resurrects the vectors.
  deletedChatSessions.add(chatSessionKey(session.contactId, session.id));
  void clearChatSessionPending(session.contactId, session.id).catch(error => console.warn("[VectorMemory] Could not clear deleted session retry markers.", error));
  const prefix = session.contactId + ":" + session.id + ":";
  const pending = [...chunkOperationQueues.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, promise]) => promise);
  void Promise.all(pending).then(async () => {
    const response = await fetch("/api/vector-memory-chat-chunks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ characterId: session.contactId, sessionId: session.id }),
    });
    if (!response.ok) console.warn("[VectorMemory] Session vector cleanup returned HTTP " + response.status);
  }).catch(error => console.warn("[VectorMemory] Session vector cleanup failed; local chat remains unaffected.", error));
}

export function deleteChatMessageBucketsFromVectorCloud(session: ChatSession, buckets: number[]): void {
  if (typeof window === "undefined" || session.isGroup || !session.contactId) return;
  for (const bucket of [...new Set(buckets.filter(value => Number.isInteger(value) && value >= 0))]) {
    enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket), async () => {\n      await deleteChatChunk(session.contactId!, session.id, bucket);\n      await clearChatChunkPending({ characterId: session.contactId!, sessionId: session.id, bucket });\n    });
  }
}


export function refreshChatMessageBucketsToVectorCloud(
  session: ChatSession,
  allMessages: ChatMessage[],
  buckets: number[],
): void {
  if (typeof window === "undefined" || session.isGroup || !session.contactId) return;
  if (deletedChatSessions.has(chatSessionKey(session.contactId, session.id))) return;
  const uniqueBuckets = [...new Set(buckets.filter(bucket => Number.isInteger(bucket) && bucket >= 0))];
  for (const bucket of uniqueBuckets) {
    const selected = allMessages
      .filter(item => item.sessionId === session.id && bucketForOrder(item.order) === bucket)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(item => ({ item, text: cleanMessageText(item) }))
      .filter(entry => entry.text);
    const sourceId = `session:${session.id}:chunk:${bucket}`;
    if (!loadMemoryConfig().vectorMemoryEnabled) {
      // Disabling Vector Memory pauses indexing; it must not erase previously stored vectors.
      continue;
    }
    if (selected.length < 2) {
      enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket), () => deleteChatChunk(session.contactId!, session.id, bucket));
      continue;
    }
    const content = selected.map(({ item, text }) => `${item.role === "user" ? "用户" : "角色"}：${text}`).join("\n").slice(0, MAX_CHUNK_CONTENT);
    if (!content.trim()) {
      enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket), () => deleteChatChunk(session.contactId!, session.id, bucket));
      continue;
    }
    const payload = {
      id: sourceId,
      characterId: session.contactId,
      sourceApp: "chat",
      sourceKind: "chat_chunk",
      content,
      metadata: { sessionId: session.id, chunkIndex: bucket, messageIds: selected.map(entry => entry.item.id), updatedAt: new Date().toISOString() },
    };
    enqueueChatChunkOperation(chunkQueueKey(session.contactId, session.id, bucket), async () => {
      // Re-check deletion and settings when the queued operation actually runs.
      if (deletedChatSessions.has(chatSessionKey(session.contactId!, session.id))) return;
      if (!loadMemoryConfig().vectorMemoryEnabled) {
        // Settings may have changed while queued. Skip upload but preserve cloud data.
        return;
      }
      const response = await fetch("/api/vector-memory-index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ entries: [payload] }),
      });
      if (!response.ok) {
        console.warn(`[VectorMemory] Chat chunk indexing returned HTTP ${response.status}`);
        return;
      }
      const result = await response.json().catch(() => null);
      const itemResult = Array.isArray(result?.results) ? result.results[0] : null;
      if (!itemResult || itemResult.success !== true) {
        console.warn("[VectorMemory] Chat chunk indexing endpoint returned HTTP 200 but did not confirm indexing success.");
      }
    });
  }
}

/** Refresh the fixed four-message bucket containing the saved assistant turn. */
export function syncChatMessageChunkToVectorCloud(session: ChatSession, message: ChatMessage, allMessages: ChatMessage[]): void {
  if (message.sessionId !== session.id || message.role !== "assistant") return;
  refreshChatMessageBucketsToVectorCloud(session, allMessages, [bucketForOrder(message.order)]);
}
