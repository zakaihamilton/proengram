"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { saveResult } from "@/lib/db/brain";
import { parseKnowledgeCitations } from "@/lib/knowledge/validation";

export async function saveAnswerAction(formData: FormData): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "result:save"))) redirect("/access-denied");
  const title = String(formData.get("title") ?? "").trim();
  const markdown = String(formData.get("markdown") ?? "").trim();
  const citations = parseKnowledgeCitations(String(formData.get("citations") ?? ""));
  if (!title || title.length > 240 || !markdown || markdown.length > 30_000 || !citations) {
    redirect("/saved/new?error=invalid");
  }
  let itemId: string;
  try {
    const item = await saveResult({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      title,
      markdown,
      citations,
    });
    itemId = item.id;
  } catch {
    redirect("/saved/new?error=storage");
  }
  revalidatePath("/overview");
  revalidatePath("/knowledge");
  revalidatePath("/saved");
  redirect(`/knowledge/${itemId}`);
}
