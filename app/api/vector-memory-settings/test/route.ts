import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getVectorMemorySupabaseServerConfig, vectorMemorySupabaseRestFetch } from "@/lib/server/supabase-rest";
import { testVectorMemoryEmbedding } from "@/lib/server/vector-memory-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!getVectorMemorySupabaseServerConfig()) return NextResponse.json({ error: "Vector Memory Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const result = await testVectorMemoryEmbedding(account.id);
    const databaseProbe = await vectorMemorySupabaseRestFetch<unknown>("rpc/match_vector_memory", {
      method: "POST",
      body: JSON.stringify({
        query_embedding: `[${result.embedding.join(",")}]`,
        match_user_id: account.id,
        match_character_id: "__vector_memory_settings_probe__",
        match_threshold: 0.30,
        match_count: 1,
      }),
    });
    if (!databaseProbe.ok) throw new Error("Vector Memory 数据库连接失败：" + databaseProbe.error);
    return NextResponse.json({
      ok: true,
      message: "Embedding API 与 Vector Memory 数据库连接成功",
      dimensions: result.dimensions,
      database: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Embedding API 测试失败";
    return NextResponse.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
