import Link from "next/link";
import { Alert, EmptyState, PageHeader } from "panel-frame-ui";
import { BrainItemList } from "@/components/brain-item-list";
import { requireDashboardIdentity } from "@/lib/auth/session";
import { listItemsByKind } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";

export default async function SavedAnswersPage() {
  const identity = await requireDashboardIdentity("brain:read");
  let items = [] as Awaited<ReturnType<typeof listItemsByKind>>;
  let error = false;
  if (isDatabaseConfigured()) {
    try {
      items = await listItemsByKind(identity.organization.organizationId, "saved_answer", 50);
    } catch {
      error = true;
    }
  }
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="COMPANY SHARED"
        title="Saved answers"
        description="Selected answers saved for colleagues to find later."
        actions={
          <Link className="pf-button pf-button-primary" href="/saved/new">
            Save an answer
          </Link>
        }
      />
      {error ? (
        <Alert tone="warning">
          Saved answers are unavailable. Check the Nanogres connection and migration.
        </Alert>
      ) : null}
      {!isDatabaseConfigured() ? (
        <EmptyState
          title="Connect the shared database"
          description="Saved answers use the ProEngram database provisioned in Nanogres."
          action={
            <Link className="text-link" href="/settings">
              Open settings
            </Link>
          }
        />
      ) : items.length ? (
        <BrainItemList items={items} />
      ) : (
        <EmptyState
          title="No answers saved yet"
          description="Use Save an answer here, or call the save_result tool from a connected assistant."
          action={
            <Link className="text-link" href="/saved/new">
              Save the first answer
            </Link>
          }
        />
      )}
    </main>
  );
}
