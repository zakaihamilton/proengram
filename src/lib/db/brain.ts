import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { buildSearchableChunks, type KnowledgeSegment } from "@/lib/knowledge/chunk";
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
  sourceId: string | null;
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
  matchVersionId: string | null;
  matchVersionObservedAt: string | null;
  matchSourceRevision: string | null;
  isHistoricalMatch: boolean;
};

export type BrainItemVersion = {
  id: string;
  title: string;
  sourceRevision: string | null;
  sourceModifiedAt: string | null;
  observedAt: string;
  markdown: string;
  projectName: string | null;
  occurredAt: string | null;
  citations: Array<{ title: string; url: string }>;
};

export type BrainSearchFilters = {
  kind?: BrainItemKind;
  sourceId?: string;
  projectName?: string;
  ownerSubjectId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeHistory?: boolean;
  syncStatus?: "running" | "succeeded" | "failed";
  sortBy?: "relevance" | "newest" | "oldest";
  queryVector?: number[];
  embeddingModelVersion?: string;
};

export type KnowledgeSuggestion = {
  id: string;
  suggestionType: "capture" | "edit";
  targetItemId: string | null;
  targetItemTitle: string | null;
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName: string | null;
  occurredAt: string | null;
  citations: Array<{ title: string; url: string }>;
  proposerSubjectId: string;
  confirmedAt: string;
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
    sourceId: typeof row.source_id === "string" ? row.source_id : null,
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
    matchVersionId: typeof row.match_version_id === "string" ? row.match_version_id : null,
    matchVersionObservedAt: nullableIso(row.match_version_observed_at),
    matchSourceRevision:
      typeof row.match_source_revision === "string" ? row.match_source_revision : null,
    isHistoricalMatch: row.is_historical_match === true,
  };
}

const ITEM_FIELDS =
  "id, source_id, kind, title, markdown, source_url, source_revision, source_modified_at, owner_subject_id, updated_at, occurred_at, project_name, citations";

