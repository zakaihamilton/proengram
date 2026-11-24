import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const srcRoot = new URL("../src/", import.meta.url);

const mockState = {
  pool: null,
  githubSource: null,
  githubToken: "ghs_test_token",
  writtenVersions: [],
  replacedChunks: [],
  activities: [],
  driveStartToken: "start-token-1",
  driveChangesPages: [],
  driveFiles: [],
  driveFolders: [],
  driveFileById: new Map(),
  removedFiles: [],
};

globalThis.__syncPlannersMock = mockState;

const VIRTUAL_MOCKS = {
  "@/lib/db/pool": `
    export async function getPool() {
      return globalThis.__syncPlannersMock.pool;
    }
    export function isDatabaseConfigured() {
      return Boolean(globalThis.__syncPlannersMock.pool);
    }
  `,
  "@/lib/db/transaction": `
    export async function withDatabaseTransaction(fn) {
      const pool = globalThis.__syncPlannersMock.pool;
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
  "@/lib/db/brain": `
    export async function writeItemVersion(_client, input) {
      globalThis.__syncPlannersMock.writtenVersions.push(input);
      return "ver-" + globalThis.__syncPlannersMock.writtenVersions.length;
    }
    export async function replaceBrainChunks(_client, input) {
      globalThis.__syncPlannersMock.replacedChunks.push(input);
    }
    export async function writeActivity(_client, input) {
      globalThis.__syncPlannersMock.activities.push(input);
    }
  `,
  "./connections": `
    export async function getGitHubAccessToken() {
      return globalThis.__syncPlannersMock.githubToken;
    }
  `,
  "./sources": `
    export async function getRepositorySource() {
      return globalThis.__syncPlannersMock.githubSource;
    }
    export function mapSource(row) {
      return {
        id: row.id,
        organizationAccountId: row.organization_account_id,
        owner: row.repository_owner,
        repository: row.repository_name,
        defaultBranch: row.default_branch,
        status: row.status,
        lastSyncedAt: row.last_synced_at,
        lastSyncedCommitSha: row.last_synced_commit_sha ?? null,
        githubLogin: row.github_login,
        accountStatus: row.account_status,
      };
    }
  `,
  "./drive-api": `
    export class GoogleDriveApiError extends Error {
      constructor(message, status) {
        super(message);
        this.name = "GoogleDriveApiError";
        this.status = status;
      }
    }
    export async function getGoogleDriveStartPageToken() {
      return globalThis.__syncPlannersMock.driveStartToken;
    }
    export async function listGoogleDriveChanges(_token, _driveId, pageToken) {
      const handler = globalThis.__syncPlannersMock.driveChangesPages.shift();
      if (!handler) return { changes: [], newStartPageToken: pageToken };
      return typeof handler === "function" ? handler(pageToken) : handler;
    }
    export async function listGoogleDriveFiles() {
      return globalThis.__syncPlannersMock.driveFiles;
    }
    export async function listGoogleDriveFolders() {
      return globalThis.__syncPlannersMock.driveFolders;
    }
    export async function getGoogleDriveFile(_token, fileId) {
      const entry = globalThis.__syncPlannersMock.driveFileById.get(fileId);
      if (entry instanceof Error) throw entry;
      return entry ?? null;
    }
  `,
  "./sync-store": `
    export async function markFileRemoved(orgId, sourceId, fileId, message) {
      globalThis.__syncPlannersMock.removedFiles.push({ orgId, sourceId, fileId, message });
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
    if (
      Object.hasOwn(VIRTUAL_MOCKS, specifier) ||
      specifier.endsWith("/lib/google-drive/drive-api.ts")
    ) {
      const key = Object.hasOwn(VIRTUAL_MOCKS, specifier) ? specifier : "./drive-api";
      return { url: `virtual:mock:${key}`, shortCircuit: true };
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

const { createMarkdownPullRequest } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/github/proposals.ts", srcRoot))).href
);
const { syncGitHubMarkdown } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/github/sync.ts", srcRoot))).href
);
const { planGoogleDriveSync, recheckErroredIncrementalFiles } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/google-drive/change-planner.ts", srcRoot))).href
);
const { GoogleDriveApiError } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/google-drive/drive-api.ts", srcRoot))).href
);

const originalFetch = globalThis.fetch;

function createFakePool(handler) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return handler(sql, params);
    },
    release() {},
  };
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return handler(sql, params);
    },
    async connect() {
      return client;
    },
  };
}

