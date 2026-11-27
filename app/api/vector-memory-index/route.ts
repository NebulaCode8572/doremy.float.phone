import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getVectorMemorySupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { generateVectorMemoryEmbedding } from "@/lib/server/vector-memory-embedding";
import { commitVectorMemoryCas } from "@/lib/server/vector-memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BATCH = 3;
const MAX_CONTENT = 12_000;
const SOURCE_KINDS = new Set(["summary", "core_memory", "long_term_memory", "chat_chunk"]);

function safeDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

export async function POST(request: Request) {
  try {
    if (!getVectorMemorySupabaseServerConfig()) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[VectorMemory] index route blocked: dedicated Supabase URL/service-role key is missing or the host is not the isolated test project.");
      }
      return NextResponse.json({ errorCode: "vector_memory_supabase_not_configured", error: "Vector Memory Supabase 服务未配置" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      if (process.env.NODE_ENV !== "production") console.warn("[VectorMemory] index route blocked: account authentication failed.");
      return NextResponse.json({ errorCode: "unauthorized", error: "请先登录" }, { status: 401 });
    }
    const parsed = await readLimitedJson(request, 48_000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (process.env.NODE_ENV !== "production") {
      console.info("[VectorMemory] index route accepted request.", { entryCount: entries.length });
    }
    if (!entries.length || entries.length > MAX_BATCH) return NextResponse.json({ error: "每批最多索引 3 条向量内容" }, { status: 400 });
    const results: Array<{ id: string; success: boolean; status?: string; revision?: number; currentRevision?: number; errorCode?: string; error?: string; skipped?: "deleted" }> = [];
    for (const item of entries) {
      const id = typeof item?.id === "string" ? item.id.slice(0, 240) : "";
      const characterId = typeof item?.characterId === "string" ? item.characterId.slice(0, 160) : "";
      const sourceApp = typeof item?.sourceApp === "string" ? item.sourceApp.slice(0, 100) : "";
      const sourceKind = typeof item?.sourceKind === "string" ? item.sourceKind : "";
      const content = typeof item?.content === "string" ? item.content.trim() : "";
      const metadata = item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? item.metadata as Record<string, unknown> : {};
      const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : "";
      const operationId = typeof item?.operationId === "string" ? item.operationId : "";
      const expectedRevision = item?.expectedRevision;
      const characterGeneration = item?.characterGeneration;
      const memoryGeneration = item?.memoryGeneration;
      if (!id || !characterId || !sourceApp || !SOURCE_KINDS.has(sourceKind) || !content || content.length > MAX_CONTENT
        || !/^[A-Za-z0-9_-]{16,120}$/.test(operationId)
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || !Number.isSafeInteger(characterGeneration) || characterGeneration < 0
        || !Number.isSafeInteger(memoryGeneration) || memoryGeneration < 0
        || (sourceKind === "chat_chunk" && (sourceApp !== "chat" || !/^[A-Za-z0-9_-]{1,140}$/.test(sessionId)))) {
        results.push({ id, success: false, errorCode: "invalid_entry", error: "记忆条目格式无效" });
        continue;
      }
      let stage: "embedding" | "cas" = "embedding";
      try {
        const embedding = await generateVectorMemoryEmbedding(account.id, content);
        stage = "cas";
        const committed = await commitVectorMemoryCas({
          userId: account.id,
          characterId,
          sourceApp,
          sourceId: id,
          sourceKind: sourceKind as "summary" | "core_memory" | "long_term_memory" | "chat_chunk",
          content,
          embedding,
          metadata,
          operationId,
          expectedRevision,
          characterGeneration,
          memoryGeneration,
          ...(sourceKind === "chat_chunk" ? { sessionId } : {}),
        });
        if (committed.status === "committed" || committed.status === "already_committed") {
          results.push({ id, success: true, status: committed.status, revision: committed.revision });
        } else if (committed.status === "deleted" || committed.status === "stale_generation") {
          results.push({ id, success: true, status: committed.status, skipped: "deleted" });
        } else if (committed.status === "conflict") {
          results.push({ id, success: false, status: committed.status, errorCode: "revision_conflict", currentRevision: committed.currentRevision, error: "来源版本冲突；保留本地内容，等待重新协调" });
        } else {
          results.push({ id, success: false, status: committed.status, errorCode: committed.status, error: "服务端拒绝该操作" });
        }
      } catch (error) {
        console.error(`[VectorMemory] ${stage} stage failed`, {
          sourceKind,
          characterId,
          sourceId: id,
          message: safeDiagnosticMessage(error),
        });
        results.push({
          id,
          success: false,
          errorCode: stage === "embedding" ? "embedding_failed" : "cas_failed",
          error: stage === "embedding" ? "向量生成失败" : "云端提交失败",
        });
      }
    }
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[VectorMemory] index route failed", safeDiagnosticMessage(error));
    return NextResponse.json({ errorCode: "index_request_failed", error: "Vector Memory 索引请求失败" }, { status: 500 });
  }
}
