import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOrganizationId, getPerministerClient } from "./config";

export const SESSION_COOKIE = "proengram_session";

type PerministerOrganization = {
  organizationId: string;
  name: string;
  role: string | null;
};

export type ProEngramIdentity = {
  subjectId: string;
  email: string | null;
  name: string;
  organization: PerministerOrganization;
  accessToken: string;
  clientKind: "dashboard" | "mcp";
};

function readOrganization(value: unknown): PerministerOrganization | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.organizationId === "string" ? row.organizationId : null;
  if (!id) return null;
  const name =
    (typeof row.organizationName === "string" && row.organizationName) ||
    (typeof row.name === "string" && row.name) ||
    "Company workspace";
  return {
    organizationId: id.toLowerCase(),
    name,
    role: typeof row.role === "string" ? row.role : null,
  };
}

async function getPerministerIdentity(
  accessToken: string,
  clientKind: "dashboard" | "mcp",
): Promise<ProEngramIdentity | null> {
  const client = getPerministerClient(clientKind);
  const organizationId = getOrganizationId();
  const endpoint = new URL("/api/auth/consumer/session", client.baseUrl);
  endpoint.searchParams.set("organization_id", organizationId);
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
        .map(readOrganization)
        .filter((org): org is PerministerOrganization => org !== null)
    : [];
  const organization = organizations.find((item) => item.organizationId === organizationId);
  if (!organization || typeof account.subjectId !== "string") return null;
  const firstName = typeof account.firstName === "string" ? account.firstName : "";
  const lastName = typeof account.lastName === "string" ? account.lastName : "";
  const email = typeof account.email === "string" ? account.email : null;
  return {
    subjectId: account.subjectId,
    email,
    name: `${firstName} ${lastName}`.trim() || email || "Company member",
    organization,
    accessToken,
    clientKind,
  };
}

export async function getDashboardIdentity(): Promise<ProEngramIdentity | null> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIE)?.value;
  if (!accessToken) return null;
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
