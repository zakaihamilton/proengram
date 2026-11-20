import "server-only";

import { withDatabaseTransaction } from "@/lib/db/transaction";
import { buildSearchableChunks } from "@/lib/knowledge/chunk";
import { embedTexts, EMBEDDING_MODEL_VERSION } from "@/lib/knowledge/embeddings";
import { getPool } from "@/lib/db/pool";

type EmbeddingJob = {
  id: string;
  organization_id: string;
  item_id: string;
  version_id: string;
  attempt_count: number;
};

async function claimEmbeddingJob(excludedIds: string[]): Promise<EmbeddingJob | null> {
  return withDatabaseTransaction(async (client) => {
    const jobResult = await client.query<EmbeddingJob>(
      `SELECT id, organization_id, item_id, version_id, attempt_count
         FROM knowledge_embedding_jobs
        WHERE ((status = 'pending' AND next_attempt_at <= now())
           OR (status = 'running' AND locked_until <= now()))
          AND id <> ALL($1::uuid[])
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [excludedIds],
    );
    const job = jobResult.rows[0];
    if (!job) return null;
    await client.query(
      `UPDATE knowledge_embedding_jobs
          SET status = 'running', locked_until = now() + interval '10 minutes', updated_at = now()
        WHERE id = $1`,
      [job.id],
    );
    return job;
  });
}

async function ensureVersionChunks(job: EmbeddingJob): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const versionResult = await client.query<{
      title: string;
      markdown: string;
    }>(
      `SELECT title, markdown FROM brain_item_versions
        WHERE organization_id = $1 AND item_id = $2 AND id = $3 FOR SHARE`,
      [job.organization_id, job.item_id, job.version_id],
    );
    const version = versionResult.rows[0];
    if (!version) throw new Error("The queued knowledge revision no longer exists.");
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM brain_chunks
        WHERE organization_id = $1 AND item_id = $2 AND version_id = $3
        LIMIT 1`,
      [job.organization_id, job.item_id, job.version_id],
    );
    if (existing.rowCount === 0) {
      const chunks = buildSearchableChunks({ markdown: version.markdown, title: version.title });
      if (chunks.length) {
        await client.query(
          `INSERT INTO brain_chunks
            (id, organization_id, item_id, version_id, ordinal, content, locator)
           SELECT gen_random_uuid(), $1, $2, $3, (entry->>'ordinal')::integer,
                  entry->>'content', nullif(entry->>'locator', '')
             FROM jsonb_array_elements($4::jsonb) AS entry
           ON CONFLICT (version_id, ordinal) DO NOTHING`,
          [job.organization_id, job.item_id, job.version_id, JSON.stringify(chunks)],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function processEmbeddingJob(job: EmbeddingJob): Promise<"complete" | "pending"> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await ensureVersionChunks(job);
  const chunks = await pool.query<{ id: string; content: string }>(
    `SELECT id, content FROM brain_chunks
      WHERE organization_id = $1 AND item_id = $2 AND version_id = $3
        AND embedding_status <> 'ready'
      ORDER BY ordinal
      LIMIT 32`,
    [job.organization_id, job.item_id, job.version_id],
  );
  if (chunks.rows.length) {
    const embeddings = await embedTexts(chunks.rows.map((chunk) => chunk.content));
    const entries = chunks.rows.map((chunk, index) => ({
      id: chunk.id,
      embedding: embeddings[index],
    }));
    if (entries.some((entry) => !entry.embedding)) {
      throw new Error("The local embedding model did not return an embedding for each chunk.");
    }
    await pool.query(
      `UPDATE brain_chunks AS chunk
          SET embedding = (entry->>'embedding')::vector(384),
              embedding_model = $4,
              embedding_status = 'ready'
         FROM jsonb_array_elements($5::jsonb) AS entry
        WHERE chunk.id = (entry->>'id')::uuid
          AND chunk.organization_id = $1
          AND chunk.item_id = $2
          AND chunk.version_id = $3`,
      [
        job.organization_id,
        job.item_id,
        job.version_id,
        EMBEDDING_MODEL_VERSION,
        JSON.stringify(entries),
      ],
    );
  }
  const remaining = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM brain_chunks
      WHERE organization_id = $1 AND item_id = $2 AND version_id = $3
        AND embedding_status <> 'ready'`,
    [job.organization_id, job.item_id, job.version_id],
  );
  if (Number(remaining.rows[0]?.count ?? 0) > 0) {
    await pool.query(
      `UPDATE knowledge_embedding_jobs
          SET status = 'pending', next_attempt_at = now() + interval '2 minutes',
              locked_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [job.id],
    );
    return "pending";
  }
  await pool.query(
    `UPDATE knowledge_embedding_jobs
        SET status = 'succeeded', completed_at = now(), locked_until = NULL,
            last_error = NULL, model_version = $2, updated_at = now()
      WHERE id = $1`,
    [job.id, EMBEDDING_MODEL_VERSION],
  );
  return "complete";
}

async function failEmbeddingJob(job: EmbeddingJob, error: unknown): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  const attempts = job.attempt_count + 1;
  const message = error instanceof Error ? error.name.slice(0, 100) : "Embedding failed.";
  if (attempts >= 8) {
    await pool.query(
      `UPDATE knowledge_embedding_jobs
          SET status = 'failed', attempt_count = $2, locked_until = NULL,
              last_error = $3, model_version = $4, updated_at = now()
        WHERE id = $1`,
      [job.id, attempts, message, EMBEDDING_MODEL_VERSION],
    );
    await pool.query(
      `UPDATE brain_chunks SET embedding_status = 'failed'
        WHERE organization_id = $1 AND item_id = $2 AND version_id = $3
          AND embedding_status <> 'ready'`,
      [job.organization_id, job.item_id, job.version_id],
    );
    return;
  }
  const delayMinutes = Math.min(60, 2 ** attempts);
  await pool.query(
    `UPDATE knowledge_embedding_jobs
        SET status = 'pending', attempt_count = $2,
            next_attempt_at = now() + ($3::text || ' minutes')::interval,
            locked_until = NULL, last_error = $4, model_version = $5, updated_at = now()
      WHERE id = $1`,
    [job.id, attempts, delayMinutes, message, EMBEDDING_MODEL_VERSION],
  );
}

async function queueOutdatedEmbeddings(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await pool.query(
    `UPDATE brain_chunks SET embedding_status = 'pending'
      WHERE embedding_model IS DISTINCT FROM $1 AND embedding_status = 'ready'`,
    [EMBEDDING_MODEL_VERSION],
  );
  await pool.query(
    `INSERT INTO knowledge_embedding_jobs (id, organization_id, item_id, version_id)
     SELECT gen_random_uuid(), item.organization_id, item.id, chunk.version_id
       FROM brain_chunks AS chunk
       JOIN brain_items AS item
         ON item.id = chunk.item_id AND item.organization_id = chunk.organization_id
      WHERE chunk.embedding_model IS DISTINCT FROM $1
      GROUP BY item.organization_id, item.id, chunk.version_id
     ON CONFLICT (organization_id, version_id) DO UPDATE SET
       status = 'pending', attempt_count = 0, next_attempt_at = now(), locked_until = NULL,
       last_error = NULL, model_version = NULL, updated_at = now(), completed_at = NULL
     WHERE knowledge_embedding_jobs.model_version IS DISTINCT FROM $2
       AND knowledge_embedding_jobs.status IN ('succeeded', 'failed')`,
    [EMBEDDING_MODEL_VERSION, EMBEDDING_MODEL_VERSION],
  );
}

export async function processKnowledgeEmbeddingJobs(maxJobs = 8): Promise<{
  processed: number;
  completed: number;
  failed: number;
}> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  await queueOutdatedEmbeddings();
  const excluded: string[] = [];
  let processed = 0;
  let completed = 0;
  let failed = 0;
  while (processed < maxJobs) {
    const job = await claimEmbeddingJob(excluded);
    if (!job) break;
    excluded.push(job.id);
    processed += 1;
    try {
      if ((await processEmbeddingJob(job)) === "complete") completed += 1;
    } catch (error) {
      failed += 1;
      await failEmbeddingJob(job, error);
      console.error("Knowledge embedding job failed.", {
        jobId: job.id,
        organizationId: job.organization_id,
        error: error instanceof Error ? error.name : "Unknown error",
      });
    }
  }
  return { processed, completed, failed };
}
