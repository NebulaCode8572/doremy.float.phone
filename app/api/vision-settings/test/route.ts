import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { loadVisionSettings } from "@/lib/server/vision-credentials";
import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const { publicSettings, apiKey } = await loadVisionSettings(account.id);
    if (!publicSettings.configured || !apiKey) return NextResponse.json({ error: "请先保存视觉模型配置" }, { status: 400 });
    const base = publicSettings.baseUrl.replace(/\/$/, "").replace(/\/chat\/completions$/i, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: publicSettings.model,
        messages: [{ role: "user", content: "请只回复：连接成功" }],
        max_tokens: 16,
      }),
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return NextResponse.json({ error: `视觉模型返回 HTTP ${response.status}: ${detail.slice(0, 180)}` }, { status: 502 });
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return NextResponse.json({ error: "模型连接成功，但没有返回文本" }, { status: 502 });
    return NextResponse.json({ ok: true, message: "视觉模型连接成功" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "连接测试失败" }, { status: 500 });
  }
}
