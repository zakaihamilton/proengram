import Link from "next/link";
import { Alert, EmptyState, PageHeader } from "panel-frame-ui";
import { BrainItemList } from "@/components/brain-item-list";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import { searchBrainItems } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const identity = await requireDashboardIdentity("brain:read");
  const params = await searchParams;
  const query = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() ?? "";
  const canReadPolicies = await authorizeAppAction(identity, "policy:read").catch(() => false);
  let items = [] as Awaited<ReturnType<typeof searchBrainItems>>;
  let error = false;
  if (isDatabaseConfigured()) {
    try {
      items = await searchBrainItems(
        identity.organization.organizationId,
        query,
        30,
        canReadPolicies ? undefined : "sentry8_policy",
      );
    } catch {
      error = true;
    }
  }

  return (
    <main className="page-content">
      <PageHeader
        eyebrow="LIBRARY"
        title="Knowledge"
        description="Search company documents, decisions, project history, saved answers, and imported policy snapshots."
        actions={
          <Link className="pf-button pf-button-secondary" href="/saved/new">
            Save an answer
          </Link>
        }
      />
      <search>
        <form action="/knowledge" className="search-form">
          <label className="sr-only" htmlFor="knowledge-query">
            Search company knowledge
          </label>
          <input
            autoComplete="off"
            defaultValue={query}
            id="knowledge-query"
            name="q"
            placeholder="Search the company brain…"
            type="search"
          />
          <button type="submit">Search</button>
        </form>
      </search>
      {error ? (
        <Alert tone="warning">
          The library could not be read. Check the Nanogres connection and apply the database
          migration.
        </Alert>
      ) : null}
      {!isDatabaseConfigured() ? (
        <EmptyState
          title="Connect the shared library"
          description="Configure this environment's Nanogres workload identity, then apply the initial migration."
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
          title={query ? "No matching knowledge" : "No shared items yet"}
          description={
            query
              ? "Try another phrase or broaden the search."
              : "Connect a company source or save a useful answer to start the library."
          }
          action={
            !query ? (
              <Link className="text-link" href="/settings">
                Connect a source
              </Link>
            ) : undefined
          }
        />
      )}
    </main>
  );
}
