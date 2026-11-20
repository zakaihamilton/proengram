"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import {
  reviewKnowledgeSuggestion,
  submitKnowledgeEditSuggestion,
  updateOwnedKnowledgeItem,
} from "@/lib/db/brain";
import { normalizeKnowledgeDate, parseKnowledgeCitations } from "@/lib/knowledge/validation";

type AppAuthoredKind = "saved_answer" | "decision_record" | "project_update";

function readContent(formData: FormData): {
  itemId: string;
  itemKind: AppAuthoredKind;
  title: string;
  markdown: string;
  projectName: string | null;
  occurredAt: string | null;
  citations: Array<{ title: string; url: string }>;
} | null {
  const itemId = String(formData.get("itemId") ?? "");
  const kind = String(formData.get("itemKind") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const markdown = String(formData.get("markdown") ?? "").trim();
  const projectName = String(formData.get("projectName") ?? "").trim();
  const date = String(formData.get("occurredAt") ?? "");
  const citations = parseKnowledgeCitations(String(formData.get("citations") ?? ""));
  if (
    !/^[0-9a-f-]{36}$/i.test(itemId) ||
    !["saved_answer", "decision_record", "project_update"].includes(kind) ||
    !title ||
    title.length > 240 ||
    !markdown ||
    markdown.length > 30_000 ||
    !citations ||
    (date !== "" && !normalizeKnowledgeDate(date)) ||
    (kind === "project_update" && (!projectName || projectName.length > 160))
  ) {
    return null;
  }
  return {
    itemId,
    itemKind: kind as AppAuthoredKind,
    title,
    markdown,
    projectName: projectName || null,
    occurredAt: normalizeKnowledgeDate(date),
    citations,
  };
}

export async function editKnowledgeItemAction(formData: FormData): Promise<void> {
  const itemId = String(formData.get("itemId") ?? "");
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "result:save"))) redirect("/access-denied");
  const content = readContent(formData);
  if (!content) redirect(`/knowledge/${itemId}?error=edit-invalid`);
  try {
    await updateOwnedKnowledgeItem({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      ...content,
    });
  } catch {
    redirect(`/knowledge/${content.itemId}?error=edit-failed`);
  }
  revalidatePath("/knowledge");
  revalidatePath(`/knowledge/${content.itemId}`);
  revalidatePath("/saved");
  redirect(`/knowledge/${content.itemId}?saved=1`);
}

export async function suggestKnowledgeEditAction(formData: FormData): Promise<void> {
  const itemId = String(formData.get("itemId") ?? "");
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "result:save"))) redirect("/access-denied");
  const content = readContent(formData);
  if (!content) redirect(`/knowledge/${itemId}?error=edit-invalid`);
  try {
    await submitKnowledgeEditSuggestion({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      requestId: randomUUID(),
      targetItemId: content.itemId,
      itemKind: content.itemKind,
      title: content.title,
      markdown: content.markdown,
      projectName: content.projectName,
      occurredAt: content.occurredAt,
      citations: content.citations,
    });
  } catch {
    redirect(`/knowledge/${itemId}?error=edit-failed`);
  }
  revalidatePath("/knowledge/review");
  redirect(`/knowledge/${content.itemId}?suggested=1`);
}

export async function reviewKnowledgeSuggestionAction(formData: FormData): Promise<void> {
  const suggestionId = String(formData.get("suggestionId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (
    !/^[0-9a-f-]{36}$/i.test(suggestionId) ||
    !["approve", "reject"].includes(decision) ||
    note.length > 500
  ) {
    redirect("/knowledge/review?result=invalid");
  }
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "knowledge:approve"))) redirect("/access-denied");
  let itemId: string | null = null;
  try {
    const result = await reviewKnowledgeSuggestion({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      suggestionId,
      decision: decision as "approve" | "reject",
      note: note || null,
    });
    itemId = result.itemId;
  } catch {
    redirect("/knowledge/review?result=failed");
  }
  revalidatePath("/knowledge");
  revalidatePath("/knowledge/review");
  revalidatePath("/overview");
  revalidatePath("/activity");
  if (itemId) revalidatePath(`/knowledge/${itemId}`);
  redirect(`/knowledge/review?result=${decision}`);
}