async function searchItems(
  organizationId: string,
  query: string,
  limit: number,
  kind?: BrainItemKind,
  excludeKind?: BrainItemKind,
  filters: BrainSearchFilters = {},
): Promise<BrainItem[]> {
  const pool = await getPool();
  if (!pool) return [];
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new Error("The start date must be on or before the end date.");
  }
  const normalizedQuery = query.trim();
  const sortBy = filters.sortBy ?? "relevance";
  const where = [
    "item.organization_id = $1",
    "item.visibility = 'company'",
    "item.is_active = true",
  ];
  const values: unknown[] = [organizationId];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const selectedKind = kind ?? filters.kind;
  if (selectedKind) where.push(`item.kind = ${bind(selectedKind)}`);
  if (excludeKind) where.push(`item.kind <> ${bind(excludeKind)}`);
  if (filters.sourceId) where.push(`item.source_id = ${bind(filters.sourceId)}::uuid`);
  if (filters.projectName)
    where.push(`lower(item.project_name) = lower(${bind(filters.projectName)})`);
  if (filters.ownerSubjectId) where.push(`item.owner_subject_id = ${bind(filters.ownerSubjectId)}`);
  if (filters.dateFrom) {
    where.push(
      `coalesce(version.occurred_at, version.source_modified_at, version.observed_at)::date >= ${bind(filters.dateFrom)}::date`,
    );
  }
  if (filters.dateTo) {
    where.push(
      `coalesce(version.occurred_at, version.source_modified_at, version.observed_at)::date <= ${bind(filters.dateTo)}::date`,
    );
  }
  if (filters.syncStatus) where.push(`source_sync.status = ${bind(filters.syncStatus)}`);

  if (!normalizedQuery) {
    const limitParameter = bind(limit);
    const result = await pool.query(
      `SELECT ${ITEM_FIELDS.split(", ")
        .map((field) => `item.${field}`)
        .join(", ")},
              NULL::text AS match_excerpt, NULL::text AS match_locator,
              version.id AS match_version_id, version.observed_at AS match_version_observed_at,
              version.source_revision AS match_source_revision, false AS is_historical_match
         FROM brain_items AS item
         LEFT JOIN brain_item_versions AS version
           ON version.id = item.current_version_id AND version.organization_id = item.organization_id
         LEFT JOIN LATERAL (
           SELECT sync.status FROM source_syncs AS sync
            WHERE sync.organization_id = item.organization_id AND sync.source_id = item.source_id
            ORDER BY sync.started_at DESC LIMIT 1
         ) AS source_sync ON true
        WHERE ${where.join(" AND ")}
        ORDER BY ${sortBy === "oldest" ? "coalesce(item.occurred_at, item.source_modified_at, item.updated_at) ASC" : "coalesce(item.occurred_at, item.source_modified_at, item.updated_at) DESC"}, item.updated_at DESC
        LIMIT ${limitParameter}`,
      values,
    );
    return result.rows.map(mapItem);
  }

  const queryVector = filters.queryVector?.length === 384 ? filters.queryVector : null;
  const queryModelVersion = queryVector ? (filters.embeddingModelVersion ?? null) : null;
  const queryParameter = bind(normalizedQuery);
  const vectorParameter = bind(queryVector ? `[${queryVector.join(",")}]` : null);
  const modelParameter = bind(queryModelVersion);
  const limitParameter = bind(limit);
  const historyFilter = filters.includeHistory ? "" : "AND version.id = item.current_version_id";
  const relevanceSort =
    sortBy === "newest"
      ? "coalesce(best.version_occurred_at, best.version_source_modified_at, best.version_observed_at) DESC, best.fused_score DESC"
      : sortBy === "oldest"
        ? "coalesce(best.version_occurred_at, best.version_source_modified_at, best.version_observed_at) ASC, best.fused_score DESC"
        : "best.fused_score DESC, coalesce(best.version_occurred_at, best.version_source_modified_at, best.version_observed_at) DESC";
  const result = await pool.query(
    `WITH candidates AS (
       SELECT item.id AS item_id, item.organization_id, item.source_id, item.kind,
              item.title, item.markdown, item.source_url, item.source_revision,
              item.source_modified_at, item.owner_subject_id, item.updated_at,
              item.occurred_at, item.project_name, item.citations,
              version.id AS version_id, version.title AS version_title,
              version.source_revision AS version_source_revision,
              version.source_modified_at AS version_source_modified_at,
              version.observed_at AS version_observed_at,
              version.occurred_at AS version_occurred_at,
              chunk.ordinal, chunk.content, chunk.locator,
              greatest(
                ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english'::regconfig, ${queryParameter})),
                ts_rank_cd(chunk.search_vector_simple, websearch_to_tsquery('simple'::regconfig, ${queryParameter}))
              ) AS lexical_score,
              CASE WHEN ${vectorParameter}::vector IS NULL OR chunk.embedding IS NULL
                         OR chunk.embedding_model IS DISTINCT FROM ${modelParameter}
                   THEN NULL
                   ELSE chunk.embedding <=> ${vectorParameter}::vector END AS vector_distance
         FROM brain_items AS item
         JOIN brain_item_versions AS version
           ON version.item_id = item.id AND version.organization_id = item.organization_id
         JOIN brain_chunks AS chunk
           ON chunk.item_id = item.id AND chunk.organization_id = item.organization_id
          AND chunk.version_id = version.id
         LEFT JOIN LATERAL (
           SELECT sync.status FROM source_syncs AS sync
            WHERE sync.organization_id = item.organization_id AND sync.source_id = item.source_id
            ORDER BY sync.started_at DESC LIMIT 1
         ) AS source_sync ON true
        WHERE ${where.join(" AND ")} ${historyFilter}
     ), lexical_best AS (
       SELECT DISTINCT ON (item_id, version_id) item_id, version_id, lexical_score,
              ordinal, content, locator
         FROM candidates
        WHERE lexical_score > 0
        ORDER BY item_id, version_id, lexical_score DESC, ordinal
     ), lexical_hits AS (
       SELECT item_id, version_id,
              row_number() OVER (ORDER BY lexical_score DESC, item_id, version_id) AS hit_rank
         FROM lexical_best
        ORDER BY lexical_score DESC, item_id, version_id
        LIMIT 100
     ), semantic_best AS (
       SELECT DISTINCT ON (item_id, version_id) item_id, version_id, vector_distance,
              ordinal, content, locator
         FROM candidates
        WHERE vector_distance IS NOT NULL
        ORDER BY item_id, version_id, vector_distance, ordinal
     ), semantic_hits AS (
       SELECT item_id, version_id,
              row_number() OVER (ORDER BY vector_distance, item_id, version_id) AS hit_rank
         FROM semantic_best
        ORDER BY vector_distance, item_id, version_id
        LIMIT 100
     ), fused AS (
       SELECT item_id, version_id, sum(reciprocal_rank) AS fused_score
         FROM (
           SELECT item_id, version_id, 1.0 / (60 + hit_rank) AS reciprocal_rank FROM lexical_hits
           UNION ALL
           SELECT item_id, version_id, 1.0 / (60 + hit_rank) AS reciprocal_rank FROM semantic_hits
         ) AS ranks
        GROUP BY item_id, version_id
     ), matching_chunk AS (
       SELECT DISTINCT ON (item_id, version_id)
              item_id, version_id, content AS match_excerpt, locator AS match_locator
         FROM candidates
        ORDER BY item_id, version_id, lexical_score DESC,
                 vector_distance ASC NULLS LAST, ordinal
     ), version_matches AS (
       SELECT candidates.item_id, candidates.organization_id, candidates.version_id,
              candidates.version_source_revision, candidates.version_source_modified_at,
              candidates.version_observed_at, candidates.version_occurred_at,
              fused.fused_score, matching_chunk.match_excerpt, matching_chunk.match_locator,
              row_number() OVER (
                PARTITION BY candidates.item_id
                ORDER BY fused.fused_score DESC,
                         coalesce(candidates.version_occurred_at, candidates.version_source_modified_at, candidates.version_observed_at) DESC,
                         candidates.version_id
              ) AS revision_rank
         FROM candidates
         JOIN fused ON fused.item_id = candidates.item_id AND fused.version_id = candidates.version_id
         JOIN matching_chunk ON matching_chunk.item_id = candidates.item_id
                            AND matching_chunk.version_id = candidates.version_id
     ), best AS (
       SELECT DISTINCT ON (matches.item_id)
              matches.item_id, matches.version_id, matches.version_source_revision,
              matches.version_source_modified_at, matches.version_observed_at,
              matches.version_occurred_at, matches.fused_score,
              matches.match_excerpt, matches.match_locator
         FROM version_matches AS matches
        WHERE matches.revision_rank = 1
        ORDER BY matches.item_id, matches.revision_rank
     )
     SELECT ${ITEM_FIELDS.split(", ")
       .map((field) => `item.${field}`)
       .join(", ")},
            best.match_excerpt, best.match_locator, best.version_id AS match_version_id,
            best.version_observed_at AS match_version_observed_at,
            best.version_source_revision AS match_source_revision,
            (best.version_id <> item.current_version_id) AS is_historical_match
       FROM best
       JOIN brain_items AS item ON item.id = best.item_id AND item.organization_id = $1
      ORDER BY ${relevanceSort}
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
  filters: BrainSearchFilters = {},
): Promise<BrainItem[]> {
  return searchItems(organizationId, query, limit, undefined, excludeKind, filters);
}

export function searchBrainItemsByKind(
  organizationId: string,
  kind: BrainItemKind,
  query: string,
  limit = 10,
  filters: BrainSearchFilters = {},
): Promise<BrainItem[]> {
  return searchItems(organizationId, query, limit, kind, undefined, filters);
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
    `SELECT version.id, version.title, version.source_revision, version.source_modified_at,
            version.observed_at, version.markdown, version.project_name,
            version.occurred_at, version.citations
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
    title: String(row.title),
    sourceRevision: typeof row.source_revision === "string" ? row.source_revision : null,
    sourceModifiedAt: nullableIso(row.source_modified_at),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    markdown: String(row.markdown),
    projectName: typeof row.project_name === "string" ? row.project_name : null,
    occurredAt: nullableIso(row.occurred_at),
    citations: mapCitations(row.citations),
  }));
}

