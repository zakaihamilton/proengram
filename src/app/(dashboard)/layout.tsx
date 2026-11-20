import { AppShell } from "@/components/app-shell";
import { authorizeAppAction, requireDashboardIdentity } from "@/lib/auth/session";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const identity = await requireDashboardIdentity("brain:read");
  const canReviewFeedback = await authorizeAppAction(identity, "source:manage").catch(() => false);
  const canReviewKnowledge = await authorizeAppAction(identity, "knowledge:approve").catch(
    () => false,
  );
  return (
    <AppShell
      email={identity.email}
      canReviewFeedback={canReviewFeedback}
      canReviewKnowledge={canReviewKnowledge}
      organizationId={identity.organization.organizationId}
      organizations={identity.organizations.map(({ organizationId, name }) => ({
        organizationId,
        name,
      }))}
      userName={identity.name}
    >
      {children}
    </AppShell>
  );
}
