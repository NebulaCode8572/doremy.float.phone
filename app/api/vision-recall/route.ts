import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { callVisionProvider, loadVisionSettings } from "@/lib/server/vision-credentials";
import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_CHARS = 500_000;
const MAX_REQUEST_BYTES = 1_600_000;

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readLimitedJson(request, MAX_REQUEST_BYTES);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    const images = parsed.value.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > 3 ||
      images.some((image) => typeof image !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(image) || image.length > MAX_IMAGE_CHARS)) {
      return NextResponse.json({ error: "请上传 1 至 3 张 PNG、JPG 或 WebP 图片，每张图片请控制在约 350 KB 以内。" }, { status: 400 });
    }
    const { publicSettings, apiKey } = await loadVisionSettings(account.id);
    if (!publicSettings.configured || !apiKey) return NextResponse.json({ error: "尚未配置全局视觉模型，请先前往系统设置配置。" }, { status: 409 });
    const response = await callVisionProvider(publicSettings.baseUrl, apiKey, {
      model: publicSettings.model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: "你是学习资料阅读助手。阅读用户上传的学习资料图片，提取清晰可辨的主题、知识点、题目或笔记内容。不要猜测模糊内容，不要替用户作答，不要评判学习质量。用简洁中文整理成可供陪伴型 AI 角色理解的资料摘要，最多 700 字；若图片无法辨认，明确说明。" },
        { role: "user", content: [
          { type: "text", text: "请阅读这些晚间学习回忆的补充资料图片，并整理出简短摘要。" },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ] },
      ],
    });
    if (!response.ok) return NextResponse.json({ error: `视觉模型请求失败（HTTP ${response.status}）：${response.text.slice(0, 180)}` }, { status: 502 });
    let data: any;
    try { data = JSON.parse(response.text); } catch { return NextResponse.json({ error: "视觉模型返回格式无效。" }, { status: 502 }); }
    const raw = data?.choices?.[0]?.message?.content;
    const summary = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: { text?: string }) => part?.text || "").join("") : "").trim();
    if (!summary) return NextResponse.json({ error: "视觉模型没有识别出图片内容，请检查图片或重试。" }, { status: 502 });
    return NextResponse.json({ ok: true, summary: summary.slice(0, 4000) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "回忆图片识别失败" }, { status: 500 });
  }
}
