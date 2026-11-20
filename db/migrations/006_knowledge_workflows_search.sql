-- Hybrid semantic and lexical knowledge search requires the pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE brain_items
  ADD COLUMN IF NOT EXISTS current_version_id uuid;

ALTER TABLE brain_item_versions
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS project_name text,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS citations jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE brain_item_versions AS version
   SET title = coalesce(version.title, item.title),
       project_name = coalesce(version.project_name, item.project_name),
       occurred_at = coalesce(version.occurred_at, item.occurred_at),
       citations = CASE
         WHEN version.citations = '[]'::jsonb THEN coalesce(item.citations, '[]'::jsonb)
         ELSE version.citations
       END
  FROM brain_items AS item
 WHERE item.id = version.item_id
   AND item.organization_id = version.organization_id;

ALTER TABLE brain_item_versions
  ALTER COLUMN title SET NOT NULL;

ALTER TABLE brain_chunks
  ADD COLUMN IF NOT EXISTS version_id uuid,
  ADD COLUMN IF NOT EXISTS embedding vector(384),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'ready', 'failed'));

-- Every item has at least one indexed revision before the current pointer is set.
INSERT INTO brain_item_versions (
  id,
  organization_id,
  item_id,
  revision_key,
  source_revision,
  source_modified_at,
  markdown,
  title,
  project_name,
  occurred_at,
  citations,
  observed_at
)
SELECT gen_random_uuid(), item.organization_id, item.id,
       'migration:' || item.id::text, item.source_revision, item.source_modified_at,
       item.markdown, item.title, item.project_name, item.occurred_at,
       item.citations, item.updated_at
  FROM brain_items AS item
 WHERE NOT EXISTS (
   SELECT 1 FROM brain_item_versions AS version
    WHERE version.organization_id = item.organization_id AND version.item_id = item.id
 );

WITH current_versions AS (
  SELECT DISTINCT ON (version.organization_id, version.item_id)
         version.organization_id, version.item_id, version.id
    FROM brain_item_versions AS version
   ORDER BY version.organization_id, version.item_id,
            coalesce(version.source_modified_at, version.observed_at) DESC,
            version.observed_at DESC, version.id DESC
)
UPDATE brain_items AS item
   SET current_version_id = version.id
  FROM current_versions AS version
 WHERE item.organization_id = version.organization_id
   AND item.id = version.item_id
   AND item.current_version_id IS NULL;

UPDATE brain_chunks AS chunk
   SET version_id = item.current_version_id
  FROM brain_items AS item
 WHERE chunk.organization_id = item.organization_id
   AND chunk.item_id = item.id
   AND chunk.version_id IS NULL;

ALTER TABLE brain_chunks
  ALTER COLUMN version_id SET NOT NULL;

ALTER TABLE brain_chunks
  DROP CONSTRAINT IF EXISTS brain_chunks_item_id_ordinal_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brain_items_current_version_fk'
  ) THEN
    ALTER TABLE brain_items
      ADD CONSTRAINT brain_items_current_version_fk
      FOREIGN KEY (current_version_id) REFERENCES brain_item_versions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brain_chunks_version_fk'
  ) THEN
    ALTER TABLE brain_chunks
      ADD CONSTRAINT brain_chunks_version_fk
      FOREIGN KEY (version_id) REFERENCES brain_item_versions(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brain_chunks_version_ordinal_key'
  ) THEN
    ALTER TABLE brain_chunks
      ADD CONSTRAINT brain_chunks_version_ordinal_key UNIQUE (version_id, ordinal);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS brain_chunks_org_item_version_idx
  ON brain_chunks (organization_id, item_id, version_id, ordinal);

CREATE INDEX IF NOT EXISTS brain_chunks_embedding_hnsw_idx
  ON brain_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_embedding_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES brain_item_versions(id) ON DELETE CASCADE,
  model_version text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, version_id)
);

CREATE INDEX IF NOT EXISTS knowledge_embedding_jobs_ready_idx
  ON knowledge_embedding_jobs (next_attempt_at, created_at)
  WHERE status = 'pending';

INSERT INTO knowledge_embedding_jobs (id, organization_id, item_id, version_id)
SELECT gen_random_uuid(), version.organization_id, version.item_id, version.id
  FROM brain_item_versions AS version
ON CONFLICT (organization_id, version_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS knowledge_suggestions (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  request_id uuid NOT NULL,
  proposer_subject_id text NOT NULL,
  suggestion_type text NOT NULL CHECK (suggestion_type IN ('capture', 'edit')),
  target_item_id uuid REFERENCES brain_items(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('saved_answer', 'decision_record', 'project_update')),
  title text NOT NULL,
  markdown text NOT NULL,
  project_name text,
  occurred_at timestamptz,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_by_subject_id text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, proposer_subject_id, request_id),
  CHECK (
    (suggestion_type = 'capture' AND target_item_id IS NULL)
    OR (suggestion_type = 'edit' AND target_item_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS knowledge_suggestions_org_status_idx
  ON knowledge_suggestions (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_suggestions_target_idx
  ON knowledge_suggestions (organization_id, target_item_id, created_at DESC)
  WHERE target_item_id IS NOT NULL;
