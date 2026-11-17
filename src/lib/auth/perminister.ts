import "server-only";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPerministerBaseUrl, getPerministerClient, getPublicOrigin } from "./config";

export type OpenIdConfiguration = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

const metadataCache = new Map<string, { expiresAt: number; value: OpenIdConfiguration }>();

export async function getOpenIdConfiguration(): Promise<OpenIdConfiguration> {
  const baseUrl = getPerministerBaseUrl();
  const cached = metadataCache.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(new URL("/.well-known/openid-configuration", baseUrl), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Perminister OpenID metadata is unavailable.");
  const raw = (await response.json()) as Partial<OpenIdConfiguration>;
  for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof raw[key] !== "string") throw new Error("Perminister OpenID metadata is incomplete.");
  }
  const config = raw as OpenIdConfiguration;
  for (const value of [
    config.issuer,
    config.authorization_endpoint,
    config.token_endpoint,
    config.jwks_uri,
  ]) {
    const url = new URL(value);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("Perminister metadata must use HTTPS in production.");
    }
  }
  metadataCache.set(baseUrl, { expiresAt: Date.now() + 5 * 60 * 1000, value: config });
  return config;
}

export function getDashboardRedirectUri(): string {
  return new URL("/auth/perminister/callback", getPublicOrigin()).toString();
}

function getPerministerBasicAuthorization(): string {
  const client = getPerministerClient("dashboard");
  const encodeForm = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return `Basic ${Buffer.from(`${encodeForm(client.clientId)}:${encodeForm(client.clientSecret)}`).toString("base64")}`;
}

export async function validateDashboardIdToken(idToken: string, nonce: string): Promise<void> {
  const [metadata, client] = await Promise.all([
    getOpenIdConfiguration(),
    Promise.resolve(getPerministerClient("dashboard")),
  ]);
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const verified = await jwtVerify(idToken, jwks, {
    issuer: metadata.issuer,
    audience: client.clientId,
  });
  if (verified.payload.nonce !== nonce) throw new Error("Perminister sign-in nonce did not match.");
}

export async function exchangeDashboardCode(
  code: string,
  verifier: string,
): Promise<{
  accessToken: string;
  idToken: string;
  expiresIn: number;
}> {
  const metadata = await getOpenIdConfiguration();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getDashboardRedirectUri(),
    code_verifier: verifier,
  });
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: getPerministerBasicAuthorization(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (
    !response.ok ||
    typeof result.access_token !== "string" ||
    typeof result.id_token !== "string"
  ) {
    throw new Error("Perminister did not return a valid sign-in session.");
  }
  return {
    accessToken: result.access_token,
    idToken: result.id_token,
    expiresIn:
      typeof result.expires_in === "number" && result.expires_in > 0
        ? Math.min(result.expires_in, 60 * 60 * 24)
        : 60 * 60,
  };
}
