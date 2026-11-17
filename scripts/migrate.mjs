import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
const connectionString = migrationUrl || process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("Set MIGRATION_DATABASE_URL or DATABASE_URL for the ProEngram Nanogres database.");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: true },
    application_name: "proengram-migrations",
  });
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('proengram:migrations')::bigint)");
    lockAcquired = true;
    const sql = await readFile(resolve("db/migrations/001_initial.sql"), "utf8");
    await client.query(sql);
    console.log("Applied db/migrations/001_initial.sql");
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext('proengram:migrations')::bigint)");
      }
    } finally {
      client.release();
      await pool.end();
    }
  }
}
