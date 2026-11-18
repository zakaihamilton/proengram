"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";
import { writeActivity } from "@/lib/db/brain";

type CatalogRule = { ruleId: string; label: string; description?: string; category?: string };

function validateCatalog(input: unknown): { revision: string; rules: CatalogRule[] } | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.rules) || value.rules.length > 100) return null;
  const revision =
    typeof value.policyRevision === "string" ? value.policyRevision.slice(0, 100) : "unversioned";
  const ids = new Set<string>();
  const rules: CatalogRule[] = [];
  for (const entry of value.rules) {
    if (!entry || typeof entry !== "object") return null;
    const rule = entry as Record<string, unknown>;
    if (typeof rule.ruleId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(rule.ruleId))
      return null;
    if (
      typeof rule.label !== "string" ||
      !rule.label.trim() ||
      rule.label.length > 240 ||
      ids.has(rule.ruleId)
    )
      return null;
    if (
      rule.description !== undefined &&
      (typeof rule.description !== "string" || rule.description.length > 4000)
    )
      return null;
    if (
      rule.category !== undefined &&
      (typeof rule.category !== "string" || rule.category.length > 160)
    )
      return null;
    ids.add(rule.ruleId);
    rules.push({
      ruleId: rule.ruleId,
      label: rule.label.trim(),
      ...(typeof rule.description === "string" ? { description: rule.description.trim() } : {}),
      ...(typeof rule.category === "string" ? { category: rule.category.trim() } : {}),
    });
  }
  return rules.length ? { revision, rules } : null;
}

export async function importSentry8CatalogAction(formData: FormData): Promise<void> {
  const identity = await getDashboardIdentity();
  if (!identity) redirect("/login");
  if (!(await authorizeAppAction(identity, "source:sync"))) redirect("/access-denied");
  const raw = String(formData.get("catalog") ?? "");
  if (!raw || raw.length > 250_000) redirect("/policies?import=invalid");
  let catalog: ReturnType<typeof validateCatalog>;
  try {
    catalog = validateCatalog(JSON.parse(raw));
  } catch {
    redirect("/policies?import=invalid");
  }
  if (!catalog) redirect("/policies?import=invalid");
  const pool = await getPool();
  if (!pool) redirect("/policies?import=storage");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE brain_items SET is_active = false WHERE organization_id = $1 AND kind = 'sentry8_policy'`,
      [identity.organization.organizationId],
    );
    for (const rule of catalog.rules) {
      const markdown = [
        rule.category ? `Category: ${rule.category}` : "",
        rule.description ?? "",
        `Rule ID: ${rule.ruleId}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      await client.query(
        `INSERT INTO brain_items
          (id, organization_id, kind, external_key, title, markdown, source_revision, is_active)
         VALUES ($1, $2, 'sentry8_policy', $3, $4, $5, $6, true)
         ON CONFLICT (organization_id, kind, external_key) DO UPDATE SET
           title = EXCLUDED.title,
           markdown = EXCLUDED.markdown,
           source_revision = EXCLUDED.source_revision,
           is_active = true,
           updated_at = now()`,
        [
          randomUUID(),
          identity.organization.organizationId,
          rule.ruleId,
          rule.label,
          markdown,
          catalog.revision,
        ],
      );
    }
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: identity.organization.organizationId,
      actorSubjectId: identity.subjectId,
      action: "source:sync",
      itemKind: "sentry8_policy",
      summary: `Imported ${catalog.rules.length} Sentry8 policy rules.`,
      metadata: { revision: catalog.revision, ruleCount: catalog.rules.length },
    });
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
    redirect("/policies?import=storage");
  } finally {
    client.release();
  }
  revalidatePath("/policies");
  revalidatePath("/overview");
  revalidatePath("/knowledge");
  redirect(`/policies?imported=${catalog.rules.length}`);
}
