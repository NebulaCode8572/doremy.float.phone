// lib/kv-db.ts
// Generic IndexedDB-backed key-value store with synchronous in-memory cache.
// Replaces all localStorage usage to avoid the ~5-10MB quota limit.

import Dexie from "dexie";

class KvDatabase extends Dexie {
    entries!: Dexie.Table<{ key: string; value: string }, string>;
    constructor() {
        super("AiPhoneKvDB");
        this.version(1).stores({ entries: "key" });
    }
}

const kvDb = new KvDatabase();

// ── In-memory cache ──
const _cache = new Map<string, string>();
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;
let _hydrateError: unknown = null;

// ── Migration registry ──
const _fixedKeys: string[] = [];
const _dynamicPrefixes: string[] = [];

export function registerKvMigration(lsKey: string): void {
    _fixedKeys.push(lsKey);
    // If hydration already ran, this module was imported late (e.g. a lazily
    // loaded app). Migrate its key now so its localStorage data isn't stranded
    // forever — hydrateKvDb only migrates keys registered before it ran.
    if (_hydrated) migrateLegacyKey(lsKey);
}

export function registerDynamicPrefix(prefix: string): void {
    _dynamicPrefixes.push(prefix);
    if (_hydrated) migrateLegacyPrefix(prefix);
}

const LOCAL_STORAGE_FALLBACK_PREFIX = "\u0000KV_FALLBACK_V1\u0000";

function decodeLocalStorageValue(raw: string): { value: string; isFallback: boolean } {
    return raw.startsWith(LOCAL_STORAGE_FALLBACK_PREFIX)
        ? { value: raw.slice(LOCAL_STORAGE_FALLBACK_PREFIX.length), isFallback: true }
        : { value: raw, isFallback: false };
}

// Migrate a legacy localStorage value only when IndexedDB has no newer value.
// Explicitly marked fallback values are newer failed-write recovery copies.
function migrateLegacyKey(lsKey: string): void {
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem(lsKey);
    if (raw === null) return;
    const decoded = decodeLocalStorageValue(raw);
    kvDb.entries.get(lsKey).then(existing => {
        if (localStorage.getItem(lsKey) !== raw) return;
        if (!decoded.isFallback && _cache.has(lsKey) && _cache.get(lsKey) !== decoded.value) return;
        if (!decoded.isFallback && existing && existing.value !== decoded.value) {
            // An unmarked, differing value is an old mirror, not proof of a
            // failed recent write. Preserve it rather than overwriting IDB.
            return;
        }
        if (existing?.value === decoded.value) {
            _cache.set(lsKey, decoded.value);
            removeLegacyLocalStorageKeyIfRaw(lsKey, raw);
            return;
        }
        return kvDb.entries.put({ key: lsKey, value: decoded.value }).then(() => {
            if (localStorage.getItem(lsKey) === raw) {
                _cache.set(lsKey, decoded.value);
                removeLegacyLocalStorageKeyIfRaw(lsKey, raw);
            }
        });
    }).catch(() => {
        // Preserve localStorage as the recovery copy.
    });
}

function migrateLegacyPrefix(prefix: string): void {
    if (typeof window === "undefined") return;
    const matched: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) matched.push(k);
    }
    for (const k of matched) migrateLegacyKey(k);
}

function matchesDynamicPrefix(key: string): boolean {
    return _dynamicPrefixes.some(prefix => key.startsWith(prefix));
}

function isManagedLegacyKey(key: string): boolean {
    return _fixedKeys.includes(key) || matchesDynamicPrefix(key);
}

function removeLegacyLocalStorageKey(key: string): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem(key);
    } catch {
        // Ignore localStorage cleanup failures; IndexedDB remains the source of truth.
    }
}

function removeLegacyLocalStorageKeyIfRaw(key: string, raw: string): void {
    if (typeof window === "undefined") return;
    try {
        if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    } catch {
        // Ignore localStorage cleanup failures; IndexedDB remains the source of truth.
    }
}

function removeLegacyLocalStorageKeyIfValue(key: string, value: string): void {
    removeLegacyLocalStorageKeyIfRaw(key, value);
    removeLegacyLocalStorageKeyIfRaw(key, LOCAL_STORAGE_FALLBACK_PREFIX + value);
}

// localStorage 配额只有 ~5MB,超过这个量级的 value(如自定义APP的整批
// 音频/封面 dataURL)镜像必失败,setItem 前还得整份拷贝一次内存——直接跳过。
const LOCAL_STORAGE_MIRROR_MAX_LENGTH = 400_000;

