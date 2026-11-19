import Link from "next/link";
import { Alert, Badge, Card, PageHeader } from "panel-frame-ui";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import { getMcpResourceUri, getPerministerBaseUrl, getPublicOrigin } from "@/lib/auth/config";
import { protectedResourceMetadataUrl } from "@/lib/auth/protected-resource";
import { isDatabaseConfigured } from "@/lib/db/pool";
import {
  isGitHubConfigured,
  listGitHubAccountRepositories,
  listGitHubRepositorySources,
} from "@/lib/github/github";
import { listGitHubAccountConnections } from "@/lib/github/connections";
import {
  addGitHubRepositoryAction,
  removeGitHubAccountAction,
  removeGitHubRepositoryAction,
  retryGitHubWebhookAction,
  syncGitHubAction,
} from "./actions";

function Status({ ready }: { ready: boolean }) {
  return <Badge tone={ready ? "success" : "warning"}>{ready ? "Configured" : "Needs setup"}</Badge>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
  const databaseReady = isDatabaseConfigured();
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

          {githubSources.length ? (
            <div className="connection-action">
              <h3>Repositories</h3>
              <div className="status-list">
                {githubSources.map((source) => (
                  <div className="status-row" key={source.id}>
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
                        <InlineActionForm
                          action={removeGitHubRepositoryAction}
                          fieldName="sourceId"
                          label="Remove"
                          value={source.id}
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
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
