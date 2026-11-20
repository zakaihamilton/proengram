import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, Badge, Card, PageHeader } from "panel-frame-ui";
import { getMcpResourceUri, getPerministerBaseUrl, getPublicOrigin } from "@/lib/auth/config";
import { protectedResourceMetadataUrl } from "@/lib/auth/protected-resource";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { listGitHubAccountConnections } from "@/lib/github/connections";
import {
  isGitHubConfigured,
  listGitHubAccountRepositories,
  listGitHubRepositorySources,
} from "@/lib/github/github";
import {
  getGoogleDriveAccessToken,
  getGoogleDriveAccountConnection,
  isGoogleDriveConfigured,
  listAvailableGoogleSharedDrives,
  listGoogleDriveSources,
} from "@/lib/google-drive/connections";
import { listGoogleDriveFolders } from "@/lib/google-drive/drive-api";
import {
  addGitHubRepositoryAction,
  addGoogleDriveSourceAction,
  disconnectGoogleDriveAction,
  removeGitHubAccountAction,
  removeGitHubRepositoryAction,
  removeGoogleDriveSourceAction,
  retryGitHubWebhookAction,
  syncGitHubAction,
  syncGoogleDriveAction,
} from "./actions";

function Status({ ready }: { ready: boolean }) {
  return <Badge tone={ready ? "success" : "warning"}>{ready ? "Configured" : "Needs setup"}</Badge>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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

function InlineActionForm({
  action,
  fieldName,
  value,
  label,
}: {
  action: (formData: FormData) => Promise<void>;
  fieldName: string;
  value: string;
  label: string;
}) {
  return (
    <form action={action}>
      <input name={fieldName} type="hidden" value={value} />
      <button className="text-link" type="submit">
        {label}
      </button>
    </form>
  );
}

function RemoveSourceAction({
  action,
  sourceId,
}: {
  action: (formData: FormData) => Promise<void>;
  sourceId: string;
}) {
  return <InlineActionForm action={action} fieldName="sourceId" label="Remove" value={sourceId} />;
}

function ConnectionStatusList<T extends { id: string }>({
  items,
  title,
  renderRow,
}: {
  items: T[];
  title: string;
  renderRow: (item: T) => ReactNode;
}) {
  if (!items.length) return null;
  return (
    <div className="connection-action">
      <h3>{title}</h3>
      <div className="status-list">
        {items.map((item) => (
          <div className="status-row" key={item.id}>
            {renderRow(item)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireDashboardIdentity("brain:read");
  const params = await searchParams;
  const canManageSources = await authorizeAppAction(identity, "source:manage").catch(() => false);
  const canSyncSources = await authorizeAppAction(identity, "source:sync").catch(() => false);
  const dashboardAuthReady = Boolean(
    process.env.PERMINISTER_DASHBOARD_CLIENT_ID && process.env.PERMINISTER_DASHBOARD_CLIENT_SECRET,
  );
  const mcpAuthReady = Boolean(
    process.env.PERMINISTER_MCP_CLIENT_ID && process.env.PERMINISTER_MCP_CLIENT_SECRET,
  );
  const githubOAuthReady = isGitHubConfigured();
  const googleDriveReady = isGoogleDriveConfigured();
  const databaseReady = isDatabaseConfigured();
  const googleDriveAccount = databaseReady
    ? await getGoogleDriveAccountConnection(identity.organization.organizationId).catch(() => null)
    : null;
  const googleDriveSources = databaseReady
    ? await listGoogleDriveSources(identity.organization.organizationId).catch(() => [])
    : [];
  let googleDrives: Awaited<ReturnType<typeof listAvailableGoogleSharedDrives>> = [];
  let googleDriveFolders = new Map<string, Awaited<ReturnType<typeof listGoogleDriveFolders>>>();
  let googleDriveListingError = false;
  if (
    canManageSources &&
    googleDriveReady &&
    databaseReady &&
    googleDriveAccount?.status === "active"
  ) {
    try {
      const accessToken = await getGoogleDriveAccessToken(identity.organization.organizationId);
      googleDrives = await listAvailableGoogleSharedDrives(identity.organization.organizationId);
      const folders = await Promise.all(
        googleDrives.map(
          async (drive) =>
            [
              drive.id,
              await listGoogleDriveFolders(accessToken, drive.id).catch(() => []),
            ] as const,
        ),
      );
      googleDriveFolders = new Map(folders);
    } catch {
      googleDriveListingError = true;
    }
  }
  const githubAccounts = databaseReady
    ? await listGitHubAccountConnections(identity.organization.organizationId).catch(() => [])
    : [];
  const githubSources = databaseReady
    ? await listGitHubRepositorySources(identity.organization.organizationId).catch(() => [])
    : [];
  const activeSources = githubSources.filter((source) => source.status === "active");
  const connectedRepositories = new Set(
    activeSources.map((source) => `${source.owner}/${source.repository}`.toLowerCase()),
  );
  const repositoryChoices = new Map<
    string,
    { repositories: Awaited<ReturnType<typeof listGitHubAccountRepositories>>; error: boolean }
  >();
  if (canManageSources && githubOAuthReady && databaseReady) {
    const choices = await Promise.all(
      githubAccounts.map(async (account) => {
        if (account.status !== "active") {
          return { accountId: account.id, repositories: [], error: false };
        }
        try {
          return {
            accountId: account.id,
            repositories: await listGitHubAccountRepositories(
              identity.organization.organizationId,
              account.id,
            ),
            error: false,
          };
        } catch {
          return { accountId: account.id, repositories: [], error: true };
        }
      }),
    );
    for (const choice of choices) repositoryChoices.set(choice.accountId, choice);
  }
  const connected = githubOAuthReady && activeSources.length > 0;
  const mcpUrl = getMcpResourceUri();
  const githubState = first(params.github);
  const githubConnectionState = first(params.githubConnection);
  const githubRepositoryState = first(params.githubRepository);
  const githubWebhookState = first(params.githubWebhook);
  const githubAccountState = first(params.githubAccount);
  const count = first(params.count);
  const githubCallbackUrl = new URL("/auth/github/callback", getPublicOrigin()).toString();
  const googleDriveCallbackUrl = new URL(
    "/auth/google-drive/callback",
    getPublicOrigin(),
  ).toString();
  const googleDriveConnectionState = first(params.googleDriveConnection);
  const googleDriveSourceState = first(params.googleDriveSource);

  return (
    <main className="page-content">
      <PageHeader
        eyebrow="WORKSPACE CONFIGURATION"
        title="Settings"
        description="Manage connections for this organization. Secrets stay server-side."
      />
      {githubState === "synced" ? (
        <Alert tone="success">Synced {count || "the"} Markdown files from GitHub.</Alert>
      ) : null}
      {githubState === "error" ? (
        <Alert tone="error">
          GitHub sync failed. Reconnect the account or check repository permissions.
        </Alert>
      ) : null}
      {githubConnectionState === "connected" ? (
        <Alert tone="success">GitHub account connected to {identity.organization.name}.</Alert>
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
          Repository could not be added. Check the selected account's repository access.
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

      <div className="connection-grid">
        <Card className="connection-card">
          <Status ready={dashboardAuthReady} />
          <h2>Perminister dashboard client</h2>
          <p>
            OIDC sign-in for the ProEngram dashboard. Configure this as a standard app client with
            the exact callback URL.
          </p>
          <p className="connection-status">
            <code>{new URL("/auth/perminister/callback", getPublicOrigin()).toString()}</code>
          </p>
        </Card>
        <Card className="connection-card">
          <Status ready={mcpAuthReady} />
          <h2>Perminister MCP resource client</h2>
          <p>
            Confidential server credentials validate remote user tokens and current grants.
            Configure the resource URI and matching scopes.
          </p>
          <p className="connection-status">
            <code>{mcpUrl}</code>
          </p>
        </Card>
        <Card className="connection-card">
          <Status ready={databaseReady} />
          <h2>Nanogres PostgreSQL</h2>
          <p>
            ProEngram uses a dedicated database and least-privilege roles through short-lived
            Nanogres workload certificates. The connection stays server-side.
          </p>
          <p className="connection-status">
            {databaseReady ? "Workload identity configured" : "Set Nanogres identity settings"}
          </p>
        </Card>

        <Card className="connection-card">
          <Badge tone={connected ? "success" : "warning"}>
            {connected ? "Connected" : githubOAuthReady ? "No repositories yet" : "Needs setup"}
          </Badge>
          <h2>GitHub sources for {identity.organization.name}</h2>
          <p>
            Connect GitHub user accounts, then choose repositories the account can access. Each
            organization keeps its own account and repository connections.
          </p>
          <p className="metric-note">
            GitHub grants this connection read/write access to repositories the user can access;
            ProEngram only indexes repositories admins select here.
          </p>
          <p className="connection-status">
            {githubOAuthReady
              ? `${githubAccounts.length} account${githubAccounts.length === 1 ? "" : "s"} · ${activeSources.length} active ${activeSources.length === 1 ? "repository" : "repositories"}`
              : "Set the GitHub OAuth client credentials and token encryption key"}
          </p>

          {canManageSources && githubOAuthReady && databaseReady ? (
            <form
              action="/auth/github/connect"
              className="save-form connection-action"
              method="get"
            >
              <label className="pf-field">
                <span className="pf-field-label">GitHub username (optional)</span>
                <input className="pf-input" name="login" placeholder="octocat" />
              </label>
              <button className="pf-button pf-button-secondary" type="submit">
                Connect or add account
              </button>
            </form>
          ) : null}

          {githubAccounts.length ? (
            <div className="connection-action">
              <h3>Connected accounts</h3>
              <div className="status-list">
                {githubAccounts.map((account) => (
                  <div className="status-row" key={account.id}>
                    <span>
                      <strong>@{account.login}</strong>
                      <span className="metric-note">
                        {account.repositoryCount} connected repositor
                        {account.repositoryCount === 1 ? "y" : "ies"}
                      </span>
                    </span>
                    <div className="connection-row-actions">
                      <Badge tone={account.status === "active" ? "success" : "warning"}>
                        {account.status === "active" ? "Connected" : "Reconnect needed"}
                      </Badge>
                      {canManageSources && account.status !== "active" ? (
                        <Link
                          className="text-link"
                          href={`/auth/github/connect?login=${encodeURIComponent(account.login)}`}
                        >
                          Reconnect
                        </Link>
                      ) : null}
                      {canManageSources ? (
                        <InlineActionForm
                          action={removeGitHubAccountAction}
                          fieldName="organizationAccountId"
                          label="Remove"
                          value={account.id}
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {canManageSources && githubOAuthReady && databaseReady
            ? githubAccounts
                .filter((account) => account.status === "active")
                .map((account) => {
                  const choice = repositoryChoices.get(account.id);
                  const availableRepositories = (choice?.repositories ?? []).filter(
                    (repository) => !connectedRepositories.has(repository.fullName.toLowerCase()),
                  );
                  return (
                    <form
                      action={addGitHubRepositoryAction}
                      className="save-form connection-action"
                      key={account.id}
                    >
                      <h3>Add a repository from @{account.login}</h3>
                      <input name="organizationAccountId" type="hidden" value={account.id} />
                      {choice?.error ? (
                        <p className="metric-note">
                          Could not load repositories. Check GitHub access and try again.
                        </p>
                      ) : availableRepositories.length ? (
                        <>
                          <label className="pf-field">
                            <span className="pf-field-label">Available repositories</span>
                            <select className="pf-input" name="repository" required>
                              <option value="">Select a repository</option>
                              {availableRepositories.map((repository) => (
                                <option key={repository.id} value={repository.fullName}>
                                  {repository.fullName} ·{" "}
                                  {repository.isPrivate ? "Private" : "Public"}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button className="pf-button pf-button-secondary" type="submit">
                            Add repository
                          </button>
                        </>
                      ) : (
                        <p className="metric-note">
                          {choice?.repositories.length
                            ? "All repositories available to this account are already connected."
                            : "No repositories are available to this account."}
                        </p>
                      )}
                    </form>
                  );
                })
            : null}

          <ConnectionStatusList
            items={githubSources}
            title="Repositories"
            renderRow={(source) => (
              <>
                <span>
                  <strong>
                    {source.owner}/{source.repository}
                  </strong>
                  <span className="metric-note">
                    {source.githubLogin ? `@${source.githubLogin} · ` : ""}
                    {source.defaultBranch}
                    {source.syncPending ? " · Sync queued" : ""}
                    {source.lastSyncedAt
                      ? ` · Synced ${new Date(source.lastSyncedAt).toLocaleDateString()}`
                      : ""}
                    {source.webhookStatus === "active"
                      ? " · Push sync enabled"
                      : " · Scheduled sync only"}
                  </span>
                </span>
                <div className="connection-row-actions">
                  <Badge tone={source.status === "active" ? "success" : "warning"}>
                    {source.status === "active" ? "Active" : "Reconnect account"}
                  </Badge>
                  {source.status === "active" && canSyncSources ? (
                    <InlineActionForm
                      action={syncGitHubAction}
                      fieldName="sourceId"
                      label="Sync"
                      value={source.id}
                    />
                  ) : null}
                  {source.status === "active" &&
                  canManageSources &&
                  source.webhookStatus !== "active" ? (
                    <InlineActionForm
                      action={retryGitHubWebhookAction}
                      fieldName="sourceId"
                      label="Retry push setup"
                      value={source.id}
                    />
                  ) : null}
                  {canManageSources ? (
                    <RemoveSourceAction
                      action={removeGitHubRepositoryAction}
                      sourceId={source.id}
                    />
                  ) : null}
                </div>
              </>
            )}
          />
        </Card>

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
          <h2>Google Drive sources for {identity.organization.name}</h2>
          <p>
            Connect one admin-managed Google account, then select Shared Drives or folders to index
            for this organization. Supported files are Docs, Sheets, Slides, and text-based PDFs.
          </p>
          <p className="metric-note">
            Everyone with <code>brain:read</code> can read every selected item, even if their own
            Google account would not have access. Select only content approved for the whole
            company.
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

          {googleDriveConnectionState === "connected" || googleDriveAccount?.status === "active" ? (
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
                    const folders = [...(googleDriveFolders.get(drive.id) ?? [])].sort(
                      (left, right) =>
                        folderDisplayPath(
                          left.id,
                          googleDriveFolders.get(drive.id) ?? [],
                        ).localeCompare(
                          folderDisplayPath(right.id, googleDriveFolders.get(drive.id) ?? []),
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
                          <p className="metric-note">
                            No folders were returned for this Shared Drive.
                          </p>
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
                <p className="metric-note">
                  No Shared Drives are available to this Google account.
                </p>
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
                            folderDisplayPath(
                              folderId,
                              googleDriveFolders.get(source.driveId) ?? [],
                            ),
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
                    <RemoveSourceAction
                      action={removeGoogleDriveSourceAction}
                      sourceId={source.id}
                    />
                  ) : null}
                </div>
              </>
            )}
          />
        </Card>

        <Card className="connection-card">
          <Badge tone="warning">Adapter required</Badge>
          <h2>Sentry8 policy snapshots</h2>
          <p>
            Import a reviewed policy catalog from a supported Sentry8 export or identity-safe
            adapter. Direct MCP calls are not enforced by Sentry8 yet.
          </p>
          <p className="connection-status">
            <Link className="text-link" href="/policies">
              Open policy library →
            </Link>
          </p>
        </Card>
        <Card className="connection-card">
          <Badge tone="accent">Remote MCP</Badge>
          <h2>Connect an assistant</h2>
          <p>
            Use the ProEngram MCP URL. ChatGPT and Claude each run a separate Perminister user
            consent flow.
          </p>
          <p className="connection-status">
            <code>{mcpUrl}</code>
          </p>
          <p className="metric-note">Discovery: {protectedResourceMetadataUrl()}</p>
        </Card>
      </div>

      <Card className="content-card setup-card">
        <div className="card-heading">
          <div>
            <h2>Initial setup</h2>
            <p>
              Keep application secrets server-side; database access uses short-lived workload
              certificates.
            </p>
          </div>
        </div>
        <ol className="setup-list">
          <li>
            Create a dedicated <code>proengram</code> database and runtime/migration roles in
            Nanogres, then grant this environment's exact Vercel OIDC identity.
          </li>
          <li>
            Configure separate Perminister clients for dashboard OIDC and MCP resource
            introspection.
          </li>
          <li>
            Create a GitHub OAuth App with callback URL <code>{githubCallbackUrl}</code>, then
            configure its server-side client ID and secret plus a 32-byte token encryption key. Each
            connected account authorizes the <code>repo</code> scope; admins select which accessible
            repositories ProEngram connects.
          </li>
          <li>
            Connect GitHub accounts and select repositories from the live repository list. No
            repository names are hard-coded or installed ahead of time.
          </li>
          <li>
            Create a Google OAuth client with callback URL <code>{googleDriveCallbackUrl}</code>.
            Configure its client ID and secret plus a separate 32-byte token encryption key. Google
            may require verification for the read-only Drive scope.
          </li>
          <li>
            Connect the Google account and select Shared Drives or folders approved for company-wide
            reading. Every ProEngram member with <code>brain:read</code> can read that selected
            corpus.
          </li>
          <li>
            Apply numbered database migrations with <code>pnpm db:migrate</code>.
          </li>
          <li>
            Run <code>pnpm health:audit</code> and review the available Repnix guardrails.
          </li>
        </ol>
        <p className="metric-note">
          Perminister: <code>{getPerministerBaseUrl()}</code>
        </p>
      </Card>
    </main>
  );
}
