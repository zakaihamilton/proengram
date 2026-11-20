ALTER TABLE brain_items
  DROP CONSTRAINT IF EXISTS brain_items_kind_check;

ALTER TABLE brain_items
  ADD CONSTRAINT brain_items_kind_check
  CHECK (
    kind IN (
      'github_markdown',
      'google_drive_document',
      'saved_answer',
      'sentry8_policy',
      'decision_record',
      'project_update'
    )
  );

ALTER TABLE brain_items
  ADD COLUMN IF NOT EXISTS source_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS project_name text;

CREATE INDEX IF NOT EXISTS brain_items_org_project_history_idx
  ON brain_items (organization_id, lower(project_name), occurred_at DESC)
  WHERE kind IN ('decision_record', 'project_update') AND is_active = true;

CREATE TABLE IF NOT EXISTS google_drive_accounts (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL UNIQUE,
  google_subject text NOT NULL,
  google_email text NOT NULL,
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text NOT NULL,
  access_token_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauthorize_required')),
  connected_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS google_drive_sources (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  drive_id text NOT NULL,
  drive_name text NOT NULL,
  selected_folder_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'needs_auth')),
  change_page_token text,
  updated_by_subject_id text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, drive_id)
);

CREATE INDEX IF NOT EXISTS google_drive_sources_org_status_idx
  ON google_drive_sources (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS google_drive_file_states (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES google_drive_sources(id) ON DELETE CASCADE,
  file_id text NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  modified_at timestamptz,
  status text NOT NULL CHECK (status IN ('indexed', 'skipped', 'removed', 'error')),
  message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, file_id)
);

CREATE INDEX IF NOT EXISTS google_drive_file_states_org_status_idx
  ON google_drive_file_states (organization_id, source_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS google_drive_sync_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES google_drive_sources(id) ON DELETE CASCADE,
  actor_subject_id text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('initial', 'poll', 'reconcile')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS google_drive_sync_jobs_one_active_per_source_idx
  ON google_drive_sync_jobs (source_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS google_drive_sync_jobs_ready_idx
  ON google_drive_sync_jobs (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS brain_item_versions (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  revision_key text NOT NULL,
  source_revision text,
  source_modified_at timestamptz,
  markdown text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, item_id, revision_key)
);

CREATE INDEX IF NOT EXISTS brain_item_versions_item_history_idx
  ON brain_item_versions (organization_id, item_id, source_modified_at DESC, observed_at DESC);

CREATE TABLE IF NOT EXISTS brain_chunks (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  content text NOT NULL,
  locator text,
  search_vector_english tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(content, ''))
  ) STORED,
  search_vector_simple tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(content, ''))
  ) STORED,
  UNIQUE (item_id, ordinal)
);

CREATE INDEX IF NOT EXISTS brain_chunks_search_english_idx
  ON brain_chunks USING GIN (search_vector_english);

CREATE INDEX IF NOT EXISTS brain_chunks_search_simple_idx
  ON brain_chunks USING GIN (search_vector_simple);

CREATE INDEX IF NOT EXISTS brain_chunks_org_item_idx
  ON brain_chunks (organization_id, item_id, ordinal);

INSERT INTO brain_item_versions (
  id,
  organization_id,
  item_id,
  revision_key,
  source_revision,
  source_modified_at,
  markdown,
  observed_at
)
SELECT
  gen_random_uuid(),
  item.organization_id,
  item.id,
  coalesce(item.source_revision, 'initial:' || item.id::text),
  item.source_revision,
  item.source_modified_at,
  item.markdown,
  item.updated_at
FROM brain_items AS item
ON CONFLICT (organization_id, item_id, revision_key) DO NOTHING;

INSERT INTO brain_chunks (id, organization_id, item_id, ordinal, content, locator)
SELECT
  gen_random_uuid(),
  item.organization_id,
  item.id,
  chunk.ordinal,
  CASE WHEN chunk.ordinal = 1 THEN item.title || E'\n' || substring(item.markdown FROM 1 FOR 1540)
       ELSE substring(item.markdown FROM ((chunk.ordinal - 1) * 1500) + 1 FOR 1800)
  END,
  NULL
FROM brain_items AS item
CROSS JOIN LATERAL generate_series(
  1,
  greatest(1, ceil(char_length(item.markdown)::numeric / 1500)::integer)
) AS chunk(ordinal)
ON CONFLICT (item_id, ordinal) DO NOTHING;

CREATE TABLE IF NOT EXISTS knowledge_feedback (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES brain_items(id) ON DELETE CASCADE,
  actor_subject_id text NOT NULL,
  rating text NOT NULL CHECK (rating IN ('helpful', 'incorrect', 'outdated', 'missing_context')),
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_subject_id text,
  UNIQUE (organization_id, item_id, actor_subject_id)
);

CREATE INDEX IF NOT EXISTS knowledge_feedback_org_status_idx
  ON knowledge_feedback (organization_id, status, created_at DESC);
