import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeAppAction, getDashboardIdentity, ORGANIZATION_COOKIE } from "@/lib/auth/session";
import { getPublicOrigin, isCookieSecure } from "@/lib/auth/config";

type OAuthState = {
  organizationId: string;
  subjectId: string;
  codeVerifier: string;
};

type OAuthToken = { accessToken: string };

type OAuthProvider<TToken extends OAuthToken, TProfile> = {
  connectionKey: "githubConnection" | "googleDriveConnection";
  getStateCookieName: (state: string) => string;
  verifyState: (token: string, state: string) => Promise<OAuthState>;
  exchangeCode: (input: { code: string; codeVerifier: string }) => Promise<TToken>;
  fetchProfile: (accessToken: string) => Promise<TProfile>;
  connect: (input: {
    organizationId: string;
    subjectId: string;
    profile: TProfile;
    token: TToken;
  }) => Promise<void>;
};

export async function handleOAuthCallback<TToken extends OAuthToken, TProfile>(
  request: Request,
  provider: OAuthProvider<TToken, TProfile>,
): Promise<Response> {
  const redirect = (reason: string) =>
    NextResponse.redirect(
      new URL(
        `/settings?${provider.connectionKey}=${encodeURIComponent(reason)}`,
        getPublicOrigin(),
      ),
    );
  const callback = new URL(request.url);
  const returnedState = callback.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(returnedState)) return redirect("error");

  const jar = await cookies();
  const cookieName = provider.getStateCookieName(returnedState);
  const stateToken = jar.get(cookieName)?.value;
  jar.set(cookieName, "", {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  if (!stateToken) return redirect("error");

  try {
    const state = await provider.verifyState(stateToken, returnedState);
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
    if (callback.searchParams.has("error")) return redirect("denied");
    const code = callback.searchParams.get("code");
    if (!code) return redirect("error");

    const token = await provider.exchangeCode({ code, codeVerifier: state.codeVerifier });
    const profile = await provider.fetchProfile(token.accessToken);
    await provider.connect({
      organizationId: organization.organizationId,
      subjectId: identity.subjectId,
      profile,
      token,
    });
    return redirect("connected");
  } catch {
    return redirect("error");
  }
}

type OAuthStartProvider = {
  connectionKey: "githubConnection" | "googleDriveConnection";
  isEncryptionConfigured: () => boolean;
  getStateCookieName: (state: string) => string;
  signState: (input: Omit<OAuthState, "state">) => Promise<{ state: string; cookieToken: string }>;
  getConfiguration: () => unknown;
  createAuthorizationUrl: (input: {
    state: string;
    codeChallenge: string;
    login?: string;
  }) => Promise<URL>;
};

export async function startOAuthConnection(
  request: Request,
  provider: OAuthStartProvider,
): Promise<Response> {
  const setupRedirect = () =>
    NextResponse.redirect(new URL(`/settings?${provider.connectionKey}=setup`, getPublicOrigin()));
  const identity = await getDashboardIdentity();
  if (!identity) return NextResponse.redirect(new URL("/login", getPublicOrigin()));
  if (!(await authorizeAppAction(identity, "source:manage"))) {
    return NextResponse.redirect(new URL("/access-denied", getPublicOrigin()));
  }
  if (!provider.isEncryptionConfigured()) return setupRedirect();

  try {
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const state = await provider.signState({
      organizationId: identity.organization.organizationId,
      subjectId: identity.subjectId,
      codeVerifier: verifier,
    });
    const jar = await cookies();
    jar.set(provider.getStateCookieName(state.state), state.cookieToken, {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    provider.getConfiguration();
    const login = new URL(request.url).searchParams.get("login")?.trim();
    return NextResponse.redirect(
      await provider.createAuthorizationUrl({ state: state.state, codeChallenge, login }),
    );
  } catch {
    return setupRedirect();
  }
}