function writeFallbackLocalStorage(key: string, value: string): void {
    if (typeof window === "undefined" || !isManagedLegacyKey(key)) return;
    if (value.length + LOCAL_STORAGE_FALLBACK_PREFIX.length > LOCAL_STORAGE_MIRROR_MAX_LENGTH) {
        // Do not leave an older mirror behind: hydration could mistake it for
        // the latest value and restore stale data over IndexedDB.
        removeLegacyLocalStorageKey(key);
        return;
    }
    try {
        localStorage.setItem(key, LOCAL_STORAGE_FALLBACK_PREFIX + value);
    } catch {
        // A stale old mirror is worse than no fallback copy.
        removeLegacyLocalStorageKey(key);
    }
}

function isAbortLikeError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const maybe = err as { name?: string; message?: string; inner?: unknown };
    return (
        maybe.name === "AbortError"
        || maybe.message?.includes("transaction was aborted") === true
        || isAbortLikeError(maybe.inner)
    );
}

// ── Hydration (call once at app startup) ──
// 语义与 chat-storage 对齐：成功才置 _hydrated，失败清掉在途 promise 允许下次重试。
// 此前失败也置 _hydrated=true：IndexedDB 一次临时读不出来，缓存就是空的，kvGet
// 全部返回 null，「读取失败」和「本来就没有」无法区分——下一次任何整包
// 读改写（如线下记录追加）都会拿空数据把 IndexedDB 里的真实历史覆盖掉。
export function hydrateKvDb(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return Promise.resolve();
    if (_hydratePromise) return _hydratePromise;
    _hydratePromise = (async () => {
        // Load existing IDB data into cache and track what is actually
        // persisted. The in-memory cache may contain values from a previous
        // failed hydration attempt, so it must not decide whether migration
        // data can safely be removed from localStorage.
        const all = await kvDb.entries.toArray();
        const persisted = new Map<string, string>();
        for (const { key, value } of all) {
            persisted.set(key, value);
            if (!_cache.has(key)) _cache.set(key, value);
        }

        // Migrate from localStorage. Cache updates are delayed until the
        // IndexedDB batch succeeds; a failed write leaves the old copy intact
        // and retryable on the next hydration attempt.
        const batch: { key: string; value: string }[] = [];
        const removeKeys = new Map<string, string>();

        const queueLegacyValue = (key: string, raw: string) => {
            const decoded = decodeLocalStorageValue(raw);
            const existing = persisted.get(key);
            if (!decoded.isFallback && _cache.has(key) && _cache.get(key) !== decoded.value) {
                // A value written during an earlier failed hydration attempt
                // may be newer than this unmarked legacy mirror.
                return;
            }
            if (decoded.isFallback) {
                // A marked value is a known failed-write recovery copy and
                // takes precedence over the older IndexedDB value.
                if (existing !== decoded.value) batch.push({ key, value: decoded.value });
                else _cache.set(key, decoded.value);
                removeKeys.set(key, raw);
                return;
            }
            if (existing === undefined) {
                batch.push({ key, value: decoded.value });
                removeKeys.set(key, raw);
            } else if (existing === decoded.value) {
                removeKeys.set(key, raw);
            }
            // If an unmarked legacy mirror differs from an existing IDB value,
            // leave it untouched as a recovery copy; never overwrite IDB with
            // an ambiguous stale value.
        };

        // Fixed keys
        for (const lsKey of _fixedKeys) {
            const raw = localStorage.getItem(lsKey);
            if (raw !== null) queueLegacyValue(lsKey, raw);
        }

        // Dynamic prefix keys
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !matchesDynamicPrefix(k)) continue;
            const raw = localStorage.getItem(k);
            if (raw !== null) queueLegacyValue(k, raw);
        }

        // Only apply the exact localStorage snapshots inspected above. If a
        // newer write replaced one while hydration was reading, leave that
        // newer fallback marker for its own IndexedDB write/retry path.
        const safeBatch = batch.filter(({ key }) => {
            const sourceRaw = removeKeys.get(key);
            return sourceRaw !== undefined && localStorage.getItem(key) === sourceRaw;
        });
        if (safeBatch.length > 0) {
            await kvDb.transaction("rw", kvDb.entries, () => kvDb.entries.bulkPut(safeBatch));
            for (const { key, value } of safeBatch) {
                if (localStorage.getItem(key) === removeKeys.get(key)) _cache.set(key, value);
            }
        }
        for (const [key, raw] of removeKeys) {
            removeLegacyLocalStorageKeyIfRaw(key, raw);
        }
    })().then(() => {
        _hydrated = true;
        _hydrateError = null;
        _hydratePromise = null;
    }).catch(err => {
        // 不向上抛：既有调用方大多不接 catch。失败状态通过 isKvHydrated() /
        // getKvHydrationError() 暴露，入口（MainApp）负责拦住用户并提供重试。
        console.warn("[KvDB] hydration failed, will retry on next call:", err);
        _hydrateError = err;
        _hydratePromise = null;
    });
    return _hydratePromise;
}

