import "server-only";

import { getPublicOrigin } from "@/lib/auth/config";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

export type GitHubOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GitHubUserToken = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
};

export type GitHubAccountProfile = {
  id: string;
  login: string;
  avatarUrl: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
};

export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function getGitHubOAuthConfiguration(): GitHubOAuthConfiguration {
  return {
    clientId: requiredSetting("GITHUB_APP_CLIENT_ID"),
    clientSecret: requiredSetting("GITHUB_APP_CLIENT_SECRET"),
    redirectUri: new URL("/auth/github/callback", getPublicOrigin()).toString(),
  };
}

export async function createGitHubAuthorizationUrl(input: {
  state: string;
  codeChallenge: string;
  login?: string;
}): Promise<URL> {
  const { clientId, redirectUri } = getGitHubOAuthConfiguration();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", "offline_access");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  if (input.login && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.login)) {
    url.searchParams.set("login", input.login);
  }
  url.searchParams.set("allow_signup", "false");
  return url;
}

async function requestUserToken(body: URLSearchParams): Promise<GitHubUserToken> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = (await response.json().catch(() => null)) as TokenResponse | null;
  if (
    !response.ok ||
    !result ||
    result.error ||
    !result.access_token ||
    !result.refresh_token ||
    !Number.isFinite(result.expires_in) ||
    !Number.isFinite(result.refresh_token_expires_in)
  ) {
    throw new GitHubOAuthError(
      "GitHub did not return an expiring user token and refresh token.",
      result?.error ?? null,
    );
  }
  const now = Date.now();
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    accessTokenExpiresAt: new Date(now + (result.expires_in as number) * 1000),
    refreshTokenExpiresAt: new Date(now + (result.refresh_token_expires_in as number) * 1000),
  };
}

export async function exchangeGitHubAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<GitHubUserToken> {
  const config = getGitHubOAuthConfiguration();
  return requestUserToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  );
}

export async function refreshGitHubUserToken(refreshToken: string): Promise<GitHubUserToken> {
  const config = getGitHubOAuthConfiguration();
  return requestUserToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

export async function fetchGitHubAccountProfile(
  accessToken: string,
): Promise<GitHubAccountProfile> {
  const response = await fetch(`${API_ROOT}/user`, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  const result = (await response.json().catch(() => null)) as {
    id?: number | string;
    login?: string;
    avatar_url?: string;
  } | null;
  if (!response.ok || !result || result.id === undefined || !result.login) {
    throw new Error("GitHub could not verify the connected account.");
  }
  return {
    id: String(result.id),
    login: result.login,
    avatarUrl: result.avatar_url ?? null,
  };
}

export async function revokeGitHubAuthorization(accessToken: string): Promise<void> {
  const { clientId, clientSecret } = getGitHubOAuthConfiguration();
  const response = await fetch(`${API_ROOT}/applications/${encodeURIComponent(clientId)}/grant`, {
    method: "DELETE",
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": API_VERSION,
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!response.ok && response.status !== 404 && response.status !== 422) {
    throw new Error("GitHub could not revoke the connected account authorization.");
  }
}
