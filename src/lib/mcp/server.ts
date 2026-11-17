import "server-only";

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authorizeMcpAction, McpAuthError, type McpPrincipal } from "@/lib/auth/mcp";
import { createMarkdownPullRequest, isGitHubConfigured } from "@/lib/github/github";
import {
  getBrainItem,
  listItemsByKind,
  searchBrainItems,
  searchBrainItemsByKind,
  saveResult,
} from "@/lib/db/brain";
import { getPool, isDatabaseConfigured } from "@/lib/db/pool";

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 400)
    : "The requested ProEngram operation failed.";
}

async function withToolErrors<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    return textResult(errorText(error), true);
  }
}

async function canAuthorizeMcpAction(principal: McpPrincipal, action: string): Promise<boolean> {
  try {
    await authorizeMcpAction(principal, action);
    return true;
  } catch (error) {
    if (error instanceof McpAuthError && (error.status === 403 || error.status === 503))
      return false;
    throw error;
  }
}

function requireDatabase(): void {
  if (!isDatabaseConfigured() || !getPool())
    throw new Error("Nanogres PostgreSQL is not configured.");
}

function createServer(principal: McpPrincipal): McpServer {
  const server = new McpServer({ name: "ProEngram", version: "0.1.0" });

  server.registerTool(
    "search_knowledge",
    {
      title: "Search company knowledge",
      description:
        "Search approved GitHub Markdown, company-saved answers, and imported Sentry8 policy snapshots.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) =>
      withToolErrors(async () => {
        await authorizeMcpAction(principal, "brain:read");
        requireDatabase();
        const canReadPolicies = await canAuthorizeMcpAction(principal, "policy:read");
        const items = await searchBrainItems(
          principal.organizationId,
          query,
          limit ?? 8,
          canReadPolicies ? undefined : "sentry8_policy",
        );
        const pool = getPool();
        if (pool) {
          await pool.query(
            `INSERT INTO activity_events (id, organization_id, actor_subject_id, action, summary, metadata)
           VALUES ($1, $2, $3, 'brain:search', 'Searched company knowledge.', $4::jsonb)`,
            [
              randomUUID(),
              principal.organizationId,
              principal.subjectId,
              JSON.stringify({ resultCount: items.length }),
            ],
          );
        }
        return textResult(
          items.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            excerpt: item.markdown.slice(0, 1800),
            sourceUrl: item.sourceUrl,
            sourceRevision: item.sourceRevision,
            updatedAt: item.updatedAt,
          })),
        );
      }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Read a company knowledge item",
      description:
        "Fetch one result returned by search_knowledge, including its source and revision.",
      inputSchema: { id: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) =>
      withToolErrors(async () => {
        await authorizeMcpAction(principal, "brain:read");
        requireDatabase();
        const canReadPolicies = await canAuthorizeMcpAction(principal, "policy:read");
        const item = await getBrainItem(
          principal.organizationId,
          id,
          canReadPolicies ? undefined : "sentry8_policy",
        );
        if (!item) return textResult("That company knowledge item was not found.", true);
        return textResult(item);
      }),
  );

  server.registerTool(
    "get_policy",
    {
      title: "Find a Sentry8 policy",
      description: "Search policy snapshots imported from the configured Sentry8 source.",
      inputSchema: { query: z.string().trim().min(1).max(500).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) =>
      withToolErrors(async () => {
        await authorizeMcpAction(principal, "policy:read");
        requireDatabase();
        const policies = query
          ? await searchBrainItemsByKind(principal.organizationId, "sentry8_policy", query, 20)
          : await listItemsByKind(principal.organizationId, "sentry8_policy", 20);
        if (policies.length === 0) {
          return textResult(
            "No Sentry8 policy catalog has been imported into ProEngram yet.",
            true,
          );
        }
        return textResult(
          policies.map((item) => ({
            id: item.id,
            title: item.title,
            policyRevision: item.sourceRevision,
            sourceUrl: item.sourceUrl,
            policy: item.markdown,
          })),
        );
      }),
  );

  server.registerTool(
    "save_result",
    {
      title: "Save a shared answer",
      description:
        "Explicitly save an answer and its citations for everyone in this company workspace.",
      inputSchema: {
        title: z.string().trim().min(1).max(240),
        markdown: z.string().trim().min(1).max(30_000),
        citations: z
          .array(
            z.object({ title: z.string().trim().min(1).max(240), url: z.string().url().max(2048) }),
          )
          .max(30)
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, markdown, citations }) =>
      withToolErrors(async () => {
        await authorizeMcpAction(principal, "result:save");
        requireDatabase();
        const item = await saveResult({
          organizationId: principal.organizationId,
          subjectId: principal.subjectId,
          title,
          markdown,
          citations: citations ?? [],
        });
        return textResult({
          saved: true,
          id: item.id,
          title: item.title,
          visibility: "company",
          citations: item.citations,
        });
      }),
  );

  server.registerTool(
    "propose_markdown_change",
    {
      title: "Propose a knowledge edit",
      description:
        "Create a GitHub pull request for a Markdown file in docs/. The proposal is not merged automatically.",
      inputSchema: {
        path: z.string().trim().min(6).max(300),
        title: z.string().trim().min(1).max(240),
        markdown: z.string().min(1).max(300_000),
        summary: z.string().trim().min(1).max(4000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, title, markdown, summary }) =>
      withToolErrors(async () => {
        await authorizeMcpAction(principal, "knowledge:propose");
        if (!isGitHubConfigured()) throw new Error("The ProEngram GitHub App is not configured.");
        const proposal = await createMarkdownPullRequest({
          organizationId: principal.organizationId,
          subjectId: principal.subjectId,
          path,
          title,
          markdown,
          summary,
        });
        return textResult({ ...proposal, merged: false });
      }),
  );

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
