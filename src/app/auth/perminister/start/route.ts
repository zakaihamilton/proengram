import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDashboardRedirectUri, getOpenIdConfiguration } from "@/lib/auth/perminister";
import { getPerministerClient, getPublicOrigin, isCookieSecure } from "@/lib/auth/config";
import { createRandomToken, createPkceChallenge, encodeOAuthState } from "@/lib/auth/oauth-state";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const requestUrl = new URL(request.url);
    const [metadata, client] = await Promise.all([
      getOpenIdConfiguration(),
      Promise.resolve(getPerministerClient("dashboard")),
    ]);
    const verifier = createRandomToken(48);
    const state = createRandomToken();
    const nonce = createRandomToken();
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", client.clientId);
    authorizationUrl.searchParams.set("redirect_uri", getDashboardRedirectUri());
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid profile email perminister_api");
    if (requestUrl.searchParams.get("prompt") === "login") {
      authorizationUrl.searchParams.set("prompt", "login");
    }
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", createPkceChallenge(verifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    const jar = await cookies();
    jar.set(
      "proengram_oauth_state",
      encodeOAuthState({ state, nonce, verifier, createdAt: Date.now() }),
      {
        httpOnly: true,
        secure: isCookieSecure(),
        sameSite: "lax",
        path: "/auth/perminister",
        maxAge: 600,
      },
    );
    return NextResponse.redirect(authorizationUrl);
  } catch {
    return NextResponse.redirect(new URL("/login?error=configuration", getPublicOrigin()));
  }
}
