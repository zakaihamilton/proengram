import Link from "next/link";
import { Badge, Card, PageHeader } from "panel-frame-ui";
import { getPublicOrigin } from "@/lib/auth/config";
import { protectedResourceMetadataUrl } from "@/lib/auth/protected-resource";
import { requireDashboardIdentity } from "@/lib/auth/session";
import { Status } from "./ConnectionPrimitives";
import { GitHubSourcesCard } from "./GitHubSourcesCard";
import { GoogleDriveSourcesCard } from "./GoogleDriveSourcesCard";
import { loadSettingsData } from "./load-settings-data";
import { SettingsAlerts } from "./SettingsAlerts";
import { SetupChecklistCard } from "./SetupChecklistCard";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireDashboardIdentity("brain:read");
  const data = await loadSettingsData(identity, await searchParams);

  return (
    <main className="page-content">
      <PageHeader
        eyebrow="WORKSPACE CONFIGURATION"
        title="Settings"
        description="Manage connections for this organization. Secrets stay server-side."
      />
      <SettingsAlerts alerts={data.alerts} organizationName={identity.organization.name} />

      <div className="connection-grid">
        <Card className="connection-card">
          <Status ready={data.dashboardAuthReady} />
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
          <Status ready={data.mcpAuthReady} />
          <h2>Perminister MCP resource client</h2>
          <p>
            Confidential server credentials validate remote user tokens and current grants.
            Configure the resource URI and matching scopes.
          </p>
          <p className="connection-status">
            <code>{data.mcpUrl}</code>
          </p>
        </Card>
        <Card className="connection-card">
          <Status ready={data.databaseReady} />
          <h2>Nanogres PostgreSQL</h2>
          <p>
            ProEngram uses a dedicated database and least-privilege roles through short-lived
            Nanogres workload certificates. The connection stays server-side.
          </p>
          <p className="connection-status">
            {data.databaseReady ? "Workload identity configured" : "Set Nanogres identity settings"}
          </p>
        </Card>

        <GitHubSourcesCard data={data} organizationName={identity.organization.name} />
        <GoogleDriveSourcesCard data={data} organizationName={identity.organization.name} />

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
            <code>{data.mcpUrl}</code>
          </p>
          <p className="metric-note">Discovery: {protectedResourceMetadataUrl()}</p>
        </Card>
      </div>

      <SetupChecklistCard
        githubCallbackUrl={data.githubCallbackUrl}
        googleDriveCallbackUrl={data.googleDriveCallbackUrl}
      />
    </main>
  );
}
