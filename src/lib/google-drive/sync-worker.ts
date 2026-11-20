import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { replaceBrainChunks, writeActivity, writeItemVersion } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import {
  claimGoogleDriveSyncJob,
  completeGoogleDriveSyncJob,
  failGoogleDriveSyncJob,
  getGoogleDriveAccessToken,
  getGoogleDriveSourceSyncConfig,
} from "./connections";
import {
  downloadGoogleDriveFile,
  GoogleDriveApiError,
  type GoogleDriveFile,
  type GoogleDriveFolder,
  getGoogleDriveFile,
  getGoogleDriveStartPageToken,
  listGoogleDriveChanges,
  listGoogleDriveFiles,
  listGoogleDriveFolders,
} from "./drive-api";
import { extractGoogleDriveFile, googleDriveExportMimeType } from "./extract";

const MAX_DRIVE_FILES = 5000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SYNC_DOWNLOAD_BYTES = 250 * 1024 * 1024;

type ExistingDriveItem = {
  id: string;
  source_revision: string | null;
  source_modified_at: Date | string | null;
  is_active: boolean;
};

class GoogleDriveSyncContextChangedError extends Error {
  constructor() {
    super(
      "The Google Drive source or selected folders changed during sync. The queued sync will retry.",
    );
  }
}

function sameFolderSelection(left: string[], right: unknown): boolean {
  if (!Array.isArray(right) || right.some((value) => typeof value !== "string")) return false;
  const normalizedRight = right as string[];
  const normalizedLeft = [...left].sort();
  const sortedRight = [...normalizedRight].sort();
  return (
    normalizedLeft.length === sortedRight.length &&
    normalizedLeft.every((folderId, index) => folderId === sortedRight[index])
  );
}

function isFolder(file: GoogleDriveFile): boolean {
  return file.mimeType === "application/vnd.google-apps.folder";
}

function includedFolders(folders: GoogleDriveFolder[], selectedFolderIds: string[]): Set<string> {
  const includedFolders = new Set(selectedFolderIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (
        !includedFolders.has(folder.id) &&
        folder.parents.some((parent) => includedFolders.has(parent))
      ) {
        includedFolders.add(folder.id);
        changed = true;
      }
    }
  }
  return includedFolders;
}

function fileIsSelected(
  file: GoogleDriveFile,
  selectedFolderIds: string[],
  includedFolderIds: Set<string>,
): boolean {
  return (
    selectedFolderIds.length === 0 || file.parents.some((parent) => includedFolderIds.has(parent))
  );
}

function selectedDriveFiles(
  files: GoogleDriveFile[],
  selectedFolderIds: string[],
): GoogleDriveFile[] {
  if (selectedFolderIds.length === 0) return files.filter((file) => !isFolder(file));
  const folders = files
    .filter(isFolder)
    .map((file) => ({ id: file.id, name: file.name, parents: file.parents }));
  const includedFolderIds = includedFolders(folders, selectedFolderIds);
  return files.filter(
    (file) => !isFolder(file) && fileIsSelected(file, selectedFolderIds, includedFolderIds),
  );
}

function sourceRevision(file: GoogleDriveFile, markdown: string): string {
  return (
    file.headRevisionId || file.modifiedTime || createHash("sha256").update(markdown).digest("hex")
  );
}

