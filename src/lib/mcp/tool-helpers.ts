import "server-only";

import { z } from "zod";
import {
  authorizeMcpAction,
  McpAuthError,
  type McpPrincipal,
  resolveMcpOrganization,
} from "@/lib/auth/mcp";
import { type BrainItem, getBrainItem } from "@/lib/db/brain";
import { isDatabaseConfigured } from "@/lib/db/pool";
import { normalizeKnowledgeDate } from "@/lib/knowledge/validation";

export function textResult(value: unknown, isError = false) {
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

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 400)
    : "The requested ProEngram operation failed.";
}

export async function withToolErrors<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    return textResult(errorText(error), true);
  }
}

export async function canAuthorizeMcpAction(
  principal: McpPrincipal,
  action: string,
  organizationId: string,
): Promise<boolean> {
  try {
    await authorizeMcpAction(principal, action, organizationId);
    return true;
  } catch (error) {
    if (error instanceof McpAuthError && (error.status === 403 || error.status === 503)) {
      return false;
    }
    throw error;
  }
}

export function requireDatabase(): void {
  if (!isDatabaseConfigured()) throw new Error("Nanogres PostgreSQL is not configured.");
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const organizationIdSchema = z.string().trim().min(1).max(128).optional();

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => Boolean(normalizeKnowledgeDate(value)), "Expected a valid calendar date.");

export const citationsSchema = z
  .array(z.object({ title: z.string().trim().min(1).max(240), url: z.string().url().max(2048) }))
  .max(30)
  .optional();

export const knowledgeContentSchema = {
  title: z.string().trim().min(1).max(240),
  markdown: z.string().trim().min(1).max(30_000),
  projectName: z.string().trim().min(1).max(160).optional(),
  occurredAt: z.string().datetime().optional(),
  citations: citationsSchema,
  organizationId: organizationIdSchema,
};

export async function authorizeBrainRead(principal: McpPrincipal, organizationId?: string) {
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

export async function authorizeResultSave(principal: McpPrincipal, organizationId?: string) {
  const organization = resolveMcpOrganization(principal, organizationId);
  await authorizeMcpAction(principal, "result:save", organization.organizationId);
  requireDatabase();
  return organization;
}

export async function readKnowledgeItem(
  principal: McpPrincipal,
  id: string,
  organizationId: string | undefined,
  render: (item: BrainItem, organizationId: string) => unknown | Promise<unknown>,
) {
  const { organization, canReadPolicies } = await authorizeBrainRead(principal, organizationId);
  const item = await getBrainItem(
    organization.organizationId,
    id,
    canReadPolicies ? undefined : "sentry8_policy",
  );
  if (!item) return textResult("That company knowledge item was not found.", true);
  return textResult(await render(item, organization.organizationId));
}