beforeEach(() => {
  mockState.pool = null;
  mockState.githubSource = {
    id: "src-gh-1",
    organizationId: "org-1",
    organizationAccountId: "acct-1",
    owner: "acme",
    repository: "handbook",
    defaultBranch: "main",
    status: "active",
    lastSyncedCommitSha: null,
  };
  mockState.writtenVersions = [];
  mockState.replacedChunks = [];
  mockState.activities = [];
  mockState.driveStartToken = "start-token-1";
  mockState.driveChangesPages = [];
  mockState.driveFiles = [];
  mockState.driveFolders = [];
  mockState.driveFileById.clear();
  mockState.removedFiles = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("createMarkdownPullRequest enforces docs/ path safety and 300 KB size limit", async () => {
  const base = {
    organizationId: "org-1",
    subjectId: "user-1",
    title: "Update guide",
    markdown: "# Guide\n\nContent",
    summary: "Summary",
  };

  for (const badPath of [
    "README.md",
    "src/docs/guide.md",
    "docs/../secret.md",
    "docs/.hidden.md",
    "docs/notes.txt",
  ]) {
    await assert.rejects(
      () => createMarkdownPullRequest({ ...base, path: badPath }),
      /Only Markdown files inside docs\//,
    );
  }

  await assert.rejects(
    () =>
      createMarkdownPullRequest({
        ...base,
        path: "docs/huge.md",
        markdown: "a".repeat(300_001),
      }),
    /exceeds 300 KB/,
  );
});

test("createMarkdownPullRequest creates branch, commits docs/*.mdx, opens PR, and audits", async () => {
  mockState.pool = createFakePool(async () => ({ rows: [], rowCount: 0 }));

  const requests = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    requests.push({ href, method, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (href.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: "a".repeat(40) } });
    }
    if (href.endsWith("/git/refs") && method === "POST") {
      return Response.json({ ref: "refs/heads/proengram/proposal-test" });
    }
    if (href.includes("/contents/docs/guides/setup.mdx") && method === "GET") {
      return new Response(null, { status: 404 });
    }
    if (href.includes("/contents/docs/guides/setup.mdx") && method === "PUT") {
      return Response.json({ content: { sha: "blob-1" } });
    }
    if (href.endsWith("/pulls") && method === "POST") {
      return Response.json({
        html_url: "https://github.com/acme/handbook/pull/99",
        number: 99,
      });
    }
    throw new Error(`Unexpected GitHub URL: ${method} ${href}`);
  };

  const result = await createMarkdownPullRequest({
    organizationId: "org-1",
    subjectId: "user-1",
    sourceId: "src-gh-1",
    path: "docs/guides/setup.mdx",
    title: "Add setup guide",
    markdown: "# Setup\n\nRun pnpm install.",
    summary: "Added setup guide",
  });

  assert.equal(result.url, "https://github.com/acme/handbook/pull/99");
  assert.equal(result.number, 99);
  assert.match(result.branch, /^proengram\/proposal-/);

  const succeededAudit = mockState.pool.queries.find((q) =>
    q.sql.includes("UPDATE activity_events"),
  );
  assert.ok(succeededAudit);
  assert.match(succeededAudit.params[1], /Opened GitHub PR #99/);
});

test("syncGitHubMarkdown skips unchanged commits and enforces tree/file/size limits", async () => {
  const sha = "b".repeat(40);
  mockState.pool = createFakePool(async () => ({ rows: [], rowCount: 0 }));
  mockState.githubSource.lastSyncedCommitSha = sha;

  const skipped = await syncGitHubMarkdown("org-1", "src-gh-1", "user-1", {
    commitSha: sha,
    skipIfUnchanged: true,
  });
  assert.deepEqual(skipped, {
    itemCount: 0,
    repository: "acme/handbook",
    commitSha: sha,
    skipped: true,
  });

  // Invalid commit SHA
  await assert.rejects(
    () => syncGitHubMarkdown("org-1", "src-gh-1", "user-1", { commitSha: "not-a-sha" }),
    /valid commit/,
  );

  // Truncated tree
  globalThis.fetch = async () => Response.json({ truncated: true, tree: [] });
  await assert.rejects(
    () => syncGitHubMarkdown("org-1", "src-gh-1", "user-1", { commitSha: sha }),
    /too large for a single safe sync/,
  );

  // > 500 markdown files
  globalThis.fetch = async () =>
    Response.json({
      truncated: false,
      tree: Array.from({ length: 501 }, (_, i) => ({
        path: `docs/f-${i}.md`,
        type: "blob",
        sha: `sha-${i}`,
        size: 10,
      })),
    });
  await assert.rejects(
    () => syncGitHubMarkdown("org-1", "src-gh-1", "user-1", { commitSha: sha }),
    /exceeds the Markdown file limit/,
  );
});

test("syncGitHubMarkdown syncs valid markdown blobs and updates versions/chunks", async () => {
  const sha = "c".repeat(40);
  mockState.pool = createFakePool(async (sql) => {
    if (sql.includes("FROM github_repository_sources")) {
      return {
        rows: [
          {
            organization_account_id: "acct-1",
            default_branch: "main",
            status: "active",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO brain_items")) {
      return { rows: [{ id: "brain-item-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/git/trees/")) {
      return Response.json({
        truncated: false,
        tree: [
          { path: "docs/intro.md", type: "blob", sha: "blob-ok", size: 30 },
          { path: "docs/too-big.md", type: "blob", sha: "blob-big", size: 400_000 },
          { path: "src/index.ts", type: "blob", sha: "blob-ts", size: 20 },
        ],
      });
    }
    if (href.endsWith("/git/blobs/blob-ok")) {
      return Response.json({
        encoding: "base64",
        size: 30,
        content: Buffer.from("# Intro Guide\n\nWelcome!", "utf8").toString("base64"),
      });
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  const result = await syncGitHubMarkdown("org-1", "src-gh-1", "user-1", { commitSha: sha });
  assert.deepEqual(result, {
    itemCount: 1,
    repository: "acme/handbook",
    commitSha: sha,
    skipped: false,
  });
  assert.equal(mockState.writtenVersions.length, 1);
  assert.equal(mockState.writtenVersions[0].title, "Intro Guide");
  assert.equal(mockState.replacedChunks.length, 1);
  assert.equal(mockState.activities.length, 1);
});

test("planGoogleDriveSync falls back to full scan on expired token (410) and classifies incremental changes", async () => {
  const folder = {
    id: "folder-root",
    name: "Engineering",
    mimeType: "application/vnd.google-apps.folder",
    modifiedTime: null,
    webViewLink: null,
    parents: [],
  };
  const nestedFolder = {
    id: "folder-sub",
    name: "RFCs",
    mimeType: "application/vnd.google-apps.folder",
    modifiedTime: null,
    webViewLink: null,
    parents: ["folder-root"],
  };
  const inScopeFile = {
    id: "file-1",
    name: "Design.gdoc",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-01-01T00:00:00Z",
    webViewLink: null,
    parents: ["folder-sub"],
    trashed: false,
  };
  const outOfScopeFile = {
    id: "file-2",
    name: "HR.gdoc",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-01-01T00:00:00Z",
    webViewLink: null,
    parents: ["folder-other"],
    trashed: false,
  };

  // 1) Expired token (410) -> fullScan
  mockState.driveChangesPages = [
    () => {
      throw new GoogleDriveApiError("Gone", 410);
    },
  ];
  mockState.driveStartToken = "fresh-token";
  mockState.driveFiles = [folder, nestedFolder, inScopeFile, outOfScopeFile];

  const expiredPlan = await planGoogleDriveSync({
    accessToken: "tok",
    source: { driveId: "drive-1", selectedFolderIds: ["folder-root"], changePageToken: "stale" },
    trigger: "poll",
  });
  assert.equal(expiredPlan.fullScan, true);
  assert.equal(expiredPlan.changeToken, "fresh-token");
  assert.deepEqual(
    expiredPlan.files.map((f) => f.id),
    ["file-1"],
  );
  assert.deepEqual([...expiredPlan.inScopeIds], ["file-1"]);

  // 2) Incremental poll with in-scope and out-of-scope files
  mockState.driveFolders = [
    { id: "folder-root", name: "Engineering", parents: [] },
    { id: "folder-sub", name: "RFCs", parents: ["folder-root"] },
  ];
  mockState.driveChangesPages = [
    {
      newStartPageToken: "token-2",
      changes: [
        { fileId: "file-1", removed: false, file: inScopeFile },
        { fileId: "file-2", removed: false, file: outOfScopeFile },
      ],
    },
  ];

  const incrementalPlan = await planGoogleDriveSync({
    accessToken: "tok",
    source: { driveId: "drive-1", selectedFolderIds: ["folder-root"], changePageToken: "token-1" },
    trigger: "poll",
  });
  assert.equal(incrementalPlan.fullScan, false);
  assert.equal(incrementalPlan.changeToken, "token-2");
  assert.deepEqual(
    incrementalPlan.files.map((f) => f.id),
    ["file-1"],
  );
  assert.deepEqual(
    incrementalPlan.outOfScopeFiles.map((f) => f.id),
    ["file-2"],
  );
});

test("recheckErroredIncrementalFiles handles 404 removal, recovered files, and out-of-scope moves", async () => {
  mockState.driveFileById.set("err-404", new GoogleDriveApiError("Not Found", 404));
  mockState.driveFileById.set("err-recovered", {
    id: "err-recovered",
    name: "Recovered.gdoc",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: null,
    webViewLink: null,
    parents: ["folder-root"],
    trashed: false,
  });
  mockState.driveFileById.set("err-moved", {
    id: "err-moved",
    name: "Moved.gdoc",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: null,
    webViewLink: null,
    parents: ["folder-other"],
    trashed: false,
  });

  const files = [];
  const outOfScopeFiles = [];
  const fileStates = new Map([
    ["err-404", { file_id: "err-404", status: "error" }],
    ["err-recovered", { file_id: "err-recovered", status: "error" }],
    ["err-moved", { file_id: "err-moved", status: "error" }],
  ]);

  await recheckErroredIncrementalFiles({
    accessToken: "tok",
    organizationId: "org-1",
    sourceId: "src-gd-1",
    selectedFolderIds: ["folder-root"],
    includedFolderIds: new Set(["folder-root"]),
    fileStates,
    files,
    outOfScopeFiles,
  });

  assert.equal(mockState.removedFiles.length, 1);
  assert.equal(mockState.removedFiles[0].fileId, "err-404");
  assert.deepEqual(
    files.map((f) => f.id),
    ["err-recovered"],
  );
  assert.deepEqual(
    outOfScopeFiles.map((f) => f.id),
    ["err-moved"],
  );
});
