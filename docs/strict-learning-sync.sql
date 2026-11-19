-- Strict Learning cloud sync for a single-user self-hosted installation.
-- Every device shares the same local_user identity. The API route additionally
-- requires STRICT_LEARNING_SYNC_SECRET; never expose the service-role key.

create table if not exists public.strict_learning_records (
  user_id text primary key check (user_id = 'local_user'),
  payload jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.strict_learning_records enable row level security;
revoke all on public.strict_learning_records from anon, authenticated;
grant all on public.strict_learning_records to service_role;

create or replace function public.strict_learning_sync_write(
  p_user_id text,
  p_expected_revision bigint,
  p_payload jsonb
)
returns table (ok boolean, revision bigint, payload jsonb, updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved public.strict_learning_records%rowtype;
begin
  if p_user_id <> 'local_user' then
    raise exception 'unsupported_user';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;

  if p_expected_revision = 0 then
    insert into public.strict_learning_records(user_id, payload, revision, updated_at)
    values ('local_user', p_payload, 1, now())
    on conflict (user_id) do nothing
    returning * into saved;
    if found then
      return query select true, saved.revision, saved.payload, saved.updated_at;
      return;
    end if;
  else
    update public.strict_learning_records as current_record
       set payload = p_payload, revision = current_record.revision + 1, updated_at = now()
     where current_record.user_id = 'local_user'
       and current_record.revision = p_expected_revision
     returning current_record.* into saved;
    if found then
      return query select true, saved.revision, saved.payload, saved.updated_at;
      return;
    end if;
  end if;

  select * into saved from public.strict_learning_records where user_id = 'local_user';
  return query select false, coalesce(saved.revision, 0), saved.payload, saved.updated_at;
end;
$$;

revoke all on function public.strict_learning_sync_write(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.strict_learning_sync_write(text, bigint, jsonb) to service_role;
