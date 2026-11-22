import Link from "next/link";
import { Alert, Badge, Card, EmptyState, PageHeader } from "panel-frame-ui";
import { reviewKnowledgeSuggestionAction } from "@/app/(dashboard)/knowledge/actions";
import { MarkdownContent } from "@/components/markdown-content";
import { requireDashboardIdentity } from "@/lib/auth/session";
import { formatDate } from "@/lib/date";
import { listPendingKnowledgeSuggestions } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";

const kindLabels = {
  saved_answer: "Saved answer",
  decision_record: "Decision",
  project_update: "Project update",
};

export default async function KnowledgeReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string | string[] }>;
}) {
  const identity = await requireDashboardIdentity("knowledge:approve");
  const params = await searchParams;
  const result = Array.isArray(params.result) ? params.result[0] : params.result;
  let suggestions = [] as Awaited<ReturnType<typeof listPendingKnowledgeSuggestions>>;
  let error = false;
  if (isDatabaseConfigured()) {
    try {
      suggestions = await listPendingKnowledgeSuggestions(identity.organization.organizationId);
    } catch {
      error = true;
    }
  }

  return (
    <main className="page-content">
      <PageHeader
        eyebrow="KNOWLEDGE WORKFLOW"
        title="Review suggestions"
        description="Employees confirm each candidate before submission. Approving publishes it to the shared library; rejecting keeps it out of search. You may review your own submission."
        actions={
          <Link className="pf-button pf-button-secondary" href="/knowledge">
            Back to knowledge
          </Link>
        }
      />
      {result === "approve" ? (
        <Alert tone="success">Suggestion approved and published.</Alert>
      ) : null}
      {result === "reject" ? <Alert tone="info">Suggestion rejected.</Alert> : null}
      {result === "failed" ? (
        <Alert tone="error">
          The suggestion could not be reviewed. It may already be resolved.
        </Alert>
      ) : null}
      {result === "invalid" ? <Alert tone="error">The review form was invalid.</Alert> : null}
      {error ? (
        <Alert tone="warning">
          Suggestions could not be loaded. Check the Nanogres connection and migration.
        </Alert>
      ) : null}
      {!isDatabaseConfigured() ? (
        <EmptyState
          title="Connect the shared database"
          description="The review queue uses ProEngram’s Nanogres PostgreSQL database."
        />
      ) : suggestions.length ? (
        <div className="suggestion-list">
          {suggestions.map((suggestion) => (
            <Card className="suggestion-card" key={suggestion.id}>
              <div className="card-heading">
                <div>
                  <h2>{suggestion.title}</h2>
                  <p>
                    {suggestion.suggestionType === "edit" ? "Suggested edit" : "New knowledge"} ·{" "}
                    {kindLabels[suggestion.itemKind]}
                  </p>
                </div>
                <Badge tone="accent">Pending</Badge>
              </div>
              {suggestion.targetItemId ? (
                <p className="metric-note">
                  Edit to{" "}
                  <Link className="text-link" href={`/knowledge/${suggestion.targetItemId}`}>
                    {suggestion.targetItemTitle || "an existing item"}
                  </Link>
                </p>
              ) : null}
              <div className="suggestion-meta">
                <span>Submitted by {suggestion.proposerSubjectId}</span>
                <span>Employee-confirmed {formatDate(suggestion.confirmedAt)}</span>
                {suggestion.projectName ? <span>Project: {suggestion.projectName}</span> : null}
                {suggestion.occurredAt ? (
                  <span>Record date: {formatDate(suggestion.occurredAt)}</span>
                ) : null}
              </div>
              <article className="result-body suggestion-body">
                <MarkdownContent markdown={suggestion.markdown} />
              </article>
              {suggestion.citations.length ? (
                <div className="suggestion-citations">
                  <h3>Sources</h3>
                  <ul>
                    {suggestion.citations.map((citation) => (
                      <li key={citation.url}>
                        <a
                          className="source-link"
                          href={citation.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {citation.title} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <form action={reviewKnowledgeSuggestionAction} className="review-form">
                <input name="suggestionId" type="hidden" value={suggestion.id} />
                <label className="pf-field">
                  <span className="pf-field-label">Review note (optional)</span>
                  <textarea
                    className="pf-input"
                    maxLength={500}
                    name="note"
                    placeholder="Add context for the review decision"
                    rows={2}
                  />
                </label>
                <div className="inline-actions">
                  <button
                    className="pf-button pf-button-primary"
                    name="decision"
                    value="approve"
                    type="submit"
                  >
                    Approve and publish
                  </button>
                  <button
                    className="pf-button pf-button-secondary"
                    name="decision"
                    value="reject"
                    type="submit"
                  >
                    Reject
                  </button>
                </div>
              </form>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          title="Nothing to review"
          description="Confirmed captures and proposed edits will appear here until an organization member reviews them."
          action={
            <Link className="text-link" href="/knowledge">
              Search knowledge
            </Link>
          }
        />
      )}
    </main>
  );
}
