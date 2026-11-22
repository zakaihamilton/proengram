import "server-only";

import { randomUUID } from "node:crypto";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { getGoogleDriveAccessToken } from "./accounts";
import {
  type GoogleDriveFolder,
  type GoogleDriveSummary,
  listGoogleDriveFolders,
  listGoogleSharedDrives,
} from "./drive-api";

type GoogleDriveSource = {
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
  if (!drive) {
    throw new Error("The selected Shared Drive is not available to the connected account.");
  }
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
