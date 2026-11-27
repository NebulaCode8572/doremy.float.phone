import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { getVectorMemorySupabaseServerConfig } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { loadVectorMemorySettings, saveVectorMemorySettings } from "@/lib/server/vector-memory-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function authenticate(request: Request) {
  if (!getVectorMemorySupabaseServerConfig()) return { account: null, response: NextResponse.json({ error: "Vector Memory Supabase 服务未配置" }, { status: 503 }) };
  const account = await getCurrentAccount(request);
  if (!account) return { account: null, response: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
  return { account, response: null };
}
export async function GET(request: Request) {
  try {
    const auth = await authenticate(request);
    if (auth.response) return auth.response;
    const { publicSettings } = await loadVectorMemorySettings(auth.account!.id);
    return NextResponse.json(publicSettings, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "读取 Vector Memory 配置失败" }, { status: 500 });
  }
}
export async function PUT(request: Request) {
  try {
    const auth = await authenticate(request);
    if (auth.response) return auth.response;
    const body = await readLimitedJson(request, 32768);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
    const record = body.value;
    const settings = await saveVectorMemorySettings(auth.account!.id, {
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
      model: typeof record.model === "string" ? record.model : "",
      apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    });
    return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存 Vector Memory 配置失败" }, { status: 400 });
  }
}
