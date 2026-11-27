import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getVectorMemorySupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { deleteVectorMemorySource, deleteVectorMemorySessionChatChunks } from "@/lib/server/vector-memory-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    if (!getVectorMemorySupabaseServerConfig()) return NextResponse.json({ error: "Vector Memory Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readLimitedJson(request, 4000);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const characterId = typeof parsed.value.characterId === "string" ? parsed.value.characterId.trim() : "";
    const sourceId = typeof parsed.value.sourceId === "string" ? parsed.value.sourceId.trim() : "";
    const sessionId = typeof parsed.value.sessionId === "string" ? parsed.value.sessionId.trim() : "";
    if (!characterId || characterId.length > 160) return NextResponse.json({ error: "聊天向量删除参数无效" }, { status: 400 });

    if (sessionId) {
      if (!/^[A-Za-z0-9_-]{1,140}$/.test(sessionId)) return NextResponse.json({ error: "会话 ID 无效" }, { status: 400 });
      await deleteVectorMemorySessionChatChunks(account.id, characterId, sessionId);
    } else {
      if (!/^session:[A-Za-z0-9_-]{1,140}:(?:g:\d+:)?(?:device:[A-Za-z0-9_-]{12,80}:)?chunk:\d{1,8}(?::v:\d{1,12}(?:-[A-Za-z0-9_-]{8,32})?)?$/.test(sourceId)) return NextResponse.json({ error: "聊天向量删除参数无效" }, { status: 400 });
      await deleteVectorMemorySource(account.id, characterId, "chat", sourceId, "chat_chunk");
    }
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "聊天向量删除失败" }, { status: 500 });
  }
}
