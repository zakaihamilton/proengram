import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader } from "panel-frame-ui";
import { MarkdownContent } from "@/components/markdown-content";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import { formatDate } from "@/lib/date";
import { getBrainItem, getBrainItemHistory } from "@/lib/db/brain";

const labels = {
  github_markdown: "GitHub Markdown",
  google_drive_document: "Google Drive",
  saved_answer: "Saved answer",
  sentry8_policy: "Sentry8 policy",
  decision_record: "Decision",
  project_update: "Project update",
};

export default async function KnowledgeItemPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireDashboardIdentity("brain:read");
  const { id } = await params;
  const canReadPolicies = await authorizeAppAction(identity, "policy:read").catch(() => false);
  let item = null;
  try {
    item = await getBrainItem(
      identity.organization.organizationId,
      id,
      canReadPolicies ? undefined : "sentry8_policy",
    );
  } catch {
    notFound();
  }
  if (!item) notFound();
  const history = await getBrainItemHistory(
    identity.organization.organizationId,
    item.id,
    20,
  ).catch(() => []);
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="KNOWLEDGE ITEM"
        title={item.title}
        description={
          <span>
            {labels[item.kind]} · Updated {formatDate(item.updatedAt)}
          </span>
        }
        actions={
          <Link className="pf-button pf-button-secondary" href="/knowledge">
            Back to library
          </Link>
        }
      />
      <div className="result-layout">
        <Card className="content-card">
          <Badge tone={item.kind === "sentry8_policy" ? "accent" : "neutral"}>
            {labels[item.kind]}
          </Badge>
          <article className="result-body" style={{ marginTop: 20 }}>
            <MarkdownContent markdown={item.markdown} />
          </article>
        </Card>
        <Card className="content-card">
          <div className="card-heading">
            <div>
              <h2>Sources</h2>
              <p>Trace this item back to its source.</p>
            </div>
          </div>
          {item.sourceUrl ? (
            <p>
              <a className="source-link" href={item.sourceUrl} rel="noreferrer" target="_blank">
                Open canonical source ↗
              </a>
            </p>
          ) : null}
          {item.sourceRevision ? (
            <p className="metric-note">
              Revision: <code>{item.sourceRevision}</code>
            </p>
          ) : null}
          {item.sourceModifiedAt ? (
            <p className="metric-note">Source modified {formatDate(item.sourceModifiedAt)}</p>
          ) : null}
          {item.projectName ? <p className="metric-note">Project: {item.projectName}</p> : null}
          {item.occurredAt ? (
            <p className="metric-note">Record date: {formatDate(item.occurredAt)}</p>
          ) : null}
          {item.citations.map((citation) => (
            <p key={citation.url}>
              <a className="source-link" href={citation.url} rel="noreferrer" target="_blank">
                {citation.title} ↗
              </a>
            </p>
          ))}
          {!item.sourceUrl && item.citations.length === 0 ? (
            <p className="metric-note">No external source is attached to this item.</p>
          ) : null}
          <div className="card-heading history-heading">
            <div>
              <h2>Revision history</h2>
              <p>Available from ProEngram’s first sync onward.</p>
            </div>
          </div>
          {history.length ? (
            <ol className="revision-list">
              {history.map((version) => (
                <li key={version.id}>
                  <details>
                    <summary>
                      {formatDate(version.sourceModifiedAt ?? version.observedAt)}
                      {version.sourceRevision ? ` · ${version.sourceRevision.slice(0, 12)}` : ""}
                    </summary>
                    <article className="result-body">
                      <MarkdownContent markdown={version.markdown} />
                    </article>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="metric-note">No revision snapshots are available.</p>
          )}
        </Card>
      </div>
    </main>
  );
}
