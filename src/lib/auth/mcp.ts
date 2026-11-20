import "server-only";

import {
  getMcpResourceUri,
  getPerministerBaseUrl,
  getPerministerClient,
  type PerministerClientConfig,
} from "./config";
import { protectedResourceMetadataUrl } from "./protected-resource";

export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 413 | 503,
    readonly scope?: string,
  ) {
    super(message);
  }
}

export type McpPrincipal = {
  accessToken: string;
  subjectId: string;
  organizations: Array<{ organizationId: string; name: string }>;
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

type PerministerSessionResult = {
  authenticated?: boolean;
  account?: { subjectId?: string };
  organizations?: Array<{
    organizationId?: string;
    organizationName?: string;
    productId?: string;
  }>;
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

async function getMcpOrganizations(
  accessToken: string,
  subjectId: string,
  client: PerministerClientConfig,
): Promise<Array<{ organizationId: string; name: string }>> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/consumer/session", client.baseUrl), {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Perminister-Client-Id": client.clientId,
        "X-Perminister-Client-Secret": client.clientSecret,
        Accept: "application/json",
      },
    });
  } catch {
    throw new McpAuthError("Perminister could not be reached to load your organizations.", 503);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new McpAuthError("Perminister is temporarily unavailable.", 503);
  }
  const session = (await response.json().catch(() => null)) as PerministerSessionResult | null;
  if (
    !response.ok ||
    session?.authenticated !== true ||
    session.account?.subjectId !== subjectId ||
    !Array.isArray(session.organizations)
  ) {
    throw new McpAuthError("This Perminister session is no longer active.", 401);
  }
  return session.organizations
    .flatMap((organization) => {
      if (
        typeof organization.organizationId !== "string" ||
        typeof organization.organizationName !== "string" ||
        typeof organization.productId !== "string" ||
        organization.productId.toLowerCase() !== client.productId.toLowerCase()
      ) {
        return [];
      }
      return [
        {
          organizationId: organization.organizationId.toLowerCase(),
          name: organization.organizationName,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.organizationId.localeCompare(right.organizationId),
    );
}

export function resolveMcpOrganization(
  principal: McpPrincipal,
  requestedOrganizationId?: string,
): { organizationId: string; name: string } {
  if (requestedOrganizationId !== undefined) {
    const organization = principal.organizations.find(
      (item) => item.organizationId === requestedOrganizationId.trim().toLowerCase(),
    );
    if (!organization) {
      throw new McpAuthError("This organization is not available to your ProEngram account.", 403);
    }
    return organization;
  }
  if (principal.organizations.length === 1) return principal.organizations[0];
  if (principal.organizations.length > 1) {
    throw new McpAuthError(
      "Choose an organization with list_organizations, then pass its organizationId to this tool.",
      400,
    );
  }
  throw new McpAuthError("No ProEngram organization access was found for this account.", 403);
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
  const organizations = await getMcpOrganizations(accessToken, token.sub, client);
  return {
    accessToken,
    subjectId: token.sub,
    organizations,
    scopes: splitScopes(token.scope),
  };
}

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024;
const TOOL_ACTIONS: Record<string, string> = {
  search_knowledge: "brain:read",
  get_document: "brain:read",
  get_document_history: "brain:read",
  list_project_history: "brain:read",
  get_policy: "policy:read",
  save_result: "result:save",
  save_memory: "result:save",
  suggest_knowledge_capture: "result:save",
  submit_knowledge_feedback: "brain:feedback",
  propose_markdown_change: "knowledge:propose",
};

function authorizationKey(organizationId: string, action: string): string {
  return `${organizationId}\u0000${action}`;
}

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
  const actions = new Map<string, { action: string; organizationId: string }>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.method !== "tools/call" || !record.params || typeof record.params !== "object")
      continue;
    const params = record.params as Record<string, unknown>;
    const name = params.name;
    if (typeof name !== "string" || !TOOL_ACTIONS[name]) continue;
    const input = params.arguments;
    const requestedOrganizationId =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>).organizationId
        : undefined;
    if (requestedOrganizationId !== undefined && typeof requestedOrganizationId !== "string") {
      throw new McpAuthError("organizationId must be a string.", 400);
    }
    const organization = resolveMcpOrganization(
      principal,
      requestedOrganizationId as string | undefined,
    );
    actions.set(authorizationKey(organization.organizationId, TOOL_ACTIONS[name]), {
      action: TOOL_ACTIONS[name],
      organizationId: organization.organizationId,
    });
  }
  for (const { action, organizationId } of actions.values()) {
    await authorizeMcpAction(principal, action, organizationId);
  }
}

export async function authorizeMcpAction(
  principal: McpPrincipal,
  action: string,
  organizationId?: string,
): Promise<void> {
  const organization = resolveMcpOrganization(principal, organizationId);
  const key = authorizationKey(organization.organizationId, action);
  if (principal.authorizedActions?.has(key)) return;
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
        organizationId: organization.organizationId,
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
  principal.authorizedActions = new Set([...(principal.authorizedActions ?? []), key]);
}
