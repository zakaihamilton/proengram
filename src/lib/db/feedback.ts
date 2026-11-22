import "server-only";

import { randomUUID } from "node:crypto";
import { writeActivity } from "./activity";
import { type KnowledgeFeedback, type KnowledgeFeedbackRating, nullableIso } from "./brain-types";
import { getPool } from "./pool";
import { withDatabaseTransaction } from "./transaction";

export async function saveKnowledgeFeedback(input: {
  organizationId: string;
  subjectId: string;
  itemId: string;
  rating: KnowledgeFeedbackRating;
  note: string | null;
}): Promise<{ id: string; status: "pending" | "resolved" }> {
  return withDatabaseTransaction(async (client) => {
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
    return result.rows[0];
  });
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
