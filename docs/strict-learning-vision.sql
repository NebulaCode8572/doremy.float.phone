-- Strict Learning / global vision API credentials.
-- Run this in the Supabase SQL Editor before using the global Vision API settings.
-- The API key is AES-256-GCM encrypted by the Next.js server; plaintext is never stored.
create table if not exists public.app_user_vision_settings (
  user_id text primary key check (user_id = 'local_user'),
  provider text not null default 'openai-compatible',
  base_url text not null,
  model text not null,
  api_key_ciphertext text not null,
  api_key_iv text not null,
  api_key_tag text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_user_vision_settings enable row level security;
revoke all on public.app_user_vision_settings from anon, authenticated;
grant all on public.app_user_vision_settings to service_role;
-- No client policies: access is only through the server's Supabase service-role client.
