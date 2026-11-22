import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPublicOrigin, isCookieSecure } from "@/lib/auth/config";
import { decodeOAuthState } from "@/lib/auth/oauth-state";
import {
  exchangeDashboardCode,
  getOpenIdConfiguration,
  validateDashboardIdToken,
} from "@/lib/auth/perminister";
import { getDashboardIdentityForAccessToken, SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";

function loginRedirect(reason: string): Response {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(reason)}`, getPublicOrigin()),
  );
}

export async function GET(request: Request): Promise<Response> {
  const callbackUrl = new URL(request.url);
  const jar = await cookies();
  const stateCookie = jar.get("proengram_oauth_state")?.value;
  jar.set("proengram_oauth_state", "", {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: "lax",
    path: "/auth/perminister",
    maxAge: 0,
  });
  const state = decodeOAuthState(stateCookie);
  const returnedState = callbackUrl.searchParams.get("state");
  const code = callbackUrl.searchParams.get("code");
  const issuer = callbackUrl.searchParams.get("iss");
  if (!state || !returnedState || state.state !== returnedState) return loginRedirect("state");
  if (callbackUrl.searchParams.has("error")) {
    return loginRedirect(callbackUrl.searchParams.get("error") || "access_denied");
  }
  if (!code) return loginRedirect("missing_code");

  try {
    const metadata = await getOpenIdConfiguration();
    if (issuer && issuer !== metadata.issuer) return loginRedirect("issuer");
    const session = await exchangeDashboardCode(code, state.verifier);
    await validateDashboardIdToken(session.idToken, state.nonce);
    const identity = await getDashboardIdentityForAccessToken(session.accessToken);
    if (!identity) return loginRedirect("access_denied");
    jar.set(SESSION_COOKIE, session.accessToken, {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: session.expiresIn,
    });
    const next = new URL("/overview", getPublicOrigin());
    return NextResponse.redirect(next);
  } catch {
    return loginRedirect("sign_in_failed");
  }
}
