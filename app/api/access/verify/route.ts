import { NextResponse } from "next/server";

import {
  createSelfHostedAccessCookieValue,
  isSelfHostedAccessConfigured,
  SELF_HOSTED_ACCESS_COOKIE,
  SELF_HOSTED_ACCESS_MAX_AGE_SECONDS,
  verifySelfHostedAccessPassword,
} from "@/lib/self-hosted-access";
import { readLimitedJson } from "@/lib/server/read-limited-json";

function jsonResponse(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET() {
  return jsonResponse({ ok: true, configured: isSelfHostedAccessConfigured() });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) {
        return jsonResponse({ ok: false, error: "请求来源无效。" }, 403);
      }
    } catch {
      return jsonResponse({ ok: false, error: "请求来源无效。" }, 403);
    }
  } else if (request.headers.get("sec-fetch-site") === "cross-site") {
    return jsonResponse({ ok: false, error: "请求来源无效。" }, 403);
  }

  if (!isSelfHostedAccessConfigured()) {
    return jsonResponse({ ok: false, error: "站点访问口令尚未完成服务端配置。" }, 503);
  }

  const parsed = await readLimitedJson(request, 4096);
  if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, parsed.status);

  const password = parsed.value.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    return jsonResponse({ ok: false, error: "访问口令不正确。" }, 401);
  }

  if (!(await verifySelfHostedAccessPassword(password))) {
    return jsonResponse({ ok: false, error: "访问口令不正确。" }, 401);
  }

  const cookieValue = await createSelfHostedAccessCookieValue();
  if (!cookieValue) {
    return jsonResponse({ ok: false, error: "站点访问口令配置无效。" }, 503);
  }

  const response = jsonResponse({ ok: true });
  response.cookies.set(SELF_HOSTED_ACCESS_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SELF_HOSTED_ACCESS_MAX_AGE_SECONDS,
  });
  return response;
}
