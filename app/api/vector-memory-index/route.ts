import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { generateVectorMemoryEmbedding } from "@/lib/server/vector-memory-embedding";
import { upsertVectorMemory } from "@/lib/server/vector-memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BATCH = 3;
const MAX_CONTENT = 12_000;
const SOURCE_KINDS = new Set(["summary", "core_memory", "chat_chunk"]);

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readLimitedJson(request, 48_000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.length || entries.length > MAX_BATCH) return NextResponse.json({ error: "每批最多索引 3 条向量内容" }, { status: 400 });
    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    for (const item of entries) {
      const id = typeof item?.id === "string" ? item.id.slice(0, 240) : "";
      const characterId = typeof item?.characterId === "string" ? item.characterId.slice(0, 160) : "";
      const sourceApp = typeof item?.sourceApp === "string" ? item.sourceApp.slice(0, 100) : "";
      const sourceKind = typeof item?.sourceKind === "string" ? item.sourceKind : "";
      const content = typeof item?.content === "string" ? item.content.trim() : "";
      if (!id || !characterId || !sourceApp || !SOURCE_KINDS.has(sourceKind) || !content || content.length > MAX_CONTENT) {
        results.push({ id, success: false, error: "记忆条目格式无效" });
        continue;
      }
      try {
        const embedding = await generateVectorMemoryEmbedding(account.id, content);
        await upsertVectorMemory({
          userId: account.id,
          characterId,
          sourceApp,
          sourceId: id,
          sourceKind: sourceKind as "summary" | "core_memory" | "chat_chunk",
          content,
          embedding,
          metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
        });
        results.push({ id, success: true });
      } catch {
        results.push({ id, success: false, error: "云端向量索引失败" });
      }
    }
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Vector Memory 索引请求失败" }, { status: 500 });
  }
}
