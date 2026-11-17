import { Alert, EmptyState, PageHeader } from "panel-frame-ui";
import { requireDashboardIdentity } from "@/lib/auth/session";
import { listActivity } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { formatDate } from "@/lib/date";

export default async function ActivityPage() {
  const identity = await requireDashboardIdentity("brain:read");
  let activity: Awaited<ReturnType<typeof listActivity>> = [];
  let error = false;
  if (isDatabaseConfigured()) {
    try {
      activity = await listActivity(identity.organization.organizationId, 50);
    } catch {
      error = true;
    }
  }
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="AUDIT TRAIL"
        title="Activity"
        description="A record of shared saves, source syncs, and knowledge proposals. Search queries and answer contents are not logged."
      />
      {error ? (
        <Alert tone="warning">
          Activity is unavailable. Check the Nanogres connection and migration.
        </Alert>
      ) : null}
      {!isDatabaseConfigured() ? (
        <EmptyState
          title="Connect Nanogres to view activity"
          description="ProEngram stores its shared activity log in the Nanogres-managed database."
        />
      ) : activity.length ? (
        <div className="table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Action</th>
                <th>Member</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((event) => (
                <tr key={event.id}>
                  <td>{event.summary}</td>
                  <td>{event.action}</td>
                  <td>
                    <code>{event.actor_subject_id.slice(0, 8)}</code>
                  </td>
                  <td>{formatDate(event.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No activity recorded yet"
          description="Shared saves and source syncs will appear here."
        />
      )}
    </main>
  );
}
