import Link from "next/link";
import { Badge, Card } from "panel-frame-ui";
import type { listGoogleDriveFolders } from "@/lib/google-drive/drive-api";
import {
  addGoogleDriveSourceAction,
  disconnectGoogleDriveAction,
  removeGoogleDriveSourceAction,
  syncGoogleDriveAction,
} from "./actions";
import { ConnectionStatusList, InlineActionForm, RemoveSourceAction } from "./ConnectionPrimitives";
import type { SettingsData } from "./load-settings-data";

function folderDisplayPath(
  folderId: string,
  folders: Awaited<ReturnType<typeof listGoogleDriveFolders>>,
): string {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.push(current.name);
    current = current.parents.map((parent) => byId.get(parent)).find(Boolean);
  }
  return names.reverse().join(" / ") || folderId;
}

export function GoogleDriveSourcesCard({
  organizationName,
  data,
}: {
  organizationName: string;
  data: SettingsData;
}) {
  const {
    canManageSources,
    canSyncSources,
    googleDriveReady,
    databaseReady,
    googleDriveAccount,
    googleDriveSources,
    googleDrives,
    googleDriveFolders,
    googleDriveListingError,
    alerts,
  } = data;

  return (
    <Card className="connection-card">
      <Badge tone={googleDriveAccount?.status === "active" ? "success" : "warning"}>
        {googleDriveAccount?.status === "active"
          ? "Account connected"
          : googleDriveAccount?.status === "reauthorize_required"
            ? "Reconnect needed"
            : googleDriveReady
              ? "Not connected"
              : "Needs setup"}
      </Badge>
      <h2>Google Drive sources for {organizationName}</h2>
      <p>
        Connect one admin-managed Google account, then select Shared Drives or folders to index for
        this organization. Supported files are Docs, Sheets, Slides, and text-based PDFs.
      </p>
      <p className="metric-note">
        Everyone with <code>brain:read</code> can read every selected item, even if their own Google
        account would not have access. Select only content approved for the whole company.
      </p>
      <p className="connection-status">
        {googleDriveReady
          ? googleDriveAccount
            ? `${googleDriveAccount.email} · ${googleDriveSources.filter((source) => source.status === "active").length} active Shared Drives`
            : "Configure the Google OAuth client credentials and token encryption key"
          : "Set GOOGLE_DRIVE_OAUTH_CLIENT_ID, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, and GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY"}
      </p>

      {canManageSources && googleDriveReady && databaseReady ? (
        <div className="connection-row-actions connection-action">
          <Link className="pf-button pf-button-secondary" href="/auth/google-drive/connect">
            {googleDriveAccount ? "Reconnect Google account" : "Connect Google account"}
          </Link>
          {googleDriveAccount ? (
            <form action={disconnectGoogleDriveAction}>
              <button className="text-link" type="submit">
                Disconnect account
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {alerts.googleDriveConnectionState === "connected" ||
      googleDriveAccount?.status === "active" ? (
        <>
          {googleDriveListingError ? (
            <p className="metric-note">
              Shared Drives could not be loaded. Reconnect the account or check its Shared Drive
              access.
            </p>
          ) : null}
          {canManageSources && googleDrives.length ? (
            <div className="connection-action">
              <h3>Select Shared Drives and folders</h3>
              {googleDrives.map((drive) => {
                const existingSource = googleDriveSources.find(
                  (source) => source.driveId === drive.id,
                );
                const driveFolders = googleDriveFolders.get(drive.id) ?? [];
                const folders = [...driveFolders].sort((left, right) =>
                  folderDisplayPath(left.id, driveFolders).localeCompare(
                    folderDisplayPath(right.id, driveFolders),
                  ),
                );
                return (
                  <form
                    action={addGoogleDriveSourceAction}
                    className="save-form connection-action"
                    key={drive.id}
                  >
                    <input name="driveId" type="hidden" value={drive.id} />
                    <h4>{drive.name}</h4>
                    <label className="choice-row">
                      <input
                        defaultChecked={
                          !existingSource || existingSource.selectedFolderIds.length === 0
                        }
                        name="scope"
                        type="radio"
                        value="drive"
                      />
                      <span>Index the entire Shared Drive</span>
                    </label>
                    <label className="choice-row">
                      <input
                        defaultChecked={Boolean(existingSource?.selectedFolderIds.length)}
                        name="scope"
                        type="radio"
                        value="folders"
                      />
                      <span>Index only selected folders and their subfolders</span>
                    </label>
                    {folders.length ? (
                      <div className="status-list">
                        {folders.map((folder) => (
                          <label className="choice-row" key={folder.id}>
                            <input
                              defaultChecked={
                                existingSource?.selectedFolderIds.includes(folder.id) ?? false
                              }
                              name="folderId"
                              type="checkbox"
                              value={folder.id}
                            />
                            <span>{folderDisplayPath(folder.id, folders)}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="metric-note">No folders were returned for this Shared Drive.</p>
                    )}
                    <button className="pf-button pf-button-secondary" type="submit">
                      {existingSource ? "Save scope and sync" : "Add Shared Drive"}
                    </button>
                  </form>
                );
              })}
            </div>
          ) : null}
          {googleDrives.length === 0 && !googleDriveListingError ? (
            <p className="metric-note">No Shared Drives are available to this Google account.</p>
          ) : null}
        </>
      ) : null}

      <ConnectionStatusList
        items={googleDriveSources}
        title="Selected sources"
        renderRow={(source) => (
          <>
            <span>
              <strong>{source.driveName}</strong>
              <span className="metric-note">
                {source.selectedFolderIds.length
                  ? source.selectedFolderIds
                      .map((folderId) =>
                        folderDisplayPath(folderId, googleDriveFolders.get(source.driveId) ?? []),
                      )
                      .join(" · ")
                  : "Entire Shared Drive"}
                {source.lastSyncedAt
                  ? ` · Synced ${new Date(source.lastSyncedAt).toLocaleDateString()}`
                  : " · Sync pending"}
                {source.syncPending ? " · Sync queued" : ""}
                {source.lastSyncStatus === "failed" ? " · Last sync failed" : ""}
                {` · ${source.indexedCount} indexed · ${source.skippedCount} skipped · ${source.errorCount} errors`}
              </span>
            </span>
            <div className="connection-row-actions">
              <Badge tone={source.status === "active" ? "success" : "warning"}>
                {source.status === "active"
                  ? "Active"
                  : source.status === "needs_auth"
                    ? "Reconnect account"
                    : "Disabled"}
              </Badge>
              {source.status === "active" && canSyncSources ? (
                <InlineActionForm
                  action={syncGoogleDriveAction}
                  fieldName="sourceId"
                  label="Sync"
                  value={source.id}
                />
              ) : null}
              {canManageSources ? (
                <RemoveSourceAction action={removeGoogleDriveSourceAction} sourceId={source.id} />
              ) : null}
            </div>
          </>
        )}
      />
    </Card>
  );
}
