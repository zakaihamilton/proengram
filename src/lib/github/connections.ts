import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import {
  GitHubOAuthError,
  getGitHubOAuthConfiguration,
  refreshGitHubUserToken,
  revokeGitHubAuthorization,
  type GitHubAccountProfile,
  type GitHubUserToken,
} from "./oauth";
import {
  decryptGitHubToken,
  encryptGitHubToken,
  isGitHubTokenEncryptionConfigured,
} from "./token-crypto";
import { deleteGitHubRepositoryWebhook } from "./webhook-api";

type GitHubOAuthAccountRow = {
  id: string;
  github_user_id: string;
  github_login: string;
  avatar_url: string | null;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: Date | string;
  refresh_token_expires_at: Date | string;
  status: "active" | "reauthorize_required";
};

export type GitHubAccountConnection = {
  id: string;
  githubAccountId: string;
  login: string;
  avatarUrl: string | null;
  status: "active" | "reauthorize_required";
  repositoryCount: number;
  createdAt: string;
};

function asTimestamp(value: Date | string): number {
  return new Date(value).getTime();
}

export function isGitHubConfigured(): boolean {
  try {
    getGitHubOAuthConfiguration();
    return isGitHubTokenEncryptionConfigured();
  } catch {
    return false;
  }
}

async function markAccountReauthorizationRequired(
  client: PoolClient,
  accountId: string,
): Promise<void> {
  await client.query(
    `UPDATE github_oauth_accounts
        SET status = 'reauthorize_required', updated_at = now()
      WHERE id = $1`,
    [accountId],
  );
  await client.query(
    `UPDATE github_repository_sources AS source
        SET status = 'needs_auth', updated_at = now()
       FROM github_organization_accounts AS link
      WHERE source.organization_account_id = link.id
        AND link.github_oauth_account_id = $1
        AND source.status = 'active'`,
    [accountId],
  );
  await client.query(
    `UPDATE brain_items
        SET is_active = false, updated_at = now()
      WHERE kind = 'github_markdown'
        AND source_id IN (
          SELECT source.id
            FROM github_repository_sources AS source
            JOIN github_organization_accounts AS link
              ON link.id = source.organization_account_id
           WHERE link.github_oauth_account_id = $1
        )`,
    [accountId],
  );
}

async function getFreshAccessToken(
  client: PoolClient,
  account: GitHubOAuthAccountRow,
): Promise<string | null> {
  if (account.status !== "active") return null;
  const now = Date.now();
  if (asTimestamp(account.access_token_expires_at) > now + 60_000) {
    return decryptGitHubToken(account.access_token_ciphertext);
  }
  if (asTimestamp(account.refresh_token_expires_at) <= now + 60_000) {
    await markAccountReauthorizationRequired(client, account.id);
    return null;
  }

  let refreshed: GitHubUserToken;
  try {
    refreshed = await refreshGitHubUserToken(decryptGitHubToken(account.refresh_token_ciphertext));
  } catch (error) {
    if (error instanceof GitHubOAuthError && error.code === "bad_refresh_token") {
      await markAccountReauthorizationRequired(client, account.id);
      return null;
    }
    throw error;
  }

  await client.query(
    `UPDATE github_oauth_accounts
        SET access_token_ciphertext = $2,
            refresh_token_ciphertext = $3,
            access_token_expires_at = $4,
            refresh_token_expires_at = $5,
            updated_at = now()
      WHERE id = $1`,
    [
      account.id,
      encryptGitHubToken(refreshed.accessToken),
      encryptGitHubToken(refreshed.refreshToken),
      refreshed.accessTokenExpiresAt,
      refreshed.refreshTokenExpiresAt,
    ],
  );
  return refreshed.accessToken;
}

