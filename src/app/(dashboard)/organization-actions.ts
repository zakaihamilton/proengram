"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isCookieSecure } from "@/lib/auth/config";
import { authorizeAppAction, getDashboardIdentity, ORGANIZATION_COOKIE } from "@/lib/auth/session";

export async function selectOrganizationAction(formData: FormData): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");

  const organizationId = String(formData.get("organizationId") ?? "")
    .trim()
    .toLowerCase();
  const organization = identity.organizations.find(
    (item) => item.organizationId === organizationId,
  );
  if (!organization) redirect("/access-denied");

  const nextIdentity = { ...identity, organization };
  if (!(await authorizeAppAction(nextIdentity, "brain:read"))) redirect("/access-denied");

  (await cookies()).set(ORGANIZATION_COOKIE, organizationId, {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/overview");
}
