-- Atomic compare-and-swap commits for Vector Memory sources.
-- Apply only after the matching API/client rollout is ready. This file is NOT
-- applied automatically and does not read memory content.
--
-- Existing revision remains the legacy reservation counter. committed_revision is
-- the CAS version of the last successfully committed payload.
alter table public.app_user_vector_memory_versions
  add column if not exists committed_revision bigint not null default 0
  check (committed_revision >= 0);

-- Existing remote rows are considered revision 1. Rows without a remote payload
-- remain revision 0 even if the legacy reservation counter was consumed.
update public.app_user_vector_memory_versions v
set committed_revision = 1
where v.committed_revision = 0
  and exists (
    select 1 from public.app_user_vector_memories m
    where m.user_id=v.user_id and m.character_id=v.character_id
      and m.source_app=v.source_app and m.source_id=v.source_id
      and m.source_kind=v.source_kind
  );

create table if not exists public.app_user_vector_memory_operations (
  user_id text not null,
  operation_id text not null,
  character_id text not null,
  source_app text not null,
  source_id text not null,
  source_kind text not null,
  expected_revision bigint not null check (expected_revision >= 0),
  committed_revision bigint,
  payload_fingerprint text not null,
  status text not null check (status in ('committed')),
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);
alter table public.app_user_vector_memory_operations enable row level security;
revoke all on public.app_user_vector_memory_operations from public, anon, authenticated;
grant all on public.app_user_vector_memory_operations to service_role;

create or replace function public.commit_vector_memory_cas(
  p_user_id text,
  p_character_id text,
  p_source_app text,
  p_source_id text,
  p_source_kind text,
  p_session_id text,
  p_operation_id text,
  p_expected_revision bigint,
  p_character_generation bigint,
  p_memory_generation bigint,
  p_content text,
  p_embedding extensions.vector,
  p_metadata jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_character_generation bigint;
  v_memory_generation bigint;
  v_current_revision bigint;
  v_next_revision bigint;
  v_fingerprint text;
  v_existing public.app_user_vector_memory_operations%rowtype;
begin
  if p_user_id is null or p_character_id is null or p_source_app is null
    or p_source_id is null or p_source_kind is null or p_operation_id is null
    or length(p_operation_id) < 16 or length(p_operation_id) > 120
    or p_expected_revision is null or p_expected_revision < 0
    or p_character_generation is null or p_memory_generation is null
    or p_content is null or length(pg_catalog.btrim(p_content)) = 0
    or p_embedding is null then
    return pg_catalog.jsonb_build_object('status','invalid');
  end if;

  v_fingerprint := pg_catalog.md5(
    p_content || chr(31) || p_embedding::text || chr(31) || coalesce(p_metadata,'{}'::jsonb)::text
  );

  -- Keep the established lock order: character -> optional session -> source.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));
  if p_source_kind = 'chat_chunk' and p_session_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vector-memory:session:' || p_user_id || chr(31) || p_character_id || chr(31) || p_session_id, 0
    ));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:source:' || p_user_id || chr(31) || p_character_id || chr(31)
      || p_source_app || chr(31) || p_source_id, 0
  ));

  insert into public.app_user_vector_memory_generations(user_id,character_id)
  values (p_user_id,p_character_id) on conflict (user_id,character_id) do nothing;
  select g.character_generation,g.memory_generation
    into v_character_generation,v_memory_generation
  from public.app_user_vector_memory_generations g
  where g.user_id=p_user_id and g.character_id=p_character_id
  for update;

  if p_character_generation <> v_character_generation
    or (p_source_kind <> 'chat_chunk' and p_memory_generation <> v_memory_generation) then
    return pg_catalog.jsonb_build_object('status','stale_generation');
  end if;

  if exists (
    select 1 from public.app_user_vector_memory_tombstones t
    where t.user_id=p_user_id and t.character_id=p_character_id
      and (
        (t.scope_type='source' and t.source_app=p_source_app
          and t.source_id=p_source_id and t.source_kind in (p_source_kind,'*'))
        or (t.scope_type='session' and p_source_kind='chat_chunk'
          and p_source_app='chat' and t.scope_id=p_session_id)
      )
  ) then
    return pg_catalog.jsonb_build_object('status','deleted');
  end if;

  -- Idempotency check is performed under the source lock. Reusing an operation ID
  -- for a different payload is rejected rather than silently treated as success.
  select * into v_existing
  from public.app_user_vector_memory_operations o
  where o.user_id=p_user_id and o.operation_id=p_operation_id;
  if found then
    if v_existing.character_id <> p_character_id
      or v_existing.source_app <> p_source_app
      or v_existing.source_id <> p_source_id
      or v_existing.source_kind <> p_source_kind
      or v_existing.payload_fingerprint <> v_fingerprint then
      return pg_catalog.jsonb_build_object('status','operation_id_reused');
    end if;
    return pg_catalog.jsonb_build_object(
      'status','already_committed',
      'revision',v_existing.committed_revision
    );
  end if;

  insert into public.app_user_vector_memory_versions(
    user_id,character_id,source_app,source_id,source_kind,revision,
    committed_revision,source_updated_at,updated_at
  ) values (
    p_user_id,p_character_id,p_source_app,p_source_id,p_source_kind,0,0,null,now()
  ) on conflict (user_id,character_id,source_app,source_id,source_kind) do nothing;

  select v.committed_revision into v_current_revision
  from public.app_user_vector_memory_versions v
  where v.user_id=p_user_id and v.character_id=p_character_id
    and v.source_app=p_source_app and v.source_id=p_source_id
    and v.source_kind=p_source_kind
  for update;

  if v_current_revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'status','conflict','current_revision',v_current_revision
    );
  end if;

  v_next_revision := v_current_revision + 1;
  insert into public.app_user_vector_memories(
    user_id,character_id,source_app,source_id,source_kind,
    content,embedding,metadata,updated_at
  ) values (
    p_user_id,p_character_id,p_source_app,p_source_id,p_source_kind,
    pg_catalog.btrim(p_content),p_embedding,coalesce(p_metadata,'{}'::jsonb),now()
  ) on conflict (user_id,character_id,source_app,source_id,source_kind)
  do update set content=excluded.content,embedding=excluded.embedding,
    metadata=excluded.metadata,updated_at=now();

  update public.app_user_vector_memory_versions
  set committed_revision=v_next_revision,updated_at=now()
  where user_id=p_user_id and character_id=p_character_id
    and source_app=p_source_app and source_id=p_source_id
    and source_kind=p_source_kind;

  insert into public.app_user_vector_memory_operations(
    user_id,operation_id,character_id,source_app,source_id,source_kind,
    expected_revision,committed_revision,payload_fingerprint,status
  ) values (
    p_user_id,p_operation_id,p_character_id,p_source_app,p_source_id,p_source_kind,
    p_expected_revision,v_next_revision,v_fingerprint,'committed'
  );

  return pg_catalog.jsonb_build_object('status','committed','revision',v_next_revision);
end;
$$;

revoke all on function public.commit_vector_memory_cas(
  text,text,text,text,text,text,text,bigint,bigint,bigint,text,extensions.vector,jsonb
) from public, anon, authenticated;
grant execute on function public.commit_vector_memory_cas(
  text,text,text,text,text,text,text,bigint,bigint,bigint,text,extensions.vector,jsonb
) to service_role;
