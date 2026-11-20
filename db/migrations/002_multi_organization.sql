CREATE TABLE IF NOT EXISTS github_repository_settings (
  organization_id text PRIMARY KEY,
  installation_id text NOT NULL,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  default_branch text NOT NULL,
  updated_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
