import { getPool } from "@/lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const pool = getPool();
  if (!pool)
    return Response.json(
      { status: "setup_required" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  try {
    await pool.query("SELECT 1");
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { status: "database_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
