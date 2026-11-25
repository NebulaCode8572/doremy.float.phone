-- Vector Memory schema for Supabase.
-- Run once in the Supabase SQL Editor with a role allowed to create extensions/tables.
-- This script creates schema only; it does not read, migrate, or delete memory rows.
--
-- Security model:
--   - Application access is server-side through the service_role key only.
--   - RLS is enabled and no client-facing policies are created.
--   - The search RPC is executable only by service_role.
--   - API keys are stored encrypted by the application (AES-256-GCM).

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.app_user_vector_memories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  character_id text not null,
  source_app text not null,
  source_id text not null,
  source_kind text not null
    check (source_kind in ('summary', 'chat_chunk', 'core_memory', 'long_term_memory')),
  content text not null,
  embedding extensions.vector(1024) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, character_id, source_app, source_id, source_kind)
);

create index if not exists app_user_vector_memories_embedding_idx
  on public.app_user_vector_memories
  using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists app_user_vector_memories_scope_idx
  on public.app_user_vector_memories (user_id, character_id, source_app);

alter table public.app_user_vector_memories enable row level security;

create table if not exists public.app_user_vector_memory_settings (
  user_id text primary key,
  base_url text not null,
  model text not null default 'BAAI/bge-m3',
  api_key_ciphertext text not null,
  api_key_iv text not null,
  api_key_tag text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_user_vector_memory_settings enable row level security;

-- No anon/authenticated table grants or RLS policies are needed: Next.js uses
-- the server-side service_role credential. Explicitly remove default PUBLIC
-- access to the RPC and grant it only to service_role.
create or replace function public.match_vector_memory(
  query_embedding extensions.vector,
  match_user_id text,
  match_character_id text,
  match_threshold double precision default 0.30,
  match_count integer default 8
)
returns table (
  id uuid,
  source_app text,
  source_id text,
  source_kind text,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $function$
  select
    memories.id,
    memories.source_app,
    memories.source_id,
    memories.source_kind,
    memories.content,
    memories.metadata,
    1 - (memories.embedding <=> query_embedding) as similarity
  from public.app_user_vector_memories as memories
  where memories.user_id = match_user_id
    and memories.character_id = match_character_id
    and 1 - (memories.embedding <=> query_embedding) >= match_threshold
  order by memories.embedding <=> query_embedding asc
  limit least(greatest(match_count, 1), 20);
$function$;

revoke all on function public.match_vector_memory(
  extensions.vector, text, text, double precision, integer
) from public, anon, authenticated;
grant execute on function public.match_vector_memory(
  extensions.vector, text, text, double precision, integer
) to service_role;

-- Keep the tables private to server-side service_role access.
revoke all on public.app_user_vector_memories from public, anon, authenticated;
revoke all on public.app_user_vector_memory_settings from public, anon, authenticated;
grant all on public.app_user_vector_memories to service_role;
grant all on public.app_user_vector_memory_settings to service_role;


-- Follow-up migrations for a fresh installation:
-- 1. docs/vector-memory-revision-schema.sql
-- 2. docs/vector-memory-tombstone-guards.sql
-- 3. docs/vector-memory-generation-guards.sql
-- 4. docs/vector-memory-source-cas.sql
--
-- Existing installations already have the revision metadata table from the earlier
-- rollout and should not re-run historical SQL. The file
-- docs/vector-memory-revision-guards.sql is now a deprecation notice only.
--
-- Apply the CAS migration before deploying the CAS-enabled application. The CAS
-- migration initializes only revision metadata based on source-row existence; it
-- does not read or rewrite memory content or embeddings.
