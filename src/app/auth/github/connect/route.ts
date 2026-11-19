import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import { getPublicOrigin, isCookieSecure } from "@/lib/auth/config";
import { createGitHubAuthorizationUrl, getGitHubOAuthConfiguration } from "@/lib/github/oauth";
import { getGitHubOAuthStateCookieName, signGitHubOAuthState } from "@/lib/github/oauth-state";
import { isGitHubTokenEncryptionConfigured } from "@/lib/github/token-crypto";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const identity = await getDashboardIdentity();
  if (!identity) return NextResponse.redirect(new URL("/login", getPublicOrigin()));
  if (!(await authorizeAppAction(identity, "source:manage"))) {
    return NextResponse.redirect(new URL("/access-denied", getPublicOrigin()));
  }
  if (!isGitHubTokenEncryptionConfigured()) {
    return NextResponse.redirect(new URL("/settings?githubConnection=setup", getPublicOrigin()));
  }

  try {
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const state = await signGitHubOAuthState({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      codeVerifier: verifier,
    });
    const jar = await cookies();
    jar.set(getGitHubOAuthStateCookieName(state.state), state.cookieToken, {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    getGitHubOAuthConfiguration();
    const login = new URL(request.url).searchParams.get("login")?.trim();
    return NextResponse.redirect(
      await createGitHubAuthorizationUrl({ state: state.state, codeChallenge, login }),
    );
  } catch {
    return NextResponse.redirect(new URL("/settings?githubConnection=setup", getPublicOrigin()));
  }
}
