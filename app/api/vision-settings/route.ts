import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { loadVisionSettings, saveVisionSettings } from "@/lib/server/vision-credentials";
import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function accountFrom(request: Request) {
  if (!getSupabaseServerConfig()) return { account: null, response: NextResponse.json({ error: "Supabase 服务未配置" }, { status: 503 }) };
  const account = await getCurrentAccount(request);
  if (!account) return { account: null, response: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
  return { account, response: null };
}
export async function GET(request: Request) {
  try {
    const auth = await accountFrom(request);
    if (auth.response) return auth.response;
    const { publicSettings } = await loadVisionSettings(auth.account!.id);
    return NextResponse.json(publicSettings, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取视觉模型配置失败" }, { status: 500 });
  }
}
export async function PUT(request: Request) {
  try {
    const auth = await accountFrom(request);
    if (auth.response) return auth.response;
    const parsedBody = await readLimitedJson(request, 32_768);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
    const record = parsedBody.value;
    const settings = await saveVisionSettings(auth.account!.id, {
      provider: typeof record.provider === "string" ? record.provider : "openai-compatible",
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
      model: typeof record.model === "string" ? record.model : "",
      apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    });
    return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存视觉模型配置失败" }, { status: 400 });
  }
}
