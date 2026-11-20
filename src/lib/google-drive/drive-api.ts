import "server-only";

const DRIVE_API_ROOT = "https://www.googleapis.com/drive/v3";

export class GoogleDriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleDriveApiError";
  }
}

export type GoogleDriveSummary = {
  id: string;
  name: string;
};

export type GoogleDriveFolder = GoogleDriveSummary & {
  parents: string[];
};

export type GoogleDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
  parents: string[];
  driveId: string | null;
  headRevisionId: string | null;
  size: number | null;
  trashed: boolean;
};

export type GoogleDriveChange = {
  fileId: string;
  removed: boolean;
  file: GoogleDriveFile | null;
};

type GoogleDriveApiFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  driveId?: string;
  headRevisionId?: string;
  size?: string;
  trashed?: boolean;
};

function mapFile(file: GoogleDriveApiFile): GoogleDriveFile | null {
  if (!file.id || !file.name || !file.mimeType) return null;
  const size = file.size === undefined ? null : Number(file.size);
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime ?? null,
    webViewLink: file.webViewLink ?? null,
    parents: Array.isArray(file.parents)
      ? file.parents.filter((parent) => typeof parent === "string")
      : [],
    driveId: file.driveId ?? null,
    headRevisionId: file.headRevisionId ?? null,
    size: Number.isFinite(size) ? size : null,
    trashed: file.trashed === true,
  };
}

async function apiRequest<T>(accessToken: string, url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new GoogleDriveApiError("Google Drive is temporarily unavailable.", response.status);
    }
    throw new GoogleDriveApiError(
      "Google Drive denied or could not complete the request.",
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as T | null;
  if (body === null) throw new GoogleDriveApiError("Google Drive returned an empty response.", 502);
  return body;
}

function driveUrl(path: string): URL {
  return new URL(`${DRIVE_API_ROOT}${path}`);
}

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,webViewLink,parents,driveId,headRevisionId,size,trashed";

export async function listGoogleSharedDrives(accessToken: string): Promise<GoogleDriveSummary[]> {
  const drives: GoogleDriveSummary[] = [];
  let pageToken: string | undefined;
  do {
    const url = driveUrl("/drives");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,drives(id,name)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await apiRequest<{
      nextPageToken?: string;
      drives?: Array<{ id?: string; name?: string }>;
    }>(accessToken, url);
    for (const drive of result.drives ?? []) {
      if (drive.id && drive.name) drives.push({ id: drive.id, name: drive.name });
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  return drives;
}

export async function listGoogleDriveFolders(
  accessToken: string,
  driveId: string,
): Promise<GoogleDriveFolder[]> {
  const folders: GoogleDriveFolder[] = [];
  let pageToken: string | undefined;
  do {
    const url = driveUrl("/files");
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", driveId);
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set(
      "q",
      "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    );
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await apiRequest<{
      nextPageToken?: string;
      files?: GoogleDriveApiFile[];
    }>(accessToken, url);
    for (const raw of result.files ?? []) {
      const file = mapFile(raw);
      if (file) folders.push({ id: file.id, name: file.name, parents: file.parents });
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  return folders;
}

export async function listGoogleDriveFiles(
  accessToken: string,
  driveId: string,
): Promise<GoogleDriveFile[]> {
  const files: GoogleDriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = driveUrl("/files");
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", driveId);
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("q", "trashed = false");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await apiRequest<{
      nextPageToken?: string;
      files?: GoogleDriveApiFile[];
    }>(accessToken, url);
    for (const raw of result.files ?? []) {
      const file = mapFile(raw);
      if (file) files.push(file);
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

export async function getGoogleDriveStartPageToken(
  accessToken: string,
  driveId: string,
): Promise<string> {
  const url = driveUrl("/changes/startPageToken");
  url.searchParams.set("driveId", driveId);
  url.searchParams.set("supportsAllDrives", "true");
  const result = await apiRequest<{ startPageToken?: string }>(accessToken, url);
  if (!result.startPageToken)
    throw new GoogleDriveApiError("Google Drive omitted its change token.", 502);
  return result.startPageToken;
}

export async function listGoogleDriveChanges(
  accessToken: string,
  driveId: string,
  pageToken: string,
): Promise<{ changes: GoogleDriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
  const url = driveUrl("/changes");
  url.searchParams.set("driveId", driveId);
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set(
    "fields",
    `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
  );
  const result = await apiRequest<{
    nextPageToken?: string;
    newStartPageToken?: string;
    changes?: Array<{ fileId?: string; removed?: boolean; file?: GoogleDriveApiFile }>;
  }>(accessToken, url);
  return {
    changes: (result.changes ?? []).flatMap((change) => {
      if (!change.fileId) return [];
      return [
        {
          fileId: change.fileId,
          removed: change.removed === true,
          file: change.file ? mapFile(change.file) : null,
        },
      ];
    }),
    nextPageToken: result.nextPageToken,
    newStartPageToken: result.newStartPageToken,
  };
}

export async function getGoogleDriveFile(
  accessToken: string,
  fileId: string,
): Promise<GoogleDriveFile | null> {
  const url = driveUrl(`/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", FILE_FIELDS);
  const result = await apiRequest<GoogleDriveApiFile>(accessToken, url);
  return mapFile(result);
}

export async function downloadGoogleDriveFile(
  accessToken: string,
  fileId: string,
  mimeType: string,
  exportMimeType: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const isWorkspaceFile = mimeType.startsWith("application/vnd.google-apps.");
  const url = isWorkspaceFile
    ? driveUrl(`/files/${encodeURIComponent(fileId)}/export`)
    : driveUrl(`/files/${encodeURIComponent(fileId)}`);
  if (isWorkspaceFile) url.searchParams.set("mimeType", exportMimeType);
  else url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "*/*" },
  });
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new GoogleDriveApiError("Google Drive is temporarily unavailable.", response.status);
    }
    throw new GoogleDriveApiError("Google Drive could not export this file.", response.status);
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes)
    throw new GoogleDriveApiError("The file exceeds the size limit.", 413);
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes)
      throw new GoogleDriveApiError("The file exceeds the size limit.", 413);
    return data;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GoogleDriveApiError("The file exceeds the size limit.", 413);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
