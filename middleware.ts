import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ACCOUNT_GATE_COOKIE, ACCOUNT_SESSION_COOKIE } from "./lib/account-cookie-constants";
import { verifyAccountGateCookieValue } from "./lib/account-gate-cookie";
import {
  SELF_HOSTED_ACCESS_COOKIE,
  verifySelfHostedAccessCookieValue,
} from "./lib/self-hosted-access";
import { isSelfHostedModeEnabled } from "./lib/self-hosting";

const PUBLIC_ROUTE_PREFIXES = [
  "/verify",
  "/api/auth/",
  "/api/verify/",
  // iPhone Shortcuts does not share the PWA's login cookies. These handlers
  // validate either the bridge token or a short-lived per-command ticket.
  "/shortcut-run/",
  "/personal-shortcut-run/",
  "/api/push/bridge-wake/",
  "/api/push/shortcut-commands/result/",
  "/api/push/shortcut-commands/media/",
  // 个人云的离线生成把「代发触发邮件」外包给站点，同样没有登录 cookie，
  // 凭 bridge_token 认账号（见该路由内的说明）。
  "/api/push/shortcut-commands/deliver-email/",
];

// Self-hosted mode has its own site-wide passcode. These existing external
// bridge routes deliberately do not use the browser cookie; each route must
// validate its own bridge token, one-time ticket, or constrained redirect URL.
const SELF_HOSTED_TOKEN_ROUTES = [
  "/shortcut-run",
  "/personal-shortcut-run",
  "/api/push/bridge-wake",
  "/api/push/shortcut-commands/deliver-email",
];

const STATIC_ROUTE_PREFIXES = [
  "/_next/",
  "/birds/",
  "/diary/",
  "/fonts/",
  "/game-builtins/",
  "/game-covers/",
  "/hdri/",
  "/images/",
  "/models/",
  "/widgets/",
  "/xiaohongshu/",
];

const STATIC_FILE_RE = /\.(?:avif|bin|css|gif|glb|gltf|hdr|ico|jpeg|jpg|js|json|map|mjs|mp3|ogg|otf|png|svg|ttf|txt|wasm|wav|webmanifest|webp|woff|woff2)$/i;

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function isSelfHostedTokenRoute(pathname: string): boolean {
  return SELF_HOSTED_TOKEN_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );
}

function isStaticRoute(pathname: string): boolean {
  return STATIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || STATIC_FILE_RE.test(pathname);
}

function isStaticAssetRoute(pathname: string): boolean {
  return pathname.startsWith("/_next/") || STATIC_FILE_RE.test(pathname);
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isSelfHostedModeEnabled()) {
    // The access page, its verification endpoint, static assets, and the
    // narrowly scoped token-authenticated bridge routes remain cookie-free.
    if (
      pathname === "/access" ||
      pathname === "/api/access/verify" ||
      isStaticAssetRoute(pathname) ||
      isSelfHostedTokenRoute(pathname)
    ) {
      return NextResponse.next();
    }

    const accessCookie = request.cookies.get(SELF_HOSTED_ACCESS_COOKIE)?.value ?? "";
    if (await verifySelfHostedAccessCookieValue(accessCookie)) {
      return NextResponse.next();
    }

    if (isApiRoute(pathname)) {
      return NextResponse.json(
        { ok: false, error: "请先输入站点访问口令。" },
        { status: 401, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }

    const url = request.nextUrl.clone();
    const requestedPath = pathname + request.nextUrl.search;
    url.pathname = "/access";
    url.search = "";
    url.searchParams.set("next", requestedPath);
    return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  if (isStaticRoute(pathname) || isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  const sessionToken = request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value ?? "";
  const gateCookie = request.cookies.get(ACCOUNT_GATE_COOKIE)?.value ?? "";
  const hasValidGate = await verifyAccountGateCookieValue(gateCookie, sessionToken);

  if (hasValidGate) return NextResponse.next();

  if (isApiRoute(pathname)) {
    return NextResponse.json(
      { ok: false, error: "请先登录账号。" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Existing logged-in browsers may only have the original account session
  // cookie until /api/auth/me refreshes the signed gate cookie.
  if (sessionToken || pathname === "/") return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:avif|bin|css|gif|glb|gltf|hdr|ico|jpeg|jpg|js|json|map|mjs|mp3|ogg|otf|png|svg|ttf|txt|wasm|wav|webmanifest|webp|woff|woff2)$).*)",
  ],
};
