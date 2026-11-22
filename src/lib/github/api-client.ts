import "server-only";

export const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
export const MAX_MARKDOWN_BYTES = 300_000;

export function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "Content-Type": "application/json",
  };
}

export async function githubJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { ...githubHeaders(token), ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body ? body.message : undefined;
    throw new Error(`GitHub request failed${message ? `: ${message}` : ""}.`);
  }
  if (body === null) throw new Error("GitHub returned an empty response.");
  return body as T;
}

export function apiPath(source: { owner: string; repository: string }, suffix: string): string {
  return `${GITHUB_API_ROOT}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}${suffix}`;
}
