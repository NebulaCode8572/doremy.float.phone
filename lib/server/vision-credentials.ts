import crypto from "crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";

const TABLE = "app_user_vision_settings";
type VisionRow = {
  provider?: string;
  base_url?: string;
  model?: string;
  api_key_ciphertext?: string;
  api_key_iv?: string;
  api_key_tag?: string;
  updated_at?: string;
};
export type VisionPublicSettings = {
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  updatedAt?: string;
};

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    if (normalized.startsWith("::ffff:")) return false;
    const halves = normalized.split("::");
    if (halves.length > 2) return false;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].map(part => Number.parseInt(part || "0", 16));
    if (groups.length !== 8 || groups.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) return false;
    const first = groups[0];
    if (first < 0x2000 || first > 0x3fff) return false;
    if (first === 0x2001 && [0x0010, 0x0020, 0x0db8].includes(groups[1])) return false;
    if (first === 0x2002) return false;
    return true;
  }
  return false;
}

async function resolvePublicEndpoint(baseUrl: string): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("视觉模型 Base URL 格式无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL 必须是无凭证、无查询参数的 HTTPS 地址");
  }
  const host = url.hostname.replace(/^\\[|\\]$/g, "").toLowerCase().replace(/\\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Base URL 不能指向本机或内网地址");
  }
  try {
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) {
      throw new Error("Base URL 域名必须解析到公开 IP 地址");
    }
    return { url, addresses };
  } catch (error) {
    if (error instanceof Error && error.message.includes("公开 IP")) throw error;
    throw new Error("无法验证视觉模型域名，请检查域名是否可解析");
  }
}

export async function callVisionProvider(baseUrl: string, apiKey: string, payload: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const { url, addresses } = await resolvePublicEndpoint(baseUrl);
  const host = url.hostname.replace(/^\\[|\\]$/g, "").toLowerCase().replace(/\\.$/, "");
  const pinnedLookup = ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: any[]) => void) => {
    if (hostname.toLowerCase().replace(/\\.$/, "") !== host) {
      const error = Object.assign(new Error("Unexpected provider hostname"), { code: "EAI_AGAIN" });
      callback(error);
      return;
    }
    const matching = options?.family ? addresses.filter(item => item.family === options.family) : addresses;
    if (!matching.length) {
      const error = Object.assign(new Error("No matching public address"), { code: "EAI_AGAIN" });
      callback(error);
      return;
    }
    if (options?.all) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  }) as never;
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  const endpoint = `${url.toString().replace(/\\/+$/, "").replace(/\\/chat\\/completions$/i, "")}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    await dispatcher.close();
  }
}

function encryptionKey(): Buffer {
  const raw = process.env.VISION_CREDENTIAL_ENCRYPTION_KEY || "";
  if (!raw) throw new Error("VISION_CREDENTIAL_ENCRYPTION_KEY 未配置");
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("VISION_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节密钥");
  return key;
}
function encryptApiKey(apiKey: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return { api_key_ciphertext: ciphertext.toString("base64"), api_key_iv: iv.toString("base64"), api_key_tag: cipher.getAuthTag().toString("base64") };
}
function decryptApiKey(row: VisionRow): string {
  if (!row.api_key_ciphertext || !row.api_key_iv || !row.api_key_tag) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.api_key_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.api_key_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.api_key_ciphertext, "base64")), decipher.final()]).toString("utf8");
}
export async function loadVisionSettings(userId: string): Promise<{ publicSettings: VisionPublicSettings; apiKey: string }> {
  const result = await supabaseRestFetch<VisionRow[]>(`${TABLE}?user_id=eq.${encodeSupabaseFilter(userId)}&select=provider,base_url,model,api_key_ciphertext,api_key_iv,api_key_tag,updated_at&limit=1`);
  if (!result.ok) throw new Error(result.error);
  const row = result.data[0];
  if (!row) return { publicSettings: { configured: false, provider: "openai-compatible", baseUrl: "", model: "" }, apiKey: "" };
  return {
    publicSettings: { configured: true, provider: row.provider || "openai-compatible", baseUrl: row.base_url || "", model: row.model || "", updatedAt: row.updated_at },
    apiKey: decryptApiKey(row),
  };
}
export async function saveVisionSettings(userId: string, input: { provider: string; baseUrl: string; model: string; apiKey?: string }): Promise<VisionPublicSettings> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const model = input.model.trim();
  if (!baseUrl || baseUrl.length > 2000) throw new Error("请填写有效的 Base URL");
  await resolvePublicEndpoint(baseUrl);
  if (!model || model.length > 160) throw new Error("请填写有效的模型名称");
  if (input.provider !== "openai-compatible") throw new Error("当前版本仅支持 OpenAI 兼容视觉接口");
  const existing = await loadVisionSettings(userId);
  const apiKey = input.apiKey?.trim() || existing.apiKey;
  if (!apiKey) throw new Error("请填写 API Key");
  if (apiKey.length > 8192) throw new Error("API Key 长度超过限制");
  const encrypted = encryptApiKey(apiKey);
  const payload = {
    user_id: userId,
    provider: input.provider,
    base_url: baseUrl,
    model,
    ...encrypted,
    updated_at: new Date().toISOString(),
  };
  const result = await supabaseRestFetch<VisionRow[]>(TABLE, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  if (!result.ok) throw new Error(result.error);
  return { configured: true, provider: input.provider, baseUrl, model, updatedAt: payload.updated_at };
}
