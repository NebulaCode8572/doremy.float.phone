"use client";

import { useCallback, useEffect } from "react";
import { useAccount } from "@/lib/account-context";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "@/lib/character-storage";
import { saveCachedVectorMemoryGeneration } from "@/lib/vector-memory-generation";

type GenerationResult = {
  characterId: string;
  success: boolean;
  characterGeneration?: number;
  memoryGeneration?: number;
};

export function VectorMemoryGenerationBootstrap() {
  const { account } = useAccount();

  const refresh = useCallback(async () => {
    const characterIds = [...new Set(loadCharacters().map(character => character.id))];
    if (!characterIds.length) return;
    try {
      const response = await fetch("/api/vector-memory-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ characterIds }),
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => null) as { results?: GenerationResult[] } | null;
      if (!Array.isArray(payload?.results)) return;
      for (const item of payload.results) {
        if (!item.success || !item.characterId
          || !Number.isSafeInteger(item.characterGeneration) || !Number.isSafeInteger(item.memoryGeneration)) continue;
        saveCachedVectorMemoryGeneration(account.id, item.characterId, {
          characterGeneration: item.characterGeneration!,
          memoryGeneration: item.memoryGeneration!,
        });
      }
    } catch {
      // Generation unavailable means cloud indexing pauses; local chat/memory writes continue.
    }
  }, [account.id]);

  useEffect(() => {
    void refresh();
    window.addEventListener("online", refresh);
    window.addEventListener(CHARACTERS_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener(CHARACTERS_UPDATED_EVENT, refresh);
    };
  }, [refresh]);

  return null;
}
