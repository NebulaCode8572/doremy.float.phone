-- Durable deletion tombstones and source timestamp ordering for Vector Memory.
-- Stores only source identities and timestamps; never reads or changes memory content.
-- All table access remains server-only through SECURITY INVOKER RPCs.

alter table public.app_user_vector_memory_versions
  add column if not exists source_updated_at timestamptz;

create table if not exists public.app_user_vector_memory_tombstones (
  user_id text not null,
  character_id text not null,
  scope_type text not null check (scope_type in ('source','session','character','character_memory')),
  scope_id text not null default '',
  source_app text not null default '',
  source_id text not null default '',
  source_kind text not null default '',
  deleted_at timestamptz not null default now(),
  primary key (user_id, character_id, scope_type, scope_id, source_app, source_id, source_kind)
);
alter table public.app_user_vector_memory_tombstones enable row level security;
revoke all on public.app_user_vector_memory_tombstones from public, anon, authenticated;
grant all on public.app_user_vector_memory_tombstones to service_role;

drop function if exists public.reserve_vector_memory_revision(text,text,text,text,text);
create or replace function public.reserve_vector_memory_revision(
  p_user_id text,
  p_character_id text,
  p_source_app text,
  p_source_id text,
  p_source_kind text,
  p_source_updated_at timestamptz,
  p_session_id text default null
) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare
  v_revision bigint;
  v_source_lock text;
begin
  if p_source_updated_at is null then
    return 0;
  end if;

  -- The character lock serializes every reserve with character-wide deletion.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));

  if p_source_kind = 'chat_chunk' and p_session_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vector-memory:session:' || p_user_id || chr(31) || p_character_id || chr(31) || p_session_id, 0
    ));
  end if;

  v_source_lock := p_source_app || chr(31) || p_source_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:source:' || p_user_id || chr(31) || p_character_id || chr(31) || v_source_lock, 0
  ));

  -- Tombstones cover sources that had never reached the cloud before deletion.
  if exists (
    select 1
    from public.app_user_vector_memory_tombstones t
    where t.user_id = p_user_id and t.character_id = p_character_id
      and (
        -- Exact source/session tombstones are permanent for that identity. A
        -- deliberate recreation must use a new source/session ID; client clocks
        -- can never move a deleted identity past its tombstone.
        (t.scope_type = 'source' and t.source_app = p_source_app
            and t.source_id = p_source_id and t.source_kind in (p_source_kind, '*'))
        or (t.scope_type = 'session' and p_source_kind = 'chat_chunk'
            and p_source_app = 'chat' and t.scope_id = p_session_id)
        -- Broad character tombstones still use the source timestamp until the
        -- explicit generation handshake is implemented for those scopes.
        or (t.deleted_at >= p_source_updated_at and (
          (t.scope_type = 'character' and t.scope_id = 'all')
          or (t.scope_type = 'character_memory' and t.scope_id = 'memory'
              and p_source_kind in ('summary','core_memory','long_term_memory'))
        ))
      )
  ) then
    return 0;
  end if;

  -- Keep the greatest observed source timestamp as well as the request revision.
  -- This also rejects an older offline snapshot that arrives after a newer edit.
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

  if not found then
    return 0;
  end if;
  return v_revision;
end;
$$;

create or replace function public.delete_vector_memory_source(
  p_user_id text,p_character_id text,p_source_app text,p_source_id text,p_source_kind text
) returns void
language plpgsql security invoker set search_path = ''
as $$
declare v_kind_key text := coalesce(p_source_kind, '*');
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:character:' || p_user_id || chr(31) || p_character_id, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vector-memory:source:' || p_user_id || chr(31) || p_character_id || chr(31) || p_source_app || chr(31) || p_source_id, 0
  ));

  insert into public.app_user_vector_memory_tombstones(
    user_id,character_id,scope_type,scope_id,source_app,source_id,source_kind,deleted_at
  ) values (p_user_id,p_character_id,'source','',p_source_app,p_source_id,v_kind_key,now())
  on conflict (user_id,character_id,scope_type,scope_id,source_app,source_id,source_kind)
  do update set deleted_at = greatest(public.app_user_vector_memory_tombstones.deleted_at, excluded.deleted_at);

  update public.app_user_vector_memory_versions
  set revision=revision+1,
      source_updated_at=greatest(coalesce(source_updated_at,'-infinity'::timestamptz),now()),
      updated_at=now()
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
declare v_prefix text := 'session:' || p_session_id || ':chunk:';
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
$$;

create or replace function public.delete_vector_memory_character(
  p_user_id text,p_character_id text,p_memory_only boolean default false
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

revoke all on function public.reserve_vector_memory_revision(text,text,text,text,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.delete_vector_memory_source(text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.delete_vector_memory_session_chunks(text,text,text) from public,anon,authenticated;
revoke all on function public.delete_vector_memory_character(text,text,boolean) from public,anon,authenticated;
grant execute on function public.reserve_vector_memory_revision(text,text,text,text,text,timestamptz,text) to service_role;
grant execute on function public.delete_vector_memory_source(text,text,text,text,text) to service_role;
grant execute on function public.delete_vector_memory_session_chunks(text,text,text) to service_role;
grant execute on function public.delete_vector_memory_character(text,text,boolean) to service_role;