export async function connectGitHubAccount(input: {
  organizationId: string;
  subjectId: string;
  profile: GitHubAccountProfile;
  token: GitHubUserToken;
}): Promise<void> {
  if (!isGitHubConfigured()) throw new Error("GitHub OAuth is not configured.");
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query<{ id: string }>(
      `INSERT INTO github_oauth_accounts
        (id, github_user_id, github_login, avatar_url, access_token_ciphertext,
         refresh_token_ciphertext, access_token_expires_at, refresh_token_expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       ON CONFLICT (github_user_id) DO UPDATE SET
         github_login = EXCLUDED.github_login,
         avatar_url = EXCLUDED.avatar_url,
         access_token_ciphertext = EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         status = 'active',
         updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        input.profile.id,
        input.profile.login,
        input.profile.avatarUrl,
        encryptGitHubToken(input.token.accessToken),
        encryptGitHubToken(input.token.refreshToken),
        input.token.accessTokenExpiresAt,
        input.token.refreshTokenExpiresAt,
      ],
    );
    const accountId = accountResult.rows[0]?.id;
    if (!accountId) throw new Error("GitHub account could not be saved.");

    const linkResult = await client.query<{ id: string }>(
      `INSERT INTO github_organization_accounts
        (id, organization_id, github_oauth_account_id, connected_by_subject_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, github_oauth_account_id) DO UPDATE SET
         connected_by_subject_id = EXCLUDED.connected_by_subject_id,
         updated_at = now()
       RETURNING id`,
      [randomUUID(), input.organizationId, accountId, input.subjectId],
    );
    const organizationAccountId = linkResult.rows[0]?.id;
    if (!organizationAccountId)
      throw new Error("GitHub account could not be connected to this workspace.");

    await client.query(
      `UPDATE github_repository_sources
          SET status = 'active', updated_by_subject_id = $2, updated_at = now()
        WHERE status = 'needs_auth'
          AND organization_account_id IN (
            SELECT id FROM github_organization_accounts WHERE github_oauth_account_id = $1
          )`,
      [accountId, input.subjectId],
    );

    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "github_account",
      itemId: organizationAccountId,
      summary: `Connected GitHub account @${input.profile.login}.`,
      metadata: { githubLogin: input.profile.login },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listGitHubAccountConnections(
  organizationId: string,
): Promise<GitHubAccountConnection[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT link.id,
            account.github_user_id,
            account.github_login,
            account.avatar_url,
            account.status,
            link.created_at,
            (SELECT count(*)::integer
               FROM github_repository_sources AS source
              WHERE source.organization_account_id = link.id
                AND source.status <> 'disabled') AS repository_count
       FROM github_organization_accounts AS link
       JOIN github_oauth_accounts AS account ON account.id = link.github_oauth_account_id
      WHERE link.organization_id = $1
      ORDER BY account.github_login`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    githubAccountId: String(row.github_user_id),
    login: String(row.github_login),
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
    status: row.status === "active" ? "active" : "reauthorize_required",
    repositoryCount: Number(row.repository_count ?? 0),
    createdAt: new Date(row.created_at as Date | string).toISOString(),
  }));
}

export async function getGitHubAccessToken(
  organizationId: string,
  organizationAccountId: string,
): Promise<string> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  let accessToken: string | null = null;
  let needsReauthorization = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<GitHubOAuthAccountRow>(
      `SELECT account.id,
              account.github_user_id,
              account.github_login,
              account.avatar_url,
              account.access_token_ciphertext,
              account.refresh_token_ciphertext,
              account.access_token_expires_at,
              account.refresh_token_expires_at,
              account.status
         FROM github_organization_accounts AS link
         JOIN github_oauth_accounts AS account ON account.id = link.github_oauth_account_id
        WHERE link.id = $1 AND link.organization_id = $2
        FOR UPDATE OF account`,
      [organizationAccountId, organizationId],
    );
    const account = result.rows[0];
    if (!account) throw new Error("Connect a GitHub account for this organization first.");
    accessToken = await getFreshAccessToken(client, account);
    needsReauthorization = accessToken === null;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (needsReauthorization || !accessToken) {
    throw new Error("Reconnect this GitHub account in Settings to continue.");
  }
  return accessToken;
}

