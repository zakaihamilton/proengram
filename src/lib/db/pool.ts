import "server-only";

import { headers } from "next/headers";
import { Pool } from "pg";
import WebSocket from "ws";
import {
  openWorkloadTunnel,
  requestWorkloadCredential,
  validateIdentityUrl,
} from "./workload-tunnel";

export type DatabaseConnectionKind = "runtime" | "migration";

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
  return {
    organizationId,
    database,
    role,
    endpoint: validateIdentityUrl(endpoint),
  };
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

export function isDatabaseConfigured(): boolean {
  return configuration("runtime") !== null;
}

export async function getPool(kind: DatabaseConnectionKind = "runtime"): Promise<Pool | null> {
  const target = configuration(kind);
  if (!target) return null;
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

    const oidcToken = await getVercelOidcToken();
    const { credential, sshPrivateKey } = await requestWorkloadCredential({
      ...target,
      oidcToken,
      requiredPooling: kind === "runtime" ? "transaction" : "session",
    });
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
