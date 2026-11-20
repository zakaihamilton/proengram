import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, PageHeader } from "panel-frame-ui";
import { MarkdownContent } from "@/components/markdown-content";
import {
  editKnowledgeItemAction,
  suggestKnowledgeEditAction,
} from "@/app/(dashboard)/knowledge/actions";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import { formatDate } from "@/lib/date";
import { getBrainItem, getBrainItemHistory, getBrainItemVersion } from "@/lib/db/brain";
import { formatKnowledgeCitations } from "@/lib/knowledge/validation";

const labels = {
  github_markdown: "GitHub Markdown",
  google_drive_document: "Google Drive",
  saved_answer: "Saved answer",
  sentry8_policy: "Sentry8 policy",
  decision_record: "Decision",
  project_update: "Project update",
};

export default async function KnowledgeItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    version?: string | string[];
    error?: string | string[];
    saved?: string;
    suggested?: string;
  }>;
}) {
  const identity = await requireDashboardIdentity("brain:read");
  const { id } = await params;
  const query = await searchParams;
  const versionId = Array.isArray(query.version) ? query.version[0] : query.version;
  const [canReadPolicies, canContribute] = await Promise.all([
    authorizeAppAction(identity, "policy:read").catch(() => false),
    authorizeAppAction(identity, "result:save").catch(() => false),
  ]);
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
  const [viewedVersion, history] = await Promise.all([
    versionId
      ? getBrainItemVersion(identity.organization.organizationId, id, versionId).catch(() => null)
      : Promise.resolve(null),
    getBrainItemHistory(identity.organization.organizationId, item.id, 20).catch(() => []),
  ]);
  if (versionId && !viewedVersion) notFound();
  const displayed = viewedVersion ?? item;
  const appAuthored =
    !item.sourceId && ["saved_answer", "decision_record", "project_update"].includes(item.kind);
  const isCreator = item.ownerSubjectId === identity.subjectId;
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="KNOWLEDGE ITEM"
        title={displayed.title}
        description={
          <span>
            {labels[item.kind]} ·{" "}
            {viewedVersion
              ? `Revision from ${formatDate(viewedVersion.sourceModifiedAt ?? viewedVersion.observedAt)}`
              : `Updated ${formatDate(item.updatedAt)}`}
          </span>
        }
        actions={
          <Link className="pf-button pf-button-secondary" href="/knowledge">
            Back to library
          </Link>
        }
      />
      {query.error === "edit-invalid" ? (
        <Alert tone="error">Check the title, content, project, date, and citation fields.</Alert>
      ) : null}
      {query.error === "edit-failed" ? (
        <Alert tone="error">
          The knowledge item could not be updated. Check its current status and permissions.
        </Alert>
      ) : null}
      {query.saved ? (
        <Alert tone="success">Your changes were saved with revision history.</Alert>
      ) : null}
      {query.suggested ? (
        <Alert tone="success">Your edit suggestion was added to the review queue.</Alert>
      ) : null}
      {viewedVersion ? (
        <Alert tone="info">
          You are viewing a historical revision.{" "}
          <Link className="text-link" href={`/knowledge/${id}`}>
            Return to the current version
          </Link>
          .
        </Alert>
      ) : null}
      <div className="result-layout">
        <Card className="content-card">
          <Badge tone={item.kind === "sentry8_policy" ? "accent" : "neutral"}>
            {labels[item.kind]}
          </Badge>
          <article className="result-body" style={{ marginTop: 20 }}>
            <MarkdownContent markdown={displayed.markdown} />
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
          {displayed.sourceRevision ? (
            <p className="metric-note">
              Revision: <code>{displayed.sourceRevision}</code>
            </p>
          ) : null}
          {displayed.sourceModifiedAt ? (
            <p className="metric-note">Source modified {formatDate(displayed.sourceModifiedAt)}</p>
          ) : null}
          {displayed.projectName ? (
            <p className="metric-note">Project: {displayed.projectName}</p>
          ) : null}
          {displayed.occurredAt ? (
            <p className="metric-note">Record date: {formatDate(displayed.occurredAt)}</p>
          ) : null}
          {displayed.citations.map((citation) => (
            <p key={citation.url}>
              <a className="source-link" href={citation.url} rel="noreferrer" target="_blank">
                {citation.title} ↗
              </a>
            </p>
          ))}
          {!item.sourceUrl && displayed.citations.length === 0 ? (
            <p className="metric-note">No external source is attached to this item.</p>
          ) : null}
          <div className="card-heading history-heading">
            <div>
              <h2>Revision history</h2>
              <p>Every approved app-authored edit and imported source revision is retained.</p>
            </div>
          </div>
          {history.length ? (
            <ol className="revision-list">
              {history.map((version) => (
                <li key={version.id}>
                  <div className="revision-entry">
                    <Link
                      className="revision-link"
                      href={`/knowledge/${item.id}?version=${version.id}`}
                    >
                      {version.title} · {formatDate(version.sourceModifiedAt ?? version.observedAt)}
                    </Link>
                    {version.sourceRevision ? (
                      <span className="metric-note">
                        Revision {version.sourceRevision.slice(0, 12)}
                      </span>
                    ) : null}
                    <details>
                      <summary>Preview this revision</summary>
                      <article className="result-body">
                        <MarkdownContent markdown={version.markdown} />
                      </article>
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="metric-note">No revision snapshots are available.</p>
          )}
        </Card>
      </div>
      {appAuthored && canContribute && !viewedVersion ? (
        <Card className="content-card knowledge-edit-card">
          <div className="card-heading">
            <div>
              <h2>{isCreator ? "Edit this knowledge" : "Suggest an edit"}</h2>
              <p>
                {isCreator
                  ? "Your changes publish immediately and keep the previous revision."
                  : "An organization member can approve your proposed revision."}
              </p>
            </div>
          </div>
          <form
            action={isCreator ? editKnowledgeItemAction : suggestKnowledgeEditAction}
            className="save-form"
          >
            <input name="itemId" type="hidden" value={item.id} />
            <input name="itemKind" type="hidden" value={item.kind} />
            <label className="pf-field">
              <span className="pf-field-label">Title</span>
              <input
                className="pf-input"
                defaultValue={item.title}
                maxLength={240}
                name="title"
                required
              />
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Content</span>
              <textarea
                className="pf-input save-textarea"
                defaultValue={item.markdown}
                maxLength={30_000}
                name="markdown"
                required
                rows={10}
              />
            </label>
            {item.kind !== "saved_answer" ? (
              <label className="pf-field">
                <span className="pf-field-label">Project</span>
                <input
                  className="pf-input"
                  defaultValue={item.projectName ?? ""}
                  maxLength={160}
                  name="projectName"
                />
              </label>
            ) : null}
            <label className="pf-field">
              <span className="pf-field-label">Record date</span>
              <input
                className="pf-input"
                defaultValue={
                  item.occurredAt ? new Date(item.occurredAt).toISOString().slice(0, 10) : ""
                }
                name="occurredAt"
                type="date"
              />
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Citations</span>
              <textarea
                className="pf-input save-citations"
                defaultValue={formatKnowledgeCitations(item.citations)}
                name="citations"
                rows={3}
              />
              <span className="pf-field-hint">One source per line, formatted as Title | URL.</span>
            </label>
            <div className="inline-actions">
              <button className="pf-button pf-button-primary" type="submit">
                {isCreator ? "Save revision" : "Submit edit suggestion"}
              </button>
            </div>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
