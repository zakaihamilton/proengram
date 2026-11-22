import Link from "next/link";
import { Badge, Card, Select } from "panel-frame-ui";
import {
  addGitHubRepositoryAction,
  removeGitHubAccountAction,
  removeGitHubRepositoryAction,
  retryGitHubWebhookAction,
  syncGitHubAction,
} from "./actions";
import { ConnectionStatusList, InlineActionForm, RemoveSourceAction } from "./ConnectionPrimitives";
import type { SettingsData } from "./load-settings-data";

export function GitHubSourcesCard({
  organizationName,
  data,
}: {
  organizationName: string;
  data: SettingsData;
}) {
  const {
    canManageSources,
    canSyncSources,
    githubOAuthReady,
    databaseReady,
    githubAccounts,
    githubSources,
    activeSources,
    connectedRepositories,
    repositoryChoices,
    connected,
  } = data;

  return (
    <Card className="connection-card">
      <Badge tone={connected ? "success" : "warning"}>
        {connected ? "Connected" : githubOAuthReady ? "No repositories yet" : "Needs setup"}
      </Badge>
      <h2>GitHub sources for {organizationName}</h2>
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
        <form action="/auth/github/connect" className="save-form connection-action" method="get">
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
                      <Select
                        defaultValue=""
                        label="Available repositories"
                        name="repository"
                        options={availableRepositories.map((repository) => ({
                          value: repository.fullName,
                          label: (
                            <>
                              {repository.fullName} · {repository.isPrivate ? "Private" : "Public"}
                            </>
                          ),
                          searchLabel: repository.fullName,
                        }))}
                        placeholder="Select a repository"
                        required
                      />
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
                <RemoveSourceAction action={removeGitHubRepositoryAction} sourceId={source.id} />
              ) : null}
            </div>
          </>
        )}
      />
    </Card>
  );
}
