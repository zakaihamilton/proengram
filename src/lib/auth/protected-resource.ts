import { getMcpResourceUri, getPerministerBaseUrl } from "./config";

export function protectedResourceMetadataUrl(): string {
  const resource = new URL(getMcpResourceUri());
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/+$/, "");
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadataResponse(path: string[] = []): Response {
  const resource = new URL(getMcpResourceUri());
  let expectedPath: string[];
  try {
    expectedPath = resource.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return Response.json({ error: "invalid_resource_uri" }, { status: 500 });
  }
  if (
    expectedPath.length !== path.length ||
    expectedPath.some((part, index) => part !== path[index])
  ) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const scopes = (
    process.env.PERMINISTER_MCP_SCOPES || "brain:read policy:read result:save knowledge:propose"
  )
    .split(/\s+/)
    .filter(Boolean);
  return Response.json(
    {
      resource: getMcpResourceUri(),
      authorization_servers: [process.env.PERMINISTER_ISSUER?.trim() || getPerministerBaseUrl()],
      scopes_supported: scopes,
      bearer_methods_supported: ["header"],
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

export function protectedResourceMetadataOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Max-Age": "600",
      Allow: "GET, OPTIONS",
    },
  });
}
