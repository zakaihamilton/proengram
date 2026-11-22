import "server-only";

import { type GoogleDriveFile, type GoogleDriveFolder, listGoogleDriveFiles } from "./drive-api";

export const MAX_DRIVE_FILES = 5000;

export function sameFolderSelection(left: string[], right: unknown): boolean {
  if (!Array.isArray(right) || right.some((value) => typeof value !== "string")) return false;
  const normalizedRight = right as string[];
  const normalizedLeft = [...left].sort();
  const sortedRight = [...normalizedRight].sort();
  return (
    normalizedLeft.length === sortedRight.length &&
    normalizedLeft.every((folderId, index) => folderId === sortedRight[index])
  );
}

export function isFolder(file: GoogleDriveFile): boolean {
  return file.mimeType === "application/vnd.google-apps.folder";
}

export function includedFolders(
  folders: GoogleDriveFolder[],
  selectedFolderIds: string[],
): Set<string> {
  const included = new Set(selectedFolderIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (!included.has(folder.id) && folder.parents.some((parent) => included.has(parent))) {
        included.add(folder.id);
        changed = true;
      }
    }
  }
  return included;
}

export function fileIsSelected(
  file: GoogleDriveFile,
  selectedFolderIds: string[],
  includedFolderIds: Set<string>,
): boolean {
  return (
    selectedFolderIds.length === 0 || file.parents.some((parent) => includedFolderIds.has(parent))
  );
}

export function selectedDriveFiles(
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

export async function fullDriveScan(
  accessToken: string,
  driveId: string,
  selectedFolderIds: string[],
): Promise<{ files: GoogleDriveFile[]; inScopeIds: Set<string> }> {
  const allFiles = await listGoogleDriveFiles(accessToken, driveId);
  if (allFiles.length > MAX_DRIVE_FILES) {
    throw new Error(
      `The Shared Drive exceeds the ${MAX_DRIVE_FILES.toLocaleString()} file sync limit.`,
    );
  }
  const files = selectedDriveFiles(allFiles, selectedFolderIds);
  return { files, inScopeIds: new Set(files.map((file) => file.id)) };
}
