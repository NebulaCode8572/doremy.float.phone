import { kvGet, kvSet, registerDynamicPrefix } from "@/lib/kv-db";
import { loadActiveAccountId } from "@/lib/account-client";

export const VECTOR_MEMORY_SETTINGS_UPDATED_EVENT = "vector-memory-settings-updated";

export type CachedVectorMemoryGeneration = {
  characterGeneration: number;
  memoryGeneration: number;
};

const KEY_PREFIX = "ai_phone_vector_memory_generation_v1:";
registerDynamicPrefix(KEY_PREFIX);

function keyFor(accountId: string, characterId: string): string {
  return KEY_PREFIX + encodeURIComponent(accountId) + ":" + encodeURIComponent(characterId);
}

export function loadCachedVectorMemoryGeneration(
  accountId: string,
  characterId: string,
): CachedVectorMemoryGeneration | null {
  if (!accountId || !characterId) return null;
  try {
    const raw = kvGet(keyFor(accountId, characterId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedVectorMemoryGeneration>;
    if (!Number.isSafeInteger(value.characterGeneration) || (value.characterGeneration ?? -1) < 0
      || !Number.isSafeInteger(value.memoryGeneration) || (value.memoryGeneration ?? -1) < 0) return null;
    return {
      characterGeneration: value.characterGeneration!,
      memoryGeneration: value.memoryGeneration!,
    };
  } catch {
    return null;
  }
}

export function saveCachedVectorMemoryGeneration(
  accountId: string,
  characterId: string,
  generation: CachedVectorMemoryGeneration,
): void {
  if (!accountId || !characterId
    || !Number.isSafeInteger(generation.characterGeneration) || generation.characterGeneration < 0
    || !Number.isSafeInteger(generation.memoryGeneration) || generation.memoryGeneration < 0) return;
  try {
    const existing = loadCachedVectorMemoryGeneration(accountId, characterId);
    // Focus/online/bootstrap refreshes can overlap. A slower response that
    // started earlier must never roll either monotonic server generation back.
    const monotonicGeneration = {
      characterGeneration: Math.max(existing?.characterGeneration ?? 0, generation.characterGeneration),
      memoryGeneration: Math.max(existing?.memoryGeneration ?? 0, generation.memoryGeneration),
    };
    kvSet(keyFor(accountId, characterId), JSON.stringify(monotonicGeneration));
  } catch {
    // A cache failure only pauses cloud indexing; local saves remain unaffected.
  }
}

export function attachCurrentMemoryGeneration<T extends { characterId: string }>(
  entry: T,
  accountId: string,
): T & { vectorMemoryAccountId?: string; vectorMemoryCharacterGeneration?: number; vectorMemoryMemoryGeneration?: number } {
  if (!accountId) return entry;
  const generation = loadCachedVectorMemoryGeneration(accountId, entry.characterId);
  return {
    ...entry,
    vectorMemoryAccountId: accountId,
    ...(generation ? {
      vectorMemoryCharacterGeneration: generation.characterGeneration,
      vectorMemoryMemoryGeneration: generation.memoryGeneration,
    } : {}),
  };
}

export function stampNewMemoryEntry<T extends { characterId: string }>(entry: T): T & {
  vectorMemoryAccountId?: string;
  vectorMemoryCharacterGeneration?: number;
  vectorMemoryMemoryGeneration?: number;
} {
  return attachCurrentMemoryGeneration(entry, loadActiveAccountId());
}

export async function refreshCachedVectorMemoryGeneration(characterId: string): Promise<void> {
  const accountId = loadActiveAccountId();
  if (!accountId || !characterId || typeof window === "undefined") return;
  try {
    const response = await fetch("/api/vector-memory-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ characterIds: [characterId] }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { errorCode?: string; error?: string } | null;
      console.warn("[VectorMemory] Single-character generation refresh failed.", {
        httpStatus: response.status,
        errorCode: failure?.errorCode,
        error: failure?.error,
        accountMode: accountId === "local_user" ? "self_hosted" : "account",
      });
      return;
    }
    const payload = await response.json().catch(() => null) as {
      results?: Array<{ characterId: string; success: boolean; errorCode?: string; characterGeneration?: number; memoryGeneration?: number }>;
    } | null;
    if (loadActiveAccountId() !== accountId) return;
    const result = payload?.results?.find(item => item.characterId === characterId);
    if (!result?.success || !Number.isSafeInteger(result.characterGeneration) || !Number.isSafeInteger(result.memoryGeneration)) {
      console.warn("[VectorMemory] Single-character generation refresh returned no usable generation.", {
        resultFound: Boolean(result),
        errorCode: result?.errorCode,
        accountMode: accountId === "local_user" ? "self_hosted" : "account",
      });
      return;
    }
    saveCachedVectorMemoryGeneration(accountId, characterId, {
      characterGeneration: result.characterGeneration!,
      memoryGeneration: result.memoryGeneration!,
    });
  } catch (error) {
    console.warn("[VectorMemory] Single-character generation refresh threw an exception.", {
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      accountMode: accountId === "local_user" ? "self_hosted" : "account",
    });
  }
}
