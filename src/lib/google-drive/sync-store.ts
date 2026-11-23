import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { replaceBrainChunks, writeItemVersion } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import type { getGoogleDriveSourceSyncConfig } from "./connections";
import type { GoogleDriveFile } from "./drive-api";
import { sameFolderSelection } from "./scope";

export type ExistingDriveItem = {
  id: string;
  source_revision: string | null;
  source_modified_at: Date | string | null;
  is_active: boolean;
};

export type DriveFileStateRow = {
  file_id: string;
  modified_at: Date | string | null;
  status: string;
  message: string | null;
};

export class GoogleDriveSyncContextChangedError extends Error {
  constructor() {
    super(
      "The Google Drive source or selected folders changed during sync. The queued sync will retry.",
    );
  }
}

function sourceRevision(file: GoogleDriveFile, markdown: string): string {
  return (
    file.headRevisionId || file.modifiedTime || createHash("sha256").update(markdown).digest("hex")
  );
}

export function composeMarkdown(
  segments: Array<{ text: string; locator?: string | null }>,
): string {
  return segments
    .map((segment) => `${segment.locator ? `### ${segment.locator}\n\n` : ""}${segment.text}`)
    .join("\n\n")
    .trim();
}

export async function removeDriveItem(
  organizationId: string,
  sourceId: string,
  fileId: string,
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `UPDATE brain_items SET is_active = false, updated_at = now()
      WHERE organization_id = $1 AND source_id = $2 AND kind = 'google_drive_document'
        AND external_key = $3`,
    [organizationId, sourceId, `file:${fileId}`],
  );
}

export async function updateFileState(input: {
  organizationId: string;
  sourceId: string;
  file: GoogleDriveFile;
  status: "indexed" | "skipped" | "removed" | "error";
  message: string | null;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `INSERT INTO google_drive_file_states
      (id, organization_id, source_id, file_id, name, mime_type, modified_at, status, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, file_id) DO UPDATE SET
       name = EXCLUDED.name,
       mime_type = EXCLUDED.mime_type,
       modified_at = EXCLUDED.modified_at,
       status = EXCLUDED.status,
       message = EXCLUDED.message,
       updated_at = now()`,
    [
      randomUUID(),
      input.organizationId,
      input.sourceId,
      input.file.id,
      input.file.name,
      input.file.mimeType,
      input.file.modifiedTime,
      input.status,
      input.message,
    ],
  );
}

export async function markFileRemoved(
  organizationId: string,
  sourceId: string,
  fileId: string,
  message: string,
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `UPDATE google_drive_file_states
        SET status = 'removed', message = $3, updated_at = now()
      WHERE organization_id = $1 AND source_id = $2 AND file_id = $4`,
    [organizationId, sourceId, message, fileId],
  );
  await removeDriveItem(organizationId, sourceId, fileId);
}

