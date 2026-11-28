import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { callVisionProvider, loadVisionSettings } from "@/lib/server/vision-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const { publicSettings, apiKey } = await loadVisionSettings(account.id);
    if (!publicSettings.configured || !apiKey) return NextResponse.json({ error: "请先配置视觉模型 API" }, { status: 400 });
    const response = await callVisionProvider(publicSettings.baseUrl, apiKey, {
      model: publicSettings.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请观察这张测试图片，并简短说明你是否成功读取了图片内容。" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC" } },
        ],
      }],
      max_tokens: 32,
    });
    if (!response.ok) {
      return NextResponse.json({ error: `视觉模型返回 HTTP ${response.status}: ${response.text.slice(0, 180)}` }, { status: 502 });
    }
    let data: any;
    try { data = JSON.parse(response.text); }
    catch { return NextResponse.json({ error: "视觉模型返回了无效 JSON。" }, { status: 502 }); }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return NextResponse.json({ error: "模型连接成功，但没有返回文本" }, { status: 502 });
    return NextResponse.json({ ok: true, message: "视觉模型连接成功" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "连接测试失败" }, { status: 500 });
  }
}
