import "server-only";

import { syncGitHubMarkdown } from "./github";
import {
  claimGitHubSyncJob,
  completeGitHubSyncJob,
  failGitHubSyncJob,
} from "./sync-jobs";

export async function processGitHubSyncJob(jobId?: string): Promise<boolean> {
  const job = await claimGitHubSyncJob(jobId);
  if (!job) return false;

  try {
    const result = await syncGitHubMarkdown(job.organizationId, job.sourceId, job.actorSubjectId, {
      commitSha: job.headSha ?? undefined,
      skipIfUnchanged: true,
    });
    await completeGitHubSyncJob(job.id, result.commitSha);
    return true;
  } catch (error) {
    await failGitHubSyncJob(job.id, job.attemptCount, error);
    console.error("Queued GitHub repository sync failed.");
    return true;
  }
}
