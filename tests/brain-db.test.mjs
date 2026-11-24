import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcRoot = new URL("../src/", import.meta.url);

const mockState = {
  pool: null,
  activities: [],
};

globalThis.__brainDbMock = mockState;

const VIRTUAL_MOCKS = {
  "@/lib/db/pool": `
    export async function getPool() {
      return globalThis.__brainDbMock.pool;
    }
    export function isDatabaseConfigured() {
      return Boolean(globalThis.__brainDbMock.pool);
    }
  `,
  "@/lib/db/transaction": `
    export async function withDatabaseTransaction(fn) {
      const pool = globalThis.__brainDbMock.pool;
      if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  `,
  "@/lib/db/activity": `
    export async function writeActivity(_client, input) {
      globalThis.__brainDbMock.activities.push(input);
    }
    export async function listActivity() {
      return [];
    }
  `,
};

function resolveTsFile(baseUrl) {
  for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
    const candidate = new URL(baseUrl.href + suffix);
    if (existsSync(fileURLToPath(candidate))) {
      return candidate.href;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "virtual:server-only", shortCircuit: true };
    }
    if (Object.hasOwn(VIRTUAL_MOCKS, specifier)) {
      return { url: `virtual:mock:${specifier}`, shortCircuit: true };
    }
    if (specifier === "./pool" && context.parentURL?.includes("/lib/db/")) {
      return { url: "virtual:mock:@/lib/db/pool", shortCircuit: true };
    }
    if (specifier === "./transaction" && context.parentURL?.includes("/lib/db/")) {
      return { url: "virtual:mock:@/lib/db/transaction", shortCircuit: true };
    }
    if (specifier === "./activity" && context.parentURL?.includes("/lib/db/")) {
      return { url: "virtual:mock:@/lib/db/activity", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const resolved = resolveTsFile(new URL(specifier.slice(2), srcRoot));
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(srcRoot.href)
    ) {
      const resolved = resolveTsFile(new URL(specifier, context.parentURL));
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:server-only") {
      return { format: "module", shortCircuit: true, source: "" };
    }
    if (url.startsWith("virtual:mock:")) {
      const key = url.slice("virtual:mock:".length);
      return { format: "module", shortCircuit: true, source: VIRTUAL_MOCKS[key] };
    }
    return nextLoad(url, context);
  },
});

const { searchBrainItems, searchBrainItemsByKind, getBrainItem, getOverview, getProjectHistory } =
  await import(pathToFileURL(fileURLToPath(new URL("lib/db/brain-queries.ts", srcRoot))).href);

const {
  writeItemVersion,
  replaceBrainChunks,
  submitKnowledgeCapture,
  submitKnowledgeEditSuggestion,
} = await import(pathToFileURL(fileURLToPath(new URL("lib/db/brain-writes.ts", srcRoot))).href);

function createFakePool(handler) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params, via: "client" });
      return handler(sql, params);
    },
    release() {},
  };
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params, via: "pool" });
      return handler(sql, params);
    },
    async connect() {
      return client;
    },
  };
}

function makeBrainRow(overrides = {}) {
  return {
    id: "item-1",
    source_id: "src-1",
    kind: "saved_answer",
    title: "Architecture Decision",
    markdown: "Use PostgreSQL with pgvector.",
    source_url: null,
    source_revision: "rev-1",
    source_modified_at: null,
    owner_subject_id: "user-1",
    updated_at: "2026-01-10T00:00:00.000Z",
    occurred_at: "2026-01-09T00:00:00.000Z",
    project_name: "Core",
    citations: [{ title: "RFC", url: "https://example.com/rfc" }],
    match_excerpt: null,
    match_locator: null,
    match_version_id: null,
    match_version_observed_at: null,
    match_source_revision: null,
    is_historical_match: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockState.pool = null;
  mockState.activities = [];
});

test("searchBrainItems returns empty array when pool is unconfigured and validates date range", async () => {
  assert.deepEqual(await searchBrainItems("org-1", "query"), []);

  mockState.pool = createFakePool(async () => ({ rows: [], rowCount: 0 }));
  await assert.rejects(
    () =>
      searchBrainItems("org-1", "query", 10, undefined, {
        dateFrom: "2026-02-10",
        dateTo: "2026-02-01",
      }),
    /start date must be on or before/,
  );
});

