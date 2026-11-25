# Vector Memory source CAS and multi-device chat protocol

Status: design specification only. This document does not change the deployed database or runtime behavior.

## Why the current protocol is unsafe

The current index route calls `reserve_vector_memory_revision` before embedding. The RPC increments a source revision and compares the client-provided `source_updated_at` with the stored timestamp. This creates two distinct problems:

1. A client clock set far into the future can permanently reject later legitimate updates.
2. The revision is consumed before embedding and commit. The API currently maps a zero reservation to `success: true, skipped: "deleted"`, although zero can also mean a stale generation, tombstone, or timestamp conflict.

A revision counter alone is not optimistic concurrency control. The client must state which committed revision its edit was based on.

## Required source identity

A logical source has this identity:

`(user_id, character_id, source_app, source_id, source_kind)`

The identity is stable across devices. Device IDs must not be added to long-term memory source IDs or chat bucket source IDs merely to avoid collisions: doing so creates duplicate logical sources and makes session deletion harder.

For chat, use one stable logical ID per session/generation/bucket:

`session:<sessionId>:g:<characterGeneration>:chunk:<bucket>`

The existing `:v:<localCounter>` suffix is not a concurrency primitive and should be retired after a migration/cleanup plan is in place. Existing suffixed IDs remain deletable by the existing session-wide deletion RPC.

## CAS and idempotency contract

Each upload carries:

- `operationId`: client-generated UUID, persisted with the exact content snapshot and reused on every retry of that snapshot.
- `expectedRevision`: last server-acknowledged committed revision for this source; `0` means the client believes the source does not yet exist.
- `characterGeneration` and `memoryGeneration`: unchanged server-issued deletion fences.
- content, embedding, metadata, and stable source identity.

The server must never use `createdAt`, `updatedAt`, or device wall-clock time to establish causal order. Those timestamps may remain descriptive metadata only.

### Reservation

A new service-role-only RPC reserves an operation without advancing the committed source revision.

1. Acquire locks in the existing order: character, optional session, then source.
2. Validate the current server generations.
3. Check exact source and session tombstones.
4. Look up `operationId`. If already committed, return its original committed revision (idempotent success). If already reserved, return the same reservation.
5. Compare `expectedRevision` to the current committed revision. A mismatch returns `conflict`; it must not be treated as deletion.
6. Insert a durable operation row with identity, operation ID, expected revision, generation snapshot, payload fingerprint, and `reserved` state. Do not increment the source revision yet.

A failed embedding leaves a retryable reserved operation and does not block a later operation from using the same expected revision.

### Commit

A second RPC atomically:

1. Locks the source and operation row.
2. Re-checks generations and tombstones (deletion may have happened while embedding was running).
3. Returns the stored result if this operation was already committed.
4. Requires the current committed revision to still equal `expectedRevision`.
5. Upserts the vector row and increments the committed revision exactly once.
6. Marks the operation committed and stores the resulting revision.

If another device committed first, return `conflict`. Do not overwrite the winner. If a deletion/generation fence won, return `deleted`/ `stale_generation` as a terminal result. If infrastructure fails, return a retryable error.

### Result states

The HTTP API must distinguish at least:

- `committed`: success, with the committed revision.
- `already_committed`: idempotent success, with the original revision.
- `conflict`: non-terminal concurrency conflict; never clear the retry item as success.
- `deleted`: terminal tombstone rejection; clear stale pending work.
- `stale_generation`: terminal generation rejection; clear stale pending work.
- `retryable_error`: preserve the same operation ID and retry later.

Do not overload a numeric zero or a boolean to represent all these states.

## Client persistence and conflict behavior

Long-term/core `MemoryEntry` records need a server-acknowledged `vectorMemoryRevision` and a pending operation snapshot containing `operationId`, `expectedRevision`, and a content/metadata fingerprint.

- Persist the operation snapshot before sending the request.
- A retry of an unchanged snapshot reuses the same operation ID and expected revision.
- A changed snapshot gets a new operation ID, but retains the last acknowledged expected revision.
- On `committed` / `already_committed`, persist the returned revision and clear the matching pending operation only if the local content fingerprint still matches the uploaded snapshot.
- On `conflict`, preserve local content and expose a conflict state. Do not automatically retry stale content against the newly observed revision; doing so would turn CAS into last-writer-wins and allow old offline edits to overwrite newer work.
- On `deleted` / `stale_generation`, clear that pending upload without assigning a new generation.
- On network/embedding failure, retain the exact operation snapshot for retry.

For the initial rollout, records without a known server revision may use `expectedRevision = 0` only when the server confirms no current source exists. Existing remote sources require a one-time metadata-only revision lookup or an explicit conflict/reconciliation path. Never infer revision from client timestamps.

## Multi-device chat chunks

Use a stable logical bucket source ID shared by all devices. Each device builds the current bucket from its local synchronized timeline and submits it with the last acknowledged source revision.

- The first successful commit wins for a given expected revision.
- A losing device must reload/reconcile the session timeline, rebuild the bucket, and submit a new operation based on the latest committed revision only if the rebuilt bucket represents the latest synchronized state.
- Never blindly retry the losing device's stale payload with a newer expected revision.
- Deleting a session continues to create the durable session tombstone and delete every bucket for that session. A concurrent in-flight upload must re-check the tombstone at commit and fail terminally.
- Retire the local per-device version counter only after the new stable IDs and cleanup behavior are deployed together. Until then, keep the existing IDs to avoid an incomplete migration.

## Database security and migration requirements

The future migration must:

- Add an operation ledger keyed by `(user_id, operation_id)`, with a unique constraint and source identity fields.
- Keep operation rows metadata-only; do not copy memory content or embeddings into the ledger.
- Enable RLS and revoke all table access from `public`, `anon`, and `authenticated`; grant only the minimum required access to `service_role`.
- Expose only narrowly scoped `SECURITY INVOKER` RPCs with `search_path = ''` and execute grants only to `service_role`.
- Preserve character/session/source lock ordering, generation checks, tombstone checks, and the existing retrieval RLS boundary.
- Avoid dropping the current RPC until the new client/API protocol is deployed and the migration order is explicit.
- Include rollback instructions that do not delete operation history or weaken tombstones.

## Rollout order

1. Add the operation ledger and new CAS RPCs without changing existing RPC behavior.
2. Add a revision lookup RPC and verify grants/RLS metadata.
3. Update the server index route to use the new RPCs and return typed states.
4. Update client persistence, pending queues, and conflict handling.
5. Switch chat buckets to stable logical IDs and add reconciliation behavior.
6. Only then retire the old timestamp-based reservation path.
7. Run authorized tests and device verification after explicit user approval.

No migration should be applied to the live Supabase project until the user explicitly authorizes the database change.
