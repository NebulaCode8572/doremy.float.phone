"use client";

import { useCallback, useEffect } from "react";
import { useAccount } from "@/lib/account-context";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadActiveAccountId } from "@/lib/account-client";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "@/lib/character-storage";
import { saveCachedVectorMemoryGeneration } from "@/lib/vector-memory-generation";
import { hydrateChatStorage, isChatStorageHydrated, loadChatMessages, loadChatSessions, backfillHistoricalChatVectors } from "@/lib/chat-storage";
import { retryPendingChatVectorChunks } from "@/lib/vector-memory-chat-sync";

type GenerationResult = {
  characterId: string;
  success: boolean;
  characterGeneration?: number;
  memoryGeneration?: number;
};

export function VectorMemoryGenerationBootstrap() {
  const { account } = useAccount();

  const refresh = useCallback(async () => {
    if (!account.id || account.id !== loadActiveAccountId()) return;
    await hydrateKvDb();
    const characterIds = [...new Set(loadCharacters().map(character => character.id))];
    if (!characterIds.length) return;
    try {
      const refreshedCharacterIds = new Set<string>();
      for (let offset = 0; offset < characterIds.length; offset += 200) {
        if (account.id !== loadActiveAccountId()) return;
        const batch = characterIds.slice(offset, offset + 200);
        const response = await fetch("/api/vector-memory-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ characterIds: batch }),
        });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { results?: GenerationResult[] } | null;
        if (!Array.isArray(payload?.results) || account.id !== loadActiveAccountId()) return;
        for (const item of payload.results) {
          if (!item.success || !item.characterId
            || !Number.isSafeInteger(item.characterGeneration) || !Number.isSafeInteger(item.memoryGeneration)) continue;
          saveCachedVectorMemoryGeneration(account.id, item.characterId, {
            characterGeneration: item.characterGeneration!,
            memoryGeneration: item.memoryGeneration!,
          });
          refreshedCharacterIds.add(item.characterId);
        }
      }
      if (account.id !== loadActiveAccountId()
        || characterIds.some(characterId => !refreshedCharacterIds.has(characterId))) return;
      await hydrateChatStorage();
      if (!isChatStorageHydrated() || account.id !== loadActiveAccountId()) return;
      await retryPendingChatVectorChunks(loadChatSessions(), loadChatMessages);
      if (account.id !== loadActiveAccountId()) return;
      await backfillHistoricalChatVectors();
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