export async function getBrainItemVersion(
  organizationId: string,
  itemId: string,
  versionId: string,
): Promise<BrainItemVersion | null> {
  const pool = await getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT version.id, version.title, version.source_revision, version.source_modified_at,
            version.observed_at, version.markdown, version.project_name,
            version.occurred_at, version.citations
       FROM brain_item_versions AS version
       JOIN brain_items AS item
         ON item.id = version.item_id AND item.organization_id = version.organization_id
      WHERE version.organization_id = $1 AND version.item_id = $2 AND version.id = $3
        AND item.visibility = 'company' AND item.is_active = true
      LIMIT 1`,
    [organizationId, itemId, versionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    sourceRevision: typeof row.source_revision === "string" ? row.source_revision : null,
    sourceModifiedAt: nullableIso(row.source_modified_at),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    markdown: String(row.markdown),
    projectName: typeof row.project_name === "string" ? row.project_name : null,
    occurredAt: nullableIso(row.occurred_at),
    citations: mapCitations(row.citations),
  };
}

export async function listKnowledgeSearchSources(
  organizationId: string,
): Promise<Array<{ id: string; label: string }>> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT source_id AS id, label FROM (
       SELECT id::text AS source_id, repository_owner || '/' || repository_name AS label
         FROM github_repository_sources WHERE organization_id = $1
       UNION ALL
       SELECT id::text AS source_id, drive_name AS label
         FROM google_drive_sources WHERE organization_id = $1
     ) AS sources ORDER BY label`,
    [organizationId],
  );
  return result.rows.map((row) => ({ id: String(row.id), label: String(row.label) }));
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
    title: string;
    markdown: string;
    revisionKey?: string;
    sourceRevision?: string | null;
    sourceModifiedAt?: string | Date | null;
    projectName?: string | null;
    occurredAt?: string | Date | null;
    citations?: Array<{ title: string; url: string }>;
  },
): Promise<string> {
  const revisionKey =
    input.revisionKey ??
    (input.sourceRevision ||
      createHash("sha256")
        .update(JSON.stringify([input.title, input.markdown, input.projectName, input.occurredAt]))
        .digest("hex"));
  const result = await client.query<{ id: string }>(
    `INSERT INTO brain_item_versions
      (id, organization_id, item_id, revision_key, source_revision, source_modified_at,
       markdown, title, project_name, occurred_at, citations, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
     ON CONFLICT (organization_id, item_id, revision_key) DO UPDATE SET
       source_revision = EXCLUDED.source_revision,
       source_modified_at = EXCLUDED.source_modified_at,
       markdown = EXCLUDED.markdown,
       title = EXCLUDED.title,
       project_name = EXCLUDED.project_name,
       occurred_at = EXCLUDED.occurred_at,
       citations = EXCLUDED.citations,
       observed_at = now()
     RETURNING id`,
    [
      randomUUID(),
      input.organizationId,
      input.itemId,
      revisionKey,
      input.sourceRevision ?? null,
      input.sourceModifiedAt ?? null,
      input.markdown,
      input.title,
      input.projectName ?? null,
      input.occurredAt ?? null,
      JSON.stringify(input.citations ?? []),
    ],
  );
  const versionId = String(result.rows[0].id);
  await client.query(
    `UPDATE brain_items SET current_version_id = $3
      WHERE organization_id = $1 AND id = $2`,
    [input.organizationId, input.itemId, versionId],
  );
  return versionId;
}

