import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getVectorMemorySupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { getVectorMemoryGeneration } from "@/lib/server/vector-memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

export async function POST(request: Request) {
  try {
    if (!getVectorMemorySupabaseServerConfig()) {
      console.error("[VectorMemory] generation route blocked: dedicated Supabase URL/service-role key is missing or the host is not the isolated test project.");
      return NextResponse.json({ errorCode: "vector_memory_supabase_not_configured", error: "Vector Memory Supabase 服务未配置" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      console.error("[VectorMemory] generation route blocked: account authentication failed.");
      return NextResponse.json({ errorCode: "unauthorized", error: "请先登录" }, { status: 401 });
    }

    const parsed = await readLimitedJson(request, 32_000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const rawIds = Array.isArray(parsed.value.characterIds) ? parsed.value.characterIds : [];
    if (!rawIds.length || rawIds.length > 200) {
      return NextResponse.json({ error: "角色列表无效" }, { status: 400 });
    }
    const characterIds = [...new Set(rawIds.filter((value): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 160
    ))];
    console.info("[VectorMemory] generation route accepted request.", { characterCount: characterIds.length, accountMode: account.id === "local_user" ? "self_hosted" : "account" });
    if (characterIds.length !== rawIds.length) {
      return NextResponse.json({ error: "角色 ID 列表包含无效项" }, { status: 400 });
    }

    const results = await Promise.all(characterIds.map(async characterId => {
      try {
        const generation = await getVectorMemoryGeneration(account.id, characterId);
        return { characterId, success: true as const, ...generation };
      } catch (error) {
        console.error("[VectorMemory] generation lookup failed", {
          characterId,
          message: safeDiagnosticMessage(error),
        });
        return { characterId, success: false as const, errorCode: "generation_lookup_failed" };
      }
    }));
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[VectorMemory] generation route failed", safeDiagnosticMessage(error));
    return NextResponse.json({ errorCode: "generation_request_failed", error: "Vector Memory generation 请求失败" }, { status: 500 });
  }
}
