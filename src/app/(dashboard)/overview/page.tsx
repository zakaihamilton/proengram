import Link from "next/link";
import { Alert, Badge, Card, EmptyState, PageHeader } from "panel-frame-ui";
import { BrainItemCard } from "@/components/brain-item-card";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import { getOverview } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { isGitHubConfigured, listGitHubRepositorySources } from "@/lib/github/github";

export default async function OverviewPage() {
  const identity = await requireDashboardIdentity("brain:read");
  const canReadPolicies = await authorizeAppAction(identity, "policy:read").catch(() => false);
  let overview: Awaited<ReturnType<typeof getOverview>> = null;
  let githubSourceReady = false;
  let storageError = false;
  if (isDatabaseConfigured()) {
    try {
      const [loadedOverview, githubSources] = await Promise.all([
        getOverview(identity.organization.organizationId, canReadPolicies),
        listGitHubRepositorySources(identity.organization.organizationId),
      ]);
      overview = loadedOverview;
      githubSourceReady = githubSources.some((source) => source.status === "active");
    } catch {
      storageError = true;
    }
  }
  const databaseReady = Boolean(overview);
  const sentry8Ready = canReadPolicies && Boolean(overview?.counts.policies);
  const mcpReady = Boolean(
    process.env.PERMINISTER_MCP_CLIENT_ID && process.env.PERMINISTER_MCP_CLIENT_SECRET,
  );
  const githubReady = isGitHubConfigured() && githubSourceReady;

  return (
    <main className="page-content">
      <div className="page-heading-row">
        <PageHeader
          eyebrow="COMPANY BRAIN"
          title="Overview"
          description="A shared space for approved knowledge, useful answers, and policy context."
          actions={
            <Link className="pf-button pf-button-primary" href="/knowledge">
              Search knowledge
            </Link>
          }
        />
      </div>

      {!databaseReady ? (
        <Alert tone={storageError ? "warning" : "info"}>
          <strong>
            {storageError ? "Nanogres database needs setup" : "Connect Nanogres to get started"}
          </strong>
          <span> Configure Nanogres workload identity, then apply the database migrations. </span>
          <Link className="text-link" href="/settings">
            View setup
          </Link>
        </Alert>
      ) : null}

      <section aria-label="Knowledge library summary" className="metric-grid">
        <Card className="metric-card">
          <div className="metric-label">
            GitHub documents{" "}
            <Badge tone={githubReady ? "success" : "warning"}>
              {githubReady ? "Connected" : "Setup needed"}
            </Badge>
          </div>
          <strong className="metric-value">
            {overview ? overview.counts.github.toLocaleString() : "—"}
          </strong>
          <div className="metric-note">Approved Markdown indexed for search</div>
        </Card>
        <Card className="metric-card">
          <div className="metric-label">
            Saved answers <Badge tone="neutral">Company shared</Badge>
          </div>
          <strong className="metric-value">
            {overview ? overview.counts.saved.toLocaleString() : "—"}
          </strong>
          <div className="metric-note">Answers explicitly saved by team members</div>
        </Card>
        <Card className="metric-card">
          <div className="metric-label">
            Sentry8 policies{" "}
            <Badge tone={sentry8Ready ? "accent" : "warning"}>
              {sentry8Ready ? "Adapter set" : "Not connected"}
            </Badge>
          </div>
          <strong className="metric-value">
            {canReadPolicies && overview ? overview.counts.policies.toLocaleString() : "—"}
          </strong>
          <div className="metric-note">
            {canReadPolicies
              ? "Imported policy snapshots with source revision"
              : "Requires the policy:read permission"}
          </div>
        </Card>
      </section>

      <div className="dashboard-grid">
        <Card className="content-card">
          <div className="card-heading">
            <div>
              <h2>Recently added</h2>
              <p>Company-visible items from your shared library.</p>
            </div>
            <Link className="text-link" href="/knowledge">
              Browse all
            </Link>
          </div>
          {overview?.recent.length ? (
            <div className="item-list">
              {overview.recent.map((item) => (
                <BrainItemCard item={item} key={item.id} />
              ))}
            </div>
          ) : (
            <EmptyState
              title={
                databaseReady
                  ? "Your library is ready for its first item"
                  : "Your library will appear here"
              }
              description={
                databaseReady
                  ? "Sync GitHub Markdown or save a useful answer to start building the company brain."
                  : "Connect the Nanogres database to show shared knowledge and saved answers."
              }
              action={
                databaseReady ? (
                  <Link className="text-link" href="/settings">
                    Connect a source
                  </Link>
                ) : undefined
              }
            />
          )}
        </Card>
        <Card className="content-card">
          <div className="card-heading">
            <div>
              <h2>Connections</h2>
              <p>ProEngram keeps each source behind the server.</p>
            </div>
          </div>
          <div className="status-list">
            <div className="status-row">
              <span>Perminister identity</span>
              <span className="status-indicator" data-status="connected">
                Connected
              </span>
            </div>
            <div className="status-row">
              <span>Nanogres PostgreSQL</span>
              <span
                className="status-indicator"
                data-status={databaseReady ? "connected" : "not-connected"}
              >
                {databaseReady ? "Connected" : "Setup needed"}
              </span>
            </div>
            <div className="status-row">
              <span>GitHub Markdown</span>
              <span
                className="status-indicator"
                data-status={githubReady ? "connected" : "not-connected"}
              >
                {githubReady ? "Ready to sync" : "Setup needed"}
              </span>
            </div>
            <div className="status-row">
              <span>Remote MCP</span>
              <span
                className="status-indicator"
                data-status={mcpReady ? "connected" : "not-connected"}
              >
                {mcpReady ? "Configured" : "Setup needed"}
              </span>
            </div>
          </div>
          <div className="inline-actions" style={{ marginTop: 18 }}>
            <Link className="text-link" href="/settings">
              Review connections →
            </Link>
          </div>
        </Card>
      </div>
    </main>
  );
}
