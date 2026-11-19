"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import {
  addGitHubRepositorySource,
  removeGitHubRepositorySource,
  syncGitHubMarkdown,
} from "@/lib/github/github";
import { removeGitHubAccountConnection } from "@/lib/github/connections";

async function requireActionIdentity(action: string) {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, action))) redirect("/access-denied");
  return identity;
}

export async function addGitHubRepositoryAction(formData: FormData): Promise<void> {
  const identity = await requireActionIdentity("source:manage");
  try {
    await addGitHubRepositorySource({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      organizationAccountId: String(formData.get("organizationAccountId") ?? ""),
      owner: String(formData.get("owner") ?? ""),
      repository: String(formData.get("repository") ?? ""),
    });
  } catch {
    redirect("/settings?githubRepository=error");
  }
  revalidateGitHubPages();
  redirect("/settings?githubRepository=added");
}

export async function removeGitHubAccountAction(formData: FormData): Promise<void> {
  const identity = await requireActionIdentity("source:manage");
  try {
    await removeGitHubAccountConnection({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      organizationAccountId: String(formData.get("organizationAccountId") ?? ""),
    });
  } catch {
    redirect("/settings?githubAccount=error");
  }
  revalidateGitHubPages();
  redirect("/settings?githubAccount=removed");
}

export async function removeGitHubRepositoryAction(formData: FormData): Promise<void> {
  const identity = await requireActionIdentity("source:manage");
  try {
    await removeGitHubRepositorySource({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      sourceId: String(formData.get("sourceId") ?? ""),
    });
  } catch {
    redirect("/settings?githubRepository=error");
  }
  revalidateGitHubPages();
  redirect("/settings?githubRepository=removed");
}

export async function syncGitHubAction(formData: FormData): Promise<void> {
  const identity = await requireActionIdentity("source:sync");
  let itemCount = 0;
  try {
    const result = await syncGitHubMarkdown(
      identity.organization.organizationId,
      String(formData.get("sourceId") ?? ""),
      identity.subjectId,
    );
    itemCount = result.itemCount;
  } catch {
    redirect("/settings?github=error");
  }
  revalidateGitHubPages();
  redirect(`/settings?github=synced&count=${itemCount}`);
}

function revalidateGitHubPages(): void {
  revalidatePath("/settings");
  revalidatePath("/overview");
  revalidatePath("/knowledge");
}