/** 最近一次水合失败的错误（成功后清空）。配合 isKvHydrated() 判断失败态。 */
export function getKvHydrationError(): unknown {
    return _hydrateError;
}

// ── Synchronous read (IndexedDB-backed in-memory cache only) ──
/** kv 是否已从 IndexedDB 水合完成。孤儿素材清理等「以 kv 内容为安全依据」的
 *  流程必须先确认此状态：未水合时 kvEntries() 是空的，扫不到引用会导致误删。 */
export function isKvHydrated(): boolean {
    return _hydrated;
}

export function kvGet(key: string): string | null {
    const cached = _cache.get(key);
    if (cached !== undefined) return cached;
    return null;
}

// ── Write: update cache + fire-and-forget to IDB ──
export function kvSet(key: string, value: string): void {
    _cache.set(key, value);
    if (isManagedLegacyKey(key)) writeFallbackLocalStorage(key, value);
    kvDb.entries.put({ key, value }).then(() => {
        if (isManagedLegacyKey(key)) removeLegacyLocalStorageKeyIfValue(key, value);
    }).catch(err => {
        if (_cache.get(key) === value) writeFallbackLocalStorage(key, value);
        if (!isAbortLikeError(err)) {
            console.warn("[KvDB] put failed:", key, err);
        }
    });
}

export async function kvSetAsync(key: string, value: string): Promise<void> {
    _cache.set(key, value);
    if (isManagedLegacyKey(key)) writeFallbackLocalStorage(key, value);
    try {
        await kvDb.entries.put({ key, value });
        if (isManagedLegacyKey(key)) removeLegacyLocalStorageKeyIfValue(key, value);
    } catch (err) {
        if (_cache.get(key) === value) writeFallbackLocalStorage(key, value);
        if (!isAbortLikeError(err)) {
            console.warn("[KvDB] put failed:", key, err);
        }
        throw err;
    }
}

// ── Delete ──
export function kvRemove(key: string): void {
    _cache.delete(key);
    if (isManagedLegacyKey(key)) removeLegacyLocalStorageKey(key);
    kvDb.entries.delete(key).catch(err =>
        console.warn("[KvDB] delete failed:", key, err));
}

/** Atomically move a key if the destination is absent. Safe across tabs. */
export async function kvMoveIfAbsent(
    sourceKey: string,
    targetKey: string,
): Promise<{ moved: boolean; value: string | null }> {
    if (sourceKey === targetKey) {
        const current = await kvDb.entries.get(targetKey);
        return { moved: false, value: current?.value ?? null };
    }

    let outcome: { moved: boolean; value: string | null } = { moved: false, value: null };
    await kvDb.transaction("rw", kvDb.entries, async () => {
        const target = await kvDb.entries.get(targetKey);
        if (target) {
            // Never discard the source when a destination already exists.
            // The caller can preserve or reconcile the two copies explicitly.
            outcome = { moved: false, value: target.value };
            return;
        }

        const source = await kvDb.entries.get(sourceKey);
        if (!source) {
            outcome = { moved: false, value: null };
            return;
        }

        await kvDb.entries.put({ key: targetKey, value: source.value });
        await kvDb.entries.delete(sourceKey);
        outcome = { moved: true, value: source.value };
    });

    if (outcome.moved) _cache.delete(sourceKey);
    if (outcome.value !== null) _cache.set(targetKey, outcome.value);
    else if (outcome.moved) _cache.delete(targetKey);

    if (outcome.moved && isManagedLegacyKey(sourceKey)) removeLegacyLocalStorageKeyIfValue(sourceKey, outcome.value ?? "");
    return outcome;
}

// ── Iterate keys with a prefix (for dynamic keys) ──
export function kvKeysWithPrefix(prefix: string): string[] {
    const result: string[] = [];
    for (const k of _cache.keys()) {
        if (k.startsWith(prefix)) result.push(k);
    }
    return result;
}

export function kvEntries(): Array<{ key: string; value: string }> {
    return Array.from(_cache.entries()).map(([key, value]) => ({ key, value }));
}
