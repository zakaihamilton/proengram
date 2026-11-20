import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import {
  GoogleDriveApiError,
  type GoogleDriveFolder,
  type GoogleDriveSummary,
  listGoogleDriveFolders,
  listGoogleSharedDrives,
} from "./drive-api";
import {
  type GoogleDriveProfile,
  type GoogleDriveToken,
  GoogleDriveReauthorizationRequiredError,
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

export type GoogleDriveAccountConnection = {
  email: string;
  status: "active" | "reauthorize_required";
  createdAt: string;
};

export type GoogleDriveSource = {
  id: string;
  driveId: string;
  driveName: string;
  selectedFolderIds: string[];
  status: "active" | "disabled" | "needs_auth";
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  syncPending: boolean;
  indexedCount: number;
  skippedCount: number;
  errorCount: number;
};

export type GoogleDriveSourceSyncConfig = {
  id: string;
  organizationId: string;
  driveId: string;
  driveName: string;
  selectedFolderIds: string[];
  changePageToken: string | null;
  actorSubjectId: string;
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

function mapSource(row: Record<string, unknown>): GoogleDriveSource {
  const folderIds = Array.isArray(row.selected_folder_ids)
    ? row.selected_folder_ids.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: String(row.id),
    driveId: String(row.drive_id),
    driveName: String(row.drive_name),
    selectedFolderIds: folderIds,
    status: row.status as GoogleDriveSource["status"],
    lastSyncedAt: row.last_synced_at ? new Date(String(row.last_synced_at)).toISOString() : null,
    lastSyncStatus: typeof row.last_sync_status === "string" ? row.last_sync_status : null,
    syncPending: row.sync_pending === true,
    indexedCount: Number(row.indexed_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
  };
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
  if (outcome.accessToken === null)
    throw new Error("Google Drive access token could not be refreshed.");
  return outcome.accessToken;
}

export async function listGoogleDriveSources(organizationId: string): Promise<GoogleDriveSource[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT source.id, source.drive_id, source.drive_name, source.selected_folder_ids,
            source.status, source.last_synced_at,
            EXISTS (
              SELECT 1 FROM google_drive_sync_jobs AS job
               WHERE job.source_id = source.id AND job.status IN ('pending', 'running')
            ) AS sync_pending,
            (SELECT count(*)::integer FROM google_drive_file_states AS file
              WHERE file.source_id = source.id AND file.status = 'indexed') AS indexed_count,
            (SELECT count(*)::integer FROM google_drive_file_states AS file
              WHERE file.source_id = source.id AND file.status = 'skipped') AS skipped_count,
            (SELECT count(*)::integer FROM google_drive_file_states AS file
              WHERE file.source_id = source.id AND file.status = 'error') AS error_count,
            (SELECT sync.status FROM source_syncs AS sync
                WHERE sync.organization_id = source.organization_id
                  AND sync.source = 'google_drive' AND sync.source_id = source.id
                ORDER BY sync.started_at DESC LIMIT 1) AS last_sync_status
       FROM google_drive_sources AS source
      WHERE source.organization_id = $1
      ORDER BY source.drive_name, source.created_at`,
    [organizationId],
  );
  return result.rows.map(mapSource);
}

export async function getGoogleDriveSourceSyncConfig(
  organizationId: string,
  sourceId: string,
): Promise<GoogleDriveSourceSyncConfig | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query(
    `SELECT source.id, source.organization_id, source.drive_id, source.drive_name,
            source.selected_folder_ids, source.change_page_token,
            coalesce(source.updated_by_subject_id, account.connected_by_subject_id) AS actor_subject_id
       FROM google_drive_sources AS source
       JOIN google_drive_accounts AS account
         ON account.organization_id = source.organization_id
      WHERE source.organization_id = $1 AND source.id = $2
        AND source.status = 'active' AND account.status = 'active'
      LIMIT 1`,
    [organizationId, sourceId],
  );
  const row = result.rows[0] as
    | {
        id: string;
        organization_id: string;
        drive_id: string;
        drive_name: string;
        selected_folder_ids: unknown;
        change_page_token: string | null;
        actor_subject_id: string;
      }
    | undefined;
  if (!row) return null;
  const folderIds = Array.isArray(row.selected_folder_ids)
    ? row.selected_folder_ids.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    driveId: String(row.drive_id),
    driveName: String(row.drive_name),
    selectedFolderIds: folderIds,
    changePageToken: row.change_page_token,
    actorSubjectId: String(row.actor_subject_id),
  };
}

export async function listAvailableGoogleSharedDrives(
  organizationId: string,
): Promise<GoogleDriveSummary[]> {
  return listGoogleSharedDrives(await getGoogleDriveAccessToken(organizationId));
}

async function listAvailableGoogleDriveFolders(
  organizationId: string,
  driveId: string,
): Promise<GoogleDriveFolder[]> {
  const available = await listAvailableGoogleSharedDrives(organizationId);
  if (!available.some((drive) => drive.id === driveId)) {
    throw new Error("The selected Shared Drive is not available to the connected account.");
  }
  return listGoogleDriveFolders(await getGoogleDriveAccessToken(organizationId), driveId);
}

export async function addGoogleDriveSource(input: {
  organizationId: string;
  subjectId: string;
  driveId: string;
  folderIds: string[];
}): Promise<string> {
  const drives = await listAvailableGoogleSharedDrives(input.organizationId);
  const drive = drives.find((item) => item.id === input.driveId);
  if (!drive)
    throw new Error("The selected Shared Drive is not available to the connected account.");
  const folderIds = [...new Set(input.folderIds.map((id) => id.trim()).filter(Boolean))];
  const folders = folderIds.length
    ? await listAvailableGoogleDriveFolders(input.organizationId, input.driveId)
    : [];
  if (folderIds.some((id) => !folders.some((folder) => folder.id === id))) {
    throw new Error("One or more selected folders are not in the chosen Shared Drive.");
  }
  return withDatabaseTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO google_drive_sources
        (id, organization_id, drive_id, drive_name, selected_folder_ids, status, updated_by_subject_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'active', $6)
       ON CONFLICT (organization_id, drive_id) DO UPDATE SET
         drive_name = EXCLUDED.drive_name,
         selected_folder_ids = EXCLUDED.selected_folder_ids,
         status = 'active',
         change_page_token = NULL,
         last_synced_at = NULL,
         updated_by_subject_id = EXCLUDED.updated_by_subject_id,
         updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        input.organizationId,
        drive.id,
        drive.name,
        JSON.stringify(folderIds),
        input.subjectId,
      ],
    );
    const sourceId = result.rows[0]?.id;
    if (!sourceId) throw new Error("The Google Drive source could not be saved.");
    await client.query(
      `UPDATE brain_items
          SET is_active = false, updated_at = now()
        WHERE organization_id = $1 AND source_id = $2 AND kind = 'google_drive_document'`,
      [input.organizationId, sourceId],
    );
    await client.query(
      `UPDATE google_drive_file_states
          SET status = 'removed', message = 'Scope changed; indexing is pending.', updated_at = now()
        WHERE organization_id = $1 AND source_id = $2`,
      [input.organizationId, sourceId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "google_drive_source",
      itemId: sourceId,
      summary: `Selected the Shared Drive ${drive.name} for company knowledge.`,
      metadata: { driveId: drive.id, folderCount: folderIds.length },
    });
    return sourceId;
  });
}

export async function removeGoogleDriveSource(input: {
  organizationId: string;
  subjectId: string;
  sourceId: string;
}): Promise<void> {
  await withDatabaseTransaction(async (client) => {
    const source = await client.query<{ drive_name: string }>(
      `UPDATE google_drive_sources
          SET status = 'disabled', updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING drive_name`,
      [input.sourceId, input.organizationId],
    );
    if (!source.rows[0]) throw new Error("The Google Drive source was not found.");
    await client.query(
      `UPDATE brain_items SET is_active = false, updated_at = now()
        WHERE organization_id = $1 AND source_id = $2 AND kind = 'google_drive_document'`,
      [input.organizationId, input.sourceId],
    );
    await client.query(
      `UPDATE google_drive_file_states SET status = 'removed', message = 'Source disconnected.', updated_at = now()
        WHERE organization_id = $1 AND source_id = $2`,
      [input.organizationId, input.sourceId],
    );
    await client.query(
      `UPDATE google_drive_sync_jobs SET status = 'cancelled', updated_at = now()
        WHERE source_id = $1 AND status IN ('pending', 'running')`,
      [input.sourceId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "google_drive_source",
      itemId: input.sourceId,
      summary: `Disconnected the Shared Drive ${source.rows[0].drive_name}.`,
    });
  });
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

export async function enqueueGoogleDriveSyncJob(input: {
  organizationId: string;
  sourceId: string;
  actorSubjectId?: string | null;
  trigger: "initial" | "poll" | "reconcile";
}): Promise<{ jobId: string; duplicate: boolean }> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<{ id: string; duplicate: boolean }>(
    `INSERT INTO google_drive_sync_jobs
      (id, organization_id, source_id, actor_subject_id, trigger)
     SELECT $1, source.organization_id, source.id,
            coalesce($4, source.updated_by_subject_id, 'system:google-drive-sync'), $5
       FROM google_drive_sources AS source
       JOIN google_drive_accounts AS account
         ON account.organization_id = source.organization_id
      WHERE source.organization_id = $2 AND source.id = $3
        AND source.status = 'active' AND account.status = 'active'
     ON CONFLICT (source_id) WHERE status IN ('pending', 'running')
     DO UPDATE SET
       trigger = CASE
         WHEN EXCLUDED.trigger = 'initial' THEN 'initial'
         WHEN google_drive_sync_jobs.trigger = 'initial' THEN 'initial'
         ELSE EXCLUDED.trigger
       END,
       next_attempt_at = now(), updated_at = now()
     RETURNING id, (xmax::text::bigint > 0) AS duplicate`,
    [
      randomUUID(),
      input.organizationId,
      input.sourceId,
      input.actorSubjectId ?? null,
      input.trigger,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("The Google Drive source is not active for this organization.");
  return { jobId: row.id, duplicate: row.duplicate };
}

export async function enqueueGoogleDriveReconciliationJobs(): Promise<number> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query(
    `INSERT INTO google_drive_sync_jobs
      (id, organization_id, source_id, actor_subject_id, trigger)
     SELECT gen_random_uuid(), source.organization_id, source.id,
            coalesce(source.updated_by_subject_id, 'system:google-drive-sync'), 'reconcile'
       FROM google_drive_sources AS source
       JOIN google_drive_accounts AS account
         ON account.organization_id = source.organization_id
      WHERE source.status = 'active' AND account.status = 'active'
     ON CONFLICT (source_id) WHERE status IN ('pending', 'running')
     DO UPDATE SET
       trigger = CASE
         WHEN google_drive_sync_jobs.trigger = 'initial' THEN 'initial'
         ELSE 'reconcile'
       END,
       next_attempt_at = now(), updated_at = now()
     RETURNING id`,
  );
  await pool.query(
    `DELETE FROM google_drive_sync_jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
        AND completed_at < now() - interval '30 days'`,
  );
  return result.rowCount ?? 0;
}

export async function claimGoogleDriveSyncJob(jobId?: string): Promise<{
  id: string;
  organizationId: string;
  sourceId: string;
  actorSubjectId: string;
  trigger: "initial" | "poll" | "reconcile";
  attemptCount: number;
} | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query(
    `WITH candidate AS (
       SELECT job.id
         FROM google_drive_sync_jobs AS job
         JOIN google_drive_sources AS source
           ON source.id = job.source_id AND source.organization_id = job.organization_id
         JOIN google_drive_accounts AS account
           ON account.organization_id = job.organization_id
        WHERE source.status = 'active' AND account.status = 'active'
          AND (($1::uuid IS NOT NULL AND job.id = $1)
            OR ($1::uuid IS NULL AND job.status = 'pending' AND job.next_attempt_at <= now()))
          AND (job.status = 'pending' OR job.locked_until < now())
        ORDER BY job.next_attempt_at, job.created_at
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1
     )
     UPDATE google_drive_sync_jobs AS job
        SET status = 'running', attempt_count = attempt_count + 1,
            locked_until = now() + interval '15 minutes', started_at = now(),
            updated_at = now(), last_error = NULL
       FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.id, job.organization_id, job.source_id, job.actor_subject_id,
                job.trigger, job.attempt_count`,
    [jobId ?? null],
  );
  const row = result.rows[0] as
    | {
        id: string;
        organization_id: string;
        source_id: string;
        actor_subject_id: string;
        trigger: "initial" | "poll" | "reconcile";
        attempt_count: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        organizationId: row.organization_id,
        sourceId: row.source_id,
        actorSubjectId: row.actor_subject_id,
        trigger: row.trigger,
        attemptCount: row.attempt_count,
      }
    : null;
}

export async function completeGoogleDriveSyncJob(jobId: string): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `UPDATE google_drive_sync_jobs
        SET status = 'succeeded', completed_at = now(), locked_until = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId],
  );
}

export async function failGoogleDriveSyncJob(
  jobId: string,
  attemptCount: number,
  error: unknown,
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const retryDelayMinutes = Math.min(60, 2 ** Math.max(0, attemptCount - 1));
  const message =
    error instanceof GoogleDriveApiError
      ? `${error.message} (HTTP ${error.status})`
      : error instanceof Error
        ? error.message.slice(0, 400)
        : "Google Drive sync failed.";
  await pool.query(
    `UPDATE google_drive_sync_jobs
        SET status = CASE WHEN attempt_count >= 8 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() + ($2::text || ' minutes')::interval,
            locked_until = NULL, last_error = $3, updated_at = now(),
            completed_at = CASE WHEN attempt_count >= 8 THEN now() ELSE NULL END
      WHERE id = $1 AND status = 'running'`,
    [jobId, String(retryDelayMinutes), message],
  );
}
