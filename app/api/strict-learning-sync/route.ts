import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { supabaseRestFetch } from "@/lib/server/supabase-rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncRow = { payload?: unknown; revision?: number | string; updated_at?: string };
type WriteRow = { ok?: boolean; revision?: number | string; payload?: unknown; updated_at?: string };

function authorized(request: Request): boolean {
  const configured = process.env.STRICT_LEARNING_SYNC_SECRET || "";
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (configured.length < 32 || supplied.length < 32 || supplied.length > 512) return false;
  const expectedHash = createHash("sha256").update(configured, "utf8").digest();
  const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

async function authorize(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account || account.id !== "local_user") {
    return NextResponse.json({ error: "当前部署不是受支持的单用户本地模式" }, { status: 403 });
  }
  if (!process.env.STRICT_LEARNING_SYNC_SECRET || process.env.STRICT_LEARNING_SYNC_SECRET.length < 32) {
    return NextResponse.json({ error: "服务端尚未配置 STRICT_LEARNING_SYNC_SECRET" }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "云同步共享密钥不正确" }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const denied = await authorize(request);
    if (denied) return denied;
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
    const denied = await authorize(request);
    if (denied) return denied;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const expectedRevision = Number(body?.expectedRevision);
    const payload = body?.payload;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return NextResponse.json({ error: "同步版本号无效" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ error: "学习记录格式无效" }, { status: 400 });
    }
    if (JSON.stringify(payload).length > 2_000_000) {
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
