import "server-only";

import type { GoogleDriveSourceSyncConfig } from "./connections";
import {
  GoogleDriveApiError,
  type GoogleDriveFile,
  getGoogleDriveFile,
  getGoogleDriveStartPageToken,
  listGoogleDriveChanges,
  listGoogleDriveFolders,
} from "./drive-api";
import { fileIsSelected, fullDriveScan, includedFolders, isFolder } from "./scope";
import { type DriveFileStateRow, markFileRemoved } from "./sync-store";

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

export type PlannedDriveSync = {
  fullScan: boolean;
  changeToken: string;
  files: GoogleDriveFile[];
  inScopeIds: Set<string> | null;
  incrementalIncludedFolderIds: Set<string>;
  removedFileIds: Set<string>;
  outOfScopeFiles: GoogleDriveFile[];
};

export async function planGoogleDriveSync(input: {
  accessToken: string;
  source: GoogleDriveSourceSyncConfig;
  trigger: "initial" | "poll" | "reconcile";
}): Promise<PlannedDriveSync> {
  let changeToken: string;
  let changes: Array<{ fileId: string; removed: boolean; file: GoogleDriveFile | null }> = [];
  let fullScan = input.trigger !== "poll" || !input.source.changePageToken;

  if (!input.source.changePageToken) {
    changeToken = await getGoogleDriveStartPageToken(input.accessToken, input.source.driveId);
  } else {
    try {
      const page = await listAllChanges(
        input.accessToken,
        input.source.driveId,
        input.source.changePageToken,
      );
      changeToken = page.changePageToken;
      changes = page.changes;
    } catch (error) {
      if (!(error instanceof GoogleDriveApiError) || error.status !== 410) throw error;
      changeToken = await getGoogleDriveStartPageToken(input.accessToken, input.source.driveId);
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
    const scan = await fullDriveScan(
      input.accessToken,
      input.source.driveId,
      input.source.selectedFolderIds,
    );
    files = scan.files;
    inScopeIds = scan.inScopeIds;
  } else {
    const folderList = input.source.selectedFolderIds.length
      ? await listGoogleDriveFolders(input.accessToken, input.source.driveId)
      : [];
    const includedFolderIds = includedFolders(folderList, input.source.selectedFolderIds);
    incrementalIncludedFolderIds = includedFolderIds;
    const latestChanges = new Map(changes.map((change) => [change.fileId, change]));
    files = [];
    for (const change of latestChanges.values()) {
      if (change.removed || !change.file) {
        removedFileIds.add(change.fileId);
        continue;
      }
      const file = change.file ?? (await getGoogleDriveFile(input.accessToken, change.fileId));
      if (!file || file.trashed) {
        removedFileIds.add(change.fileId);
        continue;
      }
      if (isFolder(file)) {
        fullScan = true;
        break;
      }
      if (fileIsSelected(file, input.source.selectedFolderIds, includedFolderIds)) files.push(file);
      else outOfScopeFiles.push(file);
    }
    if (fullScan) {
      const scan = await fullDriveScan(
        input.accessToken,
        input.source.driveId,
        input.source.selectedFolderIds,
      );
      files = scan.files;
      inScopeIds = scan.inScopeIds;
      removedFileIds.clear();
      outOfScopeFiles.length = 0;
    }
  }

  return {
    fullScan,
    changeToken,
    files,
    inScopeIds,
    incrementalIncludedFolderIds,
    removedFileIds,
    outOfScopeFiles,
  };
}

export async function recheckErroredIncrementalFiles(input: {
  accessToken: string;
  organizationId: string;
  sourceId: string;
  selectedFolderIds: string[];
  includedFolderIds: Set<string>;
  fileStates: Map<string, DriveFileStateRow>;
  files: GoogleDriveFile[];
  outOfScopeFiles: GoogleDriveFile[];
}): Promise<void> {
  const alreadySelected = new Set(input.files.map((file) => file.id));
  for (const state of input.fileStates.values()) {
    if (state.status !== "error" || alreadySelected.has(state.file_id)) continue;
    let file: GoogleDriveFile | null;
    try {
      file = await getGoogleDriveFile(input.accessToken, state.file_id);
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
    } else if (fileIsSelected(file, input.selectedFolderIds, input.includedFolderIds)) {
      input.files.push(file);
    } else {
      input.outOfScopeFiles.push(file);
    }
  }
}