export async function replaceBrainChunks(
  client: PoolClient,
  input: {
    organizationId: string;
    itemId: string;
    versionId: string;
    markdown: string;
    title?: string;
    segments?: KnowledgeSegment[];
  },
): Promise<void> {
  const searchableChunks = buildSearchableChunks(input);
  await client.query(
    `DELETE FROM brain_chunks WHERE organization_id = $1 AND item_id = $2 AND version_id = $3`,
    [input.organizationId, input.itemId, input.versionId],
  );
  if (searchableChunks.length) {
    await client.query(
      `INSERT INTO brain_chunks
        (id, organization_id, item_id, version_id, ordinal, content, locator)
       SELECT gen_random_uuid(), $1, $2, $3, (entry->>'ordinal')::integer,
              entry->>'content', nullif(entry->>'locator', '')
         FROM jsonb_array_elements($4::jsonb) AS entry`,
      [input.organizationId, input.itemId, input.versionId, JSON.stringify(searchableChunks)],
    );
  }
  await client.query(
    `INSERT INTO knowledge_embedding_jobs (id, organization_id, item_id, version_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, version_id) DO UPDATE SET
       status = 'pending', attempt_count = 0, next_attempt_at = now(), locked_until = NULL,
       last_error = NULL, updated_at = now(), completed_at = NULL`,
    [randomUUID(), input.organizationId, input.itemId, input.versionId],
  );
}

