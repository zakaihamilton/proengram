import "server-only";

import { randomUUID } from "node:crypto";
import { writeActivity } from "@/lib/db/brain";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { type GitHubOAuthAccountRow, getFreshAccessToken } from "./connections";
import { revokeGitHubAuthorization } from "./oauth";
import { deleteGitHubRepositoryWebhook } from "./webhook-api";

export async function removeGitHubAccountConnection(input: {
  organizationId: string;
  subjectId: string;
  organizationAccountId: string;
}): Promise<boolean> {
  return withDatabaseTransaction(async (client) => {
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
    return true;
  });
}
