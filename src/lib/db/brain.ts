import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "./pool";

export type BrainItemKind = "github_markdown" | "saved_answer" | "sentry8_policy";

export type BrainItem = {
  id: string;
  kind: BrainItemKind;
  title: string;
  markdown: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  ownerSubjectId: string | null;
  updatedAt: string;
  citations: Array<{ title: string; url: string }>;
};

function mapItem(row: Record<string, unknown>): BrainItem {
  const citations = Array.isArray(row.citations)
    ? row.citations.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const citation = entry as Record<string, unknown>;
        return typeof citation.title === "string" && typeof citation.url === "string"
          ? [{ title: citation.title, url: citation.url }]
          : [];
      })
    : [];
  return {
    id: String(row.id),
    kind: row.kind as BrainItemKind,
    title: String(row.title),
    markdown: String(row.markdown),
    sourceUrl: typeof row.source_url === "string" ? row.source_url : null,
    sourceRevision: typeof row.source_revision === "string" ? row.source_revision : null,
    ownerSubjectId: typeof row.owner_subject_id === "string" ? row.owner_subject_id : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    citations,
  };
}

async function searchItems(
  organizationId: string,
  query: string,
  limit: number,
  kind?: BrainItemKind,
  excludeKind?: BrainItemKind,
): Promise<BrainItem[]> {
  const pool = getPool();
  if (!pool) return [];
  const values: unknown[] = [organizationId];
  const filters = ["organization_id = $1", "visibility = 'company'", "is_active = true"];
  if (kind) {
    values.push(kind);
    filters.push(`kind = $${values.length}`);
  }
  if (excludeKind) {
    values.push(excludeKind);
    filters.push(`kind <> $${values.length}`);
  }
  const normalizedQuery = query.trim();
  let orderBy = "updated_at DESC";
  if (normalizedQuery) {
    values.push(normalizedQuery);
    const queryParameter = `$${values.length}`;
    filters.push(`search_vector @@ websearch_to_tsquery('english'::regconfig, ${queryParameter})`);
    orderBy = `ts_rank_cd(search_vector, websearch_to_tsquery('english'::regconfig, ${queryParameter})) DESC, updated_at DESC`;
  }
  values.push(limit);
  const result = await pool.query(
    `SELECT id, kind, title, markdown, source_url, source_revision, owner_subject_id, updated_at, citations
       FROM brain_items
      WHERE ${filters.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(mapItem);
}

export function searchBrainItems(
  organizationId: string,
  query: string,
  limit = 10,
  excludeKind?: BrainItemKind,
): Promise<BrainItem[]> {
  return searchItems(organizationId, query, limit, undefined, excludeKind);
}

export function searchBrainItemsByKind(
  organizationId: string,
  kind: BrainItemKind,
  query: string,
  limit = 10,
): Promise<BrainItem[]> {
  return searchItems(organizationId, query, limit, kind);
}

export async function getBrainItem(
  organizationId: string,
  id: string,
  excludeKind?: BrainItemKind,
): Promise<BrainItem | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT id, kind, title, markdown, source_url, source_revision, owner_subject_id, updated_at, citations
       FROM brain_items
      WHERE organization_id = $1 AND id = $2 AND visibility = 'company' AND is_active = true
        AND ($3::text IS NULL OR kind <> $3)
      LIMIT 1`,
    [organizationId, id, excludeKind ?? null],
  );
  return result.rows[0] ? mapItem(result.rows[0]) : null;
}

export async function listItemsByKind(
  organizationId: string,
  kind: BrainItemKind,
  limit = 20,
): Promise<BrainItem[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, kind, title, markdown, source_url, source_revision, owner_subject_id, updated_at, citations
       FROM brain_items
      WHERE organization_id = $1 AND kind = $2 AND visibility = 'company' AND is_active = true
      ORDER BY updated_at DESC
      LIMIT $3`,
    [organizationId, kind, limit],
  );
  return result.rows.map(mapItem);
}

export async function getOverview(organizationId: string, includePolicies = true) {
  const pool = getPool();
  if (!pool) return null;
  const [counts, recent, syncs] = await Promise.all([
    pool.query<{ kind: string; count: string }>(
      `SELECT kind, count(*)::text AS count FROM brain_items
        WHERE organization_id = $1 AND is_active = true
          AND ($2::boolean OR kind <> 'sentry8_policy')
        GROUP BY kind`,
      [organizationId, includePolicies],
    ),
    pool.query(
      `SELECT id, kind, title, markdown, source_url, source_revision, owner_subject_id, updated_at, citations
         FROM brain_items WHERE organization_id = $1 AND visibility = 'company' AND is_active = true
          AND ($2::boolean OR kind <> 'sentry8_policy')
        ORDER BY updated_at DESC LIMIT 5`,
      [organizationId, includePolicies],
    ),
    pool.query(
      `SELECT DISTINCT ON (source) source, status, item_count, message, completed_at
         FROM source_syncs WHERE organization_id = $1 ORDER BY source, started_at DESC`,
      [organizationId],
    ),
  ]);
  const byKind = Object.fromEntries(counts.rows.map((row) => [row.kind, Number(row.count)]));
  return {
    counts: {
      github: byKind.github_markdown ?? 0,
      saved: byKind.saved_answer ?? 0,
      policies: byKind.sentry8_policy ?? 0,
    },
    recent: recent.rows.map(mapItem),
    syncs: syncs.rows as Array<{
      source: string;
      status: string;
      item_count: number;
      message: string | null;
      completed_at: string | null;
    }>,
  };
}

export async function listActivity(organizationId: string, limit = 30) {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, actor_subject_id, action, item_kind, item_id, summary, created_at
       FROM activity_events WHERE organization_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [organizationId, limit],
  );
  return result.rows as Array<{
    id: string;
    actor_subject_id: string;
    action: string;
    item_kind: string | null;
    item_id: string | null;
    summary: string;
    created_at: string;
  }>;
}

export async function saveResult(input: {
  organizationId: string;
  subjectId: string;
  title: string;
  markdown: string;
  citations: Array<{ title: string; url: string }>;
}): Promise<BrainItem> {
  const pool = getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO brain_items
        (id, organization_id, kind, external_key, title, markdown, owner_subject_id, citations)
       VALUES ($1, $2, 'saved_answer', $1, $3, $4, $5, $6::jsonb)
       RETURNING id, kind, title, markdown, source_url, source_revision, owner_subject_id, updated_at, citations`,
      [
        id,
        input.organizationId,
        input.title,
        input.markdown,
        input.subjectId,
        JSON.stringify(input.citations),
      ],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "result:save",
      itemKind: "saved_answer",
      itemId: id,
      summary: `Saved “${input.title}” to the company brain.`,
    });
    await client.query("COMMIT");
    return mapItem(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function writeActivity(
  client: PoolClient,
  input: {
    id: string;
    organizationId: string;
    actorSubjectId: string;
    action: string;
    itemKind?: string;
    itemId?: string;
    summary: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO activity_events
      (id, organization_id, actor_subject_id, action, item_kind, item_id, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.id,
      input.organizationId,
      input.actorSubjectId,
      input.action,
      input.itemKind ?? null,
      input.itemId ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
