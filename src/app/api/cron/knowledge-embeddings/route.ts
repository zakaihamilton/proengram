import { authorizeCronRequest } from "@/lib/auth/cron";
import { processKnowledgeEmbeddingJobs } from "@/lib/knowledge/embedding-worker";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;
  try {
    return Response.json(await processKnowledgeEmbeddingJobs());
  } catch {
    console.error("Scheduled knowledge embedding worker failed.");
    return Response.json({ error: "Knowledge embedding worker failed." }, { status: 500 });
  }
}
