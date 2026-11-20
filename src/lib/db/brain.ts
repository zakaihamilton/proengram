import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { chunkMarkdown, chunkSegments, type KnowledgeSegment } from "@/lib/knowledge/chunk";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { getPool } from "./pool";

export type BrainItemKind =
  | "github_markdown"
  | "google_drive_document"
  | "saved_answer"
  | "sentry8_policy"
  | "decision_record"
  | "project_update";

export type BrainItem = {
  id: string;
  kind: BrainItemKind;
  title: string;
  markdown: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceModifiedAt: string | null;
  ownerSubjectId: string | null;
  updatedAt: string;
  occurredAt: string | null;
  projectName: string | null;
  citations: Array<{ title: string; url: string }>;
  matchExcerpt: string | null;
  matchLocator: string | null;
};

export type BrainItemVersion = {
  id: string;
  sourceRevision: string | null;
  sourceModifiedAt: string | null;
  observedAt: string;
  markdown: string;
};

export type KnowledgeFeedbackRating = "helpful" | "incorrect" | "outdated" | "missing_context";

export type KnowledgeFeedback = {
  id: string;
  itemId: string;
  itemTitle: string;
  actorSubjectId: string;
  rating: KnowledgeFeedbackRating;
  note: string | null;
  status: "pending" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
};

function mapCitations(value: unknown): Array<{ title: string; url: string }> {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const citation = entry as Record<string, unknown>;
        return typeof citation.title === "string" && typeof citation.url === "string"
          ? [{ title: citation.title, url: citation.url }]
          : [];
      })
    : [];
}

function nullableIso(value: unknown): string | null {
  return value ? new Date(String(value)).toISOString() : null;
}

function mapItem(row: Record<string, unknown>): BrainItem {
  return {
    id: String(row.id),
    kind: row.kind as BrainItemKind,
    title: String(row.title),
    markdown: String(row.markdown ?? ""),
    sourceUrl: typeof row.source_url === "string" ? row.source_url : null,
    sourceRevision: typeof row.source_revision === "string" ? row.source_revision : null,
    sourceModifiedAt: nullableIso(row.source_modified_at),
    ownerSubjectId: typeof row.owner_subject_id === "string" ? row.owner_subject_id : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    occurredAt: nullableIso(row.occurred_at),
    projectName: typeof row.project_name === "string" ? row.project_name : null,
    citations: mapCitations(row.citations),
    matchExcerpt: typeof row.match_excerpt === "string" ? row.match_excerpt : null,
    matchLocator: typeof row.match_locator === "string" ? row.match_locator : null,
  };
}

const ITEM_FIELDS =
  "id, kind, title, markdown, source_url, source_revision, source_modified_at, owner_subject_id, updated_at, occurred_at, project_name, citations";

