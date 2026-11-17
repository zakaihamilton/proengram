import { Alert, Badge, Card, EmptyState, PageHeader } from "panel-frame-ui";
import { BrainItemCard } from "@/components/brain-item-card";
import { requireDashboardIdentity } from "@/lib/auth/session";
import { listItemsByKind } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { importSentry8CatalogAction } from "./actions";

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ imported?: string | string[]; import?: string | string[] }>;
}) {
  const identity = await requireDashboardIdentity("policy:read");
  const params = await searchParams;
  const imported = Array.isArray(params.imported) ? params.imported[0] : params.imported;
  const error = Array.isArray(params.import) ? params.import[0] : params.import;
  let policies = [] as Awaited<ReturnType<typeof listItemsByKind>>;
  let readError = false;
  if (isDatabaseConfigured()) {
    try {
      policies = await listItemsByKind(identity.organization.organizationId, "sentry8_policy", 100);
    } catch {
      readError = true;
    }
  }
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="POLICY LIBRARY"
        title="Sentry8 policies"
        description="Read imported, versioned policy context alongside the company knowledge base."
      />
      {imported ? (
        <Alert tone="success">Imported {imported} policy rules from the Sentry8 catalog.</Alert>
      ) : null}
      {error === "invalid" ? (
        <Alert tone="error">
          The catalog JSON is invalid. Use the Sentry8 custom policy catalog response with a
          policyRevision and rules list.
        </Alert>
      ) : null}
      {error === "storage" || readError ? (
        <Alert tone="warning">
          Policy snapshots could not be saved or loaded. Check the Nanogres database and migration.
        </Alert>
      ) : null}
      <Alert tone="info">
        <strong>Policy access is read-only here.</strong> ProEngram does not enforce Sentry8 rules
        on direct MCP calls yet. Runtime enforcement requires the identity-preserving Sentry8
        Gateway route.
      </Alert>
      {!isDatabaseConfigured() ? (
        <EmptyState
          title="Connect the shared database"
          description="Policy snapshots are stored in the ProEngram database provisioned in Nanogres."
        />
      ) : policies.length ? (
        <div className="item-list policy-list">
          {policies.map((item) => (
            <BrainItemCard item={item} key={item.id} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No Sentry8 policy snapshot is available"
          description="Import a catalog response from your approved Sentry8 policy adapter. Sentry8’s Custom Policy API callback is not a general policy export endpoint."
        />
      )}
      <Card className="content-card policy-import-card">
        <div className="card-heading">
          <div>
            <h2>Import a policy catalog</h2>
            <p>
              Paste a reviewed snapshot JSON. Import replaces the active ProEngram snapshot and
              preserves its revision.
            </p>
          </div>
          <Badge tone="warning">Admin permission required</Badge>
        </div>
        <form action={importSentry8CatalogAction} className="save-form">
          <label className="pf-field">
            <span className="pf-field-label">Sentry8 catalog JSON</span>
            <textarea
              className="pf-input save-textarea policy-json"
              maxLength={250_000}
              name="catalog"
              placeholder={
                '{ "policyRevision": "2026.11", "rules": [{ "ruleId": "...", "label": "...", "description": "..." }] }'
              }
              required
              rows={8}
            />
            <span className="pf-field-hint">
              Expected rule fields: ruleId, label, optional description and category.
            </span>
          </label>
          <button className="pf-button pf-button-secondary" type="submit">
            Import reviewed snapshot
          </button>
        </form>
      </Card>
    </main>
  );
}
