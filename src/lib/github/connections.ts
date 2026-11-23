import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import {
  type GitHubAccountProfile,
  GitHubOAuthError,
  type GitHubUserToken,
  getGitHubOAuthConfiguration,
  refreshGitHubUserToken,
} from "./oauth";
import {
  decryptGitHubToken,
  encryptGitHubToken,
  isGitHubTokenEncryptionConfigured,
} from "./token-crypto";

export { removeGitHubAccountConnection } from "./account-removal";

export type GitHubOAuthAccountRow = {
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

export async function getFreshAccessToken(
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
  await withDatabaseTransaction(async (client) => {
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
    if (!organizationAccountId) {
      throw new Error("GitHub account could not be connected to this workspace.");
    }

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
  });
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
  const accessToken = await withDatabaseTransaction(async (client) => {
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
    return getFreshAccessToken(client, account);
  });
  if (!accessToken) {
    throw new Error("Reconnect this GitHub account in Settings to continue.");
  }
  return accessToken;
}
