import { kvGet, kvSet, registerDynamicPrefix } from "@/lib/kv-db";

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
): T & Partial<CachedVectorMemoryGeneration> {
  const generation = loadCachedVectorMemoryGeneration(accountId, entry.characterId);
  return generation ? { ...entry, ...generation } : entry;
}