type PersistBrainItemInput = {
  organizationId: string;
  subjectId: string;
  ownerSubjectId?: string;
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

async function persistBrainItemWithClient(
  client: PoolClient,
  input: PersistBrainItemInput,
): Promise<BrainItem> {
  const id = randomUUID();
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
      input.ownerSubjectId ?? input.subjectId,
      JSON.stringify(input.citations),
      input.projectName ?? null,
      input.occurredAt ?? null,
    ],
  );
  const versionId = await writeItemVersion(client, {
    organizationId: input.organizationId,
    itemId: id,
    title: input.title,
    markdown: input.markdown,
    projectName: input.projectName,
    occurredAt: input.occurredAt,
    citations: input.citations,
  });
  await replaceBrainChunks(client, {
    organizationId: input.organizationId,
    itemId: id,
    versionId,
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
}

async function persistBrainItem(input: PersistBrainItemInput): Promise<BrainItem> {
  return withDatabaseTransaction((client) => persistBrainItemWithClient(client, input));
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

type KnowledgeSuggestionInput = {
  organizationId: string;
  subjectId: string;
  requestId: string;
  suggestionType: "capture" | "edit";
  targetItemId?: string | null;
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName?: string | null;
  occurredAt?: string | null;
  citations: Array<{ title: string; url: string }>;
};

function mapSuggestion(row: Record<string, unknown>): KnowledgeSuggestion {
  return {
    id: String(row.id),
    suggestionType: row.suggestion_type as KnowledgeSuggestion["suggestionType"],
    targetItemId: typeof row.target_item_id === "string" ? row.target_item_id : null,
    targetItemTitle: typeof row.target_item_title === "string" ? row.target_item_title : null,
    itemKind: row.item_kind as KnowledgeSuggestion["itemKind"],
    title: String(row.title),
    markdown: String(row.markdown),
    projectName: typeof row.project_name === "string" ? row.project_name : null,
    occurredAt: nullableIso(row.occurred_at),
    citations: mapCitations(row.citations),
    proposerSubjectId: String(row.proposer_subject_id),
    confirmedAt: new Date(String(row.confirmed_at)).toISOString(),
  };
}

async function submitKnowledgeSuggestion(
  input: KnowledgeSuggestionInput,
): Promise<KnowledgeSuggestion> {
  return withDatabaseTransaction(async (client) => {
    let targetItemTitle: string | null = null;
    if (input.suggestionType === "edit") {
      const target = await client.query<{
        title: string;
        kind: string;
        owner_subject_id: string | null;
      }>(
        `SELECT title, kind, owner_subject_id FROM brain_items
          WHERE organization_id = $1 AND id = $2 AND visibility = 'company'
            AND is_active = true AND source_id IS NULL
            AND kind IN ('saved_answer', 'decision_record', 'project_update')
          FOR SHARE`,
        [input.organizationId, input.targetItemId],
      );
      const item = target.rows[0];
      if (!item) throw new Error("Only app-authored knowledge can receive edit suggestions.");
      if (item.owner_subject_id === input.subjectId) {
        throw new Error("Edit your own knowledge item directly.");
      }
      if (item.kind !== input.itemKind)
        throw new Error("An edit suggestion must keep the item type.");
      targetItemTitle = item.title;
    }
    if (input.itemKind === "project_update" && !input.projectName?.trim()) {
      throw new Error("Project updates require a project name.");
    }
    const inserted = await client.query(
      `INSERT INTO knowledge_suggestions
        (id, organization_id, request_id, proposer_subject_id, suggestion_type, target_item_id,
         item_kind, title, markdown, project_name, occurred_at, citations, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())
       ON CONFLICT (organization_id, proposer_subject_id, request_id) DO NOTHING
       RETURNING id, suggestion_type, target_item_id, item_kind, title, markdown,
                 project_name, occurred_at, citations, proposer_subject_id, confirmed_at`,
      [
        randomUUID(),
        input.organizationId,
        input.requestId,
        input.subjectId,
        input.suggestionType,
        input.targetItemId ?? null,
        input.itemKind,
        input.title,
        input.markdown,
        input.projectName ?? null,
        input.occurredAt ?? null,
        JSON.stringify(input.citations),
      ],
    );
    let row = inserted.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      const existing = await client.query(
        `SELECT id, suggestion_type, target_item_id, item_kind, title, markdown,
                project_name, occurred_at, citations, proposer_subject_id, confirmed_at
           FROM knowledge_suggestions
          WHERE organization_id = $1 AND proposer_subject_id = $2 AND request_id = $3`,
        [input.organizationId, input.subjectId, input.requestId],
      );
      row = existing.rows[0] as Record<string, unknown> | undefined;
      if (
        !row ||
        row.suggestion_type !== input.suggestionType ||
        row.target_item_id !== (input.targetItemId ?? null) ||
        row.item_kind !== input.itemKind ||
        row.title !== input.title ||
        row.markdown !== input.markdown ||
        row.project_name !== (input.projectName ?? null) ||
        nullableIso(row.occurred_at) !== nullableIso(input.occurredAt) ||
        JSON.stringify(mapCitations(row.citations)) !== JSON.stringify(input.citations)
      ) {
        throw new Error("This suggestion request ID was already used for different content.");
      }
    } else {
      await writeActivity(client, {
        id: randomUUID(),
        organizationId: input.organizationId,
        actorSubjectId: input.subjectId,
        action: "knowledge:suggest",
        itemKind: input.itemKind,
        itemId: input.targetItemId ?? String(row.id),
        summary:
          input.suggestionType === "edit"
            ? `Suggested an edit to “${targetItemTitle}”.`
            : `Submitted “${input.title}” for knowledge review.`,
        metadata: { suggestionId: row.id, suggestionType: input.suggestionType },
      });
    }
    if (input.targetItemId) {
      const target = await client.query<{ title: string }>(
        `SELECT title FROM brain_items WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.targetItemId],
      );
      if (target.rows[0]) targetItemTitle = String(target.rows[0].title);
    }
    return mapSuggestion({ ...row, target_item_title: targetItemTitle });
  });
}

export function submitKnowledgeCapture(input: {
  organizationId: string;
  subjectId: string;
  requestId: string;
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName?: string | null;
  occurredAt?: string | null;
  citations: Array<{ title: string; url: string }>;
}): Promise<KnowledgeSuggestion> {
  return submitKnowledgeSuggestion({ ...input, suggestionType: "capture" });
}

export function submitKnowledgeEditSuggestion(input: {
  organizationId: string;
  subjectId: string;
  requestId: string;
  targetItemId: string;
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName?: string | null;
  occurredAt?: string | null;
  citations: Array<{ title: string; url: string }>;
}): Promise<KnowledgeSuggestion> {
  return submitKnowledgeSuggestion({ ...input, suggestionType: "edit" });
}

export async function listPendingKnowledgeSuggestions(
  organizationId: string,
  limit = 100,
): Promise<KnowledgeSuggestion[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT suggestion.id, suggestion.suggestion_type, suggestion.target_item_id,
            target.title AS target_item_title, suggestion.item_kind, suggestion.title,
            suggestion.markdown, suggestion.project_name, suggestion.occurred_at,
            suggestion.citations, suggestion.proposer_subject_id, suggestion.confirmed_at
       FROM knowledge_suggestions AS suggestion
       LEFT JOIN brain_items AS target
         ON target.id = suggestion.target_item_id
        AND target.organization_id = suggestion.organization_id
      WHERE suggestion.organization_id = $1 AND suggestion.status = 'pending'
      ORDER BY suggestion.created_at ASC
      LIMIT $2`,
    [organizationId, limit],
  );
  return result.rows.map(mapSuggestion);
}

export async function updateOwnedKnowledgeItem(input: {
  organizationId: string;
  subjectId: string;
  itemId: string;
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName?: string | null;
  occurredAt?: string | null;
  citations: Array<{ title: string; url: string }>;
}): Promise<void> {
  await withDatabaseTransaction(async (client) => {
    const result = await client.query<{ title: string }>(
      `UPDATE brain_items
          SET title = $4, markdown = $5, project_name = $6, occurred_at = $7,
              citations = $8::jsonb, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND owner_subject_id = $3
          AND visibility = 'company' AND is_active = true AND source_id IS NULL
          AND kind = $9
        RETURNING title`,
      [
        input.organizationId,
        input.itemId,
        input.subjectId,
        input.title,
        input.markdown,
        input.projectName ?? null,
        input.occurredAt ?? null,
        JSON.stringify(input.citations),
        input.itemKind,
      ],
    );
    const item = result.rows[0];
    if (!item) throw new Error("Only the creator can edit this app-authored knowledge item.");
    const versionId = await writeItemVersion(client, {
      organizationId: input.organizationId,
      itemId: input.itemId,
      title: input.title,
      markdown: input.markdown,
      revisionKey: `edit:${randomUUID()}`,
      projectName: input.projectName,
      occurredAt: input.occurredAt,
      citations: input.citations,
    });
    await replaceBrainChunks(client, {
      organizationId: input.organizationId,
      itemId: input.itemId,
      versionId,
      title: input.title,
      markdown: input.markdown,
    });
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "knowledge:edit",
      itemKind: input.itemKind,
      itemId: input.itemId,
      summary: `Updated “${input.title}”.`,
      metadata: { versionId },
    });
  });
}

export async function reviewKnowledgeSuggestion(input: {
  organizationId: string;
  subjectId: string;
  suggestionId: string;
  decision: "approve" | "reject";
  note?: string | null;
}): Promise<{ itemId: string | null; status: "approved" | "rejected" }> {
  return withDatabaseTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, suggestion_type, target_item_id, proposer_subject_id, item_kind, title,
              markdown, project_name, occurred_at, citations
         FROM knowledge_suggestions
        WHERE organization_id = $1 AND id = $2 AND status = 'pending'
        FOR UPDATE`,
      [input.organizationId, input.suggestionId],
    );
    const suggestion = result.rows[0] as Record<string, unknown> | undefined;
    if (!suggestion) throw new Error("The pending knowledge suggestion was not found.");
    const status = input.decision === "approve" ? "approved" : "rejected";
    let itemId: string | null = null;
    if (input.decision === "approve") {
      const itemKind = suggestion.item_kind as
        | "saved_answer"
        | "decision_record"
        | "project_update";
      const citations = mapCitations(suggestion.citations);
      if (suggestion.suggestion_type === "capture") {
        const item = await persistBrainItemWithClient(client, {
          organizationId: input.organizationId,
          subjectId: input.subjectId,
          ownerSubjectId: String(suggestion.proposer_subject_id),
          kind: itemKind,
          title: String(suggestion.title),
          markdown: String(suggestion.markdown),
          chunkTitle: String(suggestion.title),
          projectName: typeof suggestion.project_name === "string" ? suggestion.project_name : null,
          occurredAt: nullableIso(suggestion.occurred_at),
          citations,
          summary: `Published “${String(suggestion.title)}” from the knowledge review queue.`,
          metadata: { suggestionId: input.suggestionId },
        });
        itemId = item.id;
      } else {
        const target = await client.query<{ title: string; kind: string }>(
          `SELECT title, kind FROM brain_items
            WHERE organization_id = $1 AND id = $2 AND is_active = true
              AND visibility = 'company' AND source_id IS NULL
              AND kind IN ('saved_answer', 'decision_record', 'project_update')
            FOR UPDATE`,
          [input.organizationId, suggestion.target_item_id],
        );
        if (!target.rows[0] || target.rows[0].kind !== itemKind) {
          throw new Error("The target knowledge item is no longer available for editing.");
        }
        await client.query(
          `UPDATE brain_items
              SET title = $3, markdown = $4, project_name = $5, occurred_at = $6,
                  citations = $7::jsonb, updated_at = now()
            WHERE organization_id = $1 AND id = $2`,
          [
            input.organizationId,
            suggestion.target_item_id,
            suggestion.title,
            suggestion.markdown,
            suggestion.project_name,
            suggestion.occurred_at,
            JSON.stringify(citations),
          ],
        );
        itemId = String(suggestion.target_item_id);
        const versionId = await writeItemVersion(client, {
          organizationId: input.organizationId,
          itemId,
          title: String(suggestion.title),
          markdown: String(suggestion.markdown),
          revisionKey: `edit:${randomUUID()}`,
          projectName: typeof suggestion.project_name === "string" ? suggestion.project_name : null,
          occurredAt: nullableIso(suggestion.occurred_at),
          citations,
        });
        await replaceBrainChunks(client, {
          organizationId: input.organizationId,
          itemId,
          versionId,
          title: String(suggestion.title),
          markdown: String(suggestion.markdown),
        });
      }
    }
    await client.query(
      `UPDATE knowledge_suggestions
          SET status = $3, review_note = $4, reviewed_by_subject_id = $5,
              reviewed_at = now(), updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.suggestionId, status, input.note ?? null, input.subjectId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: `knowledge:suggestion:${input.decision}`,
      itemKind: String(suggestion.item_kind),
      itemId: itemId ?? input.suggestionId,
      summary: `${input.decision === "approve" ? "Approved" : "Rejected"} the suggestion “${String(suggestion.title)}”.`,
      metadata: { suggestionId: input.suggestionId, suggestionType: suggestion.suggestion_type },
    });
    return { itemId, status };
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
