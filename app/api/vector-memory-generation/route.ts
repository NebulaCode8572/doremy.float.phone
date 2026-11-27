import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { getVectorMemoryGeneration } from "@/lib/server/vector-memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const parsed = await readLimitedJson(request, 32_000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const rawIds = Array.isArray(parsed.value.characterIds) ? parsed.value.characterIds : [];
    if (!rawIds.length || rawIds.length > 200) {
      return NextResponse.json({ error: "角色列表无效" }, { status: 400 });
    }
    const characterIds = [...new Set(rawIds.filter((value): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 160
    ))];
    if (characterIds.length !== rawIds.length) {
      return NextResponse.json({ error: "角色 ID 列表包含无效项" }, { status: 400 });
    }

    const results = await Promise.all(characterIds.map(async characterId => {
      try {
        const generation = await getVectorMemoryGeneration(account.id, characterId);
        return { characterId, success: true as const, ...generation };
      } catch {
        return { characterId, success: false as const };
      }
    }));
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Vector Memory generation 请求失败" }, { status: 500 });
  }
}
