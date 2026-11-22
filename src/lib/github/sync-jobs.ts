import "server-only";

import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";

export type GitHubSyncTrigger = "initial" | "webhook" | "reconcile";

export type GitHubSyncJob = {
  id: string;
  organizationId: string;
  sourceId: string;
  actorSubjectId: string;
  trigger: GitHubSyncTrigger;
  headSha: string | null;
  attemptCount: number;
};

type GitHubSyncJobRow = {
  id: string;
  organization_id: string;
  source_id: string;
  actor_subject_id: string;
  trigger: GitHubSyncTrigger;
  head_sha: string | null;
  attempt_count: number;
  source_status: string;
  account_status: string | null;
};

function mapJob(row: GitHubSyncJobRow): GitHubSyncJob {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    sourceId: String(row.source_id),
    actorSubjectId: String(row.actor_subject_id),
    trigger: row.trigger,
    headSha: row.head_sha,
    attemptCount: Number(row.attempt_count),
  };
}

export async function enqueueGitHubSyncJob(input: {
  organizationId: string;
  sourceId: string;
  actorSubjectId?: string | null;
  trigger: GitHubSyncTrigger;
  headSha?: string | null;
  deliveryId?: string | null;
}): Promise<{ jobId: string; duplicate: boolean }> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.deliveryId) {
      const delivery = await client.query<{ job_id: string }>(
        `SELECT job_id FROM github_webhook_deliveries WHERE delivery_id = $1 AND source_id = $2`,
        [input.deliveryId, input.sourceId],
      );
      if (delivery.rows[0]) {
        await client.query("COMMIT");
        return { jobId: String(delivery.rows[0].job_id), duplicate: true };
      }
    }

    const job = await client.query<{ id: string }>(
      `INSERT INTO github_sync_jobs
        (id, organization_id, source_id, actor_subject_id, trigger, head_sha)
       SELECT $1,
              source.organization_id,
              source.id,
              COALESCE($4, source.updated_by_subject_id, link.connected_by_subject_id, 'system:github-sync'),
              $5,
              $6
         FROM github_repository_sources AS source
         JOIN github_organization_accounts AS link
           ON link.id = source.organization_account_id
          AND link.organization_id = source.organization_id
         JOIN github_oauth_accounts AS account
           ON account.id = link.github_oauth_account_id
        WHERE source.organization_id = $2
          AND source.id = $3
          AND source.status = 'active'
          AND account.status = 'active'
       ON CONFLICT (source_id) WHERE status IN ('pending', 'running')
       DO UPDATE SET
         trigger = CASE
           WHEN EXCLUDED.trigger = 'webhook' OR github_sync_jobs.trigger <> 'webhook'
             THEN EXCLUDED.trigger
           ELSE github_sync_jobs.trigger
         END,
         head_sha = COALESCE(EXCLUDED.head_sha, github_sync_jobs.head_sha),
         actor_subject_id = EXCLUDED.actor_subject_id,
         next_attempt_at = now(),
         updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        input.organizationId,
        input.sourceId,
        input.actorSubjectId ?? null,
        input.trigger,
        input.headSha ?? null,
      ],
    );
    const jobId = job.rows[0]?.id;
    if (!jobId) throw new Error("The GitHub source is not active for this organization.");

    if (input.deliveryId) {
      const insertedDelivery = await client.query(
        `INSERT INTO github_webhook_deliveries (delivery_id, source_id, job_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (delivery_id, source_id) DO NOTHING
         RETURNING delivery_id`,
        [input.deliveryId, input.sourceId, jobId],
      );
      if (insertedDelivery.rowCount === 0) {
        const existing = await client.query<{ job_id: string }>(
          `SELECT job_id FROM github_webhook_deliveries
            WHERE delivery_id = $1 AND source_id = $2`,
          [input.deliveryId, input.sourceId],
        );
        await client.query("ROLLBACK");
        return {
          jobId: String(existing.rows[0]?.job_id ?? jobId),
          duplicate: true,
        };
      }
    }

    await client.query("COMMIT");
    return { jobId: String(jobId), duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueReconciliationJobs(): Promise<number> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query(
    `INSERT INTO github_sync_jobs
      (id, organization_id, source_id, actor_subject_id, trigger)
     SELECT gen_random_uuid(),
            source.organization_id,
            source.id,
            COALESCE(source.updated_by_subject_id, link.connected_by_subject_id, 'system:github-sync'),
            'reconcile'
       FROM github_repository_sources AS source
       JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.status = 'active'
        AND account.status = 'active'
     ON CONFLICT (source_id) WHERE status IN ('pending', 'running')
     DO UPDATE SET
       trigger = CASE
         WHEN github_sync_jobs.trigger = 'webhook' THEN 'webhook'
         ELSE EXCLUDED.trigger
       END,
       next_attempt_at = now(),
       updated_at = now()
     RETURNING id`,
  );
  await pool.query(
    `DELETE FROM github_webhook_deliveries WHERE received_at < now() - interval '30 days'`,
  );
  return result.rowCount ?? 0;
}

export async function claimGitHubSyncJob(jobId?: string): Promise<GitHubSyncJob | null> {
  return withDatabaseTransaction(async (client) => {
    const result = await client.query<GitHubSyncJobRow>(
      `SELECT job.id,
              job.organization_id,
              job.source_id,
              job.actor_subject_id,
              job.trigger,
              job.head_sha,
              job.attempt_count,
              source.status AS source_status,
              account.status AS account_status
         FROM github_sync_jobs AS job
         JOIN github_repository_sources AS source
           ON source.id = job.source_id
          AND source.organization_id = job.organization_id
         LEFT JOIN github_organization_accounts AS link
           ON link.id = source.organization_account_id
          AND link.organization_id = source.organization_id
         LEFT JOIN github_oauth_accounts AS account
           ON account.id = link.github_oauth_account_id
        WHERE ((job.status = 'pending' AND job.next_attempt_at <= now())
           OR (job.status = 'running' AND job.locked_until <= now()))
          AND ($1::uuid IS NULL OR job.id = $1::uuid)
        ORDER BY job.created_at
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1`,
      [jobId ?? null],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.source_status !== "active" || row.account_status !== "active") {
      await client.query(
        `UPDATE github_sync_jobs
            SET status = 'cancelled',
                locked_until = NULL,
                last_error = 'The repository or GitHub account is no longer active.',
                completed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      return null;
    }
    const claimed = await client.query<GitHubSyncJobRow>(
      `UPDATE github_sync_jobs
          SET status = 'running',
              attempt_count = attempt_count + 1,
              locked_until = now() + interval '10 minutes',
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id = $1
        RETURNING id, organization_id, source_id, actor_subject_id, trigger,
                  head_sha, attempt_count,
                  'active'::text AS source_status,
                  'active'::text AS account_status`,
      [row.id],
    );
    return claimed.rows[0] ? mapJob(claimed.rows[0]) : null;
  });
}

