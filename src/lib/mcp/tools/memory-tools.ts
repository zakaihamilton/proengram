import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeMcpAction, type McpPrincipal } from "@/lib/auth/mcp";
import {
  getBrainItem,
  type KnowledgeFeedbackRating,
  saveKnowledgeFeedback,
  saveMemory,
  saveResult,
  submitKnowledgeCapture,
} from "@/lib/db/brain";
import {
  authorizeBrainRead,
  authorizeResultSave,
  citationsSchema,
  knowledgeContentSchema,
  organizationIdSchema,
  requireDatabase,
  textResult,
  withToolErrors,
} from "../tool-helpers";

export function registerMemoryTools(server: McpServer, principal: McpPrincipal): void {
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
        citations: citationsSchema,
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
        const organization = await authorizeResultSave(principal, organizationId);
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
        ...knowledgeContentSchema,
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
        const organization = await authorizeResultSave(principal, organizationId);
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
    "suggest_knowledge_capture",
    {
      title: "Submit confirmed knowledge for review",
      description:
        "Submit one concise, employee-confirmed answer, decision, or project update to the shared review queue. Call this only after the employee explicitly confirms this exact candidate. Do not send or retain full chat transcripts. The item is not searchable until an organization member approves it. Pass organizationId when your account has multiple organizations.",
      inputSchema: {
        requestId: z.string().uuid(),
        employeeConfirmed: z.literal(true),
        kind: z.enum(["saved_answer", "decision_record", "project_update"]),
        ...knowledgeContentSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      requestId,
      employeeConfirmed: _employeeConfirmed,
      kind,
      title,
      markdown,
      projectName,
      occurredAt,
      citations,
      organizationId,
    }) =>
      withToolErrors(async () => {
        if (kind === "project_update" && !projectName) {
          throw new Error("Project updates require a projectName.");
        }
        const organization = await authorizeResultSave(principal, organizationId);
        const suggestion = await submitKnowledgeCapture({
          organizationId: organization.organizationId,
          subjectId: principal.subjectId,
          requestId,
          itemKind: kind,
          title,
          markdown,
          projectName: projectName ?? null,
          occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
          citations: citations ?? [],
        });
        return textResult({
          submitted: true,
          status: "pending_review",
          suggestionId: suggestion.id,
          title: suggestion.title,
          kind: suggestion.itemKind,
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
}
