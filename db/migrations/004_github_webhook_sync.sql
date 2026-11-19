ALTER TABLE github_repository_sources
  ADD COLUMN IF NOT EXISTS github_webhook_id text,
  ADD COLUMN IF NOT EXISTS github_webhook_secret_ciphertext text,
  ADD COLUMN IF NOT EXISTS github_webhook_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS github_webhook_last_error text,
  ADD COLUMN IF NOT EXISTS last_synced_commit_sha text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'github_repository_sources_webhook_status_check'
       AND conrelid = 'github_repository_sources'::regclass
  ) THEN
    ALTER TABLE github_repository_sources
      ADD CONSTRAINT github_repository_sources_webhook_status_check
      CHECK (github_webhook_status IN ('pending', 'active', 'failed', 'disabled'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS github_sync_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES github_repository_sources(id) ON DELETE CASCADE,
  actor_subject_id text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('initial', 'webhook', 'reconcile')),
  head_sha text,
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

CREATE UNIQUE INDEX IF NOT EXISTS github_sync_jobs_one_active_per_source_idx
  ON github_sync_jobs (source_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS github_sync_jobs_ready_idx
  ON github_sync_jobs (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES github_repository_sources(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES github_sync_jobs(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, source_id)
);

CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received_idx
  ON github_webhook_deliveries (received_at);

INSERT INTO github_sync_jobs (
  id,
  organization_id,
  source_id,
  actor_subject_id,
  trigger
)
SELECT
  gen_random_uuid(),
  source.organization_id,
  source.id,
  COALESCE(source.updated_by_subject_id, link.connected_by_subject_id, 'system:github-sync'),
  'initial'
FROM github_repository_sources AS source
JOIN github_organization_accounts AS link
  ON link.id = source.organization_account_id
 AND link.organization_id = source.organization_id
JOIN github_oauth_accounts AS account
  ON account.id = link.github_oauth_account_id
WHERE source.status = 'active'
  AND account.status = 'active'
  AND NOT EXISTS (
    SELECT 1
      FROM github_sync_jobs AS existing
     WHERE existing.source_id = source.id
       AND existing.trigger = 'initial'
  )
ON CONFLICT DO NOTHING;