export async function saveIndexedFile(input: {
  organizationId: string;
  sourceId: string;
  selectedFolderIds: string[];
  file: GoogleDriveFile;
  markdown: string;
  segments: Array<{ text: string; locator?: string | null }>;
}): Promise<string> {
  const revision = sourceRevision(input.file, input.markdown);
  const externalKey = `file:${input.file.id}`;
  return withDatabaseTransaction(async (client) => {
    const source = await client.query<{
      status: string;
      selected_folder_ids: unknown;
    }>(
      `SELECT status, selected_folder_ids FROM google_drive_sources
        WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [input.organizationId, input.sourceId],
    );
    const sourceRow = source.rows[0];
    if (
      sourceRow?.status !== "active" ||
      !sameFolderSelection(input.selectedFolderIds, sourceRow.selected_folder_ids)
    ) {
      throw new GoogleDriveSyncContextChangedError();
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO brain_items
        (id, organization_id, source_id, kind, external_key, title, markdown,
         source_url, source_revision, source_modified_at, is_active)
       VALUES ($1, $2, $3, 'google_drive_document', $4, $5, $6, $7, $8, $9, true)
       ON CONFLICT (organization_id, kind, external_key) WHERE kind <> 'github_markdown'
       DO UPDATE SET source_id = EXCLUDED.source_id,
         title = EXCLUDED.title,
         markdown = EXCLUDED.markdown,
         source_url = EXCLUDED.source_url,
         source_revision = EXCLUDED.source_revision,
         source_modified_at = EXCLUDED.source_modified_at,
         is_active = true,
         updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        input.organizationId,
        input.sourceId,
        externalKey,
        input.file.name.slice(0, 240),
        input.markdown,
        input.file.webViewLink,
        revision,
        input.file.modifiedTime,
      ],
    );
    const itemId = result.rows[0]?.id;
    if (!itemId) throw new Error("The indexed Google Drive document could not be retrieved.");
    const versionId = await writeItemVersion(client, {
      organizationId: input.organizationId,
      itemId,
      title: input.file.name.slice(0, 240),
      markdown: input.markdown,
      sourceRevision: revision,
      sourceModifiedAt: input.file.modifiedTime,
    });
    await replaceBrainChunks(client, {
      organizationId: input.organizationId,
      itemId,
      versionId,
      markdown: input.markdown,
      title: input.file.name.slice(0, 240),
      segments: input.segments,
    });
    return itemId;
  });
}

export async function finalizeGoogleDriveSourceSync(input: {
  source: Awaited<ReturnType<typeof getGoogleDriveSourceSyncConfig>>;
  organizationId: string;
  sourceId: string;
  changePageToken: string;
}): Promise<void> {
  const sourceConfig = input.source;
  if (!sourceConfig) throw new GoogleDriveSyncContextChangedError();
  const contextChanged = await withDatabaseTransaction(async (client) => {
    const result = await client.query<{
      status: string;
      selected_folder_ids: unknown;
      account_status: string;
    }>(
      `SELECT source.status, source.selected_folder_ids, account.status AS account_status
         FROM google_drive_sources AS source
         JOIN google_drive_accounts AS account
           ON account.organization_id = source.organization_id
        WHERE source.organization_id = $1 AND source.id = $2
        FOR UPDATE OF source`,
      [input.organizationId, input.sourceId],
    );
    const current = result.rows[0];
    if (
      current?.status !== "active" ||
      current.account_status !== "active" ||
      !sameFolderSelection(sourceConfig.selectedFolderIds, current.selected_folder_ids)
    ) {
      await client.query(
        `UPDATE brain_items SET is_active = false, updated_at = now()
          WHERE organization_id = $1 AND source_id = $2 AND kind = 'google_drive_document'`,
        [input.organizationId, input.sourceId],
      );
      await client.query(
        `UPDATE google_drive_file_states
            SET status = 'removed', message = 'Source scope changed; indexing is pending.', updated_at = now()
          WHERE organization_id = $1 AND source_id = $2`,
        [input.organizationId, input.sourceId],
      );
      return true;
    }
    await client.query(
      `UPDATE google_drive_sources
          SET change_page_token = $3, last_synced_at = now(), updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.sourceId, input.changePageToken],
    );
    return false;
  });
  if (contextChanged) throw new GoogleDriveSyncContextChangedError();
}

export async function loadDriveSyncSnapshot(organizationId: string, sourceId: string) {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const [existingResult, fileStatesResult] = await Promise.all([
    pool.query<ExistingDriveItem & { external_key: string }>(
      `SELECT id, external_key, source_revision, source_modified_at, is_active
         FROM brain_items
        WHERE organization_id = $1 AND source_id = $2 AND kind = 'google_drive_document'`,
      [organizationId, sourceId],
    ),
    pool.query<DriveFileStateRow>(
      `SELECT file_id, modified_at, status, message FROM google_drive_file_states
        WHERE organization_id = $1 AND source_id = $2`,
      [organizationId, sourceId],
    ),
  ]);
  return {
    existingByFileId: new Map(
      existingResult.rows.map((row) => [row.external_key.slice("file:".length), row]),
    ),
    fileStates: new Map(fileStatesResult.rows.map((row) => [row.file_id, row])),
  };
}

export async function deactivateOutOfScopeItems(input: {
  organizationId: string;
  sourceId: string;
  inScopeIds: Set<string>;
  existingByFileId: Map<string, ExistingDriveItem>;
  fileStates: Map<string, DriveFileStateRow>;
  keepActiveItemIds: Set<string>;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const outOfScopeIds = [
    ...new Set([...input.existingByFileId.keys(), ...input.fileStates.keys()]),
  ].filter((id) => !input.inScopeIds.has(id));
  if (outOfScopeIds.length) {
    await pool.query(
      `UPDATE google_drive_file_states
          SET status = 'removed', message = 'File was removed or is outside the selected folders.', updated_at = now()
        WHERE organization_id = $1 AND source_id = $2 AND file_id = ANY($3::text[])`,
      [input.organizationId, input.sourceId, outOfScopeIds],
    );
  }
  await pool.query(
    `UPDATE brain_items SET is_active = false, updated_at = now()
      WHERE organization_id = $1 AND source_id = $2
        AND kind = 'google_drive_document' AND NOT (id = ANY($3::uuid[]))`,
    [input.organizationId, input.sourceId, [...input.keepActiveItemIds]],
  );
}