function composeMarkdown(segments: Array<{ text: string; locator?: string | null }>): string {
  return segments
    .map((segment) => `${segment.locator ? `### ${segment.locator}\n\n` : ""}${segment.text}`)
    .join("\n\n")
    .trim();
}

async function listAllChanges(
  accessToken: string,
  driveId: string,
  startToken: string,
): Promise<{
  changePageToken: string;
  changes: Array<{ fileId: string; removed: boolean; file: GoogleDriveFile | null }>;
}> {
  let pageToken = startToken;
  let newStartPageToken: string | undefined;
  const changes: Array<{ fileId: string; removed: boolean; file: GoogleDriveFile | null }> = [];
  while (true) {
    const page = await listGoogleDriveChanges(accessToken, driveId, pageToken);
    changes.push(...page.changes);
    if (page.newStartPageToken) newStartPageToken = page.newStartPageToken;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { changePageToken: newStartPageToken ?? pageToken, changes };
}

async function removeDriveItem(
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

async function updateFileState(input: {
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

async function markFileRemoved(
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

async function saveIndexedFile(input: {
  organizationId: string;
  sourceId: string;
  selectedFolderIds: string[];
  file: GoogleDriveFile;
  markdown: string;
  segments: Array<{ text: string; locator?: string | null }>;
}): Promise<string> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const revision = sourceRevision(input.file, input.markdown);
  const externalKey = `file:${input.file.id}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
    await writeItemVersion(client, {
      organizationId: input.organizationId,
      itemId,
      markdown: input.markdown,
      sourceRevision: revision,
      sourceModifiedAt: input.file.modifiedTime,
    });
    await replaceBrainChunks(client, {
      organizationId: input.organizationId,
      itemId,
      markdown: input.markdown,
      title: input.file.name.slice(0, 240),
      segments: input.segments,
    });
    await client.query("COMMIT");
    return itemId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeGoogleDriveSourceSync(input: {
  source: Awaited<ReturnType<typeof getGoogleDriveSourceSyncConfig>>;
  organizationId: string;
  sourceId: string;
  changePageToken: string;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  if (!input.source) throw new GoogleDriveSyncContextChangedError();
  const client = await pool.connect();
  let contextChanged = false;
  try {
    await client.query("BEGIN");
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
      !sameFolderSelection(input.source.selectedFolderIds, current.selected_folder_ids)
    ) {
      contextChanged = true;
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
    } else {
      await client.query(
        `UPDATE google_drive_sources
            SET change_page_token = $3, last_synced_at = now(), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.sourceId, input.changePageToken],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (contextChanged) throw new GoogleDriveSyncContextChangedError();
}

export async function syncGoogleDriveSource(input: {
  organizationId: string;
  sourceId: string;
  actorSubjectId: string;
  trigger: "initial" | "poll" | "reconcile";
}): Promise<{ indexedCount: number; skippedCount: number; errorCount: number }> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const source = await getGoogleDriveSourceSyncConfig(input.organizationId, input.sourceId);
  if (!source) throw new Error("Reconnect Google Drive in Settings before syncing this source.");
  const accessToken = await getGoogleDriveAccessToken(input.organizationId);
  const syncId = randomUUID();
  await pool.query(
    `INSERT INTO source_syncs (id, organization_id, source, source_id, status)
     VALUES ($1, $2, 'google_drive', $3, 'running')`,
    [syncId, input.organizationId, input.sourceId],
  );

  try {
    let changeToken: string;
    let changes: Array<{ fileId: string; removed: boolean; file: GoogleDriveFile | null }> = [];
    let fullScan = input.trigger !== "poll" || !source.changePageToken;
    if (!source.changePageToken) {
      changeToken = await getGoogleDriveStartPageToken(accessToken, source.driveId);
    } else {
      try {
        const page = await listAllChanges(accessToken, source.driveId, source.changePageToken);
        changeToken = page.changePageToken;
        changes = page.changes;
      } catch (error) {
        if (!(error instanceof GoogleDriveApiError) || error.status !== 410) throw error;
        changeToken = await getGoogleDriveStartPageToken(accessToken, source.driveId);
        fullScan = true;
      }
    }

    if (
      changes.some(
        (change) => change.removed || !change.file || isFolder(change.file) || change.file.trashed,
      )
    ) {
      fullScan = true;
    }
    let files: GoogleDriveFile[];
    let inScopeIds: Set<string> | null = null;
    let incrementalIncludedFolderIds = new Set<string>();
    const removedFileIds = new Set<string>();
    const outOfScopeFiles: GoogleDriveFile[] = [];
    if (fullScan) {
      const allFiles = await listGoogleDriveFiles(accessToken, source.driveId);
      if (allFiles.length > MAX_DRIVE_FILES) {
        throw new Error(
          `The Shared Drive exceeds the ${MAX_DRIVE_FILES.toLocaleString()} file sync limit.`,
        );
      }
      files = selectedDriveFiles(allFiles, source.selectedFolderIds);
      inScopeIds = new Set(files.map((file) => file.id));
    } else {
      const folderList = source.selectedFolderIds.length
        ? await listGoogleDriveFolders(accessToken, source.driveId)
        : [];
      const includedFolderIds = includedFolders(folderList, source.selectedFolderIds);
      incrementalIncludedFolderIds = includedFolderIds;
      const latestChanges = new Map(changes.map((change) => [change.fileId, change]));
      files = [];
      for (const change of latestChanges.values()) {
        if (change.removed || !change.file) {
          removedFileIds.add(change.fileId);
          continue;
        }
        const file = change.file ?? (await getGoogleDriveFile(accessToken, change.fileId));
        if (!file || file.trashed) {
          removedFileIds.add(change.fileId);
          continue;
        }
        if (isFolder(file)) {
          fullScan = true;
          break;
        }
        if (fileIsSelected(file, source.selectedFolderIds, includedFolderIds)) files.push(file);
        else outOfScopeFiles.push(file);
      }
      if (fullScan) {
        const allFiles = await listGoogleDriveFiles(accessToken, source.driveId);
        if (allFiles.length > MAX_DRIVE_FILES) {
          throw new Error(
            `The Shared Drive exceeds the ${MAX_DRIVE_FILES.toLocaleString()} file sync limit.`,
          );
        }
        files = selectedDriveFiles(allFiles, source.selectedFolderIds);
        inScopeIds = new Set(files.map((file) => file.id));
        removedFileIds.clear();
        outOfScopeFiles.length = 0;
      }
    }
    for (const fileId of removedFileIds) {
      await markFileRemoved(
        input.organizationId,
        input.sourceId,
        fileId,
        "File was removed from Google Drive.",
      );
    }
    for (const file of outOfScopeFiles) {
      await updateFileState({
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        file,
        status: "removed",
        message: "File is outside the selected folders.",
      });
      await removeDriveItem(input.organizationId, input.sourceId, file.id);
    }
    const existingResult = await pool.query<ExistingDriveItem & { external_key: string }>(
      `SELECT id, external_key, source_revision, source_modified_at, is_active
         FROM brain_items
        WHERE organization_id = $1 AND source_id = $2 AND kind = 'google_drive_document'`,
      [input.organizationId, input.sourceId],
    );
    const existingByFileId = new Map(
      existingResult.rows.map((row) => [row.external_key.slice("file:".length), row]),
    );
    const fileStatesResult = await pool.query<{
      file_id: string;
      modified_at: Date | string | null;
      status: string;
      message: string | null;
    }>(
      `SELECT file_id, modified_at, status, message FROM google_drive_file_states
        WHERE organization_id = $1 AND source_id = $2`,
      [input.organizationId, input.sourceId],
    );
    const fileStates = new Map(fileStatesResult.rows.map((row) => [row.file_id, row]));
    if (!fullScan) {
      const alreadySelected = new Set(files.map((file) => file.id));
      for (const state of fileStates.values()) {
        if (state.status !== "error" || alreadySelected.has(state.file_id)) continue;
        let file: GoogleDriveFile | null;
        try {
          file = await getGoogleDriveFile(accessToken, state.file_id);
        } catch (error) {
          if (error instanceof GoogleDriveApiError && error.status === 404) {
            await markFileRemoved(
              input.organizationId,
              input.sourceId,
              state.file_id,
              "File was removed from Google Drive.",
            );
            continue;
          }
          throw error;
        }
        if (!file || file.trashed) {
          await markFileRemoved(
            input.organizationId,
            input.sourceId,
            state.file_id,
            "File was removed from Google Drive.",
          );
        } else if (fileIsSelected(file, source.selectedFolderIds, incrementalIncludedFolderIds)) {
          files.push(file);
        } else {
          outOfScopeFiles.push(file);
        }
      }
    }
    const keepActiveItemIds = new Set<string>();
    let indexedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let downloadedBytes = 0;

    for (const file of files) {
      const existing = existingByFileId.get(file.id);
      const state = fileStates.get(file.id);
      const exportMimeType = googleDriveExportMimeType(file.mimeType);
      if (!exportMimeType) {
        await updateFileState({
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          file,
          status: "skipped",
          message: "Unsupported file type. Supported formats are Docs, Sheets, Slides, and PDFs.",
        });
        if (existing) await removeDriveItem(input.organizationId, input.sourceId, file.id);
        skippedCount += 1;
        continue;
      }

      const sameModifiedAt =
        state?.modified_at && file.modifiedTime
          ? new Date(state.modified_at).getTime() === new Date(file.modifiedTime).getTime()
          : false;
      if (
        sameModifiedAt &&
        ((state?.status === "indexed" && existing?.is_active) || state?.status === "skipped")
      ) {
        if (state.status === "indexed" && existing) {
          keepActiveItemIds.add(existing.id);
          indexedCount += 1;
        } else {
          skippedCount += 1;
        }
        continue;
      }

      try {
        const remainingBytes = MAX_SYNC_DOWNLOAD_BYTES - downloadedBytes;
        if (remainingBytes <= 0)
          throw new Error("The Shared Drive exceeded the per-sync download limit.");
        const bytes = await downloadGoogleDriveFile(
          accessToken,
          file.id,
          file.mimeType,
          exportMimeType,
          Math.min(MAX_FILE_BYTES, remainingBytes),
        );
        downloadedBytes += bytes.byteLength;
        if (downloadedBytes > MAX_SYNC_DOWNLOAD_BYTES) {
          throw new Error("The Shared Drive exceeded the per-sync download limit.");
        }
        const extracted = await extractGoogleDriveFile(file.mimeType, bytes);
        if (extracted.skipReason) {
          await updateFileState({
            organizationId: input.organizationId,
            sourceId: input.sourceId,
            file,
            status: "skipped",
            message: extracted.skipReason,
          });
          if (existing) await removeDriveItem(input.organizationId, input.sourceId, file.id);
          skippedCount += 1;
          continue;
        }
        const markdown = composeMarkdown(extracted.segments);
        const itemId = await saveIndexedFile({
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          selectedFolderIds: source.selectedFolderIds,
          file,
          markdown,
          segments: extracted.segments,
        });
        keepActiveItemIds.add(itemId);
        await updateFileState({
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          file,
          status: "indexed",
          message: null,
        });
        indexedCount += 1;
      } catch (error) {
        if (error instanceof GoogleDriveSyncContextChangedError) throw error;
        await updateFileState({
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          file,
          status: "error",
          message: error instanceof Error ? error.message.slice(0, 300) : "File indexing failed.",
        });
        if (existing?.is_active) keepActiveItemIds.add(existing.id);
        errorCount += 1;
      }
    }

    if (inScopeIds) {
      const outOfScopeIds = [...new Set([...existingByFileId.keys(), ...fileStates.keys()])].filter(
        (id) => !inScopeIds?.has(id),
      );
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
        [input.organizationId, input.sourceId, [...keepActiveItemIds]],
      );
    }

    await finalizeGoogleDriveSourceSync({
      source,
      organizationId: input.organizationId,
      sourceId: input.sourceId,
      changePageToken: changeToken,
    });
    const activityClient = await pool.connect();
    try {
      await activityClient.query("BEGIN");
      await writeActivity(activityClient, {
        id: randomUUID(),
        organizationId: input.organizationId,
        actorSubjectId: input.actorSubjectId,
        action: "source:sync",
        itemKind: "google_drive_document",
        itemId: input.sourceId,
        summary: `Synced ${indexedCount} files from ${source.driveName}.`,
        metadata: { indexedCount, skippedCount, errorCount, trigger: input.trigger },
      });
      await activityClient.query("COMMIT");
    } catch (error) {
      await activityClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      activityClient.release();
    }
    await pool.query(
      `UPDATE source_syncs
          SET status = 'succeeded', item_count = $2,
              message = $3, completed_at = now()
        WHERE id = $1`,
      [
        syncId,
        indexedCount,
        `Indexed ${indexedCount}; skipped ${skippedCount}; errors ${errorCount}.`,
      ],
    );
    return { indexedCount, skippedCount, errorCount };
  } catch (error) {
    await pool.query(
      `UPDATE source_syncs SET status = 'failed', message = $2, completed_at = now() WHERE id = $1`,
      [syncId, error instanceof Error ? error.message.slice(0, 300) : "Google Drive sync failed."],
    );
    throw error;
  }
}

export async function processGoogleDriveSyncJob(jobId?: string): Promise<boolean> {
  const job = await claimGoogleDriveSyncJob(jobId);
  if (!job) return false;
  try {
    await syncGoogleDriveSource({
      organizationId: job.organizationId,
      sourceId: job.sourceId,
      actorSubjectId: job.actorSubjectId,
      trigger: job.trigger,
    });
    await completeGoogleDriveSyncJob(job.id);
  } catch (error) {
    await failGoogleDriveSyncJob(job.id, job.attemptCount, error);
    console.error("Queued Google Drive sync failed.");
  }
  return true;
}
