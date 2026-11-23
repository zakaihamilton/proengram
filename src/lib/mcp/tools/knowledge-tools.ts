import "server-only";

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeMcpAction, type McpPrincipal, resolveMcpOrganization } from "@/lib/auth/mcp";
import {
  getBrainItemHistory,
  getBrainItemVersion,
  getProjectHistory,
  listItemsByKind,
  searchBrainItems,
  searchBrainItemsByKind,
} from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { createKnowledgeSearchEmbedding } from "@/lib/knowledge/search-embedding";
import {
  authorizeBrainRead,
  calendarDateSchema,
  organizationIdSchema,
  READ_ONLY_ANNOTATIONS,
  readKnowledgeItem,
  requireDatabase,
  textResult,
  withToolErrors,
} from "../tool-helpers";

export function registerKnowledgeTools(server: McpServer, principal: McpPrincipal): void {
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
        "Search approved GitHub and Google Drive documents, saved answers, decisions, project history, and imported Sentry8 policy snapshots. Supports filters for type, source, project, owner, date range, historical revisions, source sync status, and sorting. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
        organizationId: organizationIdSchema,
        kind: z
          .enum([
            "github_markdown",
            "google_drive_document",
            "saved_answer",
            "sentry8_policy",
            "decision_record",
            "project_update",
          ])
          .optional(),
        sourceId: z.string().uuid().optional(),
        projectName: z.string().trim().min(1).max(160).optional(),
        ownerSubjectId: z.string().trim().min(1).max(200).optional(),
        dateFrom: calendarDateSchema.optional(),
        dateTo: calendarDateSchema.optional(),
        includeHistory: z.boolean().optional(),
        syncStatus: z.enum(["running", "succeeded", "failed"]).optional(),
        sortBy: z.enum(["relevance", "newest", "oldest"]).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      query,
      limit,
      organizationId,
      kind,
      sourceId,
      projectName,
      ownerSubjectId,
      dateFrom,
      dateTo,
      includeHistory,
      syncStatus,
      sortBy,
    }) =>
      withToolErrors(async () => {
        const { organization, canReadPolicies } = await authorizeBrainRead(
          principal,
          organizationId,
        );
        const searchEmbedding = await createKnowledgeSearchEmbedding(query);
        const items = await searchBrainItems(
          organization.organizationId,
          query,
          limit ?? 8,
          canReadPolicies ? undefined : "sentry8_policy",
          {
            kind,
            sourceId,
            projectName,
            ownerSubjectId,
            dateFrom,
            dateTo,
            includeHistory,
            syncStatus,
            sortBy,
            ...searchEmbedding,
          },
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
            sourceId: item.sourceId,
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
            matchedVersion: item.matchVersionId
              ? {
                  id: item.matchVersionId,
                  sourceRevision: item.matchSourceRevision,
                  observedAt: item.matchVersionObservedAt,
                  historical: item.isHistoricalMatch,
                }
              : null,
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
      withToolErrors(() =>
        readKnowledgeItem(principal, id, organizationId, (item, resolvedOrganizationId) =>
          getBrainItemHistory(resolvedOrganizationId, id, limit ?? 20).then((history) => ({
            id,
            title: item.title,
            history,
          })),
        ),
      ),
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
        "Fetch one result returned by search_knowledge, including its source and revision. Pass versionId to read a specific historical revision. Pass organizationId when your account has multiple ProEngram organizations.",
      inputSchema: {
        id: z.string().uuid(),
        versionId: z.string().uuid().optional(),
        organizationId: organizationIdSchema,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ id, versionId, organizationId }) =>
      withToolErrors(() =>
        readKnowledgeItem(principal, id, organizationId, async (item, resolvedOrganizationId) => {
          if (!versionId) return item;
          const version = await getBrainItemVersion(resolvedOrganizationId, id, versionId);
          if (!version) throw new Error("That knowledge revision was not found.");
          return { ...item, matchedVersion: version };
        }),
      ),
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
          ? await searchBrainItemsByKind(
              organization.organizationId,
              "sentry8_policy",
              query,
              20,
              await createKnowledgeSearchEmbedding(query),
            )
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
}
