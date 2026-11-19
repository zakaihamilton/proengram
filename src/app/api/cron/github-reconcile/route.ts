import { repairGitHubRepositoryWebhooks } from "@/lib/github/github";
import { enqueueReconciliationJobs } from "@/lib/github/sync-jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export async function GET(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET?.trim()) {
    return Response.json({ error: "Cron authorization is not configured." }, { status: 503 });
  }
  if (!cronAuthorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const queued = await enqueueReconciliationJobs();
    const webhooks = await repairGitHubRepositoryWebhooks();
    return Response.json({ queued, webhooksChecked: webhooks.checked, webhooksActive: webhooks.active });
  } catch {
    console.error("Scheduled GitHub reconciliation failed.");
    return Response.json({ error: "GitHub reconciliation failed." }, { status: 500 });
  }
}
