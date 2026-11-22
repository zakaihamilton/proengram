import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { buildSearchableChunks, type KnowledgeSegment } from "@/lib/knowledge/chunk";
import { writeActivity } from "./activity";
import {
  type BrainItem,
  type BrainItemKind,
  ITEM_FIELDS,
  type KnowledgeContentInput,
  type KnowledgeSuggestion,
  mapCitations,
  mapItem,
  nullableIso,
} from "./brain-types";
import { getPool } from "./pool";
import { withDatabaseTransaction } from "./transaction";

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

export function submitKnowledgeCapture(
  input: {
    organizationId: string;
    subjectId: string;
    requestId: string;
  } & KnowledgeContentInput,
): Promise<KnowledgeSuggestion> {
  return submitKnowledgeSuggestion({ ...input, suggestionType: "capture" });
}

export function submitKnowledgeEditSuggestion(
  input: {
    organizationId: string;
    subjectId: string;
    requestId: string;
    targetItemId: string;
  } & KnowledgeContentInput,
): Promise<KnowledgeSuggestion> {
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

async function createEditVersionAndChunks(
  client: PoolClient,
  input: {
    organizationId: string;
    itemId: string;
    title: string;
    markdown: string;
    projectName?: string | null;
    occurredAt?: string | null;
    citations: Array<{ title: string; url: string }>;
  },
): Promise<string> {
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
  return versionId;
}

export async function updateOwnedKnowledgeItem(
  input: {
    organizationId: string;
    subjectId: string;
    itemId: string;
  } & KnowledgeContentInput,
): Promise<void> {
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
    const versionId = await createEditVersionAndChunks(client, input);
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
        await createEditVersionAndChunks(client, {
          organizationId: input.organizationId,
          itemId,
          title: String(suggestion.title),
          markdown: String(suggestion.markdown),
          projectName: typeof suggestion.project_name === "string" ? suggestion.project_name : null,
          occurredAt: nullableIso(suggestion.occurred_at),
          citations,
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
