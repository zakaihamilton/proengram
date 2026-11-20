import type { Pool, PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";

export async function withDatabaseTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  suppliedPool?: Pool,
): Promise<T> {
  const pool = suppliedPool ?? (await getPool());
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
