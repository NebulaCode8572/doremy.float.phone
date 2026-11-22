import { Agent, fetch as undiciFetch } from "undici";
import { loadVectorMemorySettings } from "@/lib/server/vector-memory-credentials";
import { resolvePublicEndpoint } from "@/lib/server/vision-credentials";

const MAX_INPUT_CHARS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export async function generateVectorMemoryEmbedding(userId: string, input: string): Promise<number[]> {
  const text = input.trim();
  if (!text) throw new Error("向量化文本不能为空");
  if (text.length > MAX_INPUT_CHARS) throw new Error("向量化文本超过长度限制");
  const { publicSettings, apiKey } = await loadVectorMemorySettings(userId);
  if (!publicSettings.configured || !apiKey) throw new Error("Vector Memory Embedding API 未配置");
  const { url, addresses } = await resolvePublicEndpoint(publicSettings.baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const pinnedLookup = ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: any[]) => void) => {
    if (hostname.toLowerCase().replace(/\.$/, "") !== host) {
      callback(Object.assign(new Error("Unexpected provider hostname"), { code: "EAI_AGAIN" }));
      return;
    }
    const matching = options?.family ? addresses.filter(a => a.family === options.family) : addresses;
    if (!matching.length) {
      callback(Object.assign(new Error("No matching public address"), { code: "EAI_AGAIN" }));
      return;
    }
    if (options?.all) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  }) as never;
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  const base = url.toString().replace(/\/+$/, "").replace(/\/embeddings$/i, "");
  try {
    const response = await undiciFetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: publicSettings.model, input: text }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      dispatcher,
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Embedding 响应超过大小限制");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(bytes);
    if (!response.ok) throw new Error(`Embedding API 返回 HTTP ${response.status}`);
    let payload: any;
    try { payload = JSON.parse(raw); } catch { throw new Error("Embedding API 返回无效 JSON"); }
    const vector = payload?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 1024 || vector.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) {
      throw new Error(`Embedding 维度无效（需要 1024，实际 ${Array.isArray(vector) ? vector.length : "无效"}）`);
    }
    return vector;
  } finally {
    await dispatcher.close();
  }
}
