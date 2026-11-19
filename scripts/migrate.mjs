import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import ssh2 from "ssh2";
import { Client as SshClient } from "ssh2";
import WebSocket, { createWebSocketStream } from "ws";

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

const identityUrl = new URL(identityEndpoint);
if (
  identityUrl.protocol !== "https:" ||
  identityUrl.username ||
  identityUrl.password ||
  identityUrl.search ||
  identityUrl.hash
) {
  throw new Error("NANOGRES_IDENTITY_URL must be a clean HTTPS URL.");
}

async function openWorkloadTunnel(credential, sshPrivateKey) {
  const url = new URL(credential.sshPath, `wss://${credential.sshHost}:${credential.sshPort}`);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Nanogres returned an invalid SSH WebSocket address.");
  }

  const webSocket = new WebSocket(url, {
    followRedirects: false,
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
  });
  try {
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        webSocket.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        webSocket.off("open", onOpen);
        reject(error);
      };
      webSocket.once("open", onOpen);
      webSocket.once("error", onError);
    });
    console.log("Connected to the Nanogres workload WebSocket gateway.");

    const ssh = new SshClient();
    const transport = createWebSocketStream(webSocket);
    try {
      await new Promise((resolve, reject) => {
        const onReady = () => {
          ssh.off("error", onError);
          console.log("Authenticated to the Nanogres workload SSH gateway.");
          resolve();
        };
        const onError = (error) => {
          ssh.off("ready", onReady);
          reject(error);
        };
        ssh.once("ready", onReady);
        ssh.once("error", onError);
        ssh.connect({
          sock: transport,
          host: credential.sshHost,
          port: credential.sshPort,
          username: credential.sshUsername,
          privateKey: sshPrivateKey,
          hostHash: "sha256",
          hostVerifier: (hash) => {
            const fingerprint = typeof hash === "string" ? hash : hash.toString("hex");
            return fingerprint.toLowerCase() === credential.sshHostKeySha256.toLowerCase();
          },
          readyTimeout: 10_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
        });
      });

      const server = net.createServer((localSocket) => {
        console.log("Opening the database channel through the SSH tunnel.");
        ssh.forwardOut("127.0.0.1", 0, credential.host, credential.port, (error, channel) => {
          if (error) {
            console.error("The SSH gateway could not open the database channel.");
            localSocket.destroy(error);
            return;
          }
          console.log("Database channel opened through the SSH tunnel.");
          localSocket.on("error", () => channel.destroy());
          channel.on("error", () => localSocket.destroy());
          localSocket.on("close", () => channel.close());
          channel.on("close", () => localSocket.destroy());
          localSocket.pipe(channel).pipe(localSocket);
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw new Error("The local SSH tunnel did not receive a TCP port.");
      }
      return { server, port: address.port, ssh, webSocket };
    } catch (error) {
      ssh.end();
      transport.destroy();
      throw error;
    }
  } catch (error) {
    webSocket.terminate();
    throw error;
  }
}

const keyPair = ssh2.utils.generateKeyPairSync("ed25519");
const sshPublicKey = keyPair.public;
const credentialResponse = await fetch(identityUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${oidcToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ organizationId, database, role, sshPublicKey }),
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
  typeof credential.tlsServerName !== "string" ||
  typeof credential.sshHost !== "string" ||
  typeof credential.sshPort !== "number" ||
  typeof credential.sshPath !== "string" ||
  typeof credential.sshUsername !== "string" ||
  typeof credential.sshHostKeySha256 !== "string" ||
  Date.parse(credential.expiresAt) <= Date.now() + 60_000 ||
  credential.pooling !== "session"
) {
  throw new Error("Nanogres returned an invalid migration certificate.");
}
if (
  credential.host !== "127.0.0.1" ||
  !Number.isInteger(credential.port) ||
  credential.port < 1 ||
  credential.port > 65535 ||
  credential.sshPort !== 8443 ||
  credential.sshPath !== "/_nanogres/workload-ssh" ||
  !/^[a-f0-9]{64}$/i.test(credential.sshHostKeySha256)
) {
  throw new Error("Nanogres returned an invalid migration SSH endpoint.");
}

const tunnel = await openWorkloadTunnel(credential, keyPair.private);
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
  const migrationDirectory = resolve("db/migrations");
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();
  for (const file of migrationFiles) {
    if (file === "003_github_user_connections.sql") {
      const legacyOrganizationId = process.env.PERMINISTER_ORGANIZATION_ID?.trim().toLowerCase();
      const legacyInstallationId = process.env.GITHUB_INSTALLATION_ID?.trim();
      const legacyOwner = process.env.GITHUB_REPO_OWNER?.trim();
      const legacyRepository = process.env.GITHUB_REPO_NAME?.trim();
      if (legacyOrganizationId && legacyInstallationId && legacyOwner && legacyRepository) {
        await client.query(
          `INSERT INTO github_repository_settings
            (organization_id, installation_id, repository_owner, repository_name, default_branch)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organization_id) DO NOTHING`,
          [
            legacyOrganizationId,
            legacyInstallationId,
            legacyOwner,
            legacyRepository,
            process.env.GITHUB_DEFAULT_BRANCH?.trim() || "main",
          ],
        );
        console.log("Backfilled the legacy GitHub repository before migrating its connection.");
      }
    }
    await client.query(await readFile(resolve(migrationDirectory, file), "utf8"));
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
