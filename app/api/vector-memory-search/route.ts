import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { generateVectorMemoryEmbedding } from "@/lib/server/vector-memory-embedding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

type Match = { id: string; source_app: string; source_id: string; source_kind: string; content: string; metadata: Record<string, unknown>; similarity: number };

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readLimitedJson(request, 16_000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const characterId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    if (!query || query.length > 5000 || !characterId || characterId.length > 160) return NextResponse.json({ error: "检索参数无效" }, { status: 400 });
    const embedding = await generateVectorMemoryEmbedding(account.id, query);
    const result = await supabaseRestFetch<Match[]>("rpc/match_vector_memory", {
      method: "POST",
      body: JSON.stringify({
        query_embedding: embedding,
        match_user_id: account.id,
        match_character_id: characterId,
        match_threshold: 0.30,
        match_count: 8,
      }),
    });
    if (!result.ok) return NextResponse.json({ error: "Vector Memory 语义检索失败" }, { status: 502 });
    const matches = Array.isArray(result.data) ? result.data.map(row => ({
      content: String(row.content ?? "").slice(0, 12000),
      sourceKind: row.source_kind,
      similarity: Number(row.similarity),
      createdAt: String(row.metadata?.createdAt ?? ""),
    })).filter(row => row.content && Number.isFinite(row.similarity)) : [];
    return NextResponse.json({ matches }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Vector Memory 检索失败" }, { status: 500 });
  }
}
