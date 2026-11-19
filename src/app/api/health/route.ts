import { getPool, isDatabaseConfigured } from "@/lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!isDatabaseConfigured())
    return Response.json(
      { status: "setup_required" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const pool = await getPool();
    if (!pool) throw new Error("Nanogres workload identity is not configured.");
    await pool.query("SELECT 1");
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(
      "ProEngram database health check failed",
      error instanceof Error ? `${error.name}: ${error.message}` : "Unknown database error",
    );
    return Response.json(
      { status: "database_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
