import { kvGet, kvRemove, kvSet } from "@/lib/kv-db";

const LEGACY_STORE_KEY = "strict_learning_center_v1";
const STORE_KEY_PREFIX = "strict_learning_center_v1:";

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
export function migrateLegacyStrictLearningStore(accountId: string): string {
  const scopedKey = getStrictLearningStoreKey(accountId);
  if (kvGet(scopedKey) !== null) return scopedKey;
  const legacy = kvGet(LEGACY_STORE_KEY);
  if (legacy !== null) {
    kvSet(scopedKey, legacy);
    kvRemove(LEGACY_STORE_KEY);
  }
  return scopedKey;
}
