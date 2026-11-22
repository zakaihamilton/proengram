import "server-only";

import { randomUUID } from "node:crypto";
import { writeActivity } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { planGoogleDriveSync, recheckErroredIncrementalFiles } from "./change-planner";
import {
  claimGoogleDriveSyncJob,
  completeGoogleDriveSyncJob,
  failGoogleDriveSyncJob,
  getGoogleDriveAccessToken,
  getGoogleDriveSourceSyncConfig,
} from "./connections";
import { downloadGoogleDriveFile } from "./drive-api";
import { extractGoogleDriveFile, googleDriveExportMimeType } from "./extract";
import {
  composeMarkdown,
  deactivateOutOfScopeItems,
  finalizeGoogleDriveSourceSync,
  GoogleDriveSyncContextChangedError,
  loadDriveSyncSnapshot,
  markFileRemoved,
  removeDriveItem,
  saveIndexedFile,
  updateFileState,
} from "./sync-store";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SYNC_DOWNLOAD_BYTES = 250 * 1024 * 1024;

async function syncGoogleDriveSource(input: {
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
    const plan = await planGoogleDriveSync({
      accessToken,
      source,
      trigger: input.trigger,
    });
    for (const fileId of plan.removedFileIds) {
      await markFileRemoved(
        input.organizationId,
        input.sourceId,
        fileId,
        "File was removed from Google Drive.",
      );
    }
    for (const file of plan.outOfScopeFiles) {
      await updateFileState({
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        file,
        status: "removed",
        message: "File is outside the selected folders.",
      });
      await removeDriveItem(input.organizationId, input.sourceId, file.id);
    }

    const { existingByFileId, fileStates } = await loadDriveSyncSnapshot(
      input.organizationId,
      input.sourceId,
    );
    if (!plan.fullScan) {
      await recheckErroredIncrementalFiles({
        accessToken,
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        selectedFolderIds: source.selectedFolderIds,
        includedFolderIds: plan.incrementalIncludedFolderIds,
        fileStates,
        files: plan.files,
        outOfScopeFiles: plan.outOfScopeFiles,
      });
    }

    const keepActiveItemIds = new Set<string>();
    let indexedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let downloadedBytes = 0;

    for (const file of plan.files) {
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
        if (remainingBytes <= 0) {
          throw new Error("The Shared Drive exceeded the per-sync download limit.");
        }
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

    if (plan.inScopeIds) {
      await deactivateOutOfScopeItems({
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        inScopeIds: plan.inScopeIds,
        existingByFileId,
        fileStates,
        keepActiveItemIds,
      });
    }

    await finalizeGoogleDriveSourceSync({
      source,
      organizationId: input.organizationId,
      sourceId: input.sourceId,
      changePageToken: plan.changeToken,
    });
    await withDatabaseTransaction(async (activityClient) => {
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
    }, pool);
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
