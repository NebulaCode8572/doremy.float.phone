# Vector Memory source CAS and multi-device chat protocol

Status: implemented in the feature branch; the SQL migration still requires explicit application to the Supabase project before deploying/testing the CAS-enabled client.

## Source identity

A logical source is identified by:

`(user_id, character_id, source_app, source_id, source_kind)`

Long-term/core memory IDs remain stable across devices. Client wall-clock timestamps are descriptive metadata only and are not used to determine causal order.

Chat chunks use a per-install device identity to prevent two devices with independent local counters from writing the same source ID:

`session:<sessionId>:g:<characterGeneration>:device:<deviceId>:chunk:<bucket>:v:<localVersion>-<randomNonce>`

Session deletion remains session-wide and removes every device's chunks. The retrieval API collapses byte-for-byte identical copies of a logical session bucket, while preserving divergent snapshots rather than silently discarding content.

## Atomic commit contract

The new `commit_vector_memory_cas` RPC combines version comparison and vector upsert in one database transaction. There is no separate reservation step, so a failed embedding cannot consume a revision.

Each request carries:

- `operationId`: client-generated UUID persisted with the exact payload snapshot and reused on retry.
- `expectedRevision`: last server-acknowledged committed revision; zero means the client believes no committed source exists.
- `characterGeneration` and `memoryGeneration`: server-issued deletion fences.
- stable source identity, content, embedding and metadata.

The RPC locks in the established order: character, optional session, source. It then checks current generations, exact source/session tombstones, and the operation ledger. It compares `expectedRevision` with `committed_revision`. A match atomically upserts the vector, advances the committed revision exactly once, and records the operation result.

The operation ledger stores source identity, operation ID, expected/result revision, and a fingerprint of content plus metadata. It does not store memory content or embeddings. The fingerprint intentionally excludes the embedding representation so tiny floating-point differences across retries do not break idempotency.

## Typed outcomes

- `committed`: commit completed, with the new revision.
- `already_committed`: this exact operation was committed earlier; return its original revision.
- `conflict`: another source revision won; return the current revision. Never auto-retry the stale payload against it.
- `deleted`: a source/session tombstone wins; terminal.
- `stale_generation`: deletion generation changed; terminal.
- `operation_id_reused`: same operation ID was used for a different source or payload; do not retry automatically.
- `invalid`: request contract violation.

The API no longer maps an ambiguous numeric zero to deletion success.

## Client persistence and conflict behavior

For long-term/core memory, local records persist:

- `vectorMemoryRevision`: last acknowledged server revision.
- `vectorMemoryPendingOperationId` and `vectorMemoryPendingFingerprint`: exact retry snapshot identity.
- `vectorMemoryConflictRevision`: current cloud revision observed after a CAS conflict.

The exact operation snapshot is persisted to the local pending queue before network submission. Retries reuse the same operation ID and expected revision. A changed local snapshot gets a new operation ID while retaining the last acknowledged revision.

On successful commit, the acknowledged revision is saved without overwriting any newer local content edited while the request was in flight. On conflict, automatic retries stop and the conflict revision is shown in the Memory Bank. The user must explicitly choose “确认用本机版本覆盖云端版本” before the local snapshot is submitted against that newer revision. This avoids silently turning CAS into last-writer-wins.

Deleted or stale-generation results clear obsolete pending uploads. Network failures preserve the operation snapshot.

Existing cloud rows are initialized at committed revision 1 by the migration. Old local records without a revision therefore fail closed with a conflict rather than overwriting existing cloud content. The user can explicitly resolve the conflict in Memory Bank.

## Database security and migration

Apply `docs/vector-memory-revision-schema.sql` (fresh installations only), then the tombstone and generation guards, then `docs/vector-memory-source-cas.sql`.

The CAS migration:

- Adds `committed_revision` to the existing source version table.
- Initializes existing rows with a matching vector row to committed revision 1; rows without a vector row remain revision 0.
- Creates a metadata-only operation ledger with RLS enabled and no client grants.
- Exposes a narrowly scoped `SECURITY INVOKER` RPC with `search_path = ''`, executable only by `service_role`.
- Preserves character/session/source locks, generation fences and tombstones.

Do not apply the migration until the feature-branch API/client rollout is ready. Do not deploy the CAS-enabled API before the migration has been applied.

## Known multi-device behavior

Device-scoped chat IDs prevent concurrent devices from colliding. If devices hold divergent copies of the same session bucket, both snapshots can exist; identical copies are deduplicated at retrieval, divergent copies remain independently searchable. Session deletion removes all copies. This is intentionally fail-safe but is not a full server-side merge of divergent offline timelines.

## Rollout

1. Review the SQL migration and apply it to Supabase only with explicit authorization.
2. Deploy the matching API and client code together.
3. Verify new-source commits, idempotent retry, stale-generation rejection, explicit conflict resolution, two-device chat indexing, and session-wide deletion.
4. Only after these checks, consider removing legacy timestamp-based RPC helpers.
