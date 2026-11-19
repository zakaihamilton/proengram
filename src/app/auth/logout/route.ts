import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPerministerClient, getPublicOrigin, isCookieSecure } from "@/lib/auth/config";
import { ORGANIZATION_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIE)?.value;
  if (accessToken) {
    try {
      const client = getPerministerClient("dashboard");
      await fetch(new URL("/api/auth/consumer/session", client.baseUrl), {
        method: "DELETE",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Perminister-Client-Id": client.clientId,
          "X-Perminister-Client-Secret": client.clientSecret,
        },
      });
    } catch {
      // The local cookie is still cleared when the identity provider is unavailable.
    }
  }
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  jar.set(ORGANIZATION_COOKIE, "", {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return NextResponse.redirect(new URL("/login", getPublicOrigin()), { status: 303 });
}
