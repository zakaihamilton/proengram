CREATE TABLE IF NOT EXISTS github_oauth_accounts (
  id uuid PRIMARY KEY,
  github_user_id text NOT NULL UNIQUE,
  github_login text NOT NULL,
  avatar_url text,
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text NOT NULL,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorize_required')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_organization_accounts (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  github_oauth_account_id uuid NOT NULL REFERENCES github_oauth_accounts(id) ON DELETE CASCADE,
  connected_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, github_oauth_account_id)
);

CREATE INDEX IF NOT EXISTS github_organization_accounts_org_idx
  ON github_organization_accounts (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS github_organization_accounts_account_idx
  ON github_organization_accounts (github_oauth_account_id);

CREATE TABLE IF NOT EXISTS github_repository_sources (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  organization_account_id uuid REFERENCES github_organization_accounts(id) ON DELETE SET NULL,
  github_repository_id text,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  repository_owner_normalized text GENERATED ALWAYS AS (lower(repository_owner)) STORED,
  repository_name_normalized text GENERATED ALWAYS AS (lower(repository_name)) STORED,
  default_branch text NOT NULL,
  status text NOT NULL DEFAULT 'needs_auth' CHECK (status IN ('active', 'needs_auth', 'disabled')),
  updated_by_subject_id text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, repository_owner_normalized, repository_name_normalized)
);

CREATE UNIQUE INDEX IF NOT EXISTS github_repository_sources_org_repo_id_idx
  ON github_repository_sources (organization_id, github_repository_id)
  WHERE github_repository_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS github_repository_sources_org_status_idx
  ON github_repository_sources (organization_id, status, created_at DESC);

INSERT INTO github_repository_sources (
  id,
  organization_id,
  github_repository_id,
  repository_owner,
  repository_name,
  default_branch,
  status,
  updated_by_subject_id,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  legacy.organization_id,
  NULL,
  legacy.repository_owner,
  legacy.repository_name,
  legacy.default_branch,
  'needs_auth',
  legacy.updated_by_subject_id,
  legacy.created_at,
  legacy.updated_at
FROM github_repository_settings AS legacy
ON CONFLICT DO NOTHING;

ALTER TABLE brain_items ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE source_syncs ADD COLUMN IF NOT EXISTS source_id uuid;

UPDATE brain_items AS item
SET source_id = source.id
FROM github_repository_settings AS legacy
JOIN github_repository_sources AS source
  ON source.organization_id = legacy.organization_id
  AND source.repository_owner_normalized = lower(legacy.repository_owner)
  AND source.repository_name_normalized = lower(legacy.repository_name)
WHERE item.organization_id = legacy.organization_id
  AND item.kind = 'github_markdown'
  AND item.source_id IS NULL;

UPDATE source_syncs AS sync_record
SET source_id = source.id
FROM github_repository_settings AS legacy
JOIN github_repository_sources AS source
  ON source.organization_id = legacy.organization_id
  AND source.repository_owner_normalized = lower(legacy.repository_owner)
  AND source.repository_name_normalized = lower(legacy.repository_name)
WHERE sync_record.organization_id = legacy.organization_id
  AND sync_record.source = 'github'
  AND sync_record.source_id IS NULL;

ALTER TABLE brain_items DROP CONSTRAINT IF EXISTS brain_items_organization_id_kind_external_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS brain_items_github_source_external_key_idx
  ON brain_items (organization_id, source_id, external_key)
  WHERE kind = 'github_markdown' AND source_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS brain_items_github_legacy_external_key_idx
  ON brain_items (organization_id, external_key)
  WHERE kind = 'github_markdown' AND source_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS brain_items_non_github_external_key_idx
  ON brain_items (organization_id, kind, external_key)
  WHERE kind <> 'github_markdown';

CREATE INDEX IF NOT EXISTS brain_items_org_source_active_idx
  ON brain_items (organization_id, source_id, updated_at DESC)
  WHERE kind = 'github_markdown' AND is_active = true;

CREATE INDEX IF NOT EXISTS source_syncs_org_source_started_idx
  ON source_syncs (organization_id, source_id, started_at DESC);