async function searchItems(
  organizationId: string,
  query: string,
  limit: number,
  kind?: BrainItemKind,
  excludeKind?: BrainItemKind,
): Promise<BrainItem[]> {
  const pool = await getPool();
  if (!pool) return [];
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
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
    values.push(limit);
    const result = await pool.query(
      `SELECT ${ITEM_FIELDS} FROM brain_items
        WHERE ${filters.join(" AND ")}
        ORDER BY coalesce(occurred_at, updated_at) DESC, updated_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapItem);
  }

  const values: unknown[] = [organizationId, normalizedQuery];
  const filters = [
    "item.organization_id = $1",
    "item.visibility = 'company'",
    "item.is_active = true",
    `(
      chunk.search_vector_english @@ websearch_to_tsquery('english'::regconfig, $2)
      OR chunk.search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, $2)
    )`,
  ];
  if (kind) {
    values.push(kind);
    filters.push(`item.kind = $${values.length}`);
  }
  if (excludeKind) {
    values.push(excludeKind);
    filters.push(`item.kind <> $${values.length}`);
  }
  values.push(limit);
  const limitParameter = `$${values.length}`;
  const result = await pool.query(
    `WITH ranked AS (
       SELECT ${ITEM_FIELDS.split(", ")
         .map((field) => `item.${field}`)
         .join(", ")},
              chunk.content AS match_excerpt,
              chunk.locator AS match_locator,
              greatest(
                ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english'::regconfig, $2)),
                ts_rank_cd(chunk.search_vector_simple, websearch_to_tsquery('simple'::regconfig, $2))
              ) AS match_rank,
              row_number() OVER (
                PARTITION BY item.id
                ORDER BY greatest(
                  ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english'::regconfig, $2)),
                  ts_rank_cd(chunk.search_vector_simple, websearch_to_tsquery('simple'::regconfig, $2))
                ) DESC, chunk.ordinal
              ) AS match_number
         FROM brain_items AS item
         JOIN brain_chunks AS chunk
           ON chunk.item_id = item.id AND chunk.organization_id = item.organization_id
        WHERE ${filters.join(" AND ")}
     )
     SELECT id, kind, title, markdown, source_url, source_revision, source_modified_at,
            owner_subject_id, updated_at, occurred_at, project_name, citations,
            match_excerpt, match_locator
       FROM ranked
      WHERE match_number = 1
      ORDER BY match_rank DESC, coalesce(occurred_at, updated_at) DESC
      LIMIT ${limitParameter}`,
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
  const pool = await getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT ${ITEM_FIELDS}
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
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT ${ITEM_FIELDS}
       FROM brain_items
      WHERE organization_id = $1 AND kind = $2 AND visibility = 'company' AND is_active = true
      ORDER BY coalesce(occurred_at, updated_at) DESC, updated_at DESC
      LIMIT $3`,
    [organizationId, kind, limit],
  );
  return result.rows.map(mapItem);
}

export async function getProjectHistory(
  organizationId: string,
  projectName: string,
  from?: string,
  to?: string,
  limit = 50,
): Promise<BrainItem[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT ${ITEM_FIELDS}
       FROM brain_items
      WHERE organization_id = $1
        AND visibility = 'company'
        AND is_active = true
        AND kind IN ('decision_record', 'project_update')
        AND lower(project_name) = lower($2)
        AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR occurred_at <= $4::timestamptz)
      ORDER BY occurred_at DESC NULLS LAST, created_at DESC
      LIMIT $5`,
    [organizationId, projectName.trim(), from ?? null, to ?? null, limit],
  );
  return result.rows.map(mapItem);
}

export async function getBrainItemHistory(
  organizationId: string,
  itemId: string,
  limit = 20,
): Promise<BrainItemVersion[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT version.id, version.source_revision, version.source_modified_at,
            version.observed_at, version.markdown
       FROM brain_item_versions AS version
       JOIN brain_items AS item
         ON item.id = version.item_id AND item.organization_id = version.organization_id
      WHERE version.organization_id = $1 AND version.item_id = $2
        AND item.visibility = 'company'
      ORDER BY coalesce(version.source_modified_at, version.observed_at) DESC
      LIMIT $3`,
    [organizationId, itemId, limit],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    sourceRevision: typeof row.source_revision === "string" ? row.source_revision : null,
    sourceModifiedAt: nullableIso(row.source_modified_at),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    markdown: String(row.markdown),
  }));
}

