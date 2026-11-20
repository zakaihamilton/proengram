import { authorizeCronRequest } from "@/lib/auth/cron";
import { enqueueGoogleDriveReconciliationJobs } from "@/lib/google-drive/connections";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;
  try {
    const queued = await enqueueGoogleDriveReconciliationJobs();
    return Response.json({ queued });
  } catch {
    console.error("Scheduled Google Drive reconciliation failed.");
    return Response.json({ error: "Google Drive reconciliation failed." }, { status: 500 });
  }
}
