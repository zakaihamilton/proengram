import "server-only";

import net, { type AddressInfo, type Server } from "node:net";
import { headers } from "next/headers";
import { Pool } from "pg";
import * as ssh2 from "ssh2";
import { Client as SshClient, type ClientChannel } from "ssh2";
import WebSocket, { createWebSocketStream } from "ws";

export type DatabaseConnectionKind = "runtime" | "migration";

type WorkloadCredential = {
  clientCert: string;
  clientKey: string;
  expiresAt: string;
  host: string;
  port: number;
  user: string;
  database: string;
  tlsServerName: string;
  sshHost: string;
  sshPort: number;
  sshPath: string;
  sshUsername: string;
  sshHostKeySha256: string;
};

type WorkloadTunnel = {
  server: Server;
  port: number;
  ssh: SshClient;
  webSocket: WebSocket;
  isOpen: () => boolean;
};
type PoolHandle = {
  pool: Pool;
  expiresAt: number;
  reuseUntil: number;
  isOpen: () => boolean;
  close: () => Promise<void>;
};

const pools = new Map<DatabaseConnectionKind, PoolHandle>();
const pending = new Map<DatabaseConnectionKind, Promise<Pool | null>>();

function configuration(kind: DatabaseConnectionKind) {
  const organizationId = process.env.NANOGRES_ORGANIZATION_ID?.trim();
  const database = process.env.NANOGRES_DATABASE?.trim();
  const role =
    kind === "runtime"
      ? process.env.NANOGRES_RUNTIME_ROLE?.trim()
      : process.env.NANOGRES_MIGRATION_ROLE?.trim();
  const endpoint =
    process.env.NANOGRES_IDENTITY_URL?.trim() ||
    "https://nanogres.vercel.app/api/workload-identity";
  if (!organizationId || !database || !role) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("NANOGRES_IDENTITY_URL must be a clean HTTPS URL.");
  }
  return { organizationId, database, role, endpoint: url.toString() };
}

async function getVercelOidcToken(): Promise<string> {
  const fromEnvironment = process.env.VERCEL_OIDC_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const fromRequest = (await headers()).get("x-vercel-oidc-token")?.trim();
    if (fromRequest) return fromRequest;
  } catch {
    // Scripts use Vercel's build-time OIDC token from the environment.
  }
  throw new Error("A Vercel workload token is required for Nanogres access.");
}

async function requestCredential(kind: DatabaseConnectionKind): Promise<{
  credential: WorkloadCredential;
  sshPrivateKey: string;
}> {
  const target = configuration(kind);
  if (!target) throw new Error("Nanogres workload identity is not configured.");
  const keyPair = ssh2.utils.generateKeyPairSync("ed25519");
  const sshPublicKey = keyPair.public;
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getVercelOidcToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organizationId: target.organizationId,
      database: target.database,
      role: target.role,
      sshPublicKey,
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Nanogres workload identity exchange failed (${response.status}).`);
  }
  const credential = (await response.json()) as Partial<WorkloadCredential>;
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
    typeof credential.sshHostKeySha256 !== "string"
  ) {
    throw new Error("Nanogres returned invalid workload SSH credentials.");
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
    throw new Error("Nanogres returned an invalid workload SSH endpoint.");
  }
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    throw new Error("Nanogres returned an expired workload certificate.");
  }
  return { credential: credential as WorkloadCredential, sshPrivateKey: keyPair.private };
}

async function openWorkloadTunnel(
  credential: WorkloadCredential,
  sshPrivateKey: string,
): Promise<WorkloadTunnel> {
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
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        webSocket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        webSocket.off("open", onOpen);
        reject(error);
      };
      webSocket.once("open", onOpen);
      webSocket.once("error", onError);
    });

    const ssh = new SshClient();
    const transport = createWebSocketStream(webSocket);
    let connected = true;
    const markDisconnected = () => {
      connected = false;
    };
    ssh.on("close", markDisconnected);
    ssh.on("end", markDisconnected);
    ssh.on("error", markDisconnected);
    transport.on("close", markDisconnected);
    transport.on("error", markDisconnected);
    webSocket.on("close", markDisconnected);
    webSocket.on("error", markDisconnected);
    try {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          ssh.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
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
          hostVerifier: (hash: Buffer | string) => {
            const fingerprint = typeof hash === "string" ? hash : hash.toString("hex");
            return fingerprint.toLowerCase() === credential.sshHostKeySha256.toLowerCase();
          },
          readyTimeout: 10_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
        });
      });

      const server = net.createServer((localSocket) => {
        ssh.forwardOut(
          "127.0.0.1",
          0,
          credential.host,
          credential.port,
          (error, channel: ClientChannel) => {
            if (error) {
              localSocket.destroy(error);
              return;
            }
            localSocket.on("error", () => channel.destroy());
            channel.on("error", () => localSocket.destroy());
            localSocket.on("close", () => channel.close());
            channel.on("close", () => localSocket.destroy());
            localSocket.pipe(channel).pipe(localSocket);
          },
        );
      });
      await new Promise<void>((resolve, reject) => {
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
      return {
        server,
        port: (address as AddressInfo).port,
        ssh,
        webSocket,
        isOpen: () => connected && webSocket.readyState === WebSocket.OPEN,
      };
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

export function isDatabaseConfigured(): boolean {
  return configuration("runtime") !== null;
}

export async function getPool(kind: DatabaseConnectionKind = "runtime"): Promise<Pool | null> {
  if (!configuration(kind)) return null;
  const inProgress = pending.get(kind);
  if (inProgress) return inProgress;

  const existing = pools.get(kind);
  const now = Date.now();
  if (
    existing &&
    existing.expiresAt > now + 60_000 &&
    existing.reuseUntil > now &&
    existing.isOpen()
  ) {
    existing.reuseUntil = now + 60_000;
    return existing.pool;
  }

  const next = (async () => {
    if (existing) {
      if (pools.get(kind) === existing) pools.delete(kind);
      await existing.close();
    }

    const { credential, sshPrivateKey } = await requestCredential(kind);
    const tunnel = await openWorkloadTunnel(credential, sshPrivateKey);
    const pool = new Pool({
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
      max: kind === "runtime" ? 5 : 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      maxLifetimeSeconds: 600,
      application_name: `proengram-${kind}`,
    });
    let closed = false;
    const handle: PoolHandle = {
      pool,
      expiresAt: Date.parse(credential.expiresAt),
      reuseUntil: Date.now() + 60_000,
      isOpen: tunnel.isOpen,
      close: async () => {
        if (closed) return;
        closed = true;
        await pool.end().catch(() => undefined);
        tunnel.server.close();
        if (tunnel.isOpen()) tunnel.ssh.end();
        if (tunnel.webSocket.readyState === WebSocket.OPEN) tunnel.webSocket.close();
      },
    };
    const invalidate = () => {
      if (pools.get(kind) !== handle) return;
      pools.delete(kind);
      void handle.close();
    };
    tunnel.ssh.once("close", invalidate);
    tunnel.webSocket.once("close", invalidate);
    tunnel.webSocket.once("error", invalidate);
    pool.on("error", invalidate);
    pools.set(kind, handle);
    return pool;
  })().finally(() => pending.delete(kind));
  pending.set(kind, next);
  return next;
}

export async function endDatabasePools(): Promise<void> {
  const active = Array.from(pools.values());
  pools.clear();
  await Promise.all(active.map((handle) => handle.close()));
}
