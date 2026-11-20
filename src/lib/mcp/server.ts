import "server-only";

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  authorizeMcpAction,
  McpAuthError,
  type McpPrincipal,
  resolveMcpOrganization,
} from "@/lib/auth/mcp";
import {
  getBrainItem,
  getBrainItemHistory,
  getProjectHistory,
  type KnowledgeFeedbackRating,
  listItemsByKind,
  saveKnowledgeFeedback,
  saveMemory,
  saveResult,
  searchBrainItems,
  searchBrainItemsByKind,
} from "@/lib/db/brain";
import { getPool, isDatabaseConfigured } from "@/lib/db/pool";
import {
  createMarkdownPullRequest,
  isGitHubConfigured,
  listGitHubRepositorySources,
} from "@/lib/github/github";

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

async function canAuthorizeMcpAction(
  principal: McpPrincipal,
  action: string,
  organizationId: string,
): Promise<boolean> {
  try {
    await authorizeMcpAction(principal, action, organizationId);
    return true;
  } catch (error) {
    if (error instanceof McpAuthError && (error.status === 403 || error.status === 503))
      return false;
    throw error;
  }
}

function requireDatabase(): void {
  if (!isDatabaseConfigured()) throw new Error("Nanogres PostgreSQL is not configured.");
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const organizationIdSchema = z.string().trim().min(1).max(128).optional();

async function authorizeBrainRead(principal: McpPrincipal, organizationId?: string) {
  const organization = resolveMcpOrganization(principal, organizationId);
  await authorizeMcpAction(principal, "brain:read", organization.organizationId);
  requireDatabase();
  const canReadPolicies = await canAuthorizeMcpAction(
    principal,
    "policy:read",
    organization.organizationId,
  );
  return { organization, canReadPolicies };
}

function createServer(principal: McpPrincipal): McpServer {
  const server = new McpServer({ name: "ProEngram", version: "0.1.0" });

  server.registerTool(
    "list_organizations",
    {
      title: "List ProEngram organizations",
      description: "List the ProEngram organizations available to your Perminister account.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => textResult(principal.organizations),
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search company knowledge",
      description:
        "Search approved GitHub and Google Drive documents, saved answers, decisions, project history, and imported Sentry8 policy snapshots. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, limit, organizationId }) =>
      withToolErrors(async () => {
        const { organization, canReadPolicies } = await authorizeBrainRead(
          principal,
          organizationId,
        );
        const items = await searchBrainItems(
          organization.organizationId,
          query,
          limit ?? 8,
          canReadPolicies ? undefined : "sentry8_policy",
        );
        const pool = await getPool();
        if (pool) {
          await pool.query(
            `INSERT INTO activity_events (id, organization_id, actor_subject_id, action, summary, metadata)
           VALUES ($1, $2, $3, 'brain:search', 'Searched company knowledge.', $4::jsonb)`,
            [
              randomUUID(),
              organization.organizationId,
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
            excerpt: (item.matchExcerpt ?? item.markdown).slice(0, 1800),
            sourceUrl: item.sourceUrl,
            sourceRevision: item.sourceRevision,
            sourceModifiedAt: item.sourceModifiedAt,
            locator: item.matchLocator,
            projectName: item.projectName,
            occurredAt: item.occurredAt,
            updatedAt: item.updatedAt,
          })),
        );
      }),
  );

  server.registerTool(
    "get_document_history",
    {
      title: "Read knowledge item history",
      description:
        "Read the indexed revision history for a company knowledge item. History begins at its first ProEngram sync; prior revisions are not guaranteed. Pass organizationId when your account has multiple organizations.",
      inputSchema: {
        id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).optional(),
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ id, limit, organizationId }) =>
      withToolErrors(async () => {
        const { organization, canReadPolicies } = await authorizeBrainRead(
          principal,
          organizationId,
        );
        const item = await getBrainItem(
          organization.organizationId,
          id,
          canReadPolicies ? undefined : "sentry8_policy",
        );
        if (!item) return textResult("That company knowledge item was not found.", true);
        return textResult({
          id,
          title: item.title,
          history: await getBrainItemHistory(organization.organizationId, id, limit ?? 20),
        });
      }),
  );

  server.registerTool(
    "list_project_history",
    {
      title: "List project decisions and updates",
      description:
        "List explicitly saved decisions and project updates for a project, newest first. Pass organizationId when your account has multiple organizations.",
      inputSchema: {
        projectName: z.string().trim().min(1).max(160),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ projectName, from, to, limit, organizationId }) =>
      withToolErrors(async () => {
        const { organization } = await authorizeBrainRead(principal, organizationId);
        const history = await getProjectHistory(
          organization.organizationId,
          projectName,
          from,
          to,
          limit ?? 50,
        );
        return textResult(
          history.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            markdown: item.markdown,
            projectName: item.projectName,
            occurredAt: item.occurredAt,
            citations: item.citations,
          })),
        );
      }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Read a company knowledge item",
      description:
        "Fetch one result returned by search_knowledge, including its source and revision. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        id: z.string().uuid(),
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ id, organizationId }) =>
      withToolErrors(async () => {
        const { organization, canReadPolicies } = await authorizeBrainRead(
          principal,
          organizationId,
        );
        const item = await getBrainItem(
          organization.organizationId,
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
      description:
        "Search policy snapshots imported from the configured Sentry8 source. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        query: z.string().trim().min(1).max(500).optional(),
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, organizationId }) =>
      withToolErrors(async () => {
        const organization = resolveMcpOrganization(principal, organizationId);
        await authorizeMcpAction(principal, "policy:read", organization.organizationId);
        requireDatabase();
        const policies = query
          ? await searchBrainItemsByKind(organization.organizationId, "sentry8_policy", query, 20)
          : await listItemsByKind(organization.organizationId, "sentry8_policy", 20);
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
        "Explicitly save an answer and its citations for everyone in this company workspace. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        title: z.string().trim().min(1).max(240),
        markdown: z.string().trim().min(1).max(30_000),
        organizationId: organizationIdSchema,
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
    async ({ title, markdown, citations, organizationId }) =>
      withToolErrors(async () => {
        const organization = resolveMcpOrganization(principal, organizationId);
        await authorizeMcpAction(principal, "result:save", organization.organizationId);
        requireDatabase();
        const item = await saveResult({
          organizationId: organization.organizationId,
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
    "save_memory",
    {
      title: "Save a decision or project update",
      description:
        "Publish an explicitly requested decision or project update to the shared company brain immediately. The MCP client supplies and summarizes the memory; ProEngram does not run background AI extraction. Project updates require a project name. Pass organizationId when your account has multiple organizations.",
      inputSchema: {
        recordType: z.enum(["decision", "project_update"]),
        title: z.string().trim().min(1).max(240),
        markdown: z.string().trim().min(1).max(30_000),
        projectName: z.string().trim().min(1).max(160).optional(),
        occurredAt: z.string().datetime().optional(),
        citations: z
          .array(
            z.object({ title: z.string().trim().min(1).max(240), url: z.string().url().max(2048) }),
          )
          .max(30)
          .optional(),
        organizationId: organizationIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ recordType, title, markdown, projectName, occurredAt, citations, organizationId }) =>
      withToolErrors(async () => {
        if (recordType === "project_update" && !projectName) {
          throw new Error("Project updates require a projectName.");
        }
        const organization = resolveMcpOrganization(principal, organizationId);
        await authorizeMcpAction(principal, "result:save", organization.organizationId);
        requireDatabase();
        const item = await saveMemory({
          organizationId: organization.organizationId,
          subjectId: principal.subjectId,
          recordType,
          title,
          markdown,
          projectName: projectName ?? null,
          occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
          citations: citations ?? [],
        });
        return textResult({
          saved: true,
          id: item.id,
          kind: item.kind,
          title: item.title,
          projectName: item.projectName,
        });
      }),
  );

  server.registerTool(
    "submit_knowledge_feedback",
    {
      title: "Submit knowledge feedback",
      description:
        "Mark a company knowledge item as helpful, incorrect, outdated, or missing context. A short note is optional. Pass organizationId when your account has multiple organizations.",
      inputSchema: {
        itemId: z.string().uuid(),
        rating: z.enum(["helpful", "incorrect", "outdated", "missing_context"]),
        note: z.string().trim().max(500).optional(),
        organizationId: organizationIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ itemId, rating, note, organizationId }) =>
      withToolErrors(async () => {
        const { organization, canReadPolicies } = await authorizeBrainRead(
          principal,
          organizationId,
        );
        const item = await getBrainItem(
          organization.organizationId,
          itemId,
          canReadPolicies ? undefined : "sentry8_policy",
        );
        if (!item) return textResult("That company knowledge item was not found.", true);
        await authorizeMcpAction(principal, "brain:feedback", organization.organizationId);
        requireDatabase();
        const feedback = await saveKnowledgeFeedback({
          organizationId: organization.organizationId,
          subjectId: principal.subjectId,
          itemId,
          rating: rating as KnowledgeFeedbackRating,
          note: note || null,
        });
        return textResult({ submitted: true, ...feedback });
      }),
  );

  server.registerTool(
    "list_github_sources",
    {
      title: "List connected GitHub sources",
      description:
        "List GitHub repositories connected to a ProEngram organization. Use sourceId with propose_markdown_change when an organization has multiple repositories. Pass organizationId when your account has multiple organizations.",
      inputSchema: {
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ organizationId }) =>
      withToolErrors(async () => {
        const organization = resolveMcpOrganization(principal, organizationId);
        await authorizeMcpAction(principal, "brain:read", organization.organizationId);
        requireDatabase();
        const sources = await listGitHubRepositorySources(organization.organizationId);
        return textResult(
          sources.map((source) => ({
            sourceId: source.id,
            githubAccount: source.githubLogin,
            repository: `${source.owner}/${source.repository}`,
            defaultBranch: source.defaultBranch,
            status: source.status,
            lastSyncedAt: source.lastSyncedAt,
          })),
        );
      }),
  );

  server.registerTool(
    "propose_markdown_change",
    {
      title: "Propose a knowledge edit",
      description:
        "Create a GitHub pull request for a Markdown file in docs/. The proposal is not merged automatically. Use list_github_sources to select sourceId when the organization has multiple repositories. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        path: z.string().trim().min(6).max(300),
        title: z.string().trim().min(1).max(240),
        markdown: z.string().min(1).max(300_000),
        summary: z.string().trim().min(1).max(4000),
        sourceId: z.string().uuid().optional(),
        organizationId: organizationIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, title, markdown, summary, sourceId, organizationId }) =>
      withToolErrors(async () => {
        const organization = resolveMcpOrganization(principal, organizationId);
        await authorizeMcpAction(principal, "knowledge:propose", organization.organizationId);
        if (!isGitHubConfigured()) throw new Error("The ProEngram GitHub App is not configured.");
        const proposal = await createMarkdownPullRequest({
          organizationId: organization.organizationId,
          subjectId: principal.subjectId,
          sourceId,
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
