import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPerministerClient } from "./config";

export const SESSION_COOKIE = "proengram_session";
export const ORGANIZATION_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-proengram-organization"
    : "proengram-organization";

type PerministerOrganization = {
  organizationId: string;
  name: string;
  role: string | null;
  productId: string;
  canReadBrain: boolean;
};

export type ProEngramIdentity = {
  subjectId: string;
  email: string | null;
  name: string;
  organization: PerministerOrganization;
  organizations: PerministerOrganization[];
  accessToken: string;
  clientKind: "dashboard" | "mcp";
};

function readOrganization(value: unknown, productId: string): PerministerOrganization | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.organizationId === "string" ? row.organizationId.trim() : "";
  if (!id || typeof row.productId !== "string" || row.productId.toLowerCase() !== productId) {
    return null;
  }
  const name =
    (typeof row.organizationName === "string" && row.organizationName) ||
    (typeof row.name === "string" && row.name) ||
    "Company workspace";
  const canReadBrain =
    row.platformAdmin === true ||
    (Array.isArray(row.resourceRoles) &&
      row.resourceRoles.some((value) => {
        if (!value || typeof value !== "object") return false;
        const resourceRole = value as Record<string, unknown>;
        const scope = resourceRole.scope;
        if (!scope || typeof scope !== "object") return false;
        const resourceScope = scope as Record<string, unknown>;
        return (
          resourceScope.kind === "product" &&
          typeof resourceScope.organizationId === "string" &&
          resourceScope.organizationId.toLowerCase() === id.toLowerCase() &&
          typeof resourceScope.productId === "string" &&
          resourceScope.productId.toLowerCase() === productId &&
          Array.isArray(resourceRole.actions) &&
          resourceRole.actions.includes("brain:read")
        );
      }));
  if (!canReadBrain) return null;
  return {
    organizationId: id.toLowerCase(),
    name,
    role:
      typeof row.organizationRole === "string"
        ? row.organizationRole
        : typeof row.role === "string"
          ? row.role
          : null,
    productId: row.productId.toLowerCase(),
    canReadBrain,
  };
}

async function getPerministerIdentity(
  accessToken: string,
  clientKind: "dashboard" | "mcp",
): Promise<ProEngramIdentity | null> {
  const client = getPerministerClient(clientKind);
  const endpoint = new URL("/api/auth/consumer/session", client.baseUrl);
  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Perminister-Client-Id": client.clientId,
      "X-Perminister-Client-Secret": client.clientSecret,
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (data?.authenticated !== true || !data.account || typeof data.account !== "object") {
    return null;
  }
  const account = data.account as Record<string, unknown>;
  const organizations = Array.isArray(data.organizations)
    ? data.organizations
        .map((organization) => readOrganization(organization, client.productId.toLowerCase()))
        .filter((org): org is PerministerOrganization => org !== null)
    : [];
  organizations.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.organizationId.localeCompare(right.organizationId),
  );
  if (!organizations.length || typeof account.subjectId !== "string") return null;
  const firstName = typeof account.firstName === "string" ? account.firstName : "";
  const lastName = typeof account.lastName === "string" ? account.lastName : "";
  const email = typeof account.email === "string" ? account.email : null;
  return {
    subjectId: account.subjectId,
    email,
    name: `${firstName} ${lastName}`.trim() || email || "Company member",
    organization: organizations[0],
    organizations,
    accessToken,
    clientKind,
  };
}

export async function getDashboardIdentity(): Promise<ProEngramIdentity | null> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIE)?.value;
  if (!accessToken) return null;
  try {
    const identity = await getPerministerIdentity(accessToken, "dashboard");
    if (!identity) return null;
    const selectedOrganizationId = jar.get(ORGANIZATION_COOKIE)?.value?.toLowerCase();
    const organization = identity.organizations.find(
      (item) => item.organizationId === selectedOrganizationId,
    );
    return organization ? { ...identity, organization } : identity;
  } catch {
    return null;
  }
}

export async function getDashboardIdentityForAccessToken(
  accessToken: string,
): Promise<ProEngramIdentity | null> {
  try {
    return await getPerministerIdentity(accessToken, "dashboard");
  } catch {
    return null;
  }
}

export async function authorizeAppAction(
  identity: ProEngramIdentity,
  action: string,
  resourceUri?: string,
): Promise<boolean> {
  const client = getPerministerClient(identity.clientKind);
  const body: Record<string, string> = {
    organizationId: identity.organization.organizationId,
    productId: client.productId,
    resourceKind: "product",
    action,
  };
  if (resourceUri) body.resource = resourceUri;
  const response = await fetch(new URL("/api/authorize", client.baseUrl), {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${identity.accessToken}`,
      "X-Perminister-Client-Id": client.clientId,
      "X-Perminister-Client-Secret": client.clientSecret,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return false;
  const result = (await response.json().catch(() => null)) as {
    authorized?: boolean;
    subjectId?: string;
  } | null;
  return (
    result?.authorized === true && (!result.subjectId || result.subjectId === identity.subjectId)
  );
}

export async function requireDashboardIdentity(action = "brain:read"): Promise<ProEngramIdentity> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, action))) redirect("/access-denied");
  return identity;
}
