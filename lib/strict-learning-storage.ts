import { kvMoveIfAbsent, registerDynamicPrefix, registerKvMigration } from "@/lib/kv-db";

const LEGACY_STORE_KEY = "strict_learning_center_v1";
const STORE_KEY_PREFIX = "strict_learning_center_v1:";
const LEGACY_CONFLICT_BACKUP_PREFIX = "strict_learning_legacy_conflict_backup_";

// Register before/after KV hydration so legacy localStorage data is imported
// into IndexedDB before the account-scoped atomic move runs.
registerKvMigration(LEGACY_STORE_KEY);
registerDynamicPrefix(STORE_KEY_PREFIX);

/** Each signed-in app account gets an isolated local learning record. */
export function getStrictLearningStoreKey(accountId: string): string {
  const normalized = accountId.trim();
  return normalized ? `${STORE_KEY_PREFIX}${encodeURIComponent(normalized)}` : `${STORE_KEY_PREFIX}anonymous`;
}

/**
 * One-time migration from the pre-account-scoped key. The legacy record is
 * assigned only to the first account that opens the feature after this update;
 * subsequent accounts receive their own empty store.
 */
export async function migrateLegacyStrictLearningStore(accountId: string): Promise<string> {
  const scopedKey = getStrictLearningStoreKey(accountId);
  // IndexedDB transactions serialize across tabs: only the first account can
  // claim the legacy record, and no second account can copy it concurrently.
  const outcome = await kvMoveIfAbsent(LEGACY_STORE_KEY, scopedKey);
  if (!outcome.moved) {
    // If this account already has a scoped record but the old global key also
    // exists, preserve the old copy under a non-account key instead of
    // discarding it or allowing a later account to claim it.
    await kvMoveIfAbsent(
      LEGACY_STORE_KEY,
      `${LEGACY_CONFLICT_BACKUP_PREFIX}${encodeURIComponent(normalized || "anonymous")}_${Date.now()}`,
    );
  }
  return scopedKey;
}
