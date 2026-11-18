import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import { Client as SshClient } from "ssh2";
import WebSocket, { createWebSocketStream } from "ws";

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
if (
  identityUrl.protocol !== "https:" ||
  identityUrl.username ||
  identityUrl.password ||
  identityUrl.search ||
  identityUrl.hash
) {
  throw new Error("NANOGRES_IDENTITY_URL must be a clean HTTPS URL.");
}

function sshPublicKeyFromSpki(spki) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (spki.length !== prefix.length + 32 || !spki.subarray(0, prefix.length).equals(prefix)) {
    throw new Error("The generated SSH key was not Ed25519.");
  }
  const algorithm = Buffer.from("ssh-ed25519");
  const algorithmLength = Buffer.alloc(4);
  algorithmLength.writeUInt32BE(algorithm.length);
  const publicKeyBytes = spki.subarray(prefix.length);
  const publicKeyLength = Buffer.alloc(4);
  publicKeyLength.writeUInt32BE(publicKeyBytes.length);
  const encoded = Buffer.concat([
    algorithmLength,
    algorithm,
    publicKeyLength,
    publicKeyBytes,
  ]).toString("base64");
  return "ssh-ed25519 " + encoded;
}

async function openWorkloadTunnel(credential, sshPrivateKey) {
  const address = new URL(
    credential.sshPath,
    "wss://" + credential.sshHost + ":" + credential.sshPort,
  );
  if (
    address.protocol !== "wss:" ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  ) {
    throw new Error("Nanogres returned an invalid SSH WebSocket address.");
  }

  const webSocket = new WebSocket(address, {
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

    const ssh = new SshClient();
    const transport = createWebSocketStream(webSocket);
    try {
      await new Promise((resolve, reject) => {
        const onReady = () => {
          ssh.off("error", onError);
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
        ssh.forwardOut("127.0.0.1", 0, credential.host, credential.port, (error, channel) => {
          if (error) {
            localSocket.destroy(error);
            return;
          }
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
      const localAddress = server.address();
      if (!localAddress || typeof localAddress === "string") {
        server.close();
        throw new Error("The local SSH tunnel did not receive a TCP port.");
      }
      return { server, port: localAddress.port, ssh, webSocket };
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

async function closeWorkloadTunnel(tunnel) {
  if (!tunnel) return;
  await new Promise((resolve) => tunnel.server.close(() => resolve()));
  tunnel.ssh.end();
  tunnel.webSocket.close();
}

const keyPair = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "der", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
if (!Buffer.isBuffer(keyPair.publicKey) || typeof keyPair.privateKey !== "string") {
  throw new Error("The generated SSH keypair could not be encoded.");
}

const credentialResponse = await fetch(identityUrl, {
  method: "POST",
  headers: {
    Authorization: "Bearer " + oidcToken,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    organizationId,
    database,
    role,
    sshPublicKey: sshPublicKeyFromSpki(keyPair.publicKey),
  }),
  cache: "no-store",
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
if (!credentialResponse.ok) {
  throw new Error(
    "Nanogres migration identity exchange failed (" + credentialResponse.status + ").",
  );
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
  credential.pooling !== "session" ||
  credential.host !== "127.0.0.1" ||
  !Number.isInteger(credential.port) ||
  credential.port < 1 ||
  credential.port > 65535 ||
  credential.sshPort !== 8443 ||
  credential.sshPath !== "/_nanogres/workload-ssh" ||
  !/^[a-f0-9]{64}$/i.test(credential.sshHostKeySha256)
) {
  throw new Error("Nanogres returned invalid migration SSH credentials.");
}

const tunnel = await openWorkloadTunnel(credential, keyPair.privateKey);
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
  if (ownerRole) await client.query('SET ROLE "' + ownerRole + '"');
  await client.query("SELECT pg_advisory_lock(hashtext('proengram:migrations')::bigint)");
  lockAcquired = true;
  const sql = await readFile(resolve("db/migrations/001_initial.sql"), "utf8");
  await client.query(sql);
  console.log("Applied db/migrations/001_initial.sql");
} finally {
  try {
    if (client && lockAcquired) {
      await client.query("SELECT pg_advisory_unlock(hashtext('proengram:migrations')::bigint)");
    }
  } finally {
    client?.release();
    await pool.end();
    await closeWorkloadTunnel(tunnel);
  }
}
