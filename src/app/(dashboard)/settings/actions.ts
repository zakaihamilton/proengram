"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import {
  addGitHubRepositorySource,
  ensureGitHubRepositoryWebhook,
  removeGitHubRepositorySource,
  syncGitHubMarkdown,
} from "@/lib/github/github";
import { removeGitHubAccountConnection } from "@/lib/github/connections";
import { enqueueGitHubSyncJob } from "@/lib/github/sync-jobs";
import { processGitHubSyncJob } from "@/lib/github/sync-worker";

async function requireActionIdentity(action: string) {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, action))) redirect("/access-denied");
  return identity;
}

export async function addGitHubRepositoryAction(formData: FormData): Promise<void> {
  const identity = await requireActionIdentity("source:manage");
  const [owner, repository, extra] = String(formData.get("repository") ?? "").split("/");
  if (!owner || !repository || extra) redirect("/settings?githubRepository=error");
  let sourceId: string | null = null;
  try {
    const source = await addGitHubRepositorySource({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      organizationAccountId: String(formData.get("organizationAccountId") ?? ""),
      owner,
      repository,
    });
    sourceId = source.id;
  } catch {
    redirect("/settings?githubRepository=error");
  }
  if (sourceId) {
    try {
      await ensureGitHubRepositoryWebhook(
        identity.organization.organizationId,
        sourceId,
        identity.subjectId,
      );
    } catch {
      console.error("GitHub repository webhook setup could not be started.");
    }
    try {
      const job = await enqueueGitHubSyncJob({
        organizationId: identity.organization.organizationId,
        sourceId,
        actorSubjectId: identity.subjectId,
        trigger: "initial",
      });
      after(() => processGitHubSyncJob(job.jobId).catch(() => false));
    } catch {
      console.error("Initial GitHub repository sync could not be queued.");
    }
  }
  revalidateGitHubPages();
  redirect("/settings?githubRepository=added");
}

export async function retryGitHubWebhookAction(formData: FormData): Promise<void> {
  const identity = await requireActionIdentity("source:manage");
  const sourceId = String(formData.get("sourceId") ?? "");
  let active = false;
  try {
    active = await ensureGitHubRepositoryWebhook(
      identity.organization.organizationId,
      sourceId,
      identity.subjectId,
    );
  } catch {
    console.error("GitHub repository webhook retry failed.");
  }
  revalidateGitHubPages();
  redirect(`/settings?githubWebhook=${active ? "active" : "error"}`);
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
