"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { saveResult } from "@/lib/db/brain";

function parseCitations(value: string): Array<{ title: string; url: string }> | null {
  if (!value.trim()) return [];
  const citations: Array<{ title: string; url: string }> = [];
  for (const [index, line] of value.split("\n").entries()) {
    const text = line.trim();
    if (!text) continue;
    const separator = text.indexOf("|");
    if (separator < 1) return null;
    const title = text.slice(0, separator).trim();
    const url = text.slice(separator + 1).trim();
    try {
      const parsed = new URL(url);
      if (
        !title ||
        title.length > 240 ||
        !["http:", "https:"].includes(parsed.protocol) ||
        url.length > 2048
      )
        return null;
    } catch {
      return null;
    }
    citations.push({ title, url });
    if (index > 29 || citations.length > 30) return null;
  }
  return citations;
}

export async function saveAnswerAction(formData: FormData): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "result:save"))) redirect("/access-denied");
  const title = String(formData.get("title") ?? "").trim();
  const markdown = String(formData.get("markdown") ?? "").trim();
  const citations = parseCitations(String(formData.get("citations") ?? ""));
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
