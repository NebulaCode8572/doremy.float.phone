"use client";

import { useCallback, useEffect } from "react";
import { useAccount } from "@/lib/account-context";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadActiveAccountId } from "@/lib/account-client";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "@/lib/character-storage";
import { saveCachedVectorMemoryGeneration, VECTOR_MEMORY_SETTINGS_UPDATED_EVENT } from "@/lib/vector-memory-generation";
import { hydrateChatStorage, isChatStorageHydrated, loadChatMessages, loadChatSessions, backfillHistoricalChatVectors } from "@/lib/chat-storage";
import { retryPendingChatVectorChunks } from "@/lib/vector-memory-chat-sync";
import {
  backfillLocalMemoryVectors,
  retryPendingMemoryIndexes,
  retryPendingMemoryVectorDeletes,
  syncImportedMemoryPending,
} from "@/lib/vector-memory-sync";

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
    try {
      await hydrateKvDb();
      const characterIds = [...new Set(loadCharacters().map(character => character.id))];
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
        if (!response.ok) {
          console.warn("[VectorMemory] Generation refresh returned HTTP " + response.status + "; continuing with successfully refreshed characters.");
          break;
        }
        const payload = await response.json().catch(() => null) as { results?: GenerationResult[] } | null;
        if (account.id !== loadActiveAccountId()) return;
        if (!Array.isArray(payload?.results)) {
          console.warn("[VectorMemory] Generation refresh returned malformed results; continuing with successfully refreshed characters.");
          break;
        }
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
      if (account.id !== loadActiveAccountId()) return;
      if (refreshedCharacterIds.size < characterIds.length) {
        console.warn("[VectorMemory] Some character generations could not be refreshed; only fresh generations will be indexed.");
      }
      // Deletions do not depend on a current generation, so always recover them.
      // Index/retry only characters whose server generations were refreshed this run.
      await retryPendingMemoryVectorDeletes().catch(error => {
        console.warn("[VectorMemory] Pending memory deletions remain queued.", error);
      });
      if (account.id !== loadActiveAccountId()) return;
      const refreshedIds = [...refreshedCharacterIds];
      if (refreshedIds.length) {
        // Resume exact persisted operations first. Historical backfill must not
        // create a new operation ID for a source whose previous CAS may have committed.
        await retryPendingMemoryIndexes(refreshedIds).catch(error => {
          console.warn("[VectorMemory] Pending memory indexes remain queued.", error);
        });
        if (account.id !== loadActiveAccountId()) return;
        await syncImportedMemoryPending(refreshedIds).catch(error => {
          console.warn("[VectorMemory] Imported memory indexes remain queued.", error);
        });
        if (account.id !== loadActiveAccountId()) return;
        await backfillLocalMemoryVectors(refreshedIds).catch(error => {
          console.warn("[VectorMemory] Historical core/long-term memory backfill remains queued.", error);
          return 0;
        });
        if (account.id !== loadActiveAccountId()) return;
      }

      await hydrateChatStorage();
      if (!isChatStorageHydrated() || account.id !== loadActiveAccountId()) return;
      const refreshedSessions = loadChatSessions().filter(session =>
        Boolean(session.contactId) && refreshedCharacterIds.has(session.contactId)
      );
      await retryPendingChatVectorChunks(refreshedSessions, loadChatMessages);
      if (account.id !== loadActiveAccountId()) return;
      await backfillHistoricalChatVectors(refreshedIds);
    } catch (error) {
      // Generation unavailable means cloud indexing pauses; local chat/memory writes continue.
      // Keep the failure visible so a configuration/network problem is diagnosable.
      console.warn("[VectorMemory] Generation bootstrap paused; pending work remains queued.", error);
    }
  }, [account.id]);

  useEffect(() => {
    void refresh();
    window.addEventListener("online", refresh);
    window.addEventListener(CHARACTERS_UPDATED_EVENT, refresh);
    window.addEventListener(VECTOR_MEMORY_SETTINGS_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener(CHARACTERS_UPDATED_EVENT, refresh);
      window.removeEventListener(VECTOR_MEMORY_SETTINGS_UPDATED_EVENT, refresh);
    };
  }, [refresh]);

  return null;
}
