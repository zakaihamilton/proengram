import { authorizeCronRequest } from "@/lib/auth/cron";
import { repairGitHubRepositoryWebhooks } from "@/lib/github/github";
import { enqueueReconciliationJobs } from "@/lib/github/sync-jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;

  try {
    const queued = await enqueueReconciliationJobs();
    const webhooks = await repairGitHubRepositoryWebhooks();
    return Response.json({
      queued,
      webhooksChecked: webhooks.checked,
      webhooksActive: webhooks.active,
    });
  } catch {
    console.error("Scheduled GitHub reconciliation failed.");
    return Response.json({ error: "GitHub reconciliation failed." }, { status: 500 });
  }
}
