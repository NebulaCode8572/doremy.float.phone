import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

const TABLE = "app_user_vector_memories";
export type VectorMemorySourceKind = "summary" | "chat_chunk" | "core_memory" | "long_term_memory";
export type VectorMemoryRecord = {
  userId: string;
  characterId: string;
  sourceApp: string;
  sourceId: string;
  sourceKind: VectorMemorySourceKind;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

function validateRecord(record: VectorMemoryRecord): void {
  if (!record.userId || record.userId.length > 120) throw new Error("Vector Memory user ID 无效");
  if (!record.characterId || record.characterId.length > 160) throw new Error("Vector Memory character ID 无效");
  if (!record.sourceId || record.sourceId.length > 240) throw new Error("Vector Memory source ID 无效");
  if (!record.sourceApp || record.sourceApp.length > 100) throw new Error("Vector Memory source app 无效");
  if (!record.content.trim() || record.content.length > 12000) throw new Error("Vector Memory 内容为空或超过长度限制");
  if (!Array.isArray(record.embedding) || record.embedding.length !== 1024 || record.embedding.some(n => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error("Vector Memory embedding 必须是 1024 个有效数字");
  }
  if (!["summary", "chat_chunk", "core_memory", "long_term_memory"].includes(record.sourceKind)) throw new Error("Vector Memory 来源类型无效");
}

export async function upsertVectorMemory(record: VectorMemoryRecord): Promise<void> {
  validateRecord(record);
  const payload = {
    user_id: record.userId,
    character_id: record.characterId,
    source_app: record.sourceApp,
    source_id: record.sourceId,
    source_kind: record.sourceKind,
    content: record.content.trim(),
    embedding: `[${record.embedding.join(",")}]`,
    metadata: record.metadata ?? {},
    updated_at: new Date().toISOString(),
  };
  const result = await supabaseRestFetch<unknown[]>(`${TABLE}?on_conflict=user_id,character_id,source_app,source_id,source_kind`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!result.ok) throw new Error(result.error);
}

export async function deleteVectorMemorySource(userId: string, characterId: string, sourceApp: string, sourceId: string, sourceKind?: VectorMemorySourceKind): Promise<void> {
  const query = `user_id=eq.${encodeSupabaseFilter(userId)}&character_id=eq.${encodeSupabaseFilter(characterId)}&source_app=eq.${encodeSupabaseFilter(sourceApp)}&source_id=eq.${encodeSupabaseFilter(sourceId)}${sourceKind ? `&source_kind=eq.${encodeSupabaseFilter(sourceKind)}` : ""}`;
  const result = await supabaseRestFetch<unknown[]>(`${TABLE}?${query}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!result.ok) throw new Error(result.error);
}

export async function deleteVectorMemorySessionChatChunks(userId: string, characterId: string, sessionId: string): Promise<void> {
  const query = `user_id=eq.${encodeSupabaseFilter(userId)}&character_id=eq.${encodeSupabaseFilter(characterId)}&source_app=eq.chat&source_kind=eq.chat_chunk&metadata->>sessionId=eq.${encodeSupabaseFilter(sessionId)}`;
  const result = await supabaseRestFetch<unknown[]>(`${TABLE}?${query}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!result.ok) throw new Error(result.error);
}

export async function deleteVectorMemoriesForCharacter(userId: string, characterId: string): Promise<void> {
  const result = await supabaseRestFetch<unknown[]>(`${TABLE}?user_id=eq.${encodeSupabaseFilter(userId)}&character_id=eq.${encodeSupabaseFilter(characterId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!result.ok) throw new Error(result.error);
}
