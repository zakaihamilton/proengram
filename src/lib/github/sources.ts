import "server-only";

import { randomUUID } from "node:crypto";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { apiPath, GITHUB_API_ROOT, githubJson } from "./api-client";
import { getGitHubAccessToken, isGitHubConfigured } from "./connections";
import { deleteGitHubRepositoryWebhook } from "./webhook-api";

type GitHubAccessibleRepository = {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
};

export type GitHubRepositorySourceRow = {
  id: string;
  organization_id: string;
  organization_account_id: string | null;
  github_repository_id: string | null;
  repository_owner: string;
  repository_name: string;
  default_branch: string;
  status: "active" | "needs_auth" | "disabled";
  github_webhook_id?: string | null;
  github_webhook_secret_ciphertext?: string | null;
  github_webhook_status?: "pending" | "active" | "failed" | "disabled";
  github_webhook_last_error?: string | null;
  last_synced_commit_sha?: string | null;
  updated_by_subject_id?: string | null;
  sync_pending?: boolean;
  github_login: string | null;
  account_status: "active" | "reauthorize_required" | null;
  last_synced_at: Date | string | null;
};

type GitHubRepositorySource = {
  id: string;
  organizationAccountId: string | null;
  githubLogin: string | null;
  repositoryId: string | null;
  owner: string;
  repository: string;
  defaultBranch: string;
  status: "active" | "needs_auth" | "disabled";
  webhookStatus: "pending" | "active" | "failed" | "disabled";
  webhookError: string | null;
  syncPending: boolean;
  lastSyncedAt: string | null;
  lastSyncedCommitSha: string | null;
};

export type ResolvedGitHubSource = GitHubRepositorySource & { organizationId: string };

export function mapSource(row: GitHubRepositorySourceRow): GitHubRepositorySource {
  const connected = row.account_status === "active" && Boolean(row.organization_account_id);
  return {
    id: String(row.id),
    organizationAccountId: row.organization_account_id,
    githubLogin: row.github_login,
    repositoryId: row.github_repository_id === null ? null : String(row.github_repository_id),
    owner: String(row.repository_owner),
    repository: String(row.repository_name),
    defaultBranch: String(row.default_branch),
    status:
      row.status === "disabled"
        ? "disabled"
        : connected && row.status === "active"
          ? "active"
          : "needs_auth",
    webhookStatus: row.github_webhook_status ?? "pending",
    webhookError: row.github_webhook_last_error ?? null,
    syncPending: false,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncedCommitSha: row.last_synced_commit_sha ?? null,
  };
}

export async function listGitHubRepositorySources(
  organizationId: string,
): Promise<GitHubRepositorySource[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query<GitHubRepositorySourceRow>(
    `SELECT source.id,
            source.organization_id,
            source.organization_account_id,
            source.github_repository_id,
            source.repository_owner,
            source.repository_name,
            source.default_branch,
            source.status,
            source.github_webhook_status,
            source.github_webhook_last_error,
            source.last_synced_at,
            source.last_synced_commit_sha,
            account.github_login,
            account.status AS account_status,
            EXISTS (
              SELECT 1 FROM github_sync_jobs AS job
               WHERE job.source_id = source.id
                 AND job.status IN ('pending', 'running')
            ) AS sync_pending
       FROM github_repository_sources AS source
       LEFT JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       LEFT JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.organization_id = $1
        AND source.status <> 'disabled'
      ORDER BY source.repository_owner, source.repository_name`,
    [organizationId],
  );
  return result.rows.map((row) => ({ ...mapSource(row), syncPending: row.sync_pending === true }));
}

