import {
  authenticateMcpRequest,
  authorizeMcpToolCalls,
  McpAuthError,
  bearerChallenge,
} from "@/lib/auth/mcp";
import { handleMcpRequest } from "@/lib/mcp/server";
import { getPublicOrigin } from "@/lib/auth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function allowedOrigins(): Set<string> {
  const configured = process.env.PROENGRAM_MCP_ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured?.length ? configured : ["https://chatgpt.com", "https://claude.ai"]);
}

function corsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "";
  }
  const allowed = allowedOrigins();
  allowed.add(getPublicOrigin());
  return allowed.has(parsed.origin) ? parsed.origin : "";
}

function withCors(response: Response, origin: string | null): Response {
  if (origin === "") return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id",
  );
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handle(request: Request): Promise<Response> {
  const origin = corsOrigin(request);
  if (origin === "") return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  try {
    const principal = await authenticateMcpRequest(request);
    await authorizeMcpToolCalls(request, principal);
    const response = await handleMcpRequest(request, principal);
    return withCors(response, origin);
  } catch (error) {
    if (error instanceof McpAuthError) {
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (error.status === 401) headers.set("WWW-Authenticate", bearerChallenge());
      if (error.status === 403 && error.scope)
        headers.set("WWW-Authenticate", bearerChallenge(error.scope, "insufficient_scope"));
      return withCors(
        Response.json({ error: error.message }, { status: error.status, headers }),
        origin,
      );
    }
    return withCors(Response.json({ error: "mcp_request_failed" }, { status: 500 }), origin);
  }
}

export const POST = handle;

export async function OPTIONS(request: Request): Promise<Response> {
  const origin = corsOrigin(request);
  if (origin === "") return new Response(null, { status: 403 });
  const headers = new Headers({
    Allow: "POST, OPTIONS",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version",
    "Access-Control-Max-Age": "600",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

export function GET(): Response {
  return new Response("Use POST for the stateless Streamable HTTP MCP endpoint.", {
    status: 405,
    headers: { Allow: "POST, OPTIONS", "Cache-Control": "no-store" },
  });
}

export function DELETE(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
}
