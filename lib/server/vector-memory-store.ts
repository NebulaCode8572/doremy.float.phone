import { supabaseRestFetch } from "@/lib/server/supabase-rest";

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

type RevisionIdentity = Pick<VectorMemoryRecord, "userId" | "characterId" | "sourceApp" | "sourceId" | "sourceKind">;

export async function reserveVectorMemoryRevision(identity: RevisionIdentity): Promise<number> {
  const result = await supabaseRestFetch<unknown>("rpc/reserve_vector_memory_revision", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: identity.userId,
      p_character_id: identity.characterId,
      p_source_app: identity.sourceApp,
      p_source_id: identity.sourceId,
      p_source_kind: identity.sourceKind,
    }),
  });
  if (!result.ok) throw new Error(result.error);
  const revision = typeof result.data === "number" ? result.data : Number(result.data);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Vector Memory revision response invalid");
  return revision;
}

export async function upsertVectorMemory(record: VectorMemoryRecord, revision: number): Promise<boolean> {
  validateRecord(record);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Vector Memory revision 无效");
  const result = await supabaseRestFetch<unknown>("rpc/commit_vector_memory_revision", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: record.userId,
      p_character_id: record.characterId,
      p_source_app: record.sourceApp,
      p_source_id: record.sourceId,
      p_source_kind: record.sourceKind,
      p_revision: revision,
      p_content: record.content.trim(),
      p_embedding: `[${record.embedding.join(",")}]`,
      p_metadata: record.metadata ?? {},
    }),
  });
  if (!result.ok) throw new Error(result.error);
  return result.data === true;
}

async function callDeleteRpc(name: string, body: Record<string, unknown>): Promise<void> {
  const result = await supabaseRestFetch<unknown>(`rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!result.ok) throw new Error(result.error);
}

export async function deleteVectorMemorySource(userId: string, characterId: string, sourceApp: string, sourceId: string, sourceKind?: VectorMemorySourceKind): Promise<void> {
  await callDeleteRpc("delete_vector_memory_source", {
    p_user_id: userId, p_character_id: characterId, p_source_app: sourceApp,
    p_source_id: sourceId, p_source_kind: sourceKind ?? null,
  });
}

export async function deleteVectorMemorySessionChatChunks(userId: string, characterId: string, sessionId: string): Promise<void> {
  await callDeleteRpc("delete_vector_memory_session_chunks", {
    p_user_id: userId, p_character_id: characterId, p_session_id: sessionId,
  });
}

export async function deleteVectorMemoryEntriesForCharacter(userId: string, characterId: string): Promise<void> {
  await callDeleteRpc("delete_vector_memory_character", {
    p_user_id: userId, p_character_id: characterId, p_memory_only: true,
  });
}

export async function deleteVectorMemoriesForCharacter(userId: string, characterId: string): Promise<void> {
  await callDeleteRpc("delete_vector_memory_character", {
    p_user_id: userId, p_character_id: characterId, p_memory_only: false,
  });
}