export async function listGitHubAccountRepositories(
  organizationId: string,
  organizationAccountId: string,
): Promise<GitHubAccessibleRepository[]> {
  const token = await getGitHubAccessToken(organizationId, organizationAccountId);
  const repositories: GitHubAccessibleRepository[] = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(`${GITHUB_API_ROOT}/user/repos`);
    url.searchParams.set("affiliation", "owner,collaborator,organization_member");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    const batch = await githubJson<
      Array<{
        id?: number | string;
        full_name?: string;
        default_branch?: string;
        private?: boolean;
      }>
    >(url.toString(), token);

    for (const repository of batch) {
      if (
        repository.id === undefined ||
        !repository.full_name ||
        !repository.default_branch ||
        !/^[^/]+\/[^/]+$/.test(repository.full_name)
      ) {
        continue;
      }
      repositories.push({
        id: String(repository.id),
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        isPrivate: repository.private === true,
      });
    }

    if (batch.length < 100) break;
  }

  return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

export async function getRepositorySource(
  organizationId: string,
  sourceId: string,
  requireActive = true,
): Promise<ResolvedGitHubSource | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<GitHubRepositorySourceRow>(
    `SELECT source.id,
            source.organization_id,
            source.organization_account_id,
            source.github_repository_id,
            source.repository_owner,
            source.repository_name,
            source.default_branch,
            source.status,
            source.github_webhook_id,
            source.github_webhook_secret_ciphertext,
            source.github_webhook_status,
            source.github_webhook_last_error,
            source.last_synced_at,
            source.last_synced_commit_sha,
            source.updated_by_subject_id,
            account.github_login,
            account.status AS account_status
       FROM github_repository_sources AS source
       LEFT JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       LEFT JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.organization_id = $1
        AND source.id = $2
        ${requireActive ? "AND source.status = 'active' AND account.status = 'active'" : ""}
      LIMIT 1`,
    [organizationId, sourceId],
  );
  const row = result.rows[0];
  return row ? { ...mapSource(row), organizationId } : null;
}