test("searchBrainItems handles empty query with filters, history projection, and oldest sort", async () => {
  mockState.pool = createFakePool(async () => ({
    rows: [
      makeBrainRow({
        match_version_id: "ver-2",
        match_version_observed_at: "2026-01-05T00:00:00.000Z",
        is_historical_match: true,
      }),
    ],
    rowCount: 1,
  }));

  const items = await searchBrainItems("org-1", "   ", 15, "sentry8_policy", {
    kind: "decision_record",
    sourceId: "11111111-1111-4111-8111-111111111111",
    projectName: "Alpha",
    ownerSubjectId: "user-9",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    includeHistory: true,
    syncStatus: "succeeded",
    sortBy: "oldest",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].isHistoricalMatch, true);
  assert.equal(items[0].matchVersionId, "ver-2");

  const queryCall = mockState.pool.queries[0];
  assert.equal(queryCall.via, "pool");
  assert.match(queryCall.sql, /version\.title AS title/);
  assert.match(queryCall.sql, /item\.kind = \$2/);
  assert.match(queryCall.sql, /item\.kind <> \$3/);
  assert.match(queryCall.sql, /item\.source_id = \$4::uuid/);
  assert.match(queryCall.sql, /lower\(version\.project_name\) = lower\(\$5\)/);
  assert.match(queryCall.sql, /item\.owner_subject_id = \$6/);
  assert.match(queryCall.sql, /::date >= \$7::date/);
  assert.match(queryCall.sql, /::date <= \$8::date/);
  assert.match(queryCall.sql, /source_sync\.status = \$9/);
  assert.match(queryCall.sql, /ORDER BY coalesce\(version\.occurred_at.*\) ASC/);
  assert.deepEqual(queryCall.params, [
    "org-1",
    "decision_record",
    "sentry8_policy",
    "11111111-1111-4111-8111-111111111111",
    "Alpha",
    "user-9",
    "2026-01-01",
    "2026-01-31",
    "succeeded",
    15,
  ]);
});

