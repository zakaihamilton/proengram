import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import {
  openWorkloadTunnel,
  requestWorkloadCredential,
  validateIdentityUrl,
} from "../src/lib/db/workload-tunnel.ts";

const organizationId = process.env.NANOGRES_ORGANIZATION_ID?.trim();
const database = process.env.NANOGRES_DATABASE?.trim();
const role = process.env.NANOGRES_MIGRATION_ROLE?.trim();
const ownerRole = process.env.NANOGRES_MIGRATION_OWNER_ROLE?.trim();
const identityEndpoint =
  process.env.NANOGRES_IDENTITY_URL?.trim() || "https://nanogres.vercel.app/api/workload-identity";
const oidcToken = process.env.VERCEL_OIDC_TOKEN?.trim();

if (!organizationId || !database || !role || !oidcToken) {
  throw new Error(
    "Set Nanogres organization, database, migration role, and Vercel OIDC settings before migrating.",
  );
}
if (ownerRole && !/^[a-z][a-z0-9_]{0,62}$/.test(ownerRole)) {
  throw new Error("NANOGRES_MIGRATION_OWNER_ROLE must be a lowercase PostgreSQL role name.");
}

const endpoint = validateIdentityUrl(identityEndpoint);
const { credential, sshPrivateKey } = await requestWorkloadCredential({
  endpoint,
  oidcToken,
  organizationId,
  database,
  role,
  requiredPooling: "session",
});

const tunnel = await openWorkloadTunnel(credential, sshPrivateKey, {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
});
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: tunnel.port,
  database: credential.database,
  user: credential.user,
  ssl: {
    cert: credential.clientCert,
    key: credential.clientKey,
    servername: credential.tlsServerName,
    rejectUnauthorized: true,
  },
  max: 1,
  connectionTimeoutMillis: 5000,
  application_name: "proengram-migrations",
});
let client;
let lockAcquired = false;
try {
  client = await pool.connect();
  console.log("Connected to the ProEngram database.");
  if (ownerRole) await client.query(`SET ROLE "${ownerRole}"`);
  await client.query("SELECT pg_advisory_lock(hashtext('proengram:migrations')::bigint)");
  lockAcquired = true;
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const appliedResult = await client.query("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => String(row.filename)));
  const migrationDirectory = resolve("db/migrations");
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();
  for (const file of migrationFiles) {
    if (applied.has(file)) {
      console.log(`Skipped db/migrations/${file} (already applied)`);
      continue;
    }
    await client.query(await readFile(resolve(migrationDirectory, file), "utf8"));
    await client.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [file],
    );
    console.log(`Applied db/migrations/${file}`);
  }
} finally {
  try {
    if (lockAcquired && client) {
      await client.query("SELECT pg_advisory_unlock(hashtext('proengram:migrations')::bigint)");
    }
  } finally {
    client?.release();
    try {
      await pool.end();
    } finally {
      tunnel.server.close();
      tunnel.ssh.end();
      tunnel.webSocket.close();
    }
  }
}
