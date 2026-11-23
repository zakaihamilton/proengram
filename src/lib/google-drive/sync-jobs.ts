import "server-only";

import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { GoogleDriveApiError } from "./drive-api";

export async function enqueueGoogleDriveSyncJob(input: {
  organizationId: string;
  sourceId: string;
  actorSubjectId?: string | null;
  trigger: "initial" | "poll" | "reconcile";
}): Promise<{ jobId: string; duplicate: boolean }> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<{ id: string; duplicate: boolean }>(
    `INSERT INTO google_drive_sync_jobs
      (id, organization_id, source_id, actor_subject_id, trigger)
     SELECT $1, source.organization_id, source.id,
            coalesce($4, source.updated_by_subject_id, 'system:google-drive-sync'), $5
       FROM google_drive_sources AS source
       JOIN google_drive_accounts AS account
         ON account.organization_id = source.organization_id
      WHERE source.organization_id = $2 AND source.id = $3
        AND source.status = 'active' AND account.status = 'active'
     ON CONFLICT (source_id) WHERE status IN ('pending', 'running')
     DO UPDATE SET
       trigger = CASE
         WHEN EXCLUDED.trigger = 'initial' THEN 'initial'
         WHEN google_drive_sync_jobs.trigger = 'initial' THEN 'initial'
         ELSE EXCLUDED.trigger
       END,
       next_attempt_at = now(), updated_at = now()
     RETURNING id, (xmax::text::bigint > 0) AS duplicate`,
    [
      randomUUID(),
      input.organizationId,
      input.sourceId,
      input.actorSubjectId ?? null,
      input.trigger,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("The Google Drive source is not active for this organization.");
  return { jobId: row.id, duplicate: row.duplicate };
}

export async function enqueueGoogleDriveReconciliationJobs(): Promise<number> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query(
    `INSERT INTO google_drive_sync_jobs
      (id, organization_id, source_id, actor_subject_id, trigger)
     SELECT gen_random_uuid(), source.organization_id, source.id,
            coalesce(source.updated_by_subject_id, 'system:google-drive-sync'), 'reconcile'
       FROM google_drive_sources AS source
       JOIN google_drive_accounts AS account
         ON account.organization_id = source.organization_id
      WHERE source.status = 'active' AND account.status = 'active'
     ON CONFLICT (source_id) WHERE status IN ('pending', 'running')
     DO UPDATE SET
       trigger = CASE
         WHEN google_drive_sync_jobs.trigger = 'initial' THEN 'initial'
         ELSE 'reconcile'
       END,
       next_attempt_at = now(), updated_at = now()
     RETURNING id`,
  );
  await pool.query(
    `DELETE FROM google_drive_sync_jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
        AND completed_at < now() - interval '30 days'`,
  );
  return result.rowCount ?? 0;
}

export async function claimGoogleDriveSyncJob(jobId?: string): Promise<{
  id: string;
  organizationId: string;
  sourceId: string;
  actorSubjectId: string;
  trigger: "initial" | "poll" | "reconcile";
  attemptCount: number;
} | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query(
    `WITH candidate AS (
       SELECT job.id
         FROM google_drive_sync_jobs AS job
         JOIN google_drive_sources AS source
           ON source.id = job.source_id AND source.organization_id = job.organization_id
         JOIN google_drive_accounts AS account
           ON account.organization_id = job.organization_id
        WHERE source.status = 'active' AND account.status = 'active'
          AND (($1::uuid IS NOT NULL AND job.id = $1)
            OR ($1::uuid IS NULL AND job.status = 'pending' AND job.next_attempt_at <= now()))
          AND (job.status = 'pending' OR job.locked_until < now())
        ORDER BY job.next_attempt_at, job.created_at
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1
     )
     UPDATE google_drive_sync_jobs AS job
        SET status = 'running', attempt_count = attempt_count + 1,
            locked_until = now() + interval '15 minutes', started_at = now(),
            updated_at = now(), last_error = NULL
       FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.id, job.organization_id, job.source_id, job.actor_subject_id,
                job.trigger, job.attempt_count`,
    [jobId ?? null],
  );
  const row = result.rows[0] as
    | {
        id: string;
        organization_id: string;
        source_id: string;
        actor_subject_id: string;
        trigger: "initial" | "poll" | "reconcile";
        attempt_count: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        organizationId: row.organization_id,
        sourceId: row.source_id,
        actorSubjectId: row.actor_subject_id,
        trigger: row.trigger,
        attemptCount: row.attempt_count,
      }
    : null;
}

export async function completeGoogleDriveSyncJob(jobId: string): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `UPDATE google_drive_sync_jobs
        SET status = 'succeeded', completed_at = now(), locked_until = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId],
  );
}

export async function failGoogleDriveSyncJob(
  jobId: string,
  attemptCount: number,
  error: unknown,
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const retryDelayMinutes = Math.min(60, 2 ** Math.max(0, attemptCount - 1));
  const message =
    error instanceof GoogleDriveApiError
      ? `${error.message} (HTTP ${error.status})`
      : error instanceof Error
        ? error.message.slice(0, 400)
        : "Google Drive sync failed.";
  await pool.query(
    `UPDATE google_drive_sync_jobs
        SET status = CASE WHEN attempt_count >= 8 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() + ($2::text || ' minutes')::interval,
            locked_until = NULL, last_error = $3, updated_at = now(),
            completed_at = CASE WHEN attempt_count >= 8 THEN now() ELSE NULL END
      WHERE id = $1 AND status = 'running'`,
    [jobId, String(retryDelayMinutes), message],
  );
}
