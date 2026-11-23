import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import {
  type GoogleDriveProfile,
  GoogleDriveReauthorizationRequiredError,
  type GoogleDriveToken,
  getGoogleDriveOAuthConfiguration,
  refreshGoogleDriveAccessToken,
  revokeGoogleDriveAuthorization,
} from "./oauth";
import {
  decryptGoogleDriveToken,
  encryptGoogleDriveToken,
  isGoogleDriveTokenEncryptionConfigured,
} from "./token-crypto";

type GoogleDriveAccountRow = {
  id: string;
  organization_id: string;
  google_subject: string;
  google_email: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: Date | string;
  status: "active" | "reauthorize_required";
  connected_by_subject_id: string;
  created_at: Date | string;
};

type GoogleDriveAccountConnection = {
  email: string;
  status: "active" | "reauthorize_required";
  createdAt: string;
};

function timestamp(value: Date | string): number {
  return new Date(value).getTime();
}

export function isGoogleDriveConfigured(): boolean {
  try {
    getGoogleDriveOAuthConfiguration();
    return isGoogleDriveTokenEncryptionConfigured();
  } catch {
    return false;
  }
}

async function deactivateOrganizationDriveItems(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  await client.query(
    `UPDATE brain_items
        SET is_active = false, updated_at = now()
      WHERE kind = 'google_drive_document'
        AND organization_id = $1
        AND source_id IN (
          SELECT id FROM google_drive_sources WHERE organization_id = $1
        )`,
    [organizationId],
  );
}

export async function connectGoogleDriveAccount(input: {
  organizationId: string;
  subjectId: string;
  profile: GoogleDriveProfile;
  token: GoogleDriveToken;
}): Promise<void> {
  if (!isGoogleDriveConfigured()) throw new Error("Google Drive OAuth is not configured.");
  await withDatabaseTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO google_drive_accounts
        (id, organization_id, google_subject, google_email, access_token_ciphertext,
         refresh_token_ciphertext, access_token_expires_at, status, connected_by_subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
       ON CONFLICT (organization_id) DO UPDATE SET
         google_subject = EXCLUDED.google_subject,
         google_email = EXCLUDED.google_email,
         access_token_ciphertext = EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         status = 'active',
         connected_by_subject_id = EXCLUDED.connected_by_subject_id,
         updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        input.organizationId,
        input.profile.subject,
        input.profile.email,
        encryptGoogleDriveToken(input.token.accessToken),
        encryptGoogleDriveToken(input.token.refreshToken),
        input.token.accessTokenExpiresAt,
        input.subjectId,
      ],
    );
    const accountId = result.rows[0]?.id;
    if (!accountId) throw new Error("Google Drive account could not be saved.");
    await client.query(
      `UPDATE google_drive_sources
          SET status = 'active', updated_at = now()
        WHERE organization_id = $1 AND status = 'needs_auth'`,
      [input.organizationId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "google_drive_account",
      itemId: accountId,
      summary: `Connected Google Drive account ${input.profile.email}.`,
      metadata: { email: input.profile.email },
    });
  });
}

export async function getGoogleDriveAccountConnection(
  organizationId: string,
): Promise<GoogleDriveAccountConnection | null> {
  const pool = await getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT google_email, status, created_at
       FROM google_drive_accounts
      WHERE organization_id = $1
      LIMIT 1`,
    [organizationId],
  );
  const row = result.rows[0] as
    | {
        google_email: string;
        status: GoogleDriveAccountConnection["status"];
        created_at: Date | string;
      }
    | undefined;
  return row
    ? {
        email: row.google_email,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
      }
    : null;
}

export async function getGoogleDriveAccessToken(organizationId: string): Promise<string> {
  const outcome = await withDatabaseTransaction(async (client) => {
    const result = await client.query<GoogleDriveAccountRow>(
      `SELECT * FROM google_drive_accounts
        WHERE organization_id = $1
        FOR UPDATE`,
      [organizationId],
    );
    const account = result.rows[0];
    if (account?.status !== "active") {
      throw new Error("Reconnect Google Drive in Settings before syncing this source.");
    }
    if (timestamp(account.access_token_expires_at) > Date.now() + 60_000) {
      return { accessToken: decryptGoogleDriveToken(account.access_token_ciphertext), error: null };
    }

    let refreshed: Awaited<ReturnType<typeof refreshGoogleDriveAccessToken>>;
    try {
      refreshed = await refreshGoogleDriveAccessToken(
        decryptGoogleDriveToken(account.refresh_token_ciphertext),
      );
    } catch (error) {
      if (!(error instanceof GoogleDriveReauthorizationRequiredError)) throw error;
      await client.query(
        `UPDATE google_drive_accounts SET status = 'reauthorize_required', updated_at = now()
          WHERE id = $1`,
        [account.id],
      );
      await client.query(
        `UPDATE google_drive_sources SET status = 'needs_auth', updated_at = now()
          WHERE organization_id = $1`,
        [organizationId],
      );
      await deactivateOrganizationDriveItems(client, organizationId);
      return { accessToken: null, error };
    }

    await client.query(
      `UPDATE google_drive_accounts
          SET access_token_ciphertext = $2,
              access_token_expires_at = $3,
              updated_at = now()
        WHERE id = $1`,
      [account.id, encryptGoogleDriveToken(refreshed.accessToken), refreshed.accessTokenExpiresAt],
    );
    return { accessToken: refreshed.accessToken, error: null };
  });
  if (outcome.error) throw outcome.error;
  if (outcome.accessToken === null) {
    throw new Error("Google Drive access token could not be refreshed.");
  }
  return outcome.accessToken;
}

export async function disconnectGoogleDriveAccount(input: {
  organizationId: string;
  subjectId: string;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<GoogleDriveAccountRow>(
    `SELECT * FROM google_drive_accounts WHERE organization_id = $1 LIMIT 1`,
    [input.organizationId],
  );
  const account = result.rows[0];
  if (!account) return;
  try {
    await revokeGoogleDriveAuthorization(decryptGoogleDriveToken(account.refresh_token_ciphertext));
  } catch {
    // Continue removing the local grant even if Google has already revoked the token.
  }

  await withDatabaseTransaction(async (client) => {
    await client.query(
      `UPDATE google_drive_accounts
          SET status = 'reauthorize_required', access_token_ciphertext = '', refresh_token_ciphertext = '',
              access_token_expires_at = now(), updated_at = now()
        WHERE organization_id = $1`,
      [input.organizationId],
    );
    await client.query(
      `UPDATE google_drive_sources SET status = 'needs_auth', updated_at = now()
        WHERE organization_id = $1`,
      [input.organizationId],
    );
    await deactivateOrganizationDriveItems(client, input.organizationId);
    await client.query(
      `UPDATE google_drive_sync_jobs SET status = 'cancelled', updated_at = now()
        WHERE organization_id = $1 AND status IN ('pending', 'running')`,
      [input.organizationId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "google_drive_account",
      itemId: account.id,
      summary: `Disconnected Google Drive account ${account.google_email}.`,
    });
  }, pool);
}
