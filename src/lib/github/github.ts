import "server-only";

import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { getPool } from "@/lib/db/pool";
import { writeActivity } from "@/lib/db/brain";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_MARKDOWN_BYTES = 300_000;
const MAX_MARKDOWN_FILES = 500;
const MAX_TOTAL_MARKDOWN_BYTES = 20_000_000;
const MARKDOWN_FETCH_BATCH_SIZE = 8;

type GitHubTreeEntry = { path?: string; type?: string; sha?: string; url?: string; size?: number };
type GitHubBlob = { encoding?: string; content?: string; size?: number };

type GitHubSettings = {
  appId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repository: string;
  defaultBranch: string;
};

function setting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function getSettings(): GitHubSettings {
  return {
    appId: setting("GITHUB_APP_ID"),
    installationId: setting("GITHUB_INSTALLATION_ID"),
    privateKey: setting("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    owner: setting("GITHUB_REPO_OWNER"),
    repository: setting("GITHUB_REPO_NAME"),
    defaultBranch: process.env.GITHUB_DEFAULT_BRANCH?.trim() || "main",
  };
}

export function isGitHubConfigured(): boolean {
  return [
    "GITHUB_APP_ID",
    "GITHUB_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_REPO_OWNER",
    "GITHUB_REPO_NAME",
  ].every((key) => Boolean(process.env[key]?.trim()));
}

async function createInstallationToken(settings: GitHubSettings): Promise<string> {
  const key = await importPKCS8(settings.privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(settings.appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(key);
  const response = await fetch(
    `${API_ROOT}/app/installations/${encodeURIComponent(settings.installationId)}/access_tokens`,
    {
      method: "POST",
      cache: "no-store",
      headers: githubHeaders(jwt),
    },
  );
  const result = (await response.json().catch(() => ({}))) as { token?: string };
  if (!response.ok || !result.token)
    throw new Error("GitHub App could not create an installation token.");
  return result.token;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json",
  };
}

async function githubJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { ...githubHeaders(token), ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body ? body.message : undefined;
    throw new Error(`GitHub request failed${message ? `: ${message}` : ""}.`);
  }
  if (body === null) throw new Error("GitHub returned an empty response.");
  return body as T;
}

function apiPath(settings: GitHubSettings, suffix: string): string {
  return `${API_ROOT}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repository)}${suffix}`;
}

function githubUrl(settings: GitHubSettings, branch: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repository)}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
}

function safeMarkdownPath(path: string): boolean {
  return (
    path.startsWith("docs/") &&
    !path.includes("..") &&
    !path.startsWith("docs/.") &&
    /\.mdx?$/i.test(path)
  );
}

