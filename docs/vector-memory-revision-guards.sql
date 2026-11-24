-- Atomic per-source revision guards for Vector Memory.
-- Safe to apply to an existing deployment; creates metadata only and never reads or changes memory content.
-- service_role is the only role granted access. Functions remain SECURITY INVOKER.

create table if not exists public.app_user_vector_memory_versions (
  user_id text not null,
  character_id text not null,
  source_app text not null,
  source_id text not null,
  source_kind text not null check (source_kind in ('summary','chat_chunk','core_memory','long_term_memory')),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id, source_app, source_id, source_kind)
);
alter table public.app_user_vector_memory_versions enable row level security;
revoke all on public.app_user_vector_memory_versions from public, anon, authenticated;
grant all on public.app_user_vector_memory_versions to service_role;

create or replace function public.reserve_vector_memory_revision(
  p_user_id text, p_character_id text, p_source_app text, p_source_id text, p_source_kind text
) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare v_revision bigint;
begin
  insert into public.app_user_vector_memory_versions(user_id,character_id,source_app,source_id,source_kind,revision,updated_at)
  values (p_user_id,p_character_id,p_source_app,p_source_id,p_source_kind,1,now())
  on conflict (user_id,character_id,source_app,source_id,source_kind)
  do update set revision = public.app_user_vector_memory_versions.revision + 1, updated_at = now()
  returning revision into v_revision;
  return v_revision;
end;
$$;

create or replace function public.commit_vector_memory_revision(
  p_user_id text, p_character_id text, p_source_app text, p_source_id text, p_source_kind text,
  p_revision bigint, p_content text, p_embedding extensions.vector, p_metadata jsonb
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_current_revision bigint;
  v_rows integer;
begin
  -- Lock the revision row so reserve/delete RPCs serialize with this commit.
  select revision into v_current_revision
  from public.app_user_vector_memory_versions
  where user_id=p_user_id and character_id=p_character_id and source_app=p_source_app
    and source_id=p_source_id and source_kind=p_source_kind
  for update;
  if not found or v_current_revision <> p_revision then
    return false;
  end if;
  insert into public.app_user_vector_memories(
    user_id,character_id,source_app,source_id,source_kind,content,embedding,metadata,updated_at
  ) values (
    p_user_id,p_character_id,p_source_app,p_source_id,p_source_kind,p_content,p_embedding,coalesce(p_metadata,'{}'::jsonb),now()
  )
  on conflict (user_id,character_id,source_app,source_id,source_kind)
  do update set content=excluded.content, embedding=excluded.embedding, metadata=excluded.metadata, updated_at=now();
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.delete_vector_memory_source(
  p_user_id text,p_character_id text,p_source_app text,p_source_id text,p_source_kind text
) returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  update public.app_user_vector_memory_versions
  set revision=revision+1,updated_at=now()
  where user_id=p_user_id and character_id=p_character_id and source_app=p_source_app
    and source_id=p_source_id and (p_source_kind is null or source_kind=p_source_kind);
  delete from public.app_user_vector_memories
  where user_id=p_user_id and character_id=p_character_id and source_app=p_source_app
    and source_id=p_source_id and (p_source_kind is null or source_kind=p_source_kind);
end;
$$;

create or replace function public.delete_vector_memory_session_chunks(
  p_user_id text,p_character_id text,p_session_id text
) returns void
language plpgsql security invoker set search_path = ''
as $$
declare v_prefix text := 'session:' || p_session_id || ':chunk:%';
begin
  update public.app_user_vector_memory_versions
  set revision=revision+1,updated_at=now()
  where user_id=p_user_id and character_id=p_character_id and source_app='chat'
    and source_kind='chat_chunk' and source_id like v_prefix;
  delete from public.app_user_vector_memories
  where user_id=p_user_id and character_id=p_character_id and source_app='chat'
    and source_kind='chat_chunk' and metadata->>'sessionId'=p_session_id;
end;
$$;

create or replace function public.delete_vector_memory_character(
  p_user_id text,p_character_id text,p_memory_only boolean default false
) returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  update public.app_user_vector_memory_versions
  set revision=revision+1,updated_at=now()
  where user_id=p_user_id and character_id=p_character_id
    and (not p_memory_only or source_kind in ('summary','core_memory','long_term_memory'));
  delete from public.app_user_vector_memories
  where user_id=p_user_id and character_id=p_character_id
    and (not p_memory_only or source_kind in ('summary','core_memory','long_term_memory'));
end;
$$;

revoke all on function public.reserve_vector_memory_revision(text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.commit_vector_memory_revision(text,text,text,text,text,bigint,text,extensions.vector,jsonb) from public,anon,authenticated;
revoke all on function public.delete_vector_memory_source(text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.delete_vector_memory_session_chunks(text,text,text) from public,anon,authenticated;
revoke all on function public.delete_vector_memory_character(text,text,boolean) from public,anon,authenticated;
grant execute on function public.reserve_vector_memory_revision(text,text,text,text,text) to service_role;
grant execute on function public.commit_vector_memory_revision(text,text,text,text,text,bigint,text,extensions.vector,jsonb) to service_role;
grant execute on function public.delete_vector_memory_source(text,text,text,text,text) to service_role;
grant execute on function public.delete_vector_memory_session_chunks(text,text,text) to service_role;
grant execute on function public.delete_vector_memory_character(text,text,boolean) to service_role;
