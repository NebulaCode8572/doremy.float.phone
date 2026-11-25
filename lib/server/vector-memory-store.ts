import { supabaseRestFetch } from "@/lib/server/supabase-rest";

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

export type VectorMemoryGeneration = { characterGeneration: number; memoryGeneration: number };

export async function getVectorMemoryGeneration(userId: string, characterId: string): Promise<VectorMemoryGeneration> {
  const result = await supabaseRestFetch<unknown>("rpc/get_vector_memory_generation", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_character_id: characterId }),
  });
  if (!result.ok) throw new Error(result.error);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  const value = row as { character_generation?: unknown; memory_generation?: unknown } | null;
  const characterGeneration = Number(value?.character_generation);
  const memoryGeneration = Number(value?.memory_generation);
  if (!Number.isSafeInteger(characterGeneration) || characterGeneration < 0
    || !Number.isSafeInteger(memoryGeneration) || memoryGeneration < 0) {
    throw new Error("Vector Memory generation response invalid");
  }
  return { characterGeneration, memoryGeneration };
}

export type VectorMemoryCasResult =
  | { status: "committed" | "already_committed"; revision: number }
  | { status: "conflict"; currentRevision: number }
  | { status: "deleted" | "stale_generation" | "operation_id_reused" | "invalid" };

export async function commitVectorMemoryCas(
  record: VectorMemoryRecord & {
    sessionId?: string;
    operationId: string;
    expectedRevision: number;
    characterGeneration: number;
    memoryGeneration: number;
  },
): Promise<VectorMemoryCasResult> {
  validateRecord(record);
  if (!record.operationId || record.operationId.length < 16 || record.operationId.length > 120) {
    throw new Error("Vector Memory operation ID 无效");
  }
  if (!Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0) {
    throw new Error("Vector Memory expected revision 无效");
  }
  const result = await supabaseRestFetch<unknown>("rpc/commit_vector_memory_cas", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: record.userId,
      p_character_id: record.characterId,
      p_source_app: record.sourceApp,
      p_source_id: record.sourceId,
      p_source_kind: record.sourceKind,
      p_session_id: record.sessionId ?? null,
      p_operation_id: record.operationId,
      p_expected_revision: record.expectedRevision,
      p_character_generation: record.characterGeneration,
      p_memory_generation: record.memoryGeneration,
      p_content: record.content.trim(),
      p_embedding: `[${record.embedding.join(",")}]`,
      p_metadata: record.metadata ?? {},
    }),
  });
  if (!result.ok) throw new Error(result.error);
  const value = (Array.isArray(result.data) ? result.data[0] : result.data) as Record<string, unknown> | null;
  const status = value?.status;
  if (status === "committed" || status === "already_committed") {
    const revision = Number(value?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Vector Memory CAS revision response invalid");
    return { status, revision };
  }
  if (status === "conflict") {
    const currentRevision = Number(value?.current_revision);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw new Error("Vector Memory CAS conflict response invalid");
    return { status, currentRevision };
  }
  if (status === "deleted" || status === "stale_generation" || status === "operation_id_reused" || status === "invalid") {
    return { status };
  }
  throw new Error("Vector Memory CAS response invalid");
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
