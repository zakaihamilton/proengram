import Link from "next/link";
import { Alert, Button, Card, PageHeader, TextField } from "panel-frame-ui";
import { saveAnswerAction } from "@/app/(dashboard)/saved/actions";
import { requireDashboardIdentity } from "@/lib/auth/session";

export default async function NewSavedAnswerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await requireDashboardIdentity("brain:read");
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="SHARED ANSWER"
        title="Save an answer"
        description="Choose the answer that should become shared company knowledge. ProEngram does not capture full chat transcripts."
        actions={
          <Link className="pf-button pf-button-secondary" href="/saved">
            Cancel
          </Link>
        }
      />
      {error === "invalid" ? (
        <Alert tone="error">
          Add a title and answer, and check each citation uses “Title | URL”.
        </Alert>
      ) : null}
      {error === "storage" ? (
        <Alert tone="error">
          The answer could not be saved. Check the Nanogres database connection and migration.
        </Alert>
      ) : null}
      <Card className="content-card" style={{ maxWidth: 860, marginTop: 20 }}>
        <form action={saveAnswerAction} className="save-form">
          <TextField
            label="Title"
            name="title"
            maxLength={240}
            placeholder="A concise name for this answer"
            required
          />
          <label className="pf-field">
            <span className="pf-field-label">Answer</span>
            <textarea
              className="pf-input save-textarea"
              maxLength={30_000}
              name="markdown"
              placeholder="Paste the answer you want the company to keep…"
              required
              rows={12}
            />
            <span className="pf-field-hint">Markdown is stored in the shared company library.</span>
          </label>
          <label className="pf-field">
            <span className="pf-field-label">Citations</span>
            <textarea
              className="pf-input save-citations"
              name="citations"
              placeholder="Nanogres connection guide | https://example.com/docs"
              rows={3}
            />
            <span className="pf-field-hint">One source per line, formatted as Title | URL.</span>
          </label>
          <div className="inline-actions">
            <Button type="submit" variant="primary">
              Save to company brain
            </Button>
            <span className="metric-note">Visible to members with ProEngram read access.</span>
          </div>
        </form>
      </Card>
    </main>
  );
}
