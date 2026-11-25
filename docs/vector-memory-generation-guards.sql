-- Server-controlled generations for broad Vector Memory deletion.
-- Metadata only: this migration never reads or changes vector-memory content.
-- Tables/RPCs remain service_role-only and SECURITY INVOKER.

create table if not exists public.app_user_vector_memory_generations (
  user_id text not null,
  character_id text not null,
  character_generation bigint not null default 0 check (character_generation >= 0),
  memory_generation bigint not null default 0 check (memory_generation >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id)
);
alter table public.app_user_vector_memory_generations enable row level security;
revoke all on public.app_user_vector_memory_generations from public, anon, authenticated;
grant all on public.app_user_vector_memory_generations to service_role;

-- Seed a nonzero generation for broad tombstones created before this migration.
insert into public.app_user_vector_memory_generations (
  user_id, character_id, character_generation, memory_generation, updated_at
)
select user_id, character_id,
  max(case when scope_type = 'character' then 1 else 0 end)::bigint,
  max(case when scope_type = 'character_memory' then 1 else 0 end)::bigint,
  now()
from public.app_user_vector_memory_tombstones
where scope_type in ('character','character_memory')
group by user_id, character_id
on conflict (user_id, character_id) do update set
  character_generation = greatest(public.app_user_vector_memory_generations.character_generation, excluded.character_generation),
  memory_generation = greatest(public.app_user_vector_memory_generations.memory_generation, excluded.memory_generation),
  updated_at = now();

create or replace function public.get_vector_memory_generation(p_user_id text, p_character_id text)
returns table(character_generation bigint, memory_generation bigint)
language plpgsql security invoker set search_path = ''
as $$
begin
  if p_user_id is null or p_character_id is null or length(p_user_id) = 0 or length(p_character_id) = 0 then
    raise exception 'invalid_generation_identity';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));
  insert into public.app_user_vector_memory_generations(user_id, character_id)
  values (p_user_id, p_character_id)
  on conflict (user_id, character_id) do nothing;
  return query
  select g.character_generation, g.memory_generation
  from public.app_user_vector_memory_generations g
  where g.user_id = p_user_id and g.character_id = p_character_id;
end;
$$;

drop function if exists public.reserve_vector_memory_revision(text,text,text,text,text,timestamptz,text);
create or replace function public.reserve_vector_memory_revision(
  p_user_id text, p_character_id text, p_source_app text, p_source_id text,
  p_source_kind text, p_source_updated_at timestamptz, p_session_id text,
  p_character_generation bigint, p_memory_generation bigint
) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare
  v_revision bigint;
  v_source_lock text;
  v_character_generation bigint;
  v_memory_generation bigint;
begin
  if p_source_updated_at is null or p_character_generation is null or p_memory_generation is null then
    return 0;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));
  insert into public.app_user_vector_memory_generations(user_id, character_id)
  values (p_user_id, p_character_id)
  on conflict (user_id, character_id) do nothing;
  select g.character_generation, g.memory_generation
    into v_character_generation, v_memory_generation
  from public.app_user_vector_memory_generations g
  where g.user_id = p_user_id and g.character_id = p_character_id
  for update;
  if p_character_generation <> v_character_generation then return 0; end if;
  if p_source_kind <> 'chat_chunk' and p_memory_generation <> v_memory_generation then return 0; end if;

  if p_source_kind = 'chat_chunk' and p_session_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vector-memory:session:' || p_user_id || chr(31) || p_character_id || chr(31) || p_session_id, 0
    ));
  end if;
  v_source_lock := p_source_app || chr(31) || p_source_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:source:' || p_user_id || chr(31) || p_character_id || chr(31) || v_source_lock, 0
  ));

  -- Exact source/session tombstones are permanent. Broad deletion is enforced
  -- by server generations, not by client-supplied timestamps.
  if exists (
    select 1 from public.app_user_vector_memory_tombstones t
    where t.user_id = p_user_id and t.character_id = p_character_id
      and (
        (t.scope_type = 'source' and t.source_app = p_source_app
          and t.source_id = p_source_id and t.source_kind in (p_source_kind, '*'))
        or (t.scope_type = 'session' and p_source_kind = 'chat_chunk'
          and p_source_app = 'chat' and t.scope_id = p_session_id)
      )
  ) then return 0; end if;

  insert into public.app_user_vector_memory_versions(
    user_id,character_id,source_app,source_id,source_kind,revision,source_updated_at,updated_at
  ) values (
    p_user_id,p_character_id,p_source_app,p_source_id,p_source_kind,1,p_source_updated_at,now()
  )
  on conflict (user_id,character_id,source_app,source_id,source_kind)
  do update set
    revision = public.app_user_vector_memory_versions.revision + 1,
    source_updated_at = excluded.source_updated_at,
    updated_at = now()
  where public.app_user_vector_memory_versions.source_updated_at is null
     or excluded.source_updated_at >= public.app_user_vector_memory_versions.source_updated_at
  returning revision into v_revision;
  if not found then return 0; end if;
  return v_revision;
