import crypto from "crypto";
import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { resolvePublicEndpoint } from "@/lib/server/vision-credentials";

const TABLE = "app_user_vector_memory_settings";
type Row = { base_url?: string; model?: string; api_key_ciphertext?: string; api_key_iv?: string; api_key_tag?: string; updated_at?: string };
export type VectorMemoryPublicSettings = { configured: boolean; baseUrl: string; model: string; dimensions: 1024; updatedAt?: string };

function encryptionKey(): Buffer {
  const raw = process.env.VECTOR_MEMORY_CREDENTIAL_ENCRYPTION_KEY || "";
  if (!raw) throw new Error("VECTOR_MEMORY_CREDENTIAL_ENCRYPTION_KEY 未配置");
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("VECTOR_MEMORY_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节密钥");
  return key;
}
function encryptKey(apiKey: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return { api_key_ciphertext: encrypted.toString("base64"), api_key_iv: iv.toString("base64"), api_key_tag: cipher.getAuthTag().toString("base64") };
}
function decryptKey(row: Row): string {
  if (!row.api_key_ciphertext || !row.api_key_iv || !row.api_key_tag) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.api_key_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.api_key_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.api_key_ciphertext, "base64")), decipher.final()]).toString("utf8");
}
export async function loadVectorMemorySettings(userId: string): Promise<{ publicSettings: VectorMemoryPublicSettings; apiKey: string }> {
  const res = await supabaseRestFetch<Row[]>(`${TABLE}?user_id=eq.${encodeSupabaseFilter(userId)}&select=base_url,model,api_key_ciphertext,api_key_iv,api_key_tag,updated_at&limit=1`);
  if (!res.ok) throw new Error(res.error);
  const row = res.data[0];
  if (!row) return { publicSettings: { configured: false, baseUrl: "", model: "BAAI/bge-m3", dimensions: 1024 }, apiKey: "" };
  return { publicSettings: { configured: true, baseUrl: row.base_url || "", model: row.model || "BAAI/bge-m3", dimensions: 1024, updatedAt: row.updated_at }, apiKey: decryptKey(row) };
}
export async function saveVectorMemorySettings(userId: string, input: { baseUrl: string; model: string; apiKey?: string }): Promise<VectorMemoryPublicSettings> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const model = input.model.trim();
  if (!baseUrl || baseUrl.length > 2000) throw new Error("请填写有效的 Base URL");
  await resolvePublicEndpoint(baseUrl);
  if (!model || model.length > 160) throw new Error("请填写有效的向量模型名称");
  const existing = await loadVectorMemorySettings(userId);
  const apiKey = input.apiKey?.trim() || existing.apiKey;
  if (!apiKey) throw new Error("请填写 API Key");
  if (apiKey.length > 8192) throw new Error("API Key 长度超过限制");
  const payload = { user_id: userId, base_url: baseUrl, model, ...encryptKey(apiKey), updated_at: new Date().toISOString() };
  const result = await supabaseRestFetch<Row[]>(TABLE, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) });
  if (!result.ok) throw new Error(result.error);
  return { configured: true, baseUrl, model, dimensions: 1024, updatedAt: payload.updated_at };
}
