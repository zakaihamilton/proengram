"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { resolveKnowledgeFeedback } from "@/lib/db/brain";

export async function resolveFeedbackAction(formData: FormData): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "source:manage"))) redirect("/access-denied");
  try {
    await resolveKnowledgeFeedback({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      feedbackId: String(formData.get("feedbackId") ?? ""),
    });
  } catch {
    redirect("/feedback?resolve=error");
  }
  revalidatePath("/feedback");
  redirect("/feedback?resolve=done");
}
