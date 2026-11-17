import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { loadVisionSettings } from "@/lib/server/vision-credentials";
import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_CHARS = 12_000_000;
const MAX_REQUEST_BYTES = 12_500_000;

function boundedString(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : "";
}
function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}
function validTime(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(value)) return "";
  return value;
}
function boundedMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1440 ? value : null;
}
function sanitizeResult(value: Record<string, unknown>, kind: "sleep" | "focus") {
  return {
    kind,
    recordDate: validDate(value.recordDate),
    sleepStart: validTime(value.sleepStart),
    wakeTime: validTime(value.wakeTime),
    sleepDurationMinutes: boundedMinutes(value.sleepDurationMinutes),
    focusDurationMinutes: boundedMinutes(value.focusDurationMinutes),
    phoneLockDate: validDate(value.phoneLockDate),
    phoneLockTime: validTime(value.phoneLockTime),
    deviceVisible: value.deviceVisible === true,
    phoneLockVisible: value.phoneLockVisible === true,
    confidence: value.confidence === "high" || value.confidence === "medium" || value.confidence === "low" ? value.confidence : "low",
    notes: typeof value.notes === "string" ? value.notes.slice(0, 300) : "",
  };
}
const SYSTEM_PROMPT = `你是学习凭证识别器。只提取图片中明确可见的信息，不猜测、不补全。必须只返回 JSON 对象，不要 Markdown。
字段：{"kind":"sleep|focus","recordDate":"YYYY-MM-DD（睡眠报告对应的起床日期）或空字符串","sleepStart":"HH:mm或空字符串","wakeTime":"HH:mm或空字符串","sleepDurationMinutes":整数或null,"focusDurationMinutes":整数或null,"phoneLockDate":"YYYY-MM-DD或空字符串","phoneLockTime":"HH:mm或空字符串","deviceVisible":布尔值,"phoneLockVisible":布尔值,"confidence":"high|medium|low","notes":"简短说明"}。
kind=sleep 时识别睡眠报告；kind=focus 时识别手环今日累计专注时长。专注时长必须是“今日累计”数值，不得把单个番茄钟时段相加。若图片同时有手机锁屏，提取日期和时间。无法辨认的字段留空或 null。`;

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsedBody = await readLimitedJson(request, MAX_REQUEST_BYTES);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
    const record = parsedBody.value;
    const kind = record.kind === "sleep" || record.kind === "focus" ? record.kind : null;
    const imageDataUrl = typeof record.imageDataUrl === "string" ? record.imageDataUrl : "";
    if (!kind) return NextResponse.json({ error: "凭证类型无效" }, { status: 400 });
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(imageDataUrl) || imageDataUrl.length > MAX_IMAGE_CHARS) {
      return NextResponse.json({ error: "请上传 PNG、JPG 或 WebP 图片（文件不能超过约 9 MB）" }, { status: 400 });
    }
    const { publicSettings, apiKey } = await loadVisionSettings(account.id);
    if (!publicSettings.configured || !apiKey) return NextResponse.json({ error: "尚未配置全局视觉模型，请先前往系统设置配置。" }, { status: 409 });
    const base = publicSettings.baseUrl.replace(/\/$/, "").replace(/\/chat\/completions$/i, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: publicSettings.model,
        temperature: 0,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: kind === "focus" ? "识别手环今日累计专注时长，并检查是否同时出现手机锁屏日期和时间。" : "识别这张手环睡眠报告中的昨晚睡眠数据，并提取报告对应的起床日期（不是入睡日期）。" },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ] },
        ],
      }),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return NextResponse.json({ error: `视觉模型请求失败（HTTP ${response.status}）：${detail.slice(0, 180)}` }, { status: 502 });
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: { text?: string }) => part?.text || "").join("") : "";
    const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first < 0 || last <= first) return NextResponse.json({ error: "模型未返回可解析的识别结果，请重新上传清晰截图。" }, { status: 502 });
    let extracted: Record<string, unknown>;
    try { extracted = JSON.parse(jsonText.slice(first, last + 1)); }
    catch { return NextResponse.json({ error: "识别结果格式异常，请重新上传。" }, { status: 502 }); }
    if (extracted.kind !== kind) return NextResponse.json({ error: "识别结果类型不匹配，请重新上传。" }, { status: 502 });
    const sanitized = sanitizeResult(extracted, kind);
    return NextResponse.json({ ok: true, result: sanitized }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "图片识别失败" }, { status: 500 });
  }
}
