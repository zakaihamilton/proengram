"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { syncGitHubMarkdown } from "@/lib/github/github";

export async function syncGitHubAction(): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "source:sync"))) redirect("/access-denied");
  let itemCount = 0;
  try {
    const result = await syncGitHubMarkdown(
      identity.organization.organizationId,
      identity.subjectId,
    );
    itemCount = result.itemCount;
  } catch {
    redirect("/settings?github=error");
  }
  revalidatePath("/overview");
  revalidatePath("/knowledge");
  redirect(`/settings?github=synced&count=${itemCount}`);
}
