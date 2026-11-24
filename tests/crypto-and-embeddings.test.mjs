import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcRoot = new URL("../src/", import.meta.url);

const mockState = {
  pool: null,
  embedTexts: async () => [],
  embeddingModelVersion: "test-model-v1",
};

globalThis.__cryptoAndEmbeddingsMock = mockState;

const VIRTUAL_MOCKS = {
  "@/lib/db/pool": `
    export async function getPool() {
      return globalThis.__cryptoAndEmbeddingsMock.pool;
    }
    export function isDatabaseConfigured() {
      return Boolean(globalThis.__cryptoAndEmbeddingsMock.pool);
    }
  `,
  "@/lib/db/transaction": `
    export async function withDatabaseTransaction(fn) {
      const pool = globalThis.__cryptoAndEmbeddingsMock.pool;
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
  "@/lib/knowledge/embeddings": `
    export const EMBEDDING_MODEL_VERSION = globalThis.__cryptoAndEmbeddingsMock.embeddingModelVersion;
    export async function embedTexts(texts) {
      return globalThis.__cryptoAndEmbeddingsMock.embedTexts(texts);
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

const { isTokenEncryptionConfigured, encryptToken, decryptToken } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/auth/token-crypto.ts", srcRoot))).href
);
const { processKnowledgeEmbeddingJobs } = await import(
  pathToFileURL(fileURLToPath(new URL("lib/knowledge/embedding-worker.ts", srcRoot))).href
);

const ENV_KEY = "TEST_PROENGRAM_TOKEN_KEY";
const originalEnvValue = process.env[ENV_KEY];

beforeEach(() => {
  mockState.pool = null;
  mockState.embedTexts = async () => [];
});

afterEach(() => {
  if (originalEnvValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnvValue;
});

test("isTokenEncryptionConfigured validates 32-byte hex and base64 keys", () => {
  delete process.env[ENV_KEY];
  assert.equal(isTokenEncryptionConfigured(ENV_KEY), false);

  process.env[ENV_KEY] = "too-short";
  assert.equal(isTokenEncryptionConfigured(ENV_KEY), false);

  process.env[ENV_KEY] = randomBytes(32).toString("hex");
  assert.equal(isTokenEncryptionConfigured(ENV_KEY), true);

  process.env[ENV_KEY] = randomBytes(32).toString("base64");
  assert.equal(isTokenEncryptionConfigured(ENV_KEY), true);
});

test("encryptToken and decryptToken round-trip with hex and base64 keys and unique IVs", () => {
  const plaintext = "gho_secret_token_12345_עברית";

  process.env[ENV_KEY] = randomBytes(32).toString("hex");
  const encryptedA = encryptToken(plaintext, ENV_KEY, "GitHub");
  const encryptedB = encryptToken(plaintext, ENV_KEY, "GitHub");

  assert.notEqual(encryptedA, encryptedB);
  assert.match(encryptedA, /^v1\.[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(decryptToken(encryptedA, ENV_KEY, "GitHub"), plaintext);
  assert.equal(decryptToken(encryptedB, ENV_KEY, "GitHub"), plaintext);

  process.env[ENV_KEY] = randomBytes(32).toString("base64");
  const encryptedBase64 = encryptToken(plaintext, ENV_KEY, "Google Drive");
  assert.equal(decryptToken(encryptedBase64, ENV_KEY, "Google Drive"), plaintext);
});

test("decryptToken rejects tampered payloads, invalid formats, and wrong keys", () => {
  process.env[ENV_KEY] = randomBytes(32).toString("hex");
  const encrypted = encryptToken("sensitive-oauth-token", ENV_KEY, "GitHub");
  const parts = encrypted.split(".");

  assert.throws(
    () => decryptToken(`v2.${parts[1]}.${parts[2]}.${parts[3]}`, ENV_KEY, "GitHub"),
    /invalid/,
  );
  assert.throws(() => decryptToken(`${encrypted}.extra`, ENV_KEY, "GitHub"), /invalid/);
  assert.throws(() => decryptToken("v1.only.two", ENV_KEY, "GitHub"), /invalid/);

  // Flip a character in the ciphertext or auth tag
  const tamperedTag = `${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => decryptToken(`v1.${parts[1]}.${tamperedTag}.${parts[3]}`, ENV_KEY, "GitHub"),
    /could not be decrypted/,
  );

  const tamperedCiphertext = `${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => decryptToken(`v1.${parts[1]}.${parts[2]}.${tamperedCiphertext}`, ENV_KEY, "GitHub"),
    /could not be decrypted/,
  );

  process.env[ENV_KEY] = randomBytes(32).toString("hex");
  assert.throws(() => decryptToken(encrypted, ENV_KEY, "GitHub"), /could not be decrypted/);
});

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

test("processKnowledgeEmbeddingJobs throws when database pool is not configured", async () => {
  await assert.rejects(() => processKnowledgeEmbeddingJobs(), /PostgreSQL is not configured/);
});

test("processKnowledgeEmbeddingJobs claims jobs, creates missing chunks, embeds, and marks succeeded", async () => {
  let claimCalls = 0;
  mockState.pool = createFakePool(async (sql) => {
    if (sql.includes("FROM knowledge_embedding_jobs") && sql.includes("FOR UPDATE SKIP LOCKED")) {
      claimCalls += 1;
      if (claimCalls === 1) {
        return {
          rows: [
            {
              id: "job-1",
              organization_id: "org-1",
              item_id: "item-1",
              version_id: "ver-1",
              attempt_count: 0,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM brain_item_versions")) {
      return {
        rows: [{ title: "Doc Title", markdown: "# Heading\n\nBody text for embedding." }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT id FROM brain_chunks")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id, content FROM brain_chunks")) {
      return {
        rows: [{ id: "chunk-1", content: "Body text for embedding." }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT count(*)::text AS count FROM brain_chunks")) {
      return { rows: [{ count: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  mockState.embedTexts = async (texts) => {
    assert.equal(texts.length, 1);
    return [JSON.stringify(Array(384).fill(0.1))];
  };

  const summary = await processKnowledgeEmbeddingJobs(5);
  assert.deepEqual(summary, { processed: 1, completed: 1, failed: 0 });

  const insertedChunks = mockState.pool.queries.find((q) =>
    q.sql.includes("INSERT INTO brain_chunks"),
  );
  assert.ok(insertedChunks);
  const updatedChunks = mockState.pool.queries.find((q) =>
    q.sql.includes("UPDATE brain_chunks AS chunk"),
  );
  assert.ok(updatedChunks);
  assert.equal(updatedChunks.params[3], "test-model-v1");

  const succeededJob = mockState.pool.queries.find((q) => q.sql.includes("status = 'succeeded'"));
  assert.ok(succeededJob);
  assert.deepEqual(succeededJob.params, ["job-1", "test-model-v1"]);
});

test("processKnowledgeEmbeddingJobs re-queues pending when chunks remain and applies exponential backoff on failure", async () => {
  const jobs = [
    {
      id: "job-partial",
      organization_id: "org-1",
      item_id: "item-1",
      version_id: "ver-1",
      attempt_count: 0,
    },
    {
      id: "job-retry",
      organization_id: "org-1",
      item_id: "item-2",
      version_id: "ver-2",
      attempt_count: 5,
    },
    {
      id: "job-terminal",
      organization_id: "org-1",
      item_id: "item-3",
      version_id: "ver-3",
      attempt_count: 7,
    },
  ];
  let idx = 0;

  mockState.pool = createFakePool(async (sql, params) => {
    if (sql.includes("FROM knowledge_embedding_jobs") && sql.includes("FOR UPDATE SKIP LOCKED")) {
      const excluded = params[0];
      assert.deepEqual(
        excluded,
        jobs.slice(0, idx).map((j) => j.id),
      );
      const next = jobs[idx++];
      return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
    }
    if (sql.includes("FROM brain_item_versions")) {
      if (params[2] === "ver-2" || params[2] === "ver-3") {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ title: "Doc", markdown: "Some content" }], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM brain_chunks")) {
      return { rows: [{ id: "chunk-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT id, content FROM brain_chunks")) {
      return { rows: [{ id: "chunk-1", content: "Some content" }], rowCount: 1 };
    }
    if (sql.includes("SELECT count(*)::text AS count FROM brain_chunks")) {
      return { rows: [{ count: "4" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  mockState.embedTexts = async () => ["[0.1]"];

  const summary = await processKnowledgeEmbeddingJobs(8);
  assert.deepEqual(summary, { processed: 3, completed: 0, failed: 2 });

  const requeued = mockState.pool.queries.find(
    (q) => q.sql.includes("interval '2 minutes'") && q.params[0] === "job-partial",
  );
  assert.ok(requeued);

  // attempt_count 5 -> attempts = 6 -> min(60, 2^6) = 60 minutes
  const backoff = mockState.pool.queries.find(
    (q) => q.sql.includes("attempt_count = $2") && q.params[0] === "job-retry",
  );
  assert.ok(backoff);
  assert.equal(backoff.params[1], 6);
  assert.equal(backoff.params[2], 60);

  // attempt_count 7 -> attempts = 8 -> terminal failure + brain_chunks marked failed
  const terminal = mockState.pool.queries.find(
    (q) => q.sql.includes("status = 'failed'") && q.params[0] === "job-terminal",
  );
  assert.ok(terminal);
  assert.equal(terminal.params[1], 8);

  const failedChunks = mockState.pool.queries.find((q) =>
    q.sql.includes("UPDATE brain_chunks SET embedding_status = 'failed'"),
  );
  assert.ok(failedChunks);
  assert.deepEqual(failedChunks.params, ["org-1", "item-3", "ver-3"]);
});
