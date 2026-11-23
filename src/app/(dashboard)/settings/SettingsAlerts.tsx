import { Alert } from "panel-frame-ui";
import type { SettingsData } from "./load-settings-data";

export function SettingsAlerts({
  alerts,
  organizationName,
}: {
  alerts: SettingsData["alerts"];
  organizationName: string;
}) {
  const {
    githubState,
    githubConnectionState,
    githubRepositoryState,
    githubWebhookState,
    githubAccountState,
    count,
    googleDriveConnectionState,
    googleDriveSourceState,
  } = alerts;

  return (
    <>
      {githubState === "synced" ? (
        <Alert tone="success">Synced {count || "the"} Markdown files from GitHub.</Alert>
      ) : null}
      {githubState === "error" ? (
        <Alert tone="error">
          GitHub sync failed. Reconnect the account or check repository permissions.
        </Alert>
      ) : null}
      {githubConnectionState === "connected" ? (
        <Alert tone="success">GitHub account connected to {organizationName}.</Alert>
      ) : null}
      {githubConnectionState === "denied" ? (
        <Alert tone="warning">GitHub account authorization was cancelled.</Alert>
      ) : null}
      {githubConnectionState === "setup" || githubConnectionState === "error" ? (
        <Alert tone="error">
          GitHub OAuth is not ready. Configure the OAuth client ID and secret plus the token
          encryption key, then try again.
        </Alert>
      ) : null}
      {githubRepositoryState === "added" ? (
        <Alert tone="success">
          GitHub repository connected. Its initial Markdown sync has been queued.
        </Alert>
      ) : null}
      {githubRepositoryState === "removed" ? (
        <Alert tone="success">
          GitHub repository disconnected. Its indexed documents are inactive.
        </Alert>
      ) : null}
      {githubRepositoryState === "error" ? (
        <Alert tone="error">
          Repository could not be added. Check the selected account&apos;s repository access.
        </Alert>
      ) : null}
      {githubAccountState === "removed" ? (
        <Alert tone="success">GitHub account disconnected from this organization.</Alert>
      ) : null}
      {githubAccountState === "error" ? (
        <Alert tone="error">GitHub account could not be disconnected.</Alert>
      ) : null}
      {githubWebhookState === "active" ? (
        <Alert tone="success">Push-triggered GitHub sync is enabled.</Alert>
      ) : null}
      {githubWebhookState === "error" ? (
        <Alert tone="warning">
          GitHub push sync could not be enabled. Scheduled checks and manual sync remain available.
        </Alert>
      ) : null}
      {googleDriveConnectionState === "connected" ? (
        <Alert tone="success">
          Google Drive account connected. Choose Shared Drives or folders below to begin indexing.
        </Alert>
      ) : null}
      {googleDriveConnectionState === "disconnected" ? (
        <Alert tone="success">
          Google Drive authorization was revoked and indexed Drive items are inactive.
        </Alert>
      ) : null}
      {googleDriveConnectionState === "denied" ? (
        <Alert tone="warning">Google Drive authorization was cancelled.</Alert>
      ) : null}
      {googleDriveConnectionState === "setup" || googleDriveConnectionState === "error" ? (
        <Alert tone="error">
          Google Drive could not connect. Check the OAuth client, callback URL, and token encryption
          key.
        </Alert>
      ) : null}
      {googleDriveSourceState === "saved" ? (
        <Alert tone="success">Google Drive scope saved. Its initial sync has been queued.</Alert>
      ) : null}
      {googleDriveSourceState === "queued" ? (
        <Alert tone="success">Google Drive sync has been queued.</Alert>
      ) : null}
      {googleDriveSourceState === "removed" ? (
        <Alert tone="success">Shared Drive disconnected. Its indexed items are inactive.</Alert>
      ) : null}
      {googleDriveSourceState === "emptyScope" ? (
        <Alert tone="warning">Choose at least one folder, or select the entire Shared Drive.</Alert>
      ) : null}
      {googleDriveSourceState === "error" ? (
        <Alert tone="error">
          Google Drive source could not be saved or synced. Check access and try again.
        </Alert>
      ) : null}
    </>
  );
}
