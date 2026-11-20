import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

function headers(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json",
  };
}

function repositoryPath(owner: string, repository: string): string {
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/hooks`;
}

export async function createGitHubRepositoryWebhook(input: {
  token: string;
  owner: string;
  repository: string;
  callbackUrl: string;
  secret: string;
}): Promise<string> {
  const response = await fetch(repositoryPath(input.owner, input.repository), {
    method: "POST",
    headers: headers(input.token),
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: input.callbackUrl,
        content_type: "json",
        secret: input.secret,
        insecure_ssl: "0",
      },
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as {
    id?: number | string;
    message?: unknown;
  } | null;
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(`GitHub could not create the repository webhook: ${message}`);
  }
  if (body?.id === undefined || body.id === null) {
    throw new Error("GitHub returned a webhook without an ID.");
  }
  return String(body.id);
}

export async function deleteGitHubRepositoryWebhook(input: {
  token: string;
  owner: string;
  repository: string;
  webhookId: string;
}): Promise<void> {
  const response = await fetch(
    `${repositoryPath(input.owner, input.repository)}/${encodeURIComponent(input.webhookId)}`,
    {
      method: "DELETE",
      headers: headers(input.token),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(`GitHub could not remove the repository webhook: ${message}`);
  }
}

export function verifyGitHubWebhookSignature(
  rawBody: string | Buffer,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
