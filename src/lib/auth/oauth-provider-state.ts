import "server-only";

import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getCookieSecret } from "@/lib/auth/config";

export type OAuthStatePayload = {
  state: string;
  organizationId: string;
  subjectId: string;
  codeVerifier: string;
};

function signingKey(): Uint8Array {
  return new TextEncoder().encode(getCookieSecret());
}

export function getOAuthStateCookieName(state: string, provider: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error(`Invalid ${label} OAuth state.`);
  const prefix =
    process.env.NODE_ENV === "production"
      ? `__Host-proengram-${provider}-`
      : `proengram-${provider}-`;
  return `${prefix}${state}`;
}

export async function signOAuthState(
  input: Omit<OAuthStatePayload, "state">,
  audience: string,
): Promise<{ state: string; cookieToken: string }> {
  const state = randomBytes(32).toString("base64url");
  const cookieToken = await new SignJWT({
    state,
    organizationId: input.organizationId,
    codeVerifier: input.codeVerifier,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("proengram")
    .setAudience(audience)
    .setSubject(input.subjectId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey());
  return { state, cookieToken };
}

export async function verifyOAuthState(
  token: string,
  expectedState: string,
  audience: string,
  label: string,
): Promise<OAuthStatePayload> {
  const { payload } = await jwtVerify(token, signingKey(), {
    issuer: "proengram",
    audience,
  });
  if (
    payload.state !== expectedState ||
    typeof payload.sub !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.codeVerifier !== "string"
  ) {
    throw new Error(`${label} OAuth state did not match.`);
  }
  return {
    state: expectedState,
    organizationId: payload.organizationId,
    subjectId: payload.sub,
    codeVerifier: payload.codeVerifier,
  };
}