export async function removeGitHubAccountConnection(input: {
  organizationId: string;
  subjectId: string;
  organizationAccountId: string;
}): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  let removed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<GitHubOAuthAccountRow & { organization_account_id: string }>(
      `SELECT link.id AS organization_account_id,
              account.id,
              account.github_user_id,
              account.github_login,
              account.avatar_url,
              account.access_token_ciphertext,
              account.refresh_token_ciphertext,
              account.access_token_expires_at,
              account.refresh_token_expires_at,
              account.status
         FROM github_organization_accounts AS link
         JOIN github_oauth_accounts AS account ON account.id = link.github_oauth_account_id
        WHERE link.id = $1 AND link.organization_id = $2
        FOR UPDATE OF link, account`,
      [input.organizationAccountId, input.organizationId],
    );
    const account = result.rows[0];
    if (!account) {
      await client.query("ROLLBACK");
      return false;
    }
    const linkCountResult = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM github_organization_accounts
        WHERE github_oauth_account_id = $1`,
      [account.id],
    );
    const isLastLink = Number(linkCountResult.rows[0]?.count ?? 0) <= 1;

    let accessToken: string | null = null;
    try {
      accessToken = await getFreshAccessToken(client, account);
    } catch {
      console.error("GitHub account token refresh failed during account removal.");
    }
    const sourcesWithHooks = await client.query<{
      id: string;
      github_repository_id: string | null;
      repository_owner: string;
      repository_name: string;
      github_webhook_id: string;
    }>(
      `SELECT id, github_repository_id, repository_owner, repository_name, github_webhook_id
         FROM github_repository_sources
        WHERE organization_id = $1
          AND organization_account_id = $2
          AND status = 'active'
          AND github_webhook_id IS NOT NULL`,
      [input.organizationId, input.organizationAccountId],
    );
    const hooksRemovedSourceIds: string[] = [];
    if (accessToken) {
      for (const source of sourcesWithHooks.rows) {
        const sharedHook = await client.query(
          `SELECT 1 FROM github_repository_sources
            WHERE github_webhook_id = $1
              AND id <> $2
              AND status = 'active'
            LIMIT 1`,
          [source.github_webhook_id, source.id],
        );
        if ((sharedHook.rowCount ?? 0) > 0) {
          hooksRemovedSourceIds.push(String(source.id));
          continue;
        }
        try {
          await deleteGitHubRepositoryWebhook({
            token: accessToken,
            owner: source.repository_owner,
            repository: source.repository_name,
            webhookId: source.github_webhook_id,
          });
          hooksRemovedSourceIds.push(String(source.id));
        } catch {
          console.error("GitHub repository webhook cleanup failed during account removal.");
        }
      }
    }
    if (isLastLink && accessToken) {
      try {
        await revokeGitHubAuthorization(accessToken);
      } catch {
        console.error("GitHub authorization revocation failed during account removal.");
      }
    }

    await client.query(
      `UPDATE brain_items
          SET is_active = false, updated_at = now()
        WHERE organization_id = $1
          AND kind = 'github_markdown'
          AND source_id IN (
            SELECT id FROM github_repository_sources WHERE organization_account_id = $2
          )`,
      [input.organizationId, input.organizationAccountId],
    );
    await client.query(
      `UPDATE github_sync_jobs
          SET status = 'cancelled',
              locked_until = NULL,
              last_error = 'The GitHub account was disconnected.',
              completed_at = now(),
              updated_at = now()
        WHERE organization_id = $1
          AND source_id IN (
            SELECT id FROM github_repository_sources WHERE organization_account_id = $2
          )
          AND status IN ('pending', 'running')`,
      [input.organizationId, input.organizationAccountId],
    );
    await client.query(
      `UPDATE github_repository_sources
          SET organization_account_id = NULL,
              status = 'needs_auth',
              github_webhook_id = CASE
                WHEN id = ANY($3::uuid[]) THEN NULL
                ELSE github_webhook_id
              END,
              github_webhook_secret_ciphertext = CASE
                WHEN id = ANY($3::uuid[]) THEN NULL
                ELSE github_webhook_secret_ciphertext
              END,
              github_webhook_status = CASE
                WHEN id = ANY($3::uuid[]) THEN 'disabled'
                ELSE github_webhook_status
              END,
              github_webhook_last_error = CASE
                WHEN id = ANY($3::uuid[]) THEN NULL
                ELSE github_webhook_last_error
              END,
              updated_at = now()
        WHERE organization_id = $1 AND organization_account_id = $2`,
      [input.organizationId, input.organizationAccountId, hooksRemovedSourceIds],
    );
    await client.query(
      `DELETE FROM github_organization_accounts WHERE id = $1 AND organization_id = $2`,
      [input.organizationAccountId, input.organizationId],
    );
    if (isLastLink) {
      await client.query(`DELETE FROM github_oauth_accounts WHERE id = $1`, [account.id]);
    }
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "github_account",
      itemId: input.organizationAccountId,
      summary: `Disconnected GitHub account @${account.github_login}.`,
      metadata: { githubLogin: account.github_login },
    });
    await client.query("COMMIT");
    removed = true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return removed;
}
