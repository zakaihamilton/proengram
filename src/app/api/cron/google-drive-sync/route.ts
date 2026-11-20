import { authorizeCronRequest } from "@/lib/auth/cron";
import { processGoogleDriveSyncJob } from "@/lib/google-drive/sync-worker";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;
  try {
    const processed = await processGoogleDriveSyncJob();
    return Response.json({ processed });
  } catch {
    console.error("Scheduled Google Drive sync worker failed.");
    return Response.json({ error: "Google Drive sync worker failed." }, { status: 500 });
  }
}
