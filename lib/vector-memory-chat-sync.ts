import { loadMemoryConfig } from "@/lib/memory-storage";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";

const CHUNK_SIZE = 4;
const MAX_CHUNK_CONTENT = 10_000;

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
  try {
    const response = await fetch("/api/vector-memory-chat-chunks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ characterId, sourceId: `session:${sessionId}:chunk:${bucket}` }),
    });
    if (!response.ok) console.warn(`[VectorMemory] Chat chunk deletion returned HTTP ${response.status}`);
  } catch (error) {
    console.warn("[VectorMemory] Chat chunk deletion failed; local chat remains unaffected.", error);
  }
}

export function refreshChatMessageBucketsToVectorCloud(
  session: ChatSession,
  allMessages: ChatMessage[],
  buckets: number[],
): void {
  if (typeof window === "undefined" || session.isGroup || !session.contactId) return;
  const uniqueBuckets = [...new Set(buckets.filter(bucket => Number.isInteger(bucket) && bucket >= 0))];
  for (const bucket of uniqueBuckets) {
    const selected = allMessages
      .filter(item => item.sessionId === session.id && bucketForOrder(item.order) === bucket)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(item => ({ item, text: cleanMessageText(item) }))
      .filter(entry => entry.text);
    const sourceId = `session:${session.id}:chunk:${bucket}`;
    if (!loadMemoryConfig().vectorMemoryEnabled || selected.length < 2) {
      void deleteChatChunk(session.contactId, session.id, bucket);
      continue;
    }
    const content = selected.map(({ item, text }) => `${item.role === "user" ? "用户" : "角色"}：${text}`).join("\n").slice(0, MAX_CHUNK_CONTENT);
    if (!content.trim()) {
      void deleteChatChunk(session.contactId, session.id, bucket);
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
    void fetch("/api/vector-memory-index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ entries: [payload] }),
    }).then(response => {
      if (!response.ok) console.warn(`[VectorMemory] Chat chunk indexing returned HTTP ${response.status}`);
    }).catch(error => console.warn("[VectorMemory] Chat chunk sync failed; chat save remains unaffected.", error));
  }
}

/** Refresh the fixed four-message bucket containing the saved assistant turn. */
export function syncChatMessageChunkToVectorCloud(session: ChatSession, message: ChatMessage, allMessages: ChatMessage[]): void {
  if (message.sessionId !== session.id || message.role !== "assistant") return;
  refreshChatMessageBucketsToVectorCloud(session, allMessages, [bucketForOrder(message.order)]);
}
