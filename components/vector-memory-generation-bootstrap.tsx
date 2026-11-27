"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAccount } from "@/lib/account-context";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadActiveAccountId, saveActiveAccountId } from "@/lib/account-client";
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
  errorCode?: string;
  characterGeneration?: number;
  memoryGeneration?: number;
};

export function VectorMemoryGenerationBootstrap() {
  const { account } = useAccount();
  const currentAccountIdRef = useRef(account.id);
  currentAccountIdRef.current = account.id;

  const refresh = useCallback(async () => {
    if (!account.id) return;
    try {
      await hydrateKvDb();
      // The AccountProvider is the authenticated source of truth. Align the
      // persisted cache owner with it even when a stale ID from a previous mode
      // or account is already present. An obsolete in-flight refresh must never
      // overwrite the identity after the provider has switched accounts.
      if (currentAccountIdRef.current !== account.id) return;
      if (loadActiveAccountId() !== account.id) saveActiveAccountId(account.id);
      if (currentAccountIdRef.current !== account.id || account.id !== loadActiveAccountId()) return;
      // Hydrate chat sessions before selecting generation targets. A private chat can
      // outlive its character card (or the card can be temporarily absent from the
      // character library); its contactId is still a valid indexing target as long
      // as the session is unowned or belongs to this account.
      await hydrateChatStorage();
      if (!isChatStorageHydrated() || account.id !== loadActiveAccountId()) return;
      const chatCharacterIds = loadChatSessions()
        .filter(session => !session.isGroup && Boolean(session.contactId)
          && (!session.vectorMemoryAccountId || session.vectorMemoryAccountId === account.id))
        .map(session => session.contactId);
      const characterCardIds = loadCharacters().map(character => character.id);
      const characterIds = [...new Set([
        ...characterCardIds,
        ...chatCharacterIds,
      ].filter(Boolean))];
      if (!characterIds.length) {
        console.warn("[VectorMemory] Generation bootstrap found no character targets.", {
          characterCardCount: characterCardIds.length,
          privateSessionCount: chatCharacterIds.length,
        });
      } else {
        console.info("[VectorMemory] Generation bootstrap requesting targets.", {
          characterCardCount: characterCardIds.length,
          privateSessionCount: chatCharacterIds.length,
          uniqueCharacterCount: characterIds.length,
          accountMode: account.id === "local_user" ? "self_hosted" : "account",
        });
      }
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
          const failure = await response.json().catch(() => null) as { errorCode?: string; error?: string } | null;
          console.warn("[VectorMemory] Generation refresh request failed.", {
            httpStatus: response.status,
            errorCode: failure?.errorCode,
            error: failure?.error,
          });
          break;
        }
        const payload = await response.json().catch(() => null) as { results?: GenerationResult[] } | null;
        if (account.id !== loadActiveAccountId()) return;
        if (!Array.isArray(payload?.results)) {
          console.warn("[VectorMemory] Generation refresh returned malformed results; continuing with successfully refreshed characters.");
          break;
        }
        const failedGenerations = payload.results.filter(item => !item.success);
        if (failedGenerations.length) {
          console.warn("[VectorMemory] Generation lookup failed for some characters.", failedGenerations.map(item => ({
            characterId: item.characterId,
            errorCode: item.errorCode,
          })));
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

      if (!isChatStorageHydrated() || account.id !== loadActiveAccountId()) return;
      const refreshedSessions = loadChatSessions().filter(session =>
        !session.isGroup && Boolean(session.contactId) && refreshedCharacterIds.has(session.contactId)
        && (!session.vectorMemoryAccountId || session.vectorMemoryAccountId === account.id)
      );
      await retryPendingChatVectorChunks(refreshedSessions, loadChatMessages);
      if (account.id !== loadActiveAccountId()) return;
      await backfillHistoricalChatVectors(refreshedIds);
    } catch (error) {
      // Generation unavailable means cloud indexing pauses; local chat/memory writes continue.
      // Keep the failure visible so pending work can be diagnosed without stopping local writes.
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
