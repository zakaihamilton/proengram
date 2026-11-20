import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPublicOrigin, isCookieSecure } from "@/lib/auth/config";
import { authorizeAppAction, getDashboardIdentity, ORGANIZATION_COOKIE } from "@/lib/auth/session";
import { connectGoogleDriveAccount } from "@/lib/google-drive/connections";
import {
  exchangeGoogleDriveAuthorizationCode,
  fetchGoogleDriveProfile,
} from "@/lib/google-drive/oauth";
import {
  getGoogleDriveOAuthStateCookieName,
  verifyGoogleDriveOAuthState,
} from "@/lib/google-drive/oauth-state";

export const runtime = "nodejs";

function settingsRedirect(reason: string): Response {
  return NextResponse.redirect(
    new URL(`/settings?googleDriveConnection=${encodeURIComponent(reason)}`, getPublicOrigin()),
  );
}

export async function GET(request: Request): Promise<Response> {
  const callback = new URL(request.url);
  const returnedState = callback.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(returnedState)) return settingsRedirect("error");

  const jar = await cookies();
  const stateCookieName = getGoogleDriveOAuthStateCookieName(returnedState);
  const stateToken = jar.get(stateCookieName)?.value;
  jar.set(stateCookieName, "", {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  if (!stateToken) return settingsRedirect("error");

  try {
    const state = await verifyGoogleDriveOAuthState(stateToken, returnedState);
    const identity = await getDashboardIdentity();
    const organization = identity?.organizations.find(
      (item) => item.organizationId === state.organizationId,
    );
    if (!identity || identity.subjectId !== state.subjectId || !organization) {
      return NextResponse.redirect(new URL("/access-denied", getPublicOrigin()));
    }
    const scopedIdentity = { ...identity, organization };
    if (!(await authorizeAppAction(scopedIdentity, "source:manage"))) {
      return NextResponse.redirect(new URL("/access-denied", getPublicOrigin()));
    }
    jar.set(ORGANIZATION_COOKIE, organization.organizationId, {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    if (callback.searchParams.has("error")) return settingsRedirect("denied");
    const code = callback.searchParams.get("code");
    if (!code) return settingsRedirect("error");

    const token = await exchangeGoogleDriveAuthorizationCode({
      code,
      codeVerifier: state.codeVerifier,
    });
    const profile = await fetchGoogleDriveProfile(token.accessToken);
    await connectGoogleDriveAccount({
      organizationId: organization.organizationId,
      subjectId: identity.subjectId,
      profile,
      token,
    });
    return settingsRedirect("connected");
  } catch {
    return settingsRedirect("error");
  }
}
