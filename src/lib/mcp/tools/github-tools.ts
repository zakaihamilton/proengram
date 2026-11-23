import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeMcpAction, type McpPrincipal, resolveMcpOrganization } from "@/lib/auth/mcp";
import {
  createMarkdownPullRequest,
  isGitHubConfigured,
  listGitHubRepositorySources,
} from "@/lib/github/github";
import {
  organizationIdSchema,
  READ_ONLY_ANNOTATIONS,
  requireDatabase,
  textResult,
  withToolErrors,
} from "../tool-helpers";

export function registerGitHubTools(server: McpServer, principal: McpPrincipal): void {
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
}
