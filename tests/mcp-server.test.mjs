import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const srcRoot = new URL("../src/", import.meta.url);

const mockState = {
  pool: null,
  brainItems: [],
  brainItemById: new Map(),
  savedResults: [],
  savedMemories: [],
  githubConfigured: true,
  githubSources: [],
  proposedPr: {
    url: "https://github.com/acme/docs/pull/42",
    number: 42,
    branch: "proengram/proposal-1",
  },
  searchCalls: [],
};

globalThis.__mcpTestMock = mockState;

const VIRTUAL_MOCKS = {
  "@/lib/auth/config": `
    export function getPublicOrigin() {
      return "https://proengram.test";
    }
    export function getMcpResourceUri() {
      return "https://proengram.test/mcp";
    }
    export function getPerministerBaseUrl() {
      return "https://perminister.test";
    }
    export function getPerministerClient() {
      return {
        baseUrl: "https://perminister.test",
        clientId: "client-id",
        clientSecret: "client-secret",
        productId: "proengram",
      };
    }
  `,
  "@/lib/auth/protected-resource": `
    export function protectedResourceMetadataUrl() {
      return "https://proengram.test/.well-known/oauth-protected-resource";
    }
  `,
  "@/lib/db/pool": `
    export async function getPool() {
      return globalThis.__mcpTestMock.pool;
    }
    export function isDatabaseConfigured() {
      return Boolean(globalThis.__mcpTestMock.pool);
    }
  `,
  "@/lib/db/brain": `
    export async function searchBrainItems(orgId, query, limit, excludeKind, filters) {
      globalThis.__mcpTestMock.searchCalls.push({ orgId, query, limit, excludeKind, filters });
      return globalThis.__mcpTestMock.brainItems.filter(
        (item) => !excludeKind || item.kind !== excludeKind,
      );
    }
    export async function searchBrainItemsByKind(_orgId, kind) {
      return globalThis.__mcpTestMock.brainItems.filter((item) => item.kind === kind);
    }
    export async function getBrainItem(_orgId, id, excludeKind) {
      const item = globalThis.__mcpTestMock.brainItemById.get(id) ?? null;
      if (!item || (excludeKind && item.kind === excludeKind)) return null;
      return item;
    }
    export async function listItemsByKind(_orgId, kind) {
      return globalThis.__mcpTestMock.brainItems.filter((item) => item.kind === kind);
    }
    export async function getBrainItemHistory() { return []; }
    export async function getBrainItemVersion() { return null; }
    export async function getProjectHistory() { return []; }
    export async function saveResult(input) {
      const item = { id: "saved-1", ...input };
      globalThis.__mcpTestMock.savedResults.push(item);
      return item;
    }
    export async function saveMemory(input) {
      const item = {
        id: "mem-1",
        kind: input.recordType === "decision" ? "decision_record" : "project_update",
        ...input,
      };
      globalThis.__mcpTestMock.savedMemories.push(item);
      return item;
    }
    export async function submitKnowledgeCapture(input) {
      return { id: "sug-1", ...input };
    }
    export async function saveKnowledgeFeedback(input) {
      return { id: "fb-1", ...input };
    }
  `,
  "@/lib/knowledge/search-embedding": `
    export async function createKnowledgeSearchEmbedding() {
      return {};
    }
  `,
  "@/lib/github/github": `
    export function isGitHubConfigured() {
      return globalThis.__mcpTestMock.githubConfigured;
    }
    export async function listGitHubRepositorySources() {
      return globalThis.__mcpTestMock.githubSources;
    }
    export async function createMarkdownPullRequest() {
      return globalThis.__mcpTestMock.proposedPr;
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
    if (specifier === "./config" && context.parentURL?.includes("/lib/auth/")) {
      return { url: "virtual:mock:@/lib/auth/config", shortCircuit: true };
    }
    if (specifier === "./protected-resource" && context.parentURL?.includes("/lib/auth/")) {
      return { url: "virtual:mock:@/lib/auth/protected-resource", shortCircuit: true };
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
    if (url.startsWith(srcRoot.href) && url.endsWith(".ts")) {
      const sourceText = readFileSync(fileURLToPath(url), "utf8");
      const transpiled = ts.transpileModule(sourceText, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          isolatedModules: true,
        },
        fileName: fileURLToPath(url),
      });
      return { format: "module", shortCircuit: true, source: transpiled.outputText };
    }
    return nextLoad(url, context);
  },
});

const route = await import(pathToFileURL(fileURLToPath(new URL("app/mcp/route.ts", srcRoot))).href);
const authMcp = await import(
  pathToFileURL(fileURLToPath(new URL("lib/auth/mcp.ts", srcRoot))).href
);
const { handleMcpRequest } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/mcp/server.ts", srcRoot))).href
);

const originalFetch = globalThis.fetch;

function installFetchMock({
  scopes = "brain:read policy:read result:save brain:feedback knowledge:propose",
  organizations = [
    { organizationId: "ORG-ALPHA", organizationName: "Alpha", productId: "proengram" },
  ],
  deniedActions = new Set(),
} = {}) {
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith("/oauth/introspect")) {
      return Response.json({
        active: true,
        sub: "user-1",
        iss: "https://perminister.test",
        aud: "https://proengram.test/mcp",
        scope: scopes,
      });
    }
    if (href.endsWith("/api/auth/consumer/session")) {
      return Response.json({
        authenticated: true,
        account: { subjectId: "user-1" },
        organizations,
      });
    }
    if (href.endsWith("/api/authorize")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (deniedActions.has(body.action)) {
        return Response.json({ authorized: false, subjectId: "user-1" });
      }
      return Response.json({ authorized: true, subjectId: "user-1" });
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };
}

function makeFakePool() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeMcpPostRequest(body, headers = {}) {
  return new Request("https://proengram.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockState.pool = makeFakePool();
  mockState.brainItems = [];
  mockState.brainItemById.clear();
  mockState.savedResults = [];
  mockState.savedMemories = [];
  mockState.githubConfigured = true;
  mockState.githubSources = [];
  mockState.searchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("MCP route returns 405 on GET and DELETE with Allow: POST, OPTIONS", async () => {
  const getRes = route.GET();
  assert.equal(getRes.status, 405);
  assert.equal(getRes.headers.get("allow"), "POST, OPTIONS");
  assert.equal(getRes.headers.get("cache-control"), "no-store");

  const delRes = route.DELETE();
  assert.equal(delRes.status, 405);
  assert.equal(delRes.headers.get("allow"), "POST, OPTIONS");
});

test("MCP route OPTIONS and POST enforce CORS allowlist", async () => {
  const allowedOpt = await route.OPTIONS(
    new Request("https://proengram.test/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai" },
    }),
  );
  assert.equal(allowedOpt.status, 204);
  assert.equal(allowedOpt.headers.get("access-control-allow-origin"), "https://claude.ai");

  const blockedOpt = await route.OPTIONS(
    new Request("https://proengram.test/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
  );
  assert.equal(blockedOpt.status, 403);

  const blockedPost = await route.POST(
    makeMcpPostRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { origin: "https://evil.example" },
    ),
  );
  assert.equal(blockedPost.status, 403);
  assert.deepEqual(await blockedPost.json(), { error: "origin_not_allowed" });
});

test("MCP route returns 401 without bearer token and 403 with insufficient_scope challenge", async () => {
  const unauth = await route.POST(
    new Request("https://proengram.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata=/);

  installFetchMock({ scopes: "brain:read" });
  const forbidden = await route.POST(
    makeMcpPostRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "save_result", arguments: { title: "T", markdown: "M" } },
    }),
  );
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
  assert.match(forbidden.headers.get("www-authenticate") ?? "", /scope="result:save"/);
});

test("authorizeMcpToolCalls enforces 4 MB body size limit and validates organizationId type", async () => {
  const principal = {
    accessToken: "tok",
    subjectId: "user-1",
    organizations: [{ organizationId: "org-1", name: "Org 1" }],
    scopes: new Set(["brain:read"]),
  };

  await assert.rejects(
    () =>
      authMcp.authorizeMcpToolCalls(
        new Request("https://proengram.test/mcp", {
          method: "POST",
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
          body: "{}",
        }),
        principal,
      ),
    (err) => err instanceof authMcp.McpAuthError && err.status === 413,
  );

  await assert.rejects(
    () =>
      authMcp.authorizeMcpToolCalls(
        makeMcpPostRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_knowledge", arguments: { query: "hi", organizationId: 123 } },
        }),
        principal,
      ),
    (err) => err instanceof authMcp.McpAuthError && err.status === 400,
  );
});

test("resolveMcpOrganization enforces multi-org disambiguation and org isolation", () => {
  const multiOrgPrincipal = {
    accessToken: "tok",
    subjectId: "user-1",
    organizations: [
      { organizationId: "org-a", name: "Org A" },
      { organizationId: "org-b", name: "Org B" },
    ],
    scopes: new Set(["brain:read"]),
  };

  assert.throws(
    () => authMcp.resolveMcpOrganization(multiOrgPrincipal),
    (err) => err instanceof authMcp.McpAuthError && err.status === 400,
  );
  assert.throws(
    () => authMcp.resolveMcpOrganization(multiOrgPrincipal, "org-other"),
    (err) => err instanceof authMcp.McpAuthError && err.status === 403,
  );
  assert.deepEqual(authMcp.resolveMcpOrganization(multiOrgPrincipal, " ORG-B "), {
    organizationId: "org-b",
    name: "Org B",
  });
});

test("MCP server registers all expected tools and dispatches search_knowledge with policy filtering", async () => {
  installFetchMock({
    scopes: "brain:read",
    deniedActions: new Set(["policy:read"]),
  });

  const listRes = await route.POST(
    makeMcpPostRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { origin: "https://chatgpt.com" },
    ),
  );
  assert.equal(listRes.status, 200);
  assert.equal(listRes.headers.get("access-control-allow-origin"), "https://chatgpt.com");
  const listJson = await listRes.json();
  const toolNames = listJson.result.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, [
    "get_document",
    "get_document_history",
    "get_policy",
    "list_github_sources",
    "list_organizations",
    "list_project_history",
    "propose_markdown_change",
    "save_memory",
    "save_result",
    "search_knowledge",
    "submit_knowledge_feedback",
    "suggest_knowledge_capture",
  ]);

  mockState.brainItems = [
    {
      id: "doc-1",
      sourceId: null,
      kind: "saved_answer",
      title: "Public Answer",
      markdown: "Details",
      sourceUrl: null,
      sourceRevision: null,
      sourceModifiedAt: null,
      ownerSubjectId: "user-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      occurredAt: null,
      projectName: null,
      citations: [],
      matchExcerpt: null,
      matchLocator: null,
      matchVersionId: null,
      matchVersionObservedAt: null,
      matchSourceRevision: null,
      isHistoricalMatch: false,
    },
    {
      id: "pol-1",
      sourceId: null,
      kind: "sentry8_policy",
      title: "Secret Policy",
      markdown: "Restricted",
      sourceUrl: null,
      sourceRevision: null,
      sourceModifiedAt: null,
      ownerSubjectId: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      occurredAt: null,
      projectName: null,
      citations: [],
      matchExcerpt: null,
      matchLocator: null,
      matchVersionId: null,
      matchVersionObservedAt: null,
      matchSourceRevision: null,
      isHistoricalMatch: false,
    },
  ];

  const searchRes = await route.POST(
    makeMcpPostRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_knowledge", arguments: { query: "policy" } },
    }),
  );
  assert.equal(searchRes.status, 200);
  const searchJson = await searchRes.json();
  const parsed = JSON.parse(searchJson.result.content[0].text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "doc-1");
  assert.equal(mockState.searchCalls[0].excludeKind, "sentry8_policy");
});

test("MCP tools validate save_memory projectName and dispatch propose_markdown_change", async () => {
  installFetchMock();
  const principal = {
    accessToken: "tok",
    subjectId: "user-1",
    organizations: [{ organizationId: "org-alpha", name: "Alpha" }],
    scopes: new Set(["result:save", "knowledge:propose"]),
    authorizedActions: new Set(["org-alpha\u0000result:save", "org-alpha\u0000knowledge:propose"]),
  };

  const invalidMemRes = await handleMcpRequest(
    makeMcpPostRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "save_memory",
        arguments: {
          recordType: "project_update",
          title: "Weekly update",
          markdown: "Shipped feature",
        },
      },
    }),
    principal,
  );
  const invalidMemJson = await invalidMemRes.json();
  assert.equal(invalidMemJson.result.isError, true);
  assert.match(invalidMemJson.result.content[0].text, /projectName/);

  const prRes = await handleMcpRequest(
    makeMcpPostRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "propose_markdown_change",
        arguments: {
          path: "docs/onboarding.md",
          title: "Update onboarding",
          markdown: "# Onboarding\n\nUpdated steps.",
          summary: "Clarified setup",
        },
      },
    }),
    principal,
  );
  const prJson = await prRes.json();
  assert.equal(prJson.result.isError, undefined);
  assert.deepEqual(JSON.parse(prJson.result.content[0].text), {
    ...mockState.proposedPr,
    merged: false,
  });
});
