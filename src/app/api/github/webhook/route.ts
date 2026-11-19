import { after } from "next/server";
import { enqueueGitHubSyncJob } from "@/lib/github/sync-jobs";
import {
  listGitHubWebhookSources,
  type GitHubWebhookSource,
} from "@/lib/github/github";
import { processGitHubSyncJob } from "@/lib/github/sync-worker";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-api";
import { getPool } from "@/lib/db/pool";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_WEBHOOK_BODY_BYTES = 5_000_000;

type GitHubPushPayload = {
  after?: unknown;
  deleted?: unknown;
  ref?: unknown;
  repository?: {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  };
};

function matchesSourceRepository(source: GitHubWebhookSource, payload: GitHubPushPayload): boolean {
  const repository = payload.repository;
  if (!repository) return false;
  if (source.repositoryId && repository.id !== undefined) {
    return String(repository.id) === source.repositoryId;
  }
  return (
    typeof repository.full_name === "string" &&
    repository.full_name.toLowerCase() === `${source.owner}/${source.repository}`.toLowerCase()
  );
}

function response(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength);
}

export async function POST(request: Request): Promise<Response> {
  const hookId = request.headers.get("x-github-hook-id")?.trim();
  const event = request.headers.get("x-github-event")?.trim();
  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  if (!hookId || !event) return response(400);

  let sources: GitHubWebhookSource[];
  try {
    sources = await listGitHubWebhookSources(hookId);
  } catch {
    console.error("GitHub webhook source lookup failed.");
    return response(503);
  }
  if (!sources.length) return response(202);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) return response(413);

  let rawBody: Buffer | null;
  try {
    rawBody = await readBodyWithinLimit(request, MAX_WEBHOOK_BODY_BYTES);
  } catch {
    return response(400);
  }
  if (!rawBody) return response(413);
  if (!verifyGitHubWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"), sources[0].secret)) {
    return response(401);
  }
  if (event === "ping") return Response.json({ received: true }, { status: 200 });
  if (event !== "push") return response(202);
  if (!deliveryId || deliveryId.length > 100) return response(400);

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GitHubPushPayload;
  } catch {
    return response(400);
  }
  if (payload.deleted === true || typeof payload.ref !== "string") return response(202);
  if (typeof payload.after !== "string" || !/^[a-f0-9]{40,64}$/i.test(payload.after)) {
    return response(202);
  }

  const pool = await getPool();
  if (!pool) return response(503);
  const jobIds: string[] = [];
  try {
    for (const source of sources) {
      if (!matchesSourceRepository(source, payload)) continue;
      const defaultBranch =
        typeof payload.repository?.default_branch === "string"
          ? payload.repository.default_branch
          : source.defaultBranch;
      if (payload.ref !== `refs/heads/${defaultBranch}`) continue;
      if (defaultBranch !== source.defaultBranch) {
        await pool.query(
          `UPDATE github_repository_sources
              SET default_branch = $3,
                  last_synced_commit_sha = NULL,
                  updated_at = now()
            WHERE organization_id = $1 AND id = $2 AND status = 'active'`,
          [source.organizationId, source.id, defaultBranch],
        );
      }
      const queued = await enqueueGitHubSyncJob({
        organizationId: source.organizationId,
        sourceId: source.id,
        actorSubjectId: source.actorSubjectId,
        trigger: "webhook",
        headSha: payload.after,
        deliveryId,
      });
      jobIds.push(queued.jobId);
    }
  } catch {
    console.error("GitHub push event could not be queued for synchronization.");
    return response(503);
  }

  if (jobIds.length) {
    after(async () => {
      await Promise.all(
        [...new Set(jobIds)].map((jobId) => processGitHubSyncJob(jobId).catch(() => false)),
      );
    });
  }
  return Response.json({ received: true, queued: jobIds.length }, { status: 202 });
}
