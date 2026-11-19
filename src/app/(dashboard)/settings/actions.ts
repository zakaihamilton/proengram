"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { saveGitHubRepositorySettings, syncGitHubMarkdown } from "@/lib/github/github";

export async function configureGitHubAction(formData: FormData): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "source:sync"))) redirect("/access-denied");

  try {
    await saveGitHubRepositorySettings({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      installationId: String(formData.get("installationId") ?? ""),
      owner: String(formData.get("owner") ?? ""),
      repository: String(formData.get("repository") ?? ""),
      defaultBranch: String(formData.get("defaultBranch") ?? ""),
    });
  } catch {
    redirect("/settings?githubSettings=error");
  }
  revalidatePath("/settings");
  redirect("/settings?githubSettings=saved");
}

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
