-- Base per-source revision metadata required by tombstone, generation and CAS guards.
-- Metadata only; no vector memory content or embeddings are read or modified.
create table if not exists public.app_user_vector_memory_versions (
  user_id text not null,
  character_id text not null,
  source_app text not null,
  source_id text not null,
  source_kind text not null,
  revision bigint not null default 0 check (revision >= 0),
  source_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id, source_app, source_id, source_kind)
);
alter table public.app_user_vector_memory_versions enable row level security;
revoke all on public.app_user_vector_memory_versions from public, anon, authenticated;
grant all on public.app_user_vector_memory_versions to service_role;
