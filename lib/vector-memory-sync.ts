import type { MemoryEntry } from "@/lib/memory-types";

type VectorSyncEntry = Pick<MemoryEntry, "id" | "characterId" | "sourceApp" | "type" | "content" | "createdAt" | "updatedAt" | "metadata">;

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

export async function syncMemoryEntriesToVectorCloud(entries: VectorSyncEntry[]): Promise<void> {
  if (!entries.length || typeof window === "undefined") return;
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
      if (!response.ok) console.warn(`[VectorMemory] Index endpoint returned HTTP ${response.status}`);
    } catch (error) {
      console.warn("[VectorMemory] Incremental indexing failed; chat/memory save remains unaffected.", error);
    }
  }
}