export async function completeGitHubSyncJob(
  jobId: string,
  processedHeadSha: string,
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `UPDATE github_sync_jobs
        SET status = CASE
              WHEN head_sha IS NOT NULL AND head_sha <> $2 THEN 'pending'
              ELSE 'succeeded'
            END,
            head_sha = COALESCE(head_sha, $2),
            attempt_count = CASE
              WHEN head_sha IS NOT NULL AND head_sha <> $2 THEN 0
              ELSE attempt_count
            END,
            next_attempt_at = now(),
            locked_until = NULL,
            last_error = NULL,
            completed_at = CASE
              WHEN head_sha IS NOT NULL AND head_sha <> $2 THEN NULL
              ELSE now()
            END,
            updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId, processedHeadSha],
  );
}

export async function failGitHubSyncJob(
  jobId: string,
  attemptCount: number,
  error: unknown,
): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const message = error instanceof Error ? error.message.slice(0, 400) : "GitHub sync failed.";
  const terminal = attemptCount >= 5;
  const delaySeconds = Math.min(3600, 60 * 5 ** Math.max(0, attemptCount - 1));
  await pool.query(
    `UPDATE github_sync_jobs
        SET status = $2,
            next_attempt_at = now() + make_interval(secs => $3),
            locked_until = NULL,
            last_error = $4,
            completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId, terminal ? "failed" : "pending", delaySeconds, message],
  );
}
