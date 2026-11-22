import type { MemoryEntry } from "@/lib/memory-types";

type VectorSyncEntry = Pick<MemoryEntry, "id" | "characterId" | "sourceApp" | "type" | "content" | "createdAt" | "updatedAt" | "metadata">;

export async function syncMemoryEntriesToVectorCloud(entries: VectorSyncEntry[]): Promise<void> {
  if (!entries.length || typeof window === "undefined") return;
  // Incremental and idempotent: only newly saved entries are sent, and source IDs
  // are stable for upsert. Keep indexing non-blocking for ordinary memory writes.
  const batches: VectorSyncEntry[][] = [];
  for (let i = 0; i < entries.length; i += 3) batches.push(entries.slice(i, i + 3));
  for (const batch of batches) {
    try {
      await fetch("/api/vector-memory-index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ entries: batch.map(entry => ({
          id: entry.id,
          characterId: entry.characterId,
          sourceApp: entry.sourceApp,
          sourceKind: entry.type === "core" ? "core_memory" : "summary",
          content: entry.content,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          metadata: entry.metadata ?? {},
        })) }),
      });
    } catch (error) {
      console.warn("[VectorMemory] Incremental indexing failed; chat/memory save remains unaffected.", error);
    }
  }
}
