import { processGitHubSyncJob } from "@/lib/github/sync-worker";

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
    const processed = await processGitHubSyncJob();
    return Response.json({ processed });
  } catch {
    console.error("Scheduled GitHub sync worker failed.");
    return Response.json({ error: "GitHub sync worker failed." }, { status: 500 });
  }
}
