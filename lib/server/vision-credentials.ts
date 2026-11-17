import crypto from "crypto";
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
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) throw new Error("Base URL 必须是 HTTPS 地址");
  const parsedUrl = new URL(baseUrl);
  const host = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.username || parsedUrl.password || host === "localhost" || host.endsWith(".local") || host === "127.0.0.1" || host === "::1" || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("Base URL 不能指向本机或内网地址");
  }
  if (!model || model.length > 160) throw new Error("请填写有效的模型名称");
  if (input.provider !== "openai-compatible") throw new Error("当前版本仅支持 OpenAI 兼容视觉接口");
  const existing = await loadVisionSettings(userId);
  const apiKey = input.apiKey?.trim() || existing.apiKey;
  if (!apiKey) throw new Error("请填写 API Key");
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
