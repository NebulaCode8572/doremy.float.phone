import { createHmac, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICKET_TTL_SECONDS = 120;
const MAX_TICKETS_PER_MINUTE = 20;
const RATE_WINDOW_MS = 60_000;
const rateLimits = new Map<string, { count: number; windowStartedAt: number }>();

function jsonError(message: string, status: number, retryAfter?: number): NextResponse {
  const headers = new Headers({
    "Cache-Control": "no-store, private",
    Pragma: "no-cache",
    Vary: "Cookie",
  });
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return NextResponse.json({ ok: false, error: message }, { status, headers });
}

function allowTicketIssue(accountId: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let entry = rateLimits.get(accountId);

  if (!entry || now - entry.windowStartedAt >= RATE_WINDOW_MS) {
    entry = { count: 0, windowStartedAt: now };
    rateLimits.set(accountId, entry);
  }

  // Keep the per-process limiter bounded if many accounts visit this route.
  if (rateLimits.size > 10_000) {
    for (const [key, value] of rateLimits) {
      if (now - value.windowStartedAt >= RATE_WINDOW_MS) rateLimits.delete(key);
    }
  }

  if (entry.count >= MAX_TICKETS_PER_MINUTE) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((entry.windowStartedAt + RATE_WINDOW_MS - now) / 1000)),
    };
  }

  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function issuePaiVoiceTicket(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    aud: "paivoice",
    iat: now,
    exp: now + TICKET_TTL_SECONDS,
    jti: randomUUID(),
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encodedPayload, "ascii")
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const requestOrigin = new URL(request.url).origin;
    const allowedLocalOrigins = new Set([
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ]);
    if (origin && origin !== requestOrigin && !allowedLocalOrigins.has(origin)) {
      return jsonError("请求来源无效。", 403);
    }
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return jsonError("请求来源无效。", 403);
    }

    const account = await getCurrentAccount(request);
    if (!account || account.status !== "active") {
      return jsonError("请先登录账号。", 401);
    }

    const secret = process.env.PAIVOICE_AUTH_SECRET ?? "";
    if (Buffer.byteLength(secret, "utf8") < 32) {
      return jsonError("PaiVoice 服务端认证尚未配置。", 503);
    }

    const limit = allowTicketIssue(account.id);
    if (!limit.allowed) {
      return jsonError("通话授权请求过于频繁，请稍后再试。", 429, limit.retryAfter);
    }

    const ticket = issuePaiVoiceTicket(account.id, secret);
    return NextResponse.json(
      { ok: true, ticket, expiresIn: TICKET_TTL_SECONDS },
      {
        headers: {
          "Cache-Control": "no-store, private",
          Pragma: "no-cache",
          Vary: "Cookie",
        },
      },
    );
  } catch {
    return jsonError("暂时无法验证账号或签发通话授权，请稍后重试。", 503);
  }
}
