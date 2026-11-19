import "server-only";

import { getPublicOrigin } from "@/lib/auth/config";

export type GoogleDriveOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleDriveToken = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
};

export type GoogleDriveProfile = {
  subject: string;
  email: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
};

export class GoogleDriveReauthorizationRequiredError extends Error {
  constructor() {
    super("Google Drive authorization needs to be reconnected.");
    this.name = "GoogleDriveReauthorizationRequiredError";
  }
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function getGoogleDriveOAuthConfiguration(): GoogleDriveOAuthConfiguration {
  return {
    clientId: requiredSetting("GOOGLE_DRIVE_OAUTH_CLIENT_ID"),
    clientSecret: requiredSetting("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"),
    redirectUri: new URL("/auth/google-drive/callback", getPublicOrigin()).toString(),
  };
}

export function isGoogleDriveOAuthConfigured(): boolean {
  try {
    getGoogleDriveOAuthConfiguration();
    return true;
  } catch {
    return false;
  }
}

export async function createGoogleDriveAuthorizationUrl(input: {
  state: string;
  codeChallenge: string;
}): Promise<URL> {
  const { clientId, redirectUri } = getGoogleDriveOAuthConfiguration();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "openid email profile https://www.googleapis.com/auth/drive.readonly",
  );
  url.searchParams.set("state", input.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function tokenRequest(body: URLSearchParams): Promise<GoogleDriveToken> {
  const config = getGoogleDriveOAuthConfiguration();
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = (await response.json().catch(() => null)) as TokenResponse | null;
  if (
    !response.ok ||
    !result?.access_token ||
    !result.refresh_token ||
    !Number.isFinite(result.expires_in)
  ) {
    throw new Error("Google did not return a renewable Drive authorization.");
  }
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + (result.expires_in as number) * 1000),
  };
}

export async function exchangeGoogleDriveAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<GoogleDriveToken> {
  const { redirectUri } = getGoogleDriveOAuthConfiguration();
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: redirectUri,
      code_verifier: input.codeVerifier,
    }),
  );
}

export async function refreshGoogleDriveAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  accessTokenExpiresAt: Date;
}> {
  const config = getGoogleDriveOAuthConfiguration();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const result = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!response.ok) {
    if (result?.error === "invalid_grant") {
      throw new GoogleDriveReauthorizationRequiredError();
    }
    if (response.status === 429 || response.status >= 500) {
      throw new Error("Google Drive token refresh is temporarily unavailable.");
    }
    throw new Error("Google Drive could not refresh the access token.");
  }
  if (!result?.access_token || !Number.isFinite(result.expires_in)) {
    throw new Error("Google Drive returned an invalid token refresh response.");
  }
  return {
    accessToken: result.access_token,
    accessTokenExpiresAt: new Date(Date.now() + (result.expires_in as number) * 1000),
  };
}

export async function fetchGoogleDriveProfile(accessToken: string): Promise<GoogleDriveProfile> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const result = (await response.json().catch(() => null)) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  } | null;
  if (
    !response.ok ||
    typeof result?.sub !== "string" ||
    typeof result.email !== "string" ||
    result.email_verified !== true
  ) {
    throw new Error("Google could not verify the connected account.");
  }
  return { subject: result.sub, email: result.email };
}

export async function revokeGoogleDriveAuthorization(token: string): Promise<void> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok && response.status !== 400) {
    throw new Error("Google could not revoke the Drive authorization.");
  }
}
