import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncRow = { payload?: unknown; revision?: number | string; updated_at?: string };
type WriteRow = { ok?: boolean; revision?: number | string; payload?: unknown; updated_at?: string };

async function authorize(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account || account.id !== "local_user") {
    return { response: NextResponse.json({ error: "当前部署不是受支持的单用户本地模式" }, { status: 403 }) };
  }
  return { response: null };
}

export async function GET(request: Request) {
  try {
    const auth = await authorize(request);
    if (auth.response) return auth.response;
    const result = await supabaseRestFetch<SyncRow[]>(
      "strict_learning_records?user_id=eq.local_user&select=payload,revision,updated_at&limit=1",
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
    const row = result.data[0];
    return NextResponse.json({
      revision: Number(row?.revision || 0),
      payload: row?.payload ?? null,
      updatedAt: row?.updated_at ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取云端学习记录失败" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await authorize(request);
    if (auth.response) return auth.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const expectedRevision = Number(body?.expectedRevision);
    const payload = body?.payload;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return NextResponse.json({ error: "同步版本号无效" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ error: "学习记录格式无效" }, { status: 400 });
    }
    const serialized = JSON.stringify(payload);
    if (serialized.length > 2_000_000) {
      return NextResponse.json({ error: "学习记录超过云同步大小限制" }, { status: 413 });
    }
    const result = await supabaseRestFetch<WriteRow[]>("rpc/strict_learning_sync_write", {
      method: "POST",
      body: JSON.stringify({ p_user_id: "local_user", p_expected_revision: expectedRevision, p_payload: payload }),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
    const row = result.data[0];
    if (!row?.ok) {
      return NextResponse.json({
        error: "云端记录已在其他设备更新。为避免覆盖较新的记录，本次同步已暂停。",
        conflict: true,
        revision: Number(row?.revision || 0),
        payload: row?.payload ?? null,
        updatedAt: row?.updated_at ?? null,
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      revision: Number(row.revision || 0),
      updatedAt: row.updated_at ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "写入云端学习记录失败" }, { status: 500 });
  }
}