test("searchBrainItemsByKind builds hybrid RRF query with 384-dim vector and hnsw.ef_search", async () => {
  mockState.pool = createFakePool(async (sql) => {
    if (sql.includes("WITH filtered_versions")) {
      return {
        rows: [
          makeBrainRow({
            kind: "github_markdown",
            match_excerpt: "Matched chunk text",
            match_locator: "Docs > Setup",
            match_version_id: "ver-9",
            match_version_observed_at: "2026-01-08T00:00:00.000Z",
            match_source_revision: "abc123",
            is_historical_match: false,
          }),
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const vector = Array(384).fill(0.25);
  const results = await searchBrainItemsByKind("org-1", "github_markdown", "pgvector setup", 5, {
    queryVector: vector,
    embeddingModelVersion: "bge-small-v1",
    sortBy: "newest",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].matchExcerpt, "Matched chunk text");
  assert.equal(results[0].matchLocator, "Docs > Setup");

  const efSearch = mockState.pool.queries.find((q) => q.sql === "SET LOCAL hnsw.ef_search = 1000");
  assert.ok(efSearch);

  const rrfQuery = mockState.pool.queries.find((q) => q.sql.includes("WITH filtered_versions"));
  assert.ok(rrfQuery);
  assert.match(rrfQuery.sql, /1\.0 \/ \(60 \+ hit_rank\) AS reciprocal_rank/);
  assert.match(
    rrfQuery.sql,
    /ORDER BY coalesce\(best\.version_occurred_at.*\) DESC, best\.fused_score DESC/,
  );
  assert.equal(rrfQuery.params[0], "org-1");
  assert.equal(rrfQuery.params[1], "github_markdown");
  assert.equal(rrfQuery.params[2], "pgvector setup");
  assert.equal(rrfQuery.params[3], `[${vector.join(",")}]`);
  assert.equal(rrfQuery.params[4], "bge-small-v1");
  assert.equal(rrfQuery.params[5], 5);
});

test("searchBrainItems skips hnsw.ef_search when queryVector is missing or wrong dimension", async () => {
  mockState.pool = createFakePool(async () => ({ rows: [], rowCount: 0 }));

  await searchBrainItems("org-1", "onboarding", 10, undefined, {
    queryVector: [0.1, 0.2],
    embeddingModelVersion: "bge-small-v1",
  });

  assert.equal(
    mockState.pool.queries.some((q) => q.sql.includes("hnsw.ef_search")),
    false,
  );
  const rrfQuery = mockState.pool.queries.find((q) => q.sql.includes("WITH filtered_versions"));
  assert.ok(rrfQuery);
  assert.equal(rrfQuery.params[2], null);
  assert.equal(rrfQuery.params[3], null);
});

test("getBrainItem, getProjectHistory, and getOverview pass org-scoped parameters", async () => {
  mockState.pool = createFakePool(async (sql) => {
    if (sql.includes("GROUP BY kind")) {
      return {
        rows: [
          { kind: "github_markdown", count: "3" },
          { kind: "saved_answer", count: "2" },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("FROM source_syncs")) {
      return {
        rows: [
          {
            source: "github",
            status: "succeeded",
            item_count: 3,
            message: null,
            completed_at: null,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [makeBrainRow()], rowCount: 1 };
  });

  const item = await getBrainItem("org-1", "item-1", "sentry8_policy");
  assert.equal(item?.id, "item-1");
  assert.deepEqual(mockState.pool.queries[0].params, ["org-1", "item-1", "sentry8_policy"]);

  const history = await getProjectHistory("org-1", " Core ", "2026-01-01T00:00:00Z", undefined, 25);
  assert.equal(history.length, 1);
  assert.deepEqual(mockState.pool.queries[1].params, [
    "org-1",
    "Core",
    "2026-01-01T00:00:00Z",
    null,
    25,
  ]);

  const overview = await getOverview("org-1", false);
  assert.equal(overview?.counts.github, 3);
  assert.equal(overview?.counts.saved, 2);
  assert.equal(overview?.counts.policies, 0);
});

test("writeItemVersion computes deterministic sha256 revisionKey and updates current_version_id", async () => {
  const queries = [];
  const fakeClient = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO brain_item_versions")) {
        return { rows: [{ id: "ver-generated-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const versionId = await writeItemVersion(fakeClient, {
    organizationId: "org-1",
    itemId: "item-1",
    title: "Title",
    markdown: "Body",
    projectName: "Core",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(versionId, "ver-generated-1");
  const expectedKey = createHash("sha256")
    .update(JSON.stringify(["Title", "Body", "Core", "2026-01-01T00:00:00.000Z"]))
    .digest("hex");
  assert.equal(queries[0].params[3], expectedKey);
  assert.match(queries[1].sql, /UPDATE brain_items SET current_version_id = \$3/);
  assert.deepEqual(queries[1].params, ["org-1", "item-1", "ver-generated-1"]);
});

test("replaceBrainChunks deletes old chunks, inserts new ones, and enqueues embedding job", async () => {
  const queries = [];
  const fakeClient = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };

  await replaceBrainChunks(fakeClient, {
    organizationId: "org-1",
    itemId: "item-1",
    versionId: "ver-1",
    title: "Guide",
    markdown: "# Guide\n\n## Intro\n\nHello world.",
  });

  assert.match(queries[0].sql, /DELETE FROM brain_chunks/);
  assert.match(queries[1].sql, /INSERT INTO brain_chunks/);
  const inserted = JSON.parse(queries[1].params[3]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].locator, "Intro");
  assert.match(queries[2].sql, /INSERT INTO knowledge_embedding_jobs/);
  assert.match(queries[2].sql, /ON CONFLICT \(organization_id, version_id\) DO UPDATE/);
});

test("submitKnowledgeCapture is idempotent for identical requestId and rejects mismatched payloads", async () => {
  const baseInput = {
    organizationId: "org-1",
    subjectId: "user-1",
    requestId: "req-1",
    itemKind: "saved_answer",
    title: "Deploy Checklist",
    markdown: "Run migrations first.",
    projectName: null,
    occurredAt: "2026-01-02T00:00:00.000Z",
    citations: [{ title: "Runbook", url: "https://example.com/runbook" }],
  };

  const storedRow = {
    id: "sug-1",
    suggestion_type: "capture",
    target_item_id: null,
    item_kind: "saved_answer",
    title: baseInput.title,
    markdown: baseInput.markdown,
    project_name: null,
    occurred_at: baseInput.occurredAt,
    citations: baseInput.citations,
    proposer_subject_id: "user-1",
    confirmed_at: "2026-01-02T00:00:00.000Z",
  };

  mockState.pool = createFakePool(async (sql) => {
    if (sql.includes("INSERT INTO knowledge_suggestions")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM knowledge_suggestions")) {
      return { rows: [storedRow], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const duplicate = await submitKnowledgeCapture(baseInput);
  assert.equal(duplicate.id, "sug-1");
  assert.equal(mockState.activities.length, 0);

  await assert.rejects(
    () => submitKnowledgeCapture({ ...baseInput, title: "Different Title" }),
    /already used for different content/,
  );
});

test("submitKnowledgeEditSuggestion prevents editing own item or changing itemKind", async () => {
  mockState.pool = createFakePool(async (sql) => {
    if (sql.includes("FROM brain_items")) {
      return {
        rows: [{ title: "Existing", kind: "saved_answer", owner_subject_id: "user-1" }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    () =>
      submitKnowledgeEditSuggestion({
        organizationId: "org-1",
        subjectId: "user-1",
        requestId: "req-2",
        targetItemId: "item-1",
        itemKind: "saved_answer",
        title: "Edited",
        markdown: "Updated",
        citations: [],
      }),
    /Edit your own knowledge item directly/,
  );

  await assert.rejects(
    () =>
      submitKnowledgeEditSuggestion({
        organizationId: "org-1",
        subjectId: "user-2",
        requestId: "req-3",
        targetItemId: "item-1",
        itemKind: "decision_record",
        title: "Edited",
        markdown: "Updated",
        citations: [],
      }),
    /must keep the item type/,
  );
});
