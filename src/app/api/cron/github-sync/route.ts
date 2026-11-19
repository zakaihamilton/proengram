import { authorizeCronRequest } from "@/lib/auth/cron";
import { processGitHubSyncJob } from "@/lib/github/sync-worker";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;

  try {
    const processed = await processGitHubSyncJob();
    return Response.json({ processed });
  } catch {
    console.error("Scheduled GitHub sync worker failed.");
    return Response.json({ error: "GitHub sync worker failed." }, { status: 500 });
  }
}
