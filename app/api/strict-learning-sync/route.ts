import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { supabaseRestFetch } from "@/lib/server/supabase-rest";
import { readLimitedJson } from "@/lib/server/read-limited-json";
import { normalizeStrictLearningStore } from "@/lib/strict-learning-schema";

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
    let payload = null;
    if (row) {
      if (row.payload === undefined || row.payload === null) {
        return NextResponse.json({ error: "云端学习记录为空或格式无效，已停止同步以避免覆盖数据" }, { status: 503 });
      }
      try {
        payload = normalizeStrictLearningStore(row.payload);
      } catch {
        return NextResponse.json({ error: "云端学习记录格式异常，已停止同步以避免覆盖数据" }, { status: 503 });
      }
    }
    const revision = Number(row?.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return NextResponse.json({ error: "云端同步版本号无效" }, { status: 503 });
    }
    return NextResponse.json({
      revision,
      payload,
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
    const parsedBody = await readLimitedJson(request, 2_000_000);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error === "请求内容超过大小限制" ? "学习记录超过云同步大小限制" : parsedBody.error }, { status: parsedBody.status });
    const body = parsedBody.value;
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return NextResponse.json({ error: "同步版本号无效" }, { status: 400 });
    }
    let payload;
    try {
      payload = normalizeStrictLearningStore(body.payload);
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "学习记录格式无效",
      }, { status: 400 });
    }
    const result = await supabaseRestFetch<WriteRow[]>("rpc/strict_learning_sync_write", {
      method: "POST",
      body: JSON.stringify({ p_user_id: "local_user", p_expected_revision: expectedRevision, p_payload: payload }),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
    const row = result.data[0];
    if (!row?.ok) {
      let currentPayload = null;
      if (row?.payload !== undefined && row.payload !== null) {
        try {
          currentPayload = normalizeStrictLearningStore(row.payload);
        } catch {
          return NextResponse.json({ error: "云端冲突记录格式异常，已停止同步以避免覆盖数据" }, { status: 503 });
        }
      } else {
        return NextResponse.json({ error: "云端冲突记录为空，已停止同步以避免覆盖数据" }, { status: 503 });
      }
      const currentRevision = Number(row.revision);
      if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
        return NextResponse.json({ error: "云端冲突版本号无效" }, { status: 503 });
      }
      return NextResponse.json({
        error: "云端记录已在其他设备更新。为避免覆盖较新的记录，本次同步已暂停。",
        conflict: true,
        revision: currentRevision,
        payload: currentPayload,
        updatedAt: row.updated_at ?? null,
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
