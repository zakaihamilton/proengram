import Link from "next/link";
import { Alert, Badge, Card, EmptyState, PageHeader } from "panel-frame-ui";
import { requireDashboardIdentity } from "@/lib/auth/session";
import { formatDate } from "@/lib/date";
import { listKnowledgeFeedback } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { resolveFeedbackAction } from "./actions";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ resolve?: string | string[] }>;
}) {
  const identity = await requireDashboardIdentity("source:manage");
  const params = await searchParams;
  const resolution = Array.isArray(params.resolve) ? params.resolve[0] : params.resolve;
  const feedback = isDatabaseConfigured()
    ? await listKnowledgeFeedback(identity.organization.organizationId).catch(() => [])
    : [];

  return (
    <main className="page-content">
      <PageHeader
        eyebrow="QUALITY REVIEW"
        title="Knowledge feedback"
        description="Review member reports about missing, outdated, or incorrect company knowledge."
      />
      {resolution === "done" ? <Alert tone="success">Feedback marked as resolved.</Alert> : null}
      {resolution === "error" ? <Alert tone="error">Feedback could not be resolved.</Alert> : null}
      {feedback.length ? (
        <div className="feedback-list">
          {feedback.map((entry) => (
            <Card className="content-card feedback-card" key={entry.id}>
              <div className="card-heading">
                <div>
                  <Badge tone={entry.status === "pending" ? "warning" : "success"}>
                    {entry.status === "pending" ? "Needs review" : "Resolved"}
                  </Badge>
                  <h2>
                    <Link className="text-link" href={`/knowledge/${entry.itemId}`}>
                      {entry.itemTitle}
                    </Link>
                  </h2>
                  <p>
                    {entry.rating.replaceAll("_", " ")} · Reported {formatDate(entry.createdAt)}
                  </p>
                </div>
                {entry.status === "pending" ? (
                  <form action={resolveFeedbackAction}>
                    <input name="feedbackId" type="hidden" value={entry.id} />
                    <button className="pf-button pf-button-secondary" type="submit">
                      Mark resolved
                    </button>
                  </form>
                ) : null}
              </div>
              {entry.note ? (
                <p className="feedback-note">{entry.note}</p>
              ) : (
                <p className="metric-note">No additional note.</p>
              )}
              <p className="metric-note">Submitted by {entry.actorSubjectId}</p>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No knowledge feedback yet"
          description="Reports submitted through the ProEngram MCP will appear here for review."
        />
      )}
    </main>
  );
}