export async function addGitHubRepositorySource(input: {
  organizationId: string;
  organizationAccountId: string;
  subjectId: string;
  owner: string;
  repository: string;
}): Promise<GitHubRepositorySource> {
  if (!isGitHubConfigured()) throw new Error("GitHub OAuth is not configured.");
  const owner = input.owner.trim();
  const repository = input.repository.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error("Enter a valid GitHub organization or account name.");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository === "." || repository === "..") {
    throw new Error("Enter a valid GitHub repository name.");
  }

  const token = await getGitHubAccessToken(input.organizationId, input.organizationAccountId);
  const repo = await githubJson<{
    id?: number | string;
    full_name?: string;
    default_branch?: string;
  }>(
    `${GITHUB_API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    token,
  );
  if (
    repo.full_name?.toLowerCase() !== `${owner}/${repository}`.toLowerCase() ||
    repo.id === undefined ||
    !repo.default_branch
  ) {
    throw new Error("The selected repository is not available to this GitHub account.");
  }
  await githubJson(
    apiPath({ owner, repository }, `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`),
    token,
  );

  const saved = await withDatabaseTransaction(async (client) => {
    const result = await client.query<GitHubRepositorySourceRow>(
      `INSERT INTO github_repository_sources
        (id, organization_id, organization_account_id, github_repository_id,
         repository_owner, repository_name, default_branch, status, updated_by_subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
       ON CONFLICT (organization_id, repository_owner_normalized, repository_name_normalized)
       DO UPDATE SET
         organization_account_id = EXCLUDED.organization_account_id,
         github_repository_id = EXCLUDED.github_repository_id,
         default_branch = EXCLUDED.default_branch,
         last_synced_commit_sha = CASE
           WHEN github_repository_sources.default_branch IS DISTINCT FROM EXCLUDED.default_branch
             THEN NULL
           ELSE github_repository_sources.last_synced_commit_sha
         END,
         status = 'active',
         updated_by_subject_id = EXCLUDED.updated_by_subject_id,
         updated_at = now()
       RETURNING id, organization_id, organization_account_id, github_repository_id,
                 repository_owner, repository_name, default_branch, status, last_synced_at`,
      [
        randomUUID(),
        input.organizationId,
        input.organizationAccountId,
        String(repo.id),
        owner,
        repository,
        repo.default_branch,
        input.subjectId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("The GitHub repository could not be saved.");
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "github_markdown",
      itemId: row.id,
      summary: `Connected GitHub repository ${owner}/${repository}.`,
      metadata: { repository: `${owner}/${repository}`, sourceId: row.id },
    });
    return row;
  });
  return mapSource({ ...saved, github_login: null, account_status: "active" });
}

export async function removeGitHubRepositorySource(input: {
  organizationId: string;
  sourceId: string;
  subjectId: string;
}): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const current = await pool.query<{
    organization_account_id: string | null;
    github_repository_id: string | null;
    repository_owner: string;
    repository_name: string;
    github_webhook_id: string | null;
  }>(
    `SELECT organization_account_id, github_repository_id,
            repository_owner, repository_name, github_webhook_id
       FROM github_repository_sources
      WHERE organization_id = $1 AND id = $2 AND status <> 'disabled'`,
    [input.organizationId, input.sourceId],
  );
  const existing = current.rows[0];
  let webhookDeleted = false;
  if (existing?.github_webhook_id && existing.organization_account_id) {
    try {
      const otherSource = existing.github_repository_id
        ? await pool.query(
            `SELECT 1 FROM github_repository_sources
              WHERE github_repository_id = $1
                AND id <> $2
                AND status = 'active'
                AND github_webhook_id = $3
              LIMIT 1`,
            [existing.github_repository_id, input.sourceId, existing.github_webhook_id],
          )
        : { rowCount: 0 };
      if ((otherSource.rowCount ?? 0) === 0) {
        const token = await getGitHubAccessToken(
          input.organizationId,
          existing.organization_account_id,
        );
        await deleteGitHubRepositoryWebhook({
          token,
          owner: existing.repository_owner,
          repository: existing.repository_name,
          webhookId: existing.github_webhook_id,
        });
      }
      webhookDeleted = true;
    } catch {
      console.error("GitHub repository webhook cleanup failed during source removal.");
    }
  }
  return withDatabaseTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      repository_owner: string;
      repository_name: string;
    }>(
      `UPDATE github_repository_sources
          SET status = 'disabled',
              github_webhook_id = CASE WHEN $4 THEN NULL ELSE github_webhook_id END,
              github_webhook_secret_ciphertext = CASE
                WHEN $4 THEN NULL
                ELSE github_webhook_secret_ciphertext
              END,
              github_webhook_status = CASE WHEN $4 THEN 'disabled' ELSE github_webhook_status END,
              github_webhook_last_error = CASE WHEN $4 THEN NULL ELSE github_webhook_last_error END,
              updated_by_subject_id = $3,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND status <> 'disabled'
        RETURNING id, repository_owner, repository_name`,
      [input.organizationId, input.sourceId, input.subjectId, webhookDeleted],
    );
    const source = result.rows[0];
    if (!source) return false;
    await client.query(
      `UPDATE brain_items
          SET is_active = false, updated_at = now()
        WHERE organization_id = $1 AND kind = 'github_markdown' AND source_id = $2`,
      [input.organizationId, input.sourceId],
    );
    await client.query(
      `UPDATE github_sync_jobs
          SET status = 'cancelled',
              locked_until = NULL,
              last_error = 'The repository was disconnected.',
              completed_at = now(),
              updated_at = now()
        WHERE organization_id = $1 AND source_id = $2
          AND status IN ('pending', 'running')`,
      [input.organizationId, input.sourceId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "github_markdown",
      itemId: input.sourceId,
      summary: `Disconnected GitHub repository ${source.repository_owner}/${source.repository_name}.`,
      metadata: { sourceId: input.sourceId },
    });
    return true;
  }, pool);
}
