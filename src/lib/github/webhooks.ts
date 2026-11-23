import "server-only";

import { randomBytes } from "node:crypto";
import { getPublicOrigin } from "@/lib/auth/config";
import { getPool } from "@/lib/db/pool";
import { getGitHubAccessToken } from "./connections";
import { decryptGitHubToken, encryptGitHubToken } from "./token-crypto";
import { createGitHubRepositoryWebhook, deleteGitHubRepositoryWebhook } from "./webhook-api";

export type GitHubWebhookSource = {
  id: string;
  organizationId: string;
  organizationAccountId: string;
  repositoryId: string | null;
  owner: string;
  repository: string;
  defaultBranch: string;
  actorSubjectId: string;
  secret: string;
};

export async function listGitHubWebhookSources(hookId: string): Promise<GitHubWebhookSource[]> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<{
    id: string;
    organization_id: string;
    organization_account_id: string;
    github_repository_id: string | null;
    repository_owner: string;
    repository_name: string;
    default_branch: string;
    github_webhook_secret_ciphertext: string;
    updated_by_subject_id: string | null;
    connected_by_subject_id: string;
  }>(
    `SELECT source.id,
            source.organization_id,
            link.id AS organization_account_id,
            source.github_repository_id,
            source.repository_owner,
            source.repository_name,
            source.default_branch,
            source.github_webhook_secret_ciphertext,
            source.updated_by_subject_id,
            link.connected_by_subject_id
       FROM github_repository_sources AS source
       JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.github_webhook_id = $1
        AND source.github_webhook_secret_ciphertext IS NOT NULL
        AND source.github_webhook_status = 'active'
        AND source.status = 'active'
        AND account.status = 'active'
      ORDER BY source.organization_id`,
    [hookId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    organizationAccountId: String(row.organization_account_id),
    repositoryId: row.github_repository_id === null ? null : String(row.github_repository_id),
    owner: String(row.repository_owner),
    repository: String(row.repository_name),
    defaultBranch: String(row.default_branch),
    actorSubjectId: row.updated_by_subject_id ?? row.connected_by_subject_id,
    secret: decryptGitHubToken(row.github_webhook_secret_ciphertext),
  }));
}

