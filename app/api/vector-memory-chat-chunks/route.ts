import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { deleteVectorMemorySource } from "@/lib/server/vector-memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readLimitedJson(request, 4000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const characterId = typeof parsed.value.characterId === "string" ? parsed.value.characterId.trim() : "";
    const sourceId = typeof parsed.value.sourceId === "string" ? parsed.value.sourceId.trim() : "";
    const match = /^session:([A-Za-z0-9_-]{1,180}):chunk:(\\d{1,8})$/.exec(sourceId);
    if (!characterId || characterId.length > 160 || !match) return NextResponse.json({ error: "聊天向量删除参数无效" }, { status: 400 });
    await deleteVectorMemorySource(account.id, characterId, "chat", sourceId, "chat_chunk");
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "聊天向量删除失败" }, { status: 500 });
  }
}