end;
$$;

create or replace function public.delete_vector_memory_character(
  p_user_id text, p_character_id text, p_memory_only boolean default false
) returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_scope_type text := case when p_memory_only then 'character_memory' else 'character' end;
  v_scope_id text := case when p_memory_only then 'memory' else 'all' end;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));
  insert into public.app_user_vector_memory_generations(
    user_id, character_id, character_generation, memory_generation, updated_at
  ) values (
    p_user_id, p_character_id,
    case when p_memory_only then 0 else 1 end,
    case when p_memory_only then 1 else 0 end,
    now()
  )
  on conflict (user_id, character_id) do update set
    character_generation = public.app_user_vector_memory_generations.character_generation
      + case when p_memory_only then 0 else 1 end,
    memory_generation = public.app_user_vector_memory_generations.memory_generation
      + case when p_memory_only then 1 else 0 end,
    updated_at = now();

  insert into public.app_user_vector_memory_tombstones(
    user_id,character_id,scope_type,scope_id,source_app,source_id,source_kind,deleted_at
  ) values (p_user_id,p_character_id,v_scope_type,v_scope_id,'','','',now())
  on conflict (user_id,character_id,scope_type,scope_id,source_app,source_id,source_kind)
  do update set deleted_at = greatest(public.app_user_vector_memory_tombstones.deleted_at, excluded.deleted_at);

  update public.app_user_vector_memory_versions
  set revision=revision+1,
      source_updated_at=greatest(coalesce(source_updated_at,'-infinity'::timestamptz),now()),
      updated_at=now()
  where user_id=p_user_id and character_id=p_character_id
    and (not p_memory_only or source_kind in ('summary','core_memory','long_term_memory'));
  delete from public.app_user_vector_memories
  where user_id=p_user_id and character_id=p_character_id
    and (not p_memory_only or source_kind in ('summary','core_memory','long_term_memory'));
end;
$$;


-- Keep session deletion race-safe for generation-scoped chat chunk IDs.
create or replace function public.delete_vector_memory_session_chunks(
  p_user_id text,p_character_id text,p_session_id text
) returns void
language plpgsql security invoker set search_path = ''
as $
declare v_prefix text := 'session:' || p_session_id || ':';
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:session:' || p_user_id || chr(31) || p_character_id || chr(31) || p_session_id, 0
  ));
  insert into public.app_user_vector_memory_tombstones(
    user_id,character_id,scope_type,scope_id,source_app,source_id,source_kind,deleted_at
  ) values (p_user_id,p_character_id,'session',p_session_id,'chat','','chat_chunk',now())
  on conflict (user_id,character_id,scope_type,scope_id,source_app,source_id,source_kind)
  do update set deleted_at = greatest(public.app_user_vector_memory_tombstones.deleted_at, excluded.deleted_at);

  update public.app_user_vector_memory_versions
  set revision=revision+1,
      source_updated_at=greatest(coalesce(source_updated_at,'-infinity'::timestamptz),now()),
      updated_at=now()
  where user_id=p_user_id and character_id=p_character_id and source_app='chat'
    and source_kind='chat_chunk' and left(source_id,length(v_prefix))=v_prefix;

  delete from public.app_user_vector_memories
  where user_id=p_user_id and character_id=p_character_id and source_app='chat'
    and source_kind='chat_chunk' and metadata->>'sessionId'=p_session_id;
end;
$;

revoke all on function public.get_vector_memory_generation(text,text) from public, anon, authenticated;
grant execute on function public.get_vector_memory_generation(text,text) to service_role;
revoke all on function public.reserve_vector_memory_revision(text,text,text,text,text,timestamptz,text,bigint,bigint) from public, anon, authenticated;
grant execute on function public.reserve_vector_memory_revision(text,text,text,text,text,timestamptz,text,bigint,bigint) to service_role;
revoke all on function public.delete_vector_memory_character(text,text,boolean) from public, anon, authenticated;
grant execute on function public.delete_vector_memory_character(text,text,boolean) to service_role;
