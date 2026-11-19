import { AppShell } from "@/components/app-shell";
import { requireDashboardIdentity } from "@/lib/auth/session";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const identity = await requireDashboardIdentity("brain:read");
  return (
    <AppShell
      email={identity.email}
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
