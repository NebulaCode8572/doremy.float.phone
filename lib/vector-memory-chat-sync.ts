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

/** Incrementally refresh the fixed four-message bucket containing the newly saved message. */
export function syncChatMessageChunkToVectorCloud(session: ChatSession, message: ChatMessage): void {
  if (typeof window === "undefined" || session.isGroup || !session.contactId || !loadMemoryConfig().vectorMemoryEnabled) return;
  if (message.sessionId !== session.id) return;
  const order = typeof message.order === "number" && Number.isFinite(message.order) ? message.order : 0;
  const bucket = Math.floor(Math.max(0, order) / CHUNK_SIZE);
  const messages = (typeof window !== "undefined" ? (window as Window & { __vectorMemoryChatMessages?: ChatMessage[] }).__vectorMemoryChatMessages : undefined);
  // The caller provides the latest message and the chunk is assembled from the current persisted cache below.
  if (!messages) return;
  const selected = messages
    .filter(item => item.sessionId === session.id && Math.floor(Math.max(0, typeof item.order === "number" ? item.order : 0) / CHUNK_SIZE) === bucket)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(item => ({ item, text: cleanMessageText(item) }))
    .filter(entry => entry.text);
  if (selected.length < 2) return;
  const content = selected.map(({ item, text }) => `${item.role === "user" ? "用户" : "角色"}：${text}`).join("\\n").slice(0, MAX_CHUNK_CONTENT);
  if (!content.trim()) return;
  const sourceId = `session:${session.id}:chunk:${bucket}`;
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
