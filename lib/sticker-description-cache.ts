import { kvGet, kvSet } from "./kv-db";

const STICKER_DESCRIPTION_CACHE_KEY = "sticker_description_cache_v1";
const STICKER_DESCRIPTION_CACHE_LIMIT = 500;

/**
 * 表情包描述缓存：用图片引用字符串的双 32 位指纹作键。
 * 对 data URL 来说，指纹覆盖图片数据本身；相同素材即使消息 ID 不同也能命中。
 */
export function getStickerDescriptionCacheKey(imageRef: string): string {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < imageRef.length; i += 1) {
        const code = imageRef.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
    }
    return `stkdesc_${a.toString(36)}${b.toString(36)}`;
}

function readStickerDescriptionCache(): Record<string, string> {
    try {
        const raw = kvGet(STICKER_DESCRIPTION_CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function getCachedStickerDescription(key: string): string | undefined {
    const value = readStickerDescriptionCache()[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function saveCachedStickerDescription(key: string, description: string): void {
    const cleaned = description.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!key || !cleaned) return;
    const cache = readStickerDescriptionCache();
    cache[key] = cleaned;
    const entries = Object.entries(cache);
    const trimmed = entries.length > STICKER_DESCRIPTION_CACHE_LIMIT
        ? Object.fromEntries(entries.slice(-STICKER_DESCRIPTION_CACHE_LIMIT))
        : cache;
    try {
        kvSet(STICKER_DESCRIPTION_CACHE_KEY, JSON.stringify(trimmed));
    } catch (error) {
        console.warn("[StickerDescriptionCache] save failed:", error);
    }
}

export function extractStickerDescriptionMarkers(text: string): {
    cleanText: string;
    entries: Array<{ key: string; description: string }>;
} {
    const entries: Array<{ key: string; description: string }> = [];
    const cleanText = text.replace(
        /<sticker_description\s+key=["']([a-z0-9_]+)["']\s*>([\s\S]*?)<\/sticker_description>/gi,
        (_match, key: string, rawDescription: string) => {
            const description = rawDescription.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
            if (description) entries.push({ key, description });
            return "";
        },
    ).trim();
    return { cleanText, entries };
}
