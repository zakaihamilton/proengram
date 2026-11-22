import "server-only";

import {
  type BrainItem,
  type BrainItemKind,
  type BrainItemVersion,
  type BrainSearchFilters,
  ITEM_FIELDS,
  mapCitations,
  mapItem,
  nullableIso,
} from "./brain-types";
import { getPool } from "./pool";
import { withDatabaseTransaction } from "./transaction";

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
  if (filters.projectName) {
    const projectField = filters.includeHistory ? "version.project_name" : "item.project_name";
    where.push(`lower(${projectField}) = lower(${bind(filters.projectName)})`);
  }
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
    const versionFields = new Set([
      "title",
      "markdown",
      "source_revision",
      "source_modified_at",
      "occurred_at",
      "project_name",
      "citations",
    ]);
    const itemFields = ITEM_FIELDS.split(", ")
      .map((field) => {
        if (filters.includeHistory && versionFields.has(field))
          return `version.${field} AS ${field}`;
        if (filters.includeHistory && field === "updated_at") {
          return "version.observed_at AS updated_at";
        }
        return `item.${field}`;
      })
      .join(", ");
    const versionJoin = filters.includeHistory
      ? `JOIN brain_item_versions AS version
           ON version.item_id = item.id AND version.organization_id = item.organization_id`
      : `LEFT JOIN brain_item_versions AS version
           ON version.id = item.current_version_id AND version.organization_id = item.organization_id`;
    const versionOrder = filters.includeHistory
      ? "coalesce(version.occurred_at, version.source_modified_at, version.observed_at)"
      : "coalesce(item.occurred_at, item.source_modified_at, item.updated_at)";
    const result = await pool.query(
      `SELECT ${itemFields},
              NULL::text AS match_excerpt, NULL::text AS match_locator,
              version.id AS match_version_id, version.observed_at AS match_version_observed_at,
              version.source_revision AS match_source_revision,
              ${filters.includeHistory ? "(version.id <> item.current_version_id)" : "false"} AS is_historical_match
         FROM brain_items AS item
         ${versionJoin}
         LEFT JOIN LATERAL (
           SELECT sync.status FROM source_syncs AS sync
            WHERE sync.organization_id = item.organization_id AND sync.source_id = item.source_id
            ORDER BY sync.started_at DESC LIMIT 1
         ) AS source_sync ON true
        WHERE ${where.join(" AND ")}
        ORDER BY ${versionOrder} ${sortBy === "oldest" ? "ASC" : "DESC"}, item.updated_at DESC
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
  const result = await withDatabaseTransaction(async (client) => {
    if (queryVector) await client.query("SET LOCAL hnsw.ef_search = 1000");
    return client.query(
      `WITH filtered_versions AS (
       SELECT item.id AS item_id, item.organization_id, item.source_id, item.kind,
              item.title, item.markdown, item.source_url, item.source_revision,
              item.source_modified_at, item.owner_subject_id, item.updated_at,
              item.occurred_at, item.project_name, item.citations,
              version.id AS version_id, version.title AS version_title,
              version.source_revision AS version_source_revision,
              version.source_modified_at AS version_source_modified_at,
              version.observed_at AS version_observed_at,
              version.occurred_at AS version_occurred_at
         FROM brain_items AS item
         JOIN brain_item_versions AS version
           ON version.item_id = item.id AND version.organization_id = item.organization_id
         LEFT JOIN LATERAL (
           SELECT sync.status FROM source_syncs AS sync
            WHERE sync.organization_id = item.organization_id AND sync.source_id = item.source_id
            ORDER BY sync.started_at DESC LIMIT 1
         ) AS source_sync ON true
        WHERE ${where.join(" AND ")} ${historyFilter}
     ), lexical_candidates AS (
       SELECT filtered.*, chunk.ordinal, chunk.content, chunk.locator,
              greatest(
                ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english'::regconfig, ${queryParameter})),
                ts_rank_cd(chunk.search_vector_simple, websearch_to_tsquery('simple'::regconfig, ${queryParameter}))
              ) AS lexical_score,
              NULL::double precision AS vector_distance
         FROM filtered_versions AS filtered
         JOIN brain_chunks AS chunk
           ON chunk.item_id = filtered.item_id
          AND chunk.organization_id = filtered.organization_id
          AND chunk.version_id = filtered.version_id
        WHERE chunk.search_vector_english @@ websearch_to_tsquery('english'::regconfig, ${queryParameter})
           OR chunk.search_vector_simple @@ websearch_to_tsquery('simple'::regconfig, ${queryParameter})
     ), semantic_neighbors AS MATERIALIZED (
       SELECT chunk.id AS chunk_id,
              chunk.embedding <=> ${vectorParameter}::vector AS vector_distance
         FROM brain_chunks AS chunk
        WHERE chunk.organization_id = $1
          AND chunk.embedding_model = ${modelParameter}
          AND chunk.embedding IS NOT NULL
          AND ${vectorParameter}::vector IS NOT NULL
          AND chunk.version_id IN (SELECT version_id FROM filtered_versions)
        ORDER BY chunk.embedding <=> ${vectorParameter}::vector
        LIMIT 1000
     ), semantic_candidates AS (
       SELECT filtered.*, chunk.ordinal, chunk.content, chunk.locator,
              0::double precision AS lexical_score, neighbor.vector_distance
         FROM semantic_neighbors AS neighbor
         JOIN brain_chunks AS chunk ON chunk.id = neighbor.chunk_id
         JOIN filtered_versions AS filtered
           ON filtered.item_id = chunk.item_id
          AND filtered.organization_id = chunk.organization_id
          AND filtered.version_id = chunk.version_id
     ), candidates AS (
       SELECT * FROM lexical_candidates
       UNION ALL
       SELECT * FROM semantic_candidates
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
       SELECT filtered.item_id, filtered.organization_id, filtered.version_id,
              filtered.version_source_revision, filtered.version_source_modified_at,
              filtered.version_observed_at, filtered.version_occurred_at,
              fused.fused_score, matching_chunk.match_excerpt, matching_chunk.match_locator,
              row_number() OVER (
                PARTITION BY filtered.item_id
                ORDER BY fused.fused_score DESC,
                         coalesce(filtered.version_occurred_at, filtered.version_source_modified_at, filtered.version_observed_at) DESC,
                         filtered.version_id
              ) AS revision_rank
         FROM filtered_versions AS filtered
         JOIN fused ON fused.item_id = filtered.item_id AND fused.version_id = filtered.version_id
         JOIN matching_chunk ON matching_chunk.item_id = filtered.item_id
                            AND matching_chunk.version_id = filtered.version_id
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
  }, pool);
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

function mapBrainItemVersion(row: Record<string, unknown>): BrainItemVersion {
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
  return result.rows.map(mapBrainItemVersion);
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
  return mapBrainItemVersion(row);
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
