import net, { type AddressInfo, type Server } from "node:net";
import ssh2, { Client as SshClient, type ClientChannel } from "ssh2";
import WebSocket, { createWebSocketStream } from "ws";

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
  pooling?: string;
};

type WorkloadTunnel = {
  server: Server;
  port: number;
  ssh: SshClient;
  webSocket: WebSocket;
  isOpen: () => boolean;
};

type TunnelLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export function validateIdentityUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("NANOGRES_IDENTITY_URL must be a clean HTTPS URL.");
  }
  return url.toString();
}

export async function requestWorkloadCredential(input: {
  endpoint: string;
  oidcToken: string;
  organizationId: string;
  database: string;
  role: string;
  requiredPooling?: "session" | "transaction";
}): Promise<{
  credential: WorkloadCredential;
  sshPrivateKey: string;
}> {
  const keyPair = ssh2.utils.generateKeyPairSync("ed25519");
  const sshPublicKey = keyPair.public;
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.oidcToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organizationId: input.organizationId,
      database: input.database,
      role: input.role,
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
  if (input.requiredPooling && credential.pooling !== input.requiredPooling) {
    throw new Error("Nanogres returned an unexpected workload pooling mode.");
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

export async function openWorkloadTunnel(
  credential: WorkloadCredential,
  sshPrivateKey: string,
  logger?: TunnelLogger,
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
    logger?.log?.("Connected to the Nanogres workload WebSocket gateway.");

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
          logger?.log?.("Authenticated to the Nanogres workload SSH gateway.");
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
        logger?.log?.("Opening the database channel through the SSH tunnel.");
        ssh.forwardOut(
          "127.0.0.1",
          0,
          credential.host,
          credential.port,
          (error, channel: ClientChannel) => {
            if (error) {
              logger?.error?.("The SSH gateway could not open the database channel.");
              localSocket.destroy(error);
              return;
            }
            logger?.log?.("Database channel opened through the SSH tunnel.");
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