export async function ensureGitHubRepositoryWebhook(
  organizationId: string,
  sourceId: string,
  _subjectId: string,
): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const preflight = await pool.query<{
    organization_account_id: string | null;
    webhook_id: string | null;
    webhook_secret_ciphertext: string | null;
    webhook_status: string;
  }>(
    `SELECT source.organization_account_id,
            source.github_webhook_id AS webhook_id,
            source.github_webhook_secret_ciphertext AS webhook_secret_ciphertext,
            source.github_webhook_status AS webhook_status
       FROM github_repository_sources AS source
       JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.organization_id = $1
        AND source.id = $2
        AND source.status = 'active'
        AND account.status = 'active'
      LIMIT 1`,
    [organizationId, sourceId],
  );
  const existingSource = preflight.rows[0];
  if (!existingSource?.organization_account_id) return false;
  if (
    existingSource.webhook_id &&
    existingSource.webhook_secret_ciphertext &&
    existingSource.webhook_status === "active"
  ) {
    return true;
  }
  let token: string;
  try {
    token = await getGitHubAccessToken(organizationId, existingSource.organization_account_id);
  } catch (error) {
    await pool
      .query(
        `UPDATE github_repository_sources
            SET github_webhook_status = 'failed',
                github_webhook_last_error = $3,
                updated_at = now()
          WHERE organization_id = $1 AND id = $2 AND status = 'active'`,
        [
          organizationId,
          sourceId,
          error instanceof Error ? error.message.slice(0, 300) : "Webhook setup failed.",
        ],
      )
      .catch(() => undefined);
    return false;
  }
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query("BEGIN");
    transaction = true;
    const result = await client.query<{
      organization_account_id: string | null;
      repository_id: string | null;
      owner: string;
      repository: string;
      webhook_id: string | null;
      webhook_secret_ciphertext: string | null;
      webhook_status: string;
      account_status: string | null;
    }>(
      `SELECT source.organization_account_id,
              source.github_repository_id AS repository_id,
              source.repository_owner AS owner,
              source.repository_name AS repository,
              source.github_webhook_id AS webhook_id,
              source.github_webhook_secret_ciphertext AS webhook_secret_ciphertext,
              source.github_webhook_status AS webhook_status,
              account.status AS account_status
         FROM github_repository_sources AS source
         LEFT JOIN github_organization_accounts AS link
           ON link.id = source.organization_account_id
          AND link.organization_id = source.organization_id
         LEFT JOIN github_oauth_accounts AS account
           ON account.id = link.github_oauth_account_id
        WHERE source.organization_id = $1
          AND source.id = $2
          AND source.status = 'active'
        FOR UPDATE OF source`,
      [organizationId, sourceId],
    );
    const source = result.rows[0];
    if (!source?.organization_account_id || source.account_status !== "active") {
      await client.query("COMMIT");
      return false;
    }
    if (source.organization_account_id !== existingSource.organization_account_id) {
      await client.query("COMMIT");
      return false;
    }
    if (
      source.webhook_id &&
      source.webhook_secret_ciphertext &&
      source.webhook_status === "active"
    ) {
      await client.query("COMMIT");
      return true;
    }

    if (source.repository_id) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `proengram:github-webhook:${source.repository_id}`,
      ]);
      const shared = await client.query<{
        github_webhook_id: string;
        github_webhook_secret_ciphertext: string;
      }>(
        `SELECT github_webhook_id, github_webhook_secret_ciphertext
           FROM github_repository_sources
          WHERE github_repository_id = $1
            AND id <> $2
            AND status = 'active'
            AND github_webhook_status = 'active'
            AND github_webhook_id IS NOT NULL
            AND github_webhook_secret_ciphertext IS NOT NULL
          ORDER BY created_at
          LIMIT 1`,
        [source.repository_id, sourceId],
      );
      const sharedHook = shared.rows[0];
      if (sharedHook) {
        await client.query(
          `UPDATE github_repository_sources
              SET github_webhook_id = $3,
                  github_webhook_secret_ciphertext = $4,
                  github_webhook_status = 'active',
                  github_webhook_last_error = NULL,
                  updated_at = now()
            WHERE organization_id = $1 AND id = $2`,
          [
            organizationId,
            sourceId,
            sharedHook.github_webhook_id,
            sharedHook.github_webhook_secret_ciphertext,
          ],
        );
        await client.query("COMMIT");
        return true;
      }
    }

    if (source.webhook_id) {
      await deleteGitHubRepositoryWebhook({
        token,
        owner: source.owner,
        repository: source.repository,
        webhookId: source.webhook_id,
      }).catch(() => undefined);
    }
    const secret = randomBytes(32).toString("base64url");
    const webhookId = await createGitHubRepositoryWebhook({
      token,
      owner: source.owner,
      repository: source.repository,
      callbackUrl: new URL("/api/github/webhook", getPublicOrigin()).toString(),
      secret,
    });
    await client.query(
      `UPDATE github_repository_sources
          SET github_webhook_id = $3,
              github_webhook_secret_ciphertext = $4,
              github_webhook_status = 'active',
              github_webhook_last_error = NULL,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, sourceId, webhookId, encryptGitHubToken(secret)],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    if (transaction) {
      const message =
        error instanceof Error ? error.message.slice(0, 300) : "Webhook setup failed.";
      await client
        .query(
          `UPDATE github_repository_sources
              SET github_webhook_status = 'failed',
                  github_webhook_last_error = $3,
                  updated_at = now()
            WHERE organization_id = $1 AND id = $2`,
          [organizationId, sourceId, message],
        )
        .catch(() => undefined);
      await client
        .query("COMMIT")
        .catch(() => client.query("ROLLBACK"))
        .catch(() => undefined);
    }
    console.error("GitHub repository webhook setup failed.");
    return false;
  } finally {
    client.release();
  }
}

export async function repairGitHubRepositoryWebhooks(): Promise<{
  checked: number;
  active: number;
}> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<{
    organization_id: string;
    source_id: string;
    actor_subject_id: string;
  }>(
    `SELECT source.organization_id,
            source.id AS source_id,
            COALESCE(source.updated_by_subject_id, link.connected_by_subject_id, 'system:github-sync')
              AS actor_subject_id
       FROM github_repository_sources AS source
       JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.status = 'active'
        AND account.status = 'active'
        AND (source.github_webhook_status <> 'active'
          OR source.github_webhook_id IS NULL
          OR source.github_webhook_secret_ciphertext IS NULL)
      ORDER BY source.created_at`,
  );
  let active = 0;
  for (let offset = 0; offset < result.rows.length; offset += 5) {
    const batch = result.rows.slice(offset, offset + 5);
    const outcomes = await Promise.all(
      batch.map((source) =>
        ensureGitHubRepositoryWebhook(
          String(source.organization_id),
          String(source.source_id),
          String(source.actor_subject_id),
        ),
      ),
    );
    active += outcomes.filter(Boolean).length;
  }
  return { checked: result.rows.length, active };
}
