export type BrainItemKind =
  | "github_markdown"
  | "google_drive_document"
  | "saved_answer"
  | "sentry8_policy"
  | "decision_record"
  | "project_update";

export type BrainItem = {
  id: string;
  sourceId: string | null;
  kind: BrainItemKind;
  title: string;
  markdown: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceModifiedAt: string | null;
  ownerSubjectId: string | null;
  updatedAt: string;
  occurredAt: string | null;
  projectName: string | null;
  citations: Array<{ title: string; url: string }>;
  matchExcerpt: string | null;
  matchLocator: string | null;
  matchVersionId: string | null;
  matchVersionObservedAt: string | null;
  matchSourceRevision: string | null;
  isHistoricalMatch: boolean;
};

export type BrainItemVersion = {
  id: string;
  title: string;
  sourceRevision: string | null;
  sourceModifiedAt: string | null;
  observedAt: string;
  markdown: string;
  projectName: string | null;
  occurredAt: string | null;
  citations: Array<{ title: string; url: string }>;
};

export type KnowledgeContentInput = {
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName?: string | null;
  occurredAt?: string | null;
  citations: Array<{ title: string; url: string }>;
};

export type BrainSearchFilters = {
  kind?: BrainItemKind;
  sourceId?: string;
  projectName?: string;
  ownerSubjectId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeHistory?: boolean;
  syncStatus?: "running" | "succeeded" | "failed";
  sortBy?: "relevance" | "newest" | "oldest";
  queryVector?: number[];
  embeddingModelVersion?: string;
};

export type KnowledgeSuggestion = {
  id: string;
  suggestionType: "capture" | "edit";
  targetItemId: string | null;
  targetItemTitle: string | null;
  itemKind: "saved_answer" | "decision_record" | "project_update";
  title: string;
  markdown: string;
  projectName: string | null;
  occurredAt: string | null;
  citations: Array<{ title: string; url: string }>;
  proposerSubjectId: string;
  confirmedAt: string;
};

export type KnowledgeFeedbackRating = "helpful" | "incorrect" | "outdated" | "missing_context";

export type KnowledgeFeedback = {
  id: string;
  itemId: string;
  itemTitle: string;
  actorSubjectId: string;
  rating: KnowledgeFeedbackRating;
  note: string | null;
  status: "pending" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
};

export const ITEM_FIELDS =
  "id, source_id, kind, title, markdown, source_url, source_revision, source_modified_at, owner_subject_id, updated_at, occurred_at, project_name, citations";

export function mapCitations(value: unknown): Array<{ title: string; url: string }> {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const citation = entry as Record<string, unknown>;
        return typeof citation.title === "string" && typeof citation.url === "string"
          ? [{ title: citation.title, url: citation.url }]
          : [];
      })
    : [];
}

export function nullableIso(value: unknown): string | null {
  return value ? new Date(String(value)).toISOString() : null;
}

export function mapItem(row: Record<string, unknown>): BrainItem {
  return {
    id: String(row.id),
    sourceId: typeof row.source_id === "string" ? row.source_id : null,
    kind: row.kind as BrainItemKind,
    title: String(row.title),
    markdown: String(row.markdown ?? ""),
    sourceUrl: typeof row.source_url === "string" ? row.source_url : null,
    sourceRevision: typeof row.source_revision === "string" ? row.source_revision : null,
    sourceModifiedAt: nullableIso(row.source_modified_at),
    ownerSubjectId: typeof row.owner_subject_id === "string" ? row.owner_subject_id : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    occurredAt: nullableIso(row.occurred_at),
    projectName: typeof row.project_name === "string" ? row.project_name : null,
    citations: mapCitations(row.citations),
    matchExcerpt: typeof row.match_excerpt === "string" ? row.match_excerpt : null,
    matchLocator: typeof row.match_locator === "string" ? row.match_locator : null,
    matchVersionId: typeof row.match_version_id === "string" ? row.match_version_id : null,
    matchVersionObservedAt: nullableIso(row.match_version_observed_at),
    matchSourceRevision:
      typeof row.match_source_revision === "string" ? row.match_source_revision : null,
    isHistoricalMatch: row.is_historical_match === true,
  };
}
