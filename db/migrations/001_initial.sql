CREATE TABLE IF NOT EXISTS brain_items (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('github_markdown', 'saved_answer', 'sentry8_policy')),
  external_key text NOT NULL,
  title text NOT NULL,
  markdown text NOT NULL,
  source_url text,
  source_revision text,
  owner_subject_id text,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_batch_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  visibility text NOT NULL DEFAULT 'company' CHECK (visibility = 'company'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(markdown, ''))
  ) STORED,
  UNIQUE (organization_id, kind, external_key)
);

CREATE INDEX IF NOT EXISTS brain_items_search_idx ON brain_items USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS brain_items_org_kind_updated_idx
  ON brain_items (organization_id, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS source_syncs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  item_count integer NOT NULL DEFAULT 0,
  message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS source_syncs_org_started_idx
  ON source_syncs (organization_id, started_at DESC);

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  actor_subject_id text NOT NULL,
  action text NOT NULL,
  item_kind text,
  item_id text,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_events_org_created_idx
  ON activity_events (organization_id, created_at DESC);
