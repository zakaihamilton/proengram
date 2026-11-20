import Link from "next/link";
import { Alert, EmptyState, PageHeader } from "panel-frame-ui";
import { BrainItemList } from "@/components/brain-item-list";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";
import {
  listKnowledgeSearchSources,
  searchBrainItems,
  type BrainItemKind,
  type BrainSearchFilters,
} from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { createKnowledgeSearchEmbedding } from "@/lib/knowledge/search-embedding";

const kinds: Array<{ value: BrainItemKind; label: string }> = [
  { value: "github_markdown", label: "GitHub Markdown" },
  { value: "google_drive_document", label: "Google Drive" },
  { value: "saved_answer", label: "Saved answer" },
  { value: "decision_record", label: "Decision" },
  { value: "project_update", label: "Project update" },
  { value: "sentry8_policy", label: "Sentry8 policy" },
];

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function validDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function parseFilters(params: Record<string, string | string[] | undefined>): BrainSearchFilters {
  const kind = first(params.kind);
  const sourceId = first(params.sourceId);
  const projectName = first(params.projectName);
  const ownerSubjectId = first(params.ownerSubjectId);
  const dateFrom = validDate(first(params.dateFrom));
  const dateTo = validDate(first(params.dateTo));
  const syncStatus = first(params.syncStatus);
  const sortBy = first(params.sortBy);
  const includeHistory = first(params.includeHistory) === "1";
  return {
    kind: kinds.some((entry) => entry.value === kind) ? (kind as BrainItemKind) : undefined,
    sourceId: /^[0-9a-f-]{36}$/i.test(sourceId) ? sourceId : undefined,
    projectName: projectName.slice(0, 160) || undefined,
    ownerSubjectId: ownerSubjectId.slice(0, 200) || undefined,
    dateFrom,
    dateTo,
    includeHistory,
    syncStatus: ["running", "succeeded", "failed"].includes(syncStatus)
      ? (syncStatus as BrainSearchFilters["syncStatus"])
      : undefined,
    sortBy: ["relevance", "newest", "oldest"].includes(sortBy)
      ? (sortBy as BrainSearchFilters["sortBy"])
      : undefined,
  };
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireDashboardIdentity("brain:read");
  const params = await searchParams;
  const query = first(params.q).slice(0, 500);
  const filters = parseFilters(params);
  const canReadPolicies = await authorizeAppAction(identity, "policy:read").catch(() => false);
  let items = [] as Awaited<ReturnType<typeof searchBrainItems>>;
  let sources: Array<{ id: string; label: string }> = [];
  let error = false;
  if (isDatabaseConfigured()) {
    try {
      const searchEmbedding = query ? await createKnowledgeSearchEmbedding(query) : {};
      [items, sources] = await Promise.all([
        searchBrainItems(
          identity.organization.organizationId,
          query,
          30,
          canReadPolicies ? undefined : "sentry8_policy",
          { ...filters, ...searchEmbedding },
        ),
        listKnowledgeSearchSources(identity.organization.organizationId),
      ]);
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
        <form action="/knowledge" className="knowledge-search-form">
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
          <div className="search-filters">
            <label className="pf-field">
              <span className="pf-field-label">Type</span>
              <select className="pf-input" defaultValue={filters.kind ?? ""} name="kind">
                <option value="">All types</option>
                {kinds
                  .filter((kind) => canReadPolicies || kind.value !== "sentry8_policy")
                  .map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Source</span>
              <select className="pf-input" defaultValue={filters.sourceId ?? ""} name="sourceId">
                <option value="">All sources</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Project</span>
              <input
                className="pf-input"
                defaultValue={filters.projectName}
                maxLength={160}
                name="projectName"
              />
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Owner subject ID</span>
              <input
                className="pf-input"
                defaultValue={filters.ownerSubjectId}
                maxLength={200}
                name="ownerSubjectId"
              />
            </label>
            <label className="pf-field">
              <span className="pf-field-label">From</span>
              <input
                className="pf-input"
                defaultValue={filters.dateFrom}
                name="dateFrom"
                type="date"
              />
            </label>
            <label className="pf-field">
              <span className="pf-field-label">To</span>
              <input className="pf-input" defaultValue={filters.dateTo} name="dateTo" type="date" />
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Latest source sync</span>
              <select
                className="pf-input"
                defaultValue={filters.syncStatus ?? ""}
                name="syncStatus"
              >
                <option value="">Any status</option>
                <option value="running">Running</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <label className="pf-field">
              <span className="pf-field-label">Sort</span>
              <select
                className="pf-input"
                defaultValue={filters.sortBy ?? "relevance"}
                name="sortBy"
              >
                <option value="relevance">Relevance</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </label>
            <label className="search-history-toggle">
              <input
                defaultChecked={filters.includeHistory}
                name="includeHistory"
                type="checkbox"
                value="1"
              />
              Include historical revisions
            </label>
            <div className="search-filter-actions">
              <button type="submit">Apply filters</button>
              <Link className="text-link" href="/knowledge">
                Clear
              </Link>
            </div>
          </div>
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
          title={
            query || Object.values(filters).some(Boolean)
              ? "No matching knowledge"
              : "No shared items yet"
          }
          description={
            query || Object.values(filters).some(Boolean)
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
