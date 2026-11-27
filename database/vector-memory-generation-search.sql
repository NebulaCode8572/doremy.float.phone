-- Keep semantic retrieval aligned with the authoritative character/memory generation.
-- The committed operation ledger is the generation source for each current vector row.
CREATE INDEX IF NOT EXISTS app_user_vector_memory_operations_current_source_idx
  ON public.app_user_vector_memory_operations
    (user_id, character_id, source_app, source_id, source_kind, committed_revision)
  WHERE status = 'committed';

CREATE OR REPLACE FUNCTION public.match_vector_memory(
  query_embedding extensions.vector,
  match_user_id text,
  match_character_id text,
  match_threshold double precision DEFAULT 0.30,
  match_count integer DEFAULT 8
)
RETURNS TABLE(
  id uuid,
  source_app text,
  source_id text,
  source_kind text,
  content text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
  select
    memories.id,
    memories.source_app,
    memories.source_id,
    memories.source_kind,
    memories.content,
    memories.metadata,
    1 - (memories.embedding <=> query_embedding) as similarity
  from public.app_user_vector_memories as memories
  join public.app_user_vector_memory_generations as generations
    on generations.user_id = memories.user_id
    and generations.character_id = memories.character_id
  join public.app_user_vector_memory_versions as versions
    on versions.user_id = memories.user_id
    and versions.character_id = memories.character_id
    and versions.source_app = memories.source_app
    and versions.source_id = memories.source_id
    and versions.source_kind = memories.source_kind
  join public.app_user_vector_memory_operations as committed_operations
    on committed_operations.user_id = versions.user_id
    and committed_operations.character_id = versions.character_id
    and committed_operations.source_app = versions.source_app
    and committed_operations.source_id = versions.source_id
    and committed_operations.source_kind = versions.source_kind
    and committed_operations.committed_revision = versions.committed_revision
    and committed_operations.status = 'committed'
  where memories.user_id = match_user_id
    and memories.character_id = match_character_id
    and committed_operations.character_generation = generations.character_generation
    and (
      memories.source_kind = 'chat_chunk'
      or committed_operations.memory_generation = generations.memory_generation
    )
    and 1 - (memories.embedding <=> query_embedding) >= match_threshold
  order by memories.embedding <=> query_embedding asc
  limit least(greatest(match_count, 1), 20);
$function$;
