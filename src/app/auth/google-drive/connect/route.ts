import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPublicOrigin, isCookieSecure } from "@/lib/auth/config";
import { authorizeAppAction, getDashboardIdentity } from "@/lib/auth/session";
import {
  createGoogleDriveAuthorizationUrl,
  getGoogleDriveOAuthConfiguration,
} from "@/lib/google-drive/oauth";
import {
  getGoogleDriveOAuthStateCookieName,
  signGoogleDriveOAuthState,
} from "@/lib/google-drive/oauth-state";
import { isGoogleDriveTokenEncryptionConfigured } from "@/lib/google-drive/token-crypto";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const identity = await getDashboardIdentity();
  if (!identity) return NextResponse.redirect(new URL("/login", getPublicOrigin()));
  if (!(await authorizeAppAction(identity, "source:manage"))) {
    return NextResponse.redirect(new URL("/access-denied", getPublicOrigin()));
  }
  if (!isGoogleDriveTokenEncryptionConfigured()) {
    return NextResponse.redirect(
      new URL("/settings?googleDriveConnection=setup", getPublicOrigin()),
    );
  }

  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = await signGoogleDriveOAuthState({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      codeVerifier: verifier,
    });
    const jar = await cookies();
    jar.set(getGoogleDriveOAuthStateCookieName(state.state), state.cookieToken, {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    getGoogleDriveOAuthConfiguration();
    return NextResponse.redirect(
      await createGoogleDriveAuthorizationUrl({ state: state.state, codeChallenge: challenge }),
    );
  } catch {
    return NextResponse.redirect(
      new URL("/settings?googleDriveConnection=setup", getPublicOrigin()),
    );
  }
}
