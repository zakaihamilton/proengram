import { getMcpResourceUri, getPublicOrigin } from "@/lib/auth/config";
import { authorizeAppAction, type ProEngramIdentity } from "@/lib/auth/session";
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

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function loadSettingsData(
  identity: ProEngramIdentity,
  params: Record<string, string | string[] | undefined>,
) {
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

  return {
    canManageSources,
    canSyncSources,
    dashboardAuthReady,
    mcpAuthReady,
    githubOAuthReady,
    googleDriveReady,
    databaseReady,
    googleDriveAccount,
    googleDriveSources,
    googleDrives,
    googleDriveFolders,
    googleDriveListingError,
    githubAccounts,
    githubSources,
    activeSources,
    connectedRepositories,
    repositoryChoices,
    connected: githubOAuthReady && activeSources.length > 0,
    mcpUrl: getMcpResourceUri(),
    githubCallbackUrl: new URL("/auth/github/callback", getPublicOrigin()).toString(),
    googleDriveCallbackUrl: new URL("/auth/google-drive/callback", getPublicOrigin()).toString(),
    alerts: {
      githubState: first(params.github),
      githubConnectionState: first(params.githubConnection),
      githubRepositoryState: first(params.githubRepository),
      githubWebhookState: first(params.githubWebhook),
      githubAccountState: first(params.githubAccount),
      count: first(params.count),
      googleDriveConnectionState: first(params.googleDriveConnection),
      googleDriveSourceState: first(params.googleDriveSource),
    },
  };
}

export type SettingsData = Awaited<ReturnType<typeof loadSettingsData>>;
