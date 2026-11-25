import { kvGet, kvSet, registerDynamicPrefix } from "@/lib/kv-db";
import { loadActiveAccountId } from "@/lib/account-client";

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
    kvSet(keyFor(accountId, characterId), JSON.stringify(generation));
  } catch {
    // A cache failure only pauses cloud indexing; local saves remain unaffected.
  }
}

export function attachCurrentMemoryGeneration<T extends { characterId: string }>(
  entry: T,
  accountId: string,
): T & { vectorMemoryCharacterGeneration?: number; vectorMemoryMemoryGeneration?: number } {
  const generation = loadCachedVectorMemoryGeneration(accountId, entry.characterId);
  return generation ? {
    ...entry,
    vectorMemoryCharacterGeneration: generation.characterGeneration,
    vectorMemoryMemoryGeneration: generation.memoryGeneration,
  } : entry;
}

export function stampNewMemoryEntry<T extends { characterId: string }>(entry: T): T & {
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
    if (!response.ok) return;
    const payload = await response.json().catch(() => null) as {
      results?: Array<{ characterId: string; success: boolean; characterGeneration?: number; memoryGeneration?: number }>;
    } | null;
    const result = payload?.results?.find(item => item.characterId === characterId && item.success);
    if (!result || !Number.isSafeInteger(result.characterGeneration) || !Number.isSafeInteger(result.memoryGeneration)) return;
    saveCachedVectorMemoryGeneration(accountId, characterId, {
      characterGeneration: result.characterGeneration!,
      memoryGeneration: result.memoryGeneration!,
    });
  } catch {
    // Failed refresh leaves the old generation in place, so new uploads fail closed.
  }
}
