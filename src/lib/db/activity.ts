import "server-only";

import type { PoolClient } from "pg";
import { getPool } from "./pool";

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
