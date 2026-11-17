import "server-only";

import {
  getMcpResourceUri,
  getOrganizationId,
  getPerministerBaseUrl,
  getPerministerClient,
  type PerministerClientConfig,
} from "./config";
import { protectedResourceMetadataUrl } from "./protected-resource";

export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 413 | 503,
    readonly scope?: string,
  ) {
    super(message);
  }
}

export type McpPrincipal = {
  accessToken: string;
  subjectId: string;
  organizationId: string;
  scopes: Set<string>;
  authorizedActions?: Set<string>;
};

type IntrospectionResult = {
  active?: boolean;
  scope?: string;
  sub?: string;
  aud?: string[] | string;
  iss?: string;
};

function splitScopes(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(/\s+/).filter(Boolean));
}

function encodeFormValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

export function bearerChallenge(scope?: string, error?: string): string {
  const params = [`resource_metadata="${protectedResourceMetadataUrl()}"`];
  if (error) params.unshift(`error="${error}"`);
  if (scope) params.push(`scope="${scope}"`);
  return `Bearer ${params.join(", ")}`;
}

export async function authenticateMcpRequest(request: Request): Promise<McpPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]) throw new McpAuthError("A Perminister bearer token is required.", 401);
  const accessToken = match[1].trim();
  if (accessToken.length > 2048) throw new McpAuthError("Invalid bearer token.", 401);

  let client: PerministerClientConfig;
  try {
    client = getPerministerClient("mcp");
  } catch {
    throw new McpAuthError("Perminister MCP resource credentials are not configured.", 503);
  }
  const resource = getMcpResourceUri();
  const body = new URLSearchParams({ token: accessToken, resource });
  let response: Response;
  try {
    response = await fetch(new URL("/oauth/introspect", client.baseUrl), {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${encodeFormValue(client.clientId)}:${encodeFormValue(client.clientSecret)}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
  } catch {
    throw new McpAuthError("Perminister could not be reached to validate this token.", 503);
  }
  if (!response.ok) {
    throw new McpAuthError("Perminister could not validate this token.", 503);
  }
  const token = (await response.json().catch(() => null)) as IntrospectionResult | null;
  const audiences = Array.isArray(token?.aud)
    ? token.aud
    : typeof token?.aud === "string"
      ? [token.aud]
      : [];
  const expectedIssuer = process.env.PERMINISTER_ISSUER?.trim() || getPerministerBaseUrl();
  if (
    token?.active !== true ||
    token.sub === undefined ||
    token.iss !== expectedIssuer ||
    !audiences.includes(resource)
  ) {
    throw new McpAuthError("This token is inactive or was issued for another resource.", 401);
  }
  return {
    accessToken,
    subjectId: token.sub,
    organizationId: getOrganizationId(),
    scopes: splitScopes(token.scope),
  };
}

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024;
const TOOL_ACTIONS: Record<string, string> = {
  search_knowledge: "brain:read",
  get_document: "brain:read",
  get_policy: "policy:read",
  save_result: "result:save",
  propose_markdown_change: "knowledge:propose",
};

async function readMcpRequestJson(
  request: Request,
): Promise<{ value: unknown; tooLarge: boolean }> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_MCP_REQUEST_BYTES
  ) {
    return { value: null, tooLarge: true };
  }
  const body = request.clone().body;
  if (!body) return { value: null, tooLarge: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MCP_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { value: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { value: null, tooLarge: false };
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), tooLarge: false };
  } catch {
    return { value: null, tooLarge: false };
  }
}

export async function authorizeMcpToolCalls(
  request: Request,
  principal: McpPrincipal,
): Promise<void> {
  const parsed = await readMcpRequestJson(request);
  if (parsed.tooLarge) {
    throw new McpAuthError("The MCP request body exceeds the 4 MB limit.", 413);
  }
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const actions = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.method !== "tools/call" || !record.params || typeof record.params !== "object")
      continue;
    const name = (record.params as Record<string, unknown>).name;
    if (typeof name === "string" && TOOL_ACTIONS[name]) actions.add(TOOL_ACTIONS[name]);
  }
  for (const action of actions) await authorizeMcpAction(principal, action);
  principal.authorizedActions = new Set([...(principal.authorizedActions ?? []), ...actions]);
}

export async function authorizeMcpAction(principal: McpPrincipal, action: string): Promise<void> {
  if (principal.authorizedActions?.has(action)) return;
  if (!principal.scopes.has(action)) {
    throw new McpAuthError(`The token does not include the ${action} permission.`, 403, action);
  }
  const client = getPerministerClient("mcp");
  let response: Response;
  try {
    response = await fetch(new URL("/api/authorize", client.baseUrl), {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${principal.accessToken}`,
        "X-Perminister-Client-Id": client.clientId,
        "X-Perminister-Client-Secret": client.clientSecret,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        organizationId: principal.organizationId,
        productId: client.productId,
        resourceKind: "product",
        action,
        resource: getMcpResourceUri(),
      }),
    });
  } catch {
    throw new McpAuthError("Perminister could not verify the current user grant.", 503);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new McpAuthError("Perminister authorization is temporarily unavailable.", 503);
  }
  const result = (await response.json().catch(() => null)) as {
    authorized?: boolean;
    subjectId?: string;
  } | null;
  if (!response.ok || result?.authorized !== true || result.subjectId !== principal.subjectId) {
    throw new McpAuthError(`Perminister denied the ${action} action.`, 403, action);
  }
}