export async function getOverview(organizationId: string, includePolicies = true) {
  const pool = await getPool();
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
      `SELECT ${ITEM_FIELDS} FROM brain_items
        WHERE organization_id = $1 AND visibility = 'company' AND is_active = true
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
      drive: byKind.google_drive_document ?? 0,
      saved: byKind.saved_answer ?? 0,
      decisions: byKind.decision_record ?? 0,
      projectUpdates: byKind.project_update ?? 0,
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
  const pool = await getPool();
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

export async function writeItemVersion(
  client: PoolClient,
  input: {
    organizationId: string;
    itemId: string;
    markdown: string;
    sourceRevision?: string | null;
    sourceModifiedAt?: string | Date | null;
  },
): Promise<void> {
  const revisionKey =
    input.sourceRevision || createHash("sha256").update(input.markdown).digest("hex");
  await client.query(
    `INSERT INTO brain_item_versions
      (id, organization_id, item_id, revision_key, source_revision, source_modified_at, markdown)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id, item_id, revision_key) DO NOTHING`,
    [
      randomUUID(),
      input.organizationId,
      input.itemId,
      revisionKey,
      input.sourceRevision ?? null,
      input.sourceModifiedAt ?? null,
      input.markdown,
    ],
  );
}

export async function replaceBrainChunks(
  client: PoolClient,
  input: {
    organizationId: string;
    itemId: string;
    markdown: string;
    title?: string;
    segments?: KnowledgeSegment[];
  },
): Promise<void> {
  const sourceSegments = input.segments ?? undefined;
  const chunks = sourceSegments
    ? chunkSegments([
        ...(input.title ? [{ text: input.title, locator: "Title" }] : []),
        ...sourceSegments,
      ])
    : chunkMarkdown(input.title ? `# ${input.title}\n\n${input.markdown}` : input.markdown);
  const searchableChunks = chunks.map((chunk) => {
    const parts = [
      input.title?.trim(),
      chunk.locator === "Title" ? null : chunk.locator?.trim(),
      chunk.content.trim(),
    ].filter((part): part is string => Boolean(part));
    return { ...chunk, content: [...new Set(parts)].join("\n") };
  });
  await client.query(`DELETE FROM brain_chunks WHERE organization_id = $1 AND item_id = $2`, [
    input.organizationId,
    input.itemId,
  ]);
  if (!searchableChunks.length) return;
  await client.query(
    `INSERT INTO brain_chunks (id, organization_id, item_id, ordinal, content, locator)
     SELECT gen_random_uuid(), $1, $2, (entry->>'ordinal')::integer,
            entry->>'content', nullif(entry->>'locator', '')
       FROM jsonb_array_elements($3::jsonb) AS entry`,
    [input.organizationId, input.itemId, JSON.stringify(searchableChunks)],
  );
}

type PersistBrainItemInput = {
  organizationId: string;
  subjectId: string;
  kind: BrainItemKind;
  title: string;
  markdown: string;
  chunkTitle: string;
  projectName?: string | null;
  occurredAt?: string | null;
  citations: Array<{ title: string; url: string }>;
  summary: string;
  metadata?: Record<string, unknown>;
};

