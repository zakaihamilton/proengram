import "server-only";

import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getCookieSecret } from "@/lib/auth/config";

const ISSUER = "proengram";
const AUDIENCE = "github-oauth";

export type GitHubOAuthState = {
  state: string;
  organizationId: string;
  subjectId: string;
  codeVerifier: string;
};

function signingKey(): Uint8Array {
  return new TextEncoder().encode(getCookieSecret());
}

export function getGitHubOAuthStateCookieName(state: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid GitHub OAuth state.");
  const prefix =
    process.env.NODE_ENV === "production" ? "__Host-proengram-github-" : "proengram-github-";
  return `${prefix}${state}`;
}

export async function signGitHubOAuthState(
  input: Omit<GitHubOAuthState, "state">,
): Promise<{ state: string; cookieToken: string }> {
  const state = randomBytes(32).toString("base64url");
  const cookieToken = await new SignJWT({
    state,
    organizationId: input.organizationId,
    codeVerifier: input.codeVerifier,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(input.subjectId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey());
  return { state, cookieToken };
}

export async function verifyGitHubOAuthState(
  token: string,
  expectedState: string,
): Promise<GitHubOAuthState> {
  const { payload } = await jwtVerify(token, signingKey(), { issuer: ISSUER, audience: AUDIENCE });
  if (
    payload.state !== expectedState ||
    typeof payload.sub !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.codeVerifier !== "string"
  ) {
    throw new Error("GitHub OAuth state did not match.");
  }
  return {
    state: expectedState,
    organizationId: payload.organizationId,
    subjectId: payload.sub,
    codeVerifier: payload.codeVerifier,
  };
}