export async function syncGitHubMarkdown(organizationId: string, subjectId: string) {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const settings = getSettings();
  const syncId = randomUUID();
  await pool.query(
    `INSERT INTO source_syncs (id, organization_id, source, status)
     VALUES ($1, $2, 'github', 'running')`,
    [syncId, organizationId],
  );
  try {
    const token = await createInstallationToken(settings);
    const tree = await githubJson<{ truncated?: boolean; tree?: GitHubTreeEntry[] }>(
      apiPath(settings, `/git/trees/${encodeURIComponent(settings.defaultBranch)}?recursive=1`),
      token,
    );
    if (tree.truncated) throw new Error("The GitHub tree is too large for a single safe sync.");
    const entries = (tree.tree ?? []).filter(
      (entry) => entry.type === "blob" && entry.path && entry.sha && /\.mdx?$/i.test(entry.path),
    );
    if (entries.length > MAX_MARKDOWN_FILES)
      throw new Error("The repository exceeds the Markdown file limit.");

    const documents: Array<{ path: string; sha: string; markdown: string }> = [];
    let totalMarkdownBytes = 0;
    for (let offset = 0; offset < entries.length; offset += MARKDOWN_FETCH_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + MARKDOWN_FETCH_BATCH_SIZE);
      const batchDocuments = await Promise.all(
        batch.map(async (entry) => {
          if (!entry.path || !entry.sha) return null;
          if (typeof entry.size !== "number" || entry.size > MAX_MARKDOWN_BYTES) return null;
          const blob = await githubJson<GitHubBlob>(
            apiPath(settings, `/git/blobs/${entry.sha}`),
            token,
          );
          if (blob.encoding !== "base64" || typeof blob.content !== "string") return null;
          if ((blob.size ?? 0) > MAX_MARKDOWN_BYTES) return null;
          const markdown = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
          const markdownBytes = Buffer.byteLength(markdown, "utf8");
          if (markdownBytes > MAX_MARKDOWN_BYTES) return null;
          return { path: entry.path, sha: entry.sha, markdown, markdownBytes };
        }),
      );
      for (const document of batchDocuments) {
        if (!document) continue;
        totalMarkdownBytes += document.markdownBytes;
        if (totalMarkdownBytes > MAX_TOTAL_MARKDOWN_BYTES) {
          throw new Error("The repository exceeds the 20 MB total Markdown sync limit.");
        }
        documents.push({ path: document.path, sha: document.sha, markdown: document.markdown });
      }
    }

    const batchId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE brain_items SET is_active = false
          WHERE organization_id = $1 AND kind = 'github_markdown'`,
        [organizationId],
      );
      for (const document of documents) {
        const title =
          document.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
          document.path.split("/").at(-1) ||
          document.path;
        await client.query(
          `INSERT INTO brain_items
            (id, organization_id, kind, external_key, title, markdown, source_url, source_revision, sync_batch_id, is_active)
           VALUES ($1, $2, 'github_markdown', $3, $4, $5, $6, $7, $8, true)
           ON CONFLICT (organization_id, kind, external_key) DO UPDATE SET
             title = EXCLUDED.title,
             markdown = EXCLUDED.markdown,
             source_url = EXCLUDED.source_url,
             source_revision = EXCLUDED.source_revision,
             sync_batch_id = EXCLUDED.sync_batch_id,
             is_active = true,
             updated_at = now()`,
          [
            randomUUID(),
            organizationId,
            document.path,
            title.slice(0, 240),
            document.markdown,
            githubUrl(settings, settings.defaultBranch, document.path),
            document.sha,
            batchId,
          ],
        );
      }
      await writeActivity(client, {
        id: randomUUID(),
        organizationId,
        actorSubjectId: subjectId,
        action: "source:sync",
        itemKind: "github_markdown",
        summary: `Synced ${documents.length} Markdown files from GitHub.`,
        metadata: {
          itemCount: documents.length,
          repository: `${settings.owner}/${settings.repository}`,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await pool.query(
      `UPDATE source_syncs SET status = 'succeeded', item_count = $2, message = $3, completed_at = now()
        WHERE id = $1`,
      [syncId, documents.length, `Synced ${settings.owner}/${settings.repository}`],
    );
    return { itemCount: documents.length, repository: `${settings.owner}/${settings.repository}` };
  } catch (error) {
    await pool.query(
      `UPDATE source_syncs SET status = 'failed', message = $2, completed_at = now() WHERE id = $1`,
      [syncId, error instanceof Error ? error.message.slice(0, 400) : "GitHub sync failed."],
    );
    throw error;
  }
}

export async function createMarkdownPullRequest(input: {
  organizationId: string;
  subjectId: string;
  path: string;
  title: string;
  markdown: string;
  summary: string;
}) {
  if (!safeMarkdownPath(input.path))
    throw new Error("Only Markdown files inside docs/ can be proposed.");
  if (Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES)
    throw new Error("The proposed Markdown exceeds 300 KB.");
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is required to audit GitHub proposals.");
  const activityId = randomUUID();
  await pool.query(
    `INSERT INTO activity_events
      (id, organization_id, actor_subject_id, action, item_kind, item_id, summary, metadata)
     VALUES ($1, $2, $3, 'knowledge:propose', 'github_markdown', $4, $5, $6::jsonb)`,
    [
      activityId,
      input.organizationId,
      input.subjectId,
      input.path,
      `Started GitHub proposal for ${input.path}.`,
      JSON.stringify({ status: "pending", path: input.path }),
    ],
  );

  let result: { url: string; number: number; branch: string };
  try {
    const settings = getSettings();
    const token = await createInstallationToken(settings);
    const baseRef = await githubJson<{ object?: { sha?: string } }>(
      apiPath(settings, `/git/ref/heads/${encodeURIComponent(settings.defaultBranch)}`),
      token,
    );
    const baseSha = baseRef.object?.sha;
    if (!baseSha) throw new Error("GitHub did not return the default branch revision.");

    const proposalBranch = `proengram/proposal-${randomUUID().slice(0, 8)}`;
    await githubJson(apiPath(settings, "/git/refs"), token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${proposalBranch}`, sha: baseSha }),
    });

    const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
    let existingSha: string | undefined;
    const existingResponse = await fetch(
      `${apiPath(settings, `/contents/${encodedPath}`)}?ref=${encodeURIComponent(proposalBranch)}`,
      { cache: "no-store", headers: githubHeaders(token) },
    );
    if (existingResponse.ok) {
      const existing = (await existingResponse.json()) as { sha?: string };
      existingSha = existing.sha;
    } else if (existingResponse.status !== 404) {
      throw new Error("GitHub could not read the target Markdown file.");
    }

    await githubJson(apiPath(settings, `/contents/${encodedPath}`), token, {
      method: "PUT",
      body: JSON.stringify({
        message: `ProEngram: ${input.title}`,
        content: Buffer.from(input.markdown, "utf8").toString("base64"),
        branch: proposalBranch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    const pullRequest = await githubJson<{ html_url?: string; number?: number }>(
      apiPath(settings, "/pulls"),
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title.slice(0, 240),
          head: proposalBranch,
          base: settings.defaultBranch,
          body: `${input.summary.slice(0, 4000)}\n\nProposed by ProEngram for Perminister user ${input.subjectId}.`,
        }),
      },
    );
    if (!pullRequest.html_url || !pullRequest.number)
      throw new Error("GitHub did not return the pull request URL.");
    result = { url: pullRequest.html_url, number: pullRequest.number, branch: proposalBranch };
  } catch (error) {
    await pool
      .query(
        `UPDATE activity_events SET summary = $2, metadata = $3::jsonb
          WHERE id = $1 AND organization_id = $4`,
        [
          activityId,
          `GitHub proposal failed for ${input.path}.`,
          JSON.stringify({
            status: "failed",
            path: input.path,
            error: error instanceof Error ? error.message.slice(0, 400) : "GitHub request failed.",
          }),
          input.organizationId,
        ],
      )
      .catch(() => undefined);
    throw error;
  }

  await pool
    .query(
      `UPDATE activity_events SET summary = $2, metadata = $3::jsonb
        WHERE id = $1 AND organization_id = $4`,
      [
        activityId,
        `Opened GitHub PR #${result.number}: ${input.title}`,
        JSON.stringify({
          status: "succeeded",
          path: input.path,
          pullRequestUrl: result.url,
        }),
        input.organizationId,
      ],
    )
    .catch(() => {
      // The pending audit row remains if GitHub succeeded but this final update fails.
      console.error(
        "ProEngram could not mark a completed GitHub proposal in the activity log.",
        activityId,
      );
    });
  return result;
}
