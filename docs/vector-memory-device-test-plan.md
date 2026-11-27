# Vector Memory CAS device test plan

This is a manual verification plan. No tests or device actions have been run.

## Prerequisites

- Apply `docs/vector-memory-source-cas.sql` to the existing Supabase project after confirming the revision, tombstone, and generation migrations are already present.
- Deploy the matching `feature/vector-memory` API and client together. The CAS-enabled index route requires the new RPC.
- Configure the independent Embedding API and enable Vector Memory.
- Use a disposable test character and synthetic test memories. Do not use real personal memory content for concurrency tests.
- Have two signed-in devices for the same account for multi-device checks.

## 1. First write and idempotent retry

1. On device A, create a new synthetic long-term memory.
2. Confirm the local save completes and the cloud source is indexed.
3. Trigger a retry of the same pending operation (for example, by temporarily interrupting the response after submission, then restoring connectivity).
4. Expected: the retry returns `already_committed`; the source revision does not increment twice and only one logical source is present.

## 2. Competing edits

1. Start with one cloud-synced synthetic memory whose local `vectorMemoryRevision` is known on both devices.
2. Disconnect device B from the network.
3. Edit the same memory independently on devices A and B.
4. Let A sync first, then reconnect B.
5. Expected: B receives a CAS conflict; B's local content remains intact; automatic retry stops; Memory Bank displays the cloud-version warning.
6. On B, explicitly choose “确认用本机版本覆盖云端版本”.
7. Expected: B submits against the observed cloud revision. If another update wins meanwhile, the conflict warning refreshes rather than overwriting silently.

## 3. Deletion wins over offline retries

1. Create a synthetic memory and leave a pending offline edit on device B.
2. On device A, delete the character's Vector Memory (or delete only its long-term/core vectors).
3. Reconnect B.
4. Expected: the stale pending upload receives `stale_generation` and is cleared; deleted content does not reappear.
5. Repeat with a deleted chat session. Expected: the session tombstone rejects every device's pending chat chunk for that session.

## 4. Multi-device chat chunks

1. Open the same private chat session on devices A and B.
2. Let both devices index the same synchronized messages.
3. Expected: source IDs contain different install-scoped device identities; no device overwrites the other's chunk.
4. Search for a query matching that chunk.
5. Expected: byte-for-byte identical copies are deduplicated in retrieval results.
6. Add divergent offline messages on both devices and sync.
7. Expected: divergent snapshots remain separately searchable; the system does not silently choose one based on client timestamps.
8. Delete the session.
9. Expected: session-wide deletion removes all device-scoped chunks and tombstones the session against late uploads.
10. Delete an individual message, then delete the last message in a bucket. Expected: deleted text is never reintroduced by the affected-message snapshot, and an empty bucket deletes its cloud source.
11. Upgrade a device that already has generation-stamped messages and a legacy shared bucket source. Expected: the first generation-scoped sync retires the legacy source even though no message is missing a generation stamp.

## 5. Isolation and local-save guarantees

- Group-chat messages must not enter private-chat Vector Memory.
- Switching accounts must not upload another account's queued entries.
- A failed embedding or unavailable Supabase RPC must not prevent the local traditional-memory save.
- Traditional Memory token budgets must not cap Vector Memory storage or retrieval.
- Import/restore must not upload until the user explicitly confirms import.

## Pass criteria

All checks above pass, the Supabase RPC metadata confirms RLS/service-role-only access and SECURITY INVOKER posture, and no build/type errors occur. Only then is the feature ready for broader real-device use.


## Isolated Supabase test backend configuration

The app's account/session system continues to use the primary application Supabase
project. Vector Memory storage/settings/RPC calls can be routed to a separate test
project with server-only environment variables:

- `VECTOR_MEMORY_SUPABASE_URL`: isolated test project's project URL.
- `VECTOR_MEMORY_SUPABASE_SERVICE_ROLE_KEY`: isolated test project's service-role/secret key. Server only; never use a `NEXT_PUBLIC_` prefix.
- `VECTOR_MEMORY_CREDENTIAL_ENCRYPTION_KEY`: independent 32-byte key, encoded as 64 hexadecimal characters (or base64).

Both dedicated Vector Memory Supabase variables are required. There is no
fallback to the primary application Supabase project: settings, embeddings
configuration, indexing, retrieval, and deletion all fail closed when the
dedicated project is unavailable. The current test branch additionally
allowlists the isolated project host
`hcohoykrxearxqsdbotg.supabase.co`; changing that host requires an explicit
code review. Account authentication remains separate and continues to use the
app's normal authentication path (or the self-hosted access-code identity).

For local testing, add these values only to the local server's ignored
`.env.local` file. Generate the encryption key locally with
`openssl rand -hex 32`; do not paste the key or service-role secret into chat,
GitHub, browser/client variables, or committed files. The dedicated project must
contain the Vector Memory migrations; it does not need the app's account tables.


## Additional regression checks added during generation/retrieval repair

- With a current character generation of 2 and memory generation of 5, retrieval
  must exclude chat chunks committed under character generation 1 and ordinary
  memories committed under memory generation 4; it must retain current chat
  chunks and ordinary memories committed under both current generations.
- Interrupt historical chat backfill after the session row is stamped but before
  message rows are stamped. On the next run, messages whose generation differs
  from the session must be repaired and indexed.
- Send a new message while that character's historical backfill is in progress,
  including after the pass has snapshotted its buckets. A coalesced follow-up pass
  must index the new message rather than dropping the request.
- Run two tabs with different cached generation snapshots. A stale tab must not
  overwrite a newer generation already stored by the other tab; delayed generation
  API responses must not regress either cached counter.
- Force two writers to race on the same chat source revision. The losing writer must advance to the returned current revision and retry with a fresh operation ID instead of remaining pending forever.
- Change only memory_generation between a chat chunk's commit and its retry. Expected: the same chat operation remains idempotent because chat chunks are scoped to character_generation, not memory_generation.
- Verify the settings GET/PUT, embedding connection test, memory deletion,
  indexing, chat-chunk deletion, generation lookup, and semantic search routes
  all check the dedicated Vector Memory database configuration rather than the
  primary application database configuration.
- Verify semantic recall can finish within the API's 45-second execution window;
  the client request must not abort after the previous 8-second timeout.
