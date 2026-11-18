import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const organizationId = process.env.NANOGRES_ORGANIZATION_ID?.trim();
const database = process.env.NANOGRES_DATABASE?.trim();
const role = process.env.NANOGRES_MIGRATION_ROLE?.trim();
const ownerRole = process.env.NANOGRES_MIGRATION_OWNER_ROLE?.trim();
const identityEndpoint =
  process.env.NANOGRES_IDENTITY_URL?.trim() ||
  "https://nanogres.vercel.app/api/workload-identity";
const oidcToken = process.env.VERCEL_OIDC_TOKEN?.trim();

if (!organizationId || !database || !role || !oidcToken) {
  throw new Error(
    "Set Nanogres organization, database, migration role, and Vercel OIDC settings before migrating.",
  );
}
if (ownerRole && !/^[a-z][a-z0-9_]{0,62}$/.test(ownerRole)) {
  throw new Error("NANOGRES_MIGRATION_OWNER_ROLE must be a lowercase PostgreSQL role name.");
}

const identityUrl = new URL(identityEndpoint);
if (identityUrl.protocol !== "https:" || identityUrl.username || identityUrl.password || identityUrl.search || identityUrl.hash) {
  throw new Error("NANOGRES_IDENTITY_URL must be a clean HTTPS URL.");
}

const credentialResponse = await fetch(identityUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${oidcToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ organizationId, database, role }),
  cache: "no-store",
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
if (!credentialResponse.ok) {
  throw new Error(`Nanogres migration identity exchange failed (${credentialResponse.status}).`);
}
const credential = await credentialResponse.json();
if (
  typeof credential.clientCert !== "string" ||
  typeof credential.clientKey !== "string" ||
  typeof credential.expiresAt !== "string" ||
  typeof credential.host !== "string" ||
  typeof credential.port !== "number" ||
  typeof credential.user !== "string" ||
  typeof credential.database !== "string" ||
  Date.parse(credential.expiresAt) <= Date.now() + 60_000 ||
  credential.pooling !== "session"
) {
  throw new Error("Nanogres returned an invalid migration certificate.");
}

const pool = new pg.Pool({
    host: credential.host,
    port: credential.port,
    database: credential.database,
    user: credential.user,
    ssl: {
      cert: credential.clientCert,
      key: credential.clientKey,
      rejectUnauthorized: true,
    },
    max: 1,
    connectionTimeoutMillis: 5000,
    application_name: "proengram-migrations",
  });
const client = await pool.connect();
let lockAcquired = false;
try {
  if (ownerRole) await client.query(`SET ROLE "${ownerRole}"`);
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