async function persistBrainItem(input: PersistBrainItemInput): Promise<BrainItem> {
  const id = randomUUID();
  return withDatabaseTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO brain_items
        (id, organization_id, kind, external_key, title, markdown, owner_subject_id,
         citations, project_name, occurred_at)
       VALUES ($1, $2, $3, $1, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING ${ITEM_FIELDS}`,
      [
        id,
        input.organizationId,
        input.kind,
        input.title,
        input.markdown,
        input.subjectId,
        JSON.stringify(input.citations),
        input.projectName ?? null,
        input.occurredAt ?? null,
      ],
    );
    await writeItemVersion(client, {
      organizationId: input.organizationId,
      itemId: id,
      markdown: input.markdown,
    });
    await replaceBrainChunks(client, {
      organizationId: input.organizationId,
      itemId: id,
      markdown: input.markdown,
      title: input.chunkTitle,
    });
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "result:save",
      itemKind: input.kind,
      itemId: id,
      summary: input.summary,
      metadata: input.metadata,
    });
    return mapItem(result.rows[0]);
  });
}

export async function saveResult(input: {
  organizationId: string;
  subjectId: string;
  title: string;
  markdown: string;
  citations: Array<{ title: string; url: string }>;
}): Promise<BrainItem> {
  return persistBrainItem({
    ...input,
    kind: "saved_answer",
    chunkTitle: input.title,
    summary: `Saved “${input.title}” to the company brain.`,
  });
}

export async function saveMemory(input: {
  organizationId: string;
  subjectId: string;
  recordType: "decision" | "project_update";
  title: string;
  markdown: string;
  projectName: string | null;
  occurredAt: string;
  citations: Array<{ title: string; url: string }>;
}): Promise<BrainItem> {
  const kind: BrainItemKind =
    input.recordType === "decision" ? "decision_record" : "project_update";
  return persistBrainItem({
    ...input,
    kind,
    chunkTitle: input.projectName ? `${input.projectName}: ${input.title}` : input.title,
    summary: `Saved a ${input.recordType.replace("_", " ")} record: ${input.title}.`,
    metadata: { projectName: input.projectName, occurredAt: input.occurredAt },
  });
}

export async function saveKnowledgeFeedback(input: {
  organizationId: string;
  subjectId: string;
  itemId: string;
  rating: KnowledgeFeedbackRating;
  note: string | null;
}): Promise<{ id: string; status: "pending" | "resolved" }> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query<{ title: string }>(
      `SELECT title FROM brain_items
        WHERE organization_id = $1 AND id = $2 AND visibility = 'company' AND is_active = true`,
      [input.organizationId, input.itemId],
    );
    if (!item.rows[0]) throw new Error("The knowledge item was not found.");
    const result = await client.query<{ id: string; status: "pending" | "resolved" }>(
      `INSERT INTO knowledge_feedback
        (id, organization_id, item_id, actor_subject_id, rating, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, item_id, actor_subject_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         note = EXCLUDED.note,
         status = 'pending',
         created_at = now(),
         resolved_at = NULL,
         resolved_by_subject_id = NULL
       RETURNING id, status`,
      [randomUUID(), input.organizationId, input.itemId, input.subjectId, input.rating, input.note],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "brain:feedback",
      itemKind: "knowledge_feedback",
      itemId: input.itemId,
      summary: `Marked “${item.rows[0].title}” as ${input.rating.replace("_", " ")}.`,
      metadata: { rating: input.rating },
    });
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listKnowledgeFeedback(
  organizationId: string,
  limit = 100,
): Promise<KnowledgeFeedback[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT feedback.id, feedback.item_id, item.title AS item_title,
            feedback.actor_subject_id, feedback.rating, feedback.note, feedback.status,
            feedback.created_at, feedback.resolved_at
       FROM knowledge_feedback AS feedback
       JOIN brain_items AS item
         ON item.id = feedback.item_id AND item.organization_id = feedback.organization_id
      WHERE feedback.organization_id = $1
      ORDER BY (feedback.status = 'pending') DESC, feedback.created_at DESC
      LIMIT $2`,
    [organizationId, limit],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    itemId: String(row.item_id),
    itemTitle: String(row.item_title),
    actorSubjectId: String(row.actor_subject_id),
    rating: row.rating as KnowledgeFeedbackRating,
    note: typeof row.note === "string" ? row.note : null,
    status: row.status as KnowledgeFeedback["status"],
    createdAt: new Date(String(row.created_at)).toISOString(),
    resolvedAt: nullableIso(row.resolved_at),
  }));
}

export async function resolveKnowledgeFeedback(input: {
  organizationId: string;
  subjectId: string;
  feedbackId: string;
}): Promise<void> {
  await withDatabaseTransaction(async (client) => {
    const result = await client.query<{ item_id: string; item_title: string }>(
      `UPDATE knowledge_feedback AS feedback
          SET status = 'resolved', resolved_at = now(), resolved_by_subject_id = $3
         FROM brain_items AS item
        WHERE feedback.organization_id = $1 AND feedback.id = $2 AND feedback.status = 'pending'
          AND item.organization_id = feedback.organization_id AND item.id = feedback.item_id
        RETURNING feedback.item_id, item.title AS item_title`,
      [input.organizationId, input.feedbackId, input.subjectId],
    );
    const feedback = result.rows[0];
    if (!feedback) throw new Error("The pending feedback item was not found.");
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "brain:feedback:resolve",
      itemKind: "knowledge_feedback",
      itemId: input.feedbackId,
      summary: `Resolved feedback for “${feedback.item_title}”.`,
      metadata: { itemId: feedback.item_id },
    });
  });
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
