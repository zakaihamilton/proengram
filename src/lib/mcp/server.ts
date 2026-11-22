import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpPrincipal } from "@/lib/auth/mcp";
import { registerGitHubTools } from "./tools/github-tools";
import { registerKnowledgeTools } from "./tools/knowledge-tools";
import { registerMemoryTools } from "./tools/memory-tools";

function createServer(principal: McpPrincipal): McpServer {
  const server = new McpServer({ name: "ProEngram", version: "0.1.0" });
  registerKnowledgeTools(server, principal);
  registerMemoryTools(server, principal);
  registerGitHubTools(server, principal);
  return server;
}

export async function handleMcpRequest(
  request: Request,
  principal: McpPrincipal,
): Promise<Response> {
  const server = createServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
