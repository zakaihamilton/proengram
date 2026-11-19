import "server-only";

import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { writeActivity } from "@/lib/db/brain";
import { getGitHubAccessToken, isGitHubConfigured } from "./connections";

export { isGitHubConfigured } from "./connections";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_MARKDOWN_BYTES = 300_000;
const MAX_MARKDOWN_FILES = 500;
const MAX_TOTAL_MARKDOWN_BYTES = 20_000_000;
const MARKDOWN_FETCH_BATCH_SIZE = 8;

type GitHubTreeEntry = { path?: string; type?: string; sha?: string; url?: string; size?: number };
type GitHubBlob = { encoding?: string; content?: string; size?: number };

type GitHubRepositorySourceRow = {
  id: string;
  organization_id: string;
  organization_account_id: string | null;
  github_repository_id: string | null;
  repository_owner: string;
  repository_name: string;
  default_branch: string;
  status: "active" | "needs_auth" | "disabled";
  github_login: string | null;
  account_status: "active" | "reauthorize_required" | null;
  last_synced_at: Date | string | null;
};

export type GitHubRepositorySource = {
  id: string;
  organizationAccountId: string | null;
  githubLogin: string | null;
  repositoryId: string | null;
  owner: string;
  repository: string;
  defaultBranch: string;
  status: "active" | "needs_auth" | "disabled";
  lastSyncedAt: string | null;
};

type ResolvedGitHubSource = GitHubRepositorySource & { organizationId: string };

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

function apiPath(
  source: Pick<GitHubRepositorySource, "owner" | "repository">,
  suffix: string,
): string {
  return `${API_ROOT}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}${suffix}`;
}

function mapSource(row: GitHubRepositorySourceRow): GitHubRepositorySource {
  const connected = row.account_status === "active" && Boolean(row.organization_account_id);
  return {
    id: String(row.id),
    organizationAccountId: row.organization_account_id,
    githubLogin: row.github_login,
    repositoryId: row.github_repository_id === null ? null : String(row.github_repository_id),
    owner: String(row.repository_owner),
    repository: String(row.repository_name),
    defaultBranch: String(row.default_branch),
    status:
      row.status === "disabled"
        ? "disabled"
        : connected && row.status === "active"
          ? "active"
          : "needs_auth",
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
  };
}

export async function listGitHubRepositorySources(
  organizationId: string,
): Promise<GitHubRepositorySource[]> {
  const pool = await getPool();
  if (!pool) return [];
  const result = await pool.query<GitHubRepositorySourceRow>(
    `SELECT source.id,
            source.organization_id,
            source.organization_account_id,
            source.github_repository_id,
            source.repository_owner,
            source.repository_name,
            source.default_branch,
            source.status,
            source.last_synced_at,
            account.github_login,
            account.status AS account_status
       FROM github_repository_sources AS source
       LEFT JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       LEFT JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.organization_id = $1
        AND source.status <> 'disabled'
      ORDER BY source.repository_owner, source.repository_name`,
    [organizationId],
  );
  return result.rows.map(mapSource);
}

async function getRepositorySource(
  organizationId: string,
  sourceId: string,
  requireActive = true,
): Promise<ResolvedGitHubSource | null> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<GitHubRepositorySourceRow>(
    `SELECT source.id,
            source.organization_id,
            source.organization_account_id,
            source.github_repository_id,
            source.repository_owner,
            source.repository_name,
            source.default_branch,
            source.status,
            source.last_synced_at,
            account.github_login,
            account.status AS account_status
       FROM github_repository_sources AS source
       LEFT JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       LEFT JOIN github_oauth_accounts AS account
         ON account.id = link.github_oauth_account_id
      WHERE source.organization_id = $1
        AND source.id = $2
        ${requireActive ? "AND source.status = 'active' AND account.status = 'active'" : ""}
      LIMIT 1`,
    [organizationId, sourceId],
  );
  const row = result.rows[0];
  return row ? { ...mapSource(row), organizationId } : null;
}

export async function addGitHubRepositorySource(input: {
  organizationId: string;
  organizationAccountId: string;
  subjectId: string;
  owner: string;
  repository: string;
}): Promise<GitHubRepositorySource> {
  if (!isGitHubConfigured()) throw new Error("GitHub OAuth is not configured.");
  const owner = input.owner.trim();
  const repository = input.repository.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error("Enter a valid GitHub organization or account name.");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository === "." || repository === "..") {
    throw new Error("Enter a valid GitHub repository name.");
  }

  const token = await getGitHubAccessToken(input.organizationId, input.organizationAccountId);
  const repo = await githubJson<{
    id?: number | string;
    full_name?: string;
    default_branch?: string;
  }>(`${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, token);
  if (
    repo.full_name?.toLowerCase() !== `${owner}/${repository}`.toLowerCase() ||
    repo.id === undefined ||
    !repo.default_branch
  ) {
    throw new Error("The selected repository is not available to this GitHub account.");
  }
  await githubJson(
    apiPath({ owner, repository }, `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`),
    token,
  );

  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  let saved: GitHubRepositorySourceRow | undefined;
  try {
    await client.query("BEGIN");
    const result = await client.query<GitHubRepositorySourceRow>(
      `INSERT INTO github_repository_sources
        (id, organization_id, organization_account_id, github_repository_id,
         repository_owner, repository_name, default_branch, status, updated_by_subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
       ON CONFLICT (organization_id, repository_owner_normalized, repository_name_normalized)
       DO UPDATE SET
         organization_account_id = EXCLUDED.organization_account_id,
         github_repository_id = EXCLUDED.github_repository_id,
         default_branch = EXCLUDED.default_branch,
         status = 'active',
         updated_by_subject_id = EXCLUDED.updated_by_subject_id,
         updated_at = now()
       RETURNING id, organization_id, organization_account_id, github_repository_id,
                 repository_owner, repository_name, default_branch, status, last_synced_at`,
      [
        randomUUID(),
        input.organizationId,
        input.organizationAccountId,
        String(repo.id),
        owner,
        repository,
        repo.default_branch,
        input.subjectId,
      ],
    );
    saved = result.rows[0];
    if (!saved) throw new Error("The GitHub repository could not be saved.");
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "github_markdown",
      itemId: saved.id,
      summary: `Connected GitHub repository ${owner}/${repository}.`,
      metadata: { repository: `${owner}/${repository}`, sourceId: saved.id },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return mapSource({ ...saved, github_login: null, account_status: "active" });
}

export async function removeGitHubRepositorySource(input: {
  organizationId: string;
  sourceId: string;
  subjectId: string;
}): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      repository_owner: string;
      repository_name: string;
    }>(
      `UPDATE github_repository_sources
          SET status = 'disabled', updated_by_subject_id = $3, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND status <> 'disabled'
        RETURNING id, repository_owner, repository_name`,
      [input.organizationId, input.sourceId, input.subjectId],
    );
    const source = result.rows[0];
    if (!source) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE brain_items
          SET is_active = false, updated_at = now()
        WHERE organization_id = $1 AND kind = 'github_markdown' AND source_id = $2`,
      [input.organizationId, input.sourceId],
    );
    await writeActivity(client, {
      id: randomUUID(),
      organizationId: input.organizationId,
      actorSubjectId: input.subjectId,
      action: "source:manage",
      itemKind: "github_markdown",
      itemId: input.sourceId,
      summary: `Disconnected GitHub repository ${source.repository_owner}/${source.repository_name}.`,
      metadata: { sourceId: input.sourceId },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function safeMarkdownPath(path: string): boolean {
  return (
    path.startsWith("docs/") &&
    !path.includes("..") &&
    !path.startsWith("docs/.") &&
    /\.mdx?$/i.test(path)
  );
}

async function resolveProposalSource(
  organizationId: string,
  requestedSourceId?: string,
): Promise<ResolvedGitHubSource> {
  if (requestedSourceId) {
    const source = await getRepositorySource(organizationId, requestedSourceId);
    if (!source) throw new Error("That GitHub source is not connected to this organization.");
    return source;
  }
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const result = await pool.query<GitHubRepositorySourceRow>(
    `SELECT source.id,
            source.organization_id,
            source.organization_account_id,
            source.github_repository_id,
            source.repository_owner,
            source.repository_name,
            source.default_branch,
            source.status,
            source.last_synced_at,
            account.github_login,
            account.status AS account_status
       FROM github_repository_sources AS source
       JOIN github_organization_accounts AS link
         ON link.id = source.organization_account_id
        AND link.organization_id = source.organization_id
       JOIN github_oauth_accounts AS account ON account.id = link.github_oauth_account_id
      WHERE source.organization_id = $1
        AND source.status = 'active'
        AND account.status = 'active'
      ORDER BY source.created_at
      LIMIT 2`,
    [organizationId],
  );
  if (result.rows.length === 0)
    throw new Error("Connect a GitHub repository for this organization in Settings first.");
  if (result.rows.length > 1) {
    throw new Error("Pass sourceId from list_github_sources to choose a repository.");
  }
  return { ...mapSource(result.rows[0]), organizationId };
}

export async function syncGitHubMarkdown(
  organizationId: string,
  sourceId: string,
  subjectId: string,
) {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const source = await getRepositorySource(organizationId, sourceId);
  if (!source || !source.organizationAccountId) {
    throw new Error("Reconnect this GitHub repository in Settings before syncing.");
  }
  const syncId = randomUUID();
  await pool.query(
    `INSERT INTO source_syncs (id, organization_id, source, source_id, status)
     VALUES ($1, $2, 'github', $3, 'running')`,
    [syncId, organizationId, source.id],
  );

  try {
    const token = await getGitHubAccessToken(organizationId, source.organizationAccountId);
    const tree = await githubJson<{ truncated?: boolean; tree?: GitHubTreeEntry[] }>(
      apiPath(source, `/git/trees/${encodeURIComponent(source.defaultBranch)}?recursive=1`),
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
            apiPath(source, `/git/blobs/${entry.sha}`),
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
        `UPDATE brain_items
            SET is_active = false, updated_at = now()
          WHERE organization_id = $1 AND source_id = $2 AND kind = 'github_markdown'`,
        [organizationId, source.id],
      );
      for (const document of documents) {
        const title =
          document.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
          document.path.split("/").at(-1) ||
          document.path;
        await client.query(
          `INSERT INTO brain_items
            (id, organization_id, source_id, kind, external_key, title, markdown, source_url, source_revision, sync_batch_id, is_active)
           VALUES ($1, $2, $3, 'github_markdown', $4, $5, $6, $7, $8, $9, true)
           ON CONFLICT (organization_id, source_id, external_key)
             WHERE kind = 'github_markdown' AND source_id IS NOT NULL
           DO UPDATE SET
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
            source.id,
            document.path,
            title.slice(0, 240),
            document.markdown,
            `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/blob/${source.defaultBranch.split("/").map(encodeURIComponent).join("/")}/${document.path.split("/").map(encodeURIComponent).join("/")}`,
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
        itemId: source.id,
        summary: `Synced ${documents.length} Markdown files from ${source.owner}/${source.repository}.`,
        metadata: {
          itemCount: documents.length,
          sourceId: source.id,
          repository: `${source.owner}/${source.repository}`,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await pool.query(
      `UPDATE source_syncs
          SET status = 'succeeded', item_count = $2, message = $3, completed_at = now()
        WHERE id = $1`,
      [syncId, documents.length, `Synced ${source.owner}/${source.repository}`],
    );
    await pool.query(
      `UPDATE github_repository_sources SET last_synced_at = now(), updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, source.id],
    );
    return { itemCount: documents.length, repository: `${source.owner}/${source.repository}` };
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
  sourceId?: string;
  path: string;
  title: string;
  markdown: string;
  summary: string;
}) {
  if (!safeMarkdownPath(input.path))
    throw new Error("Only Markdown files inside docs/ can be proposed.");
  if (Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new Error("The proposed Markdown exceeds 300 KB.");
  }
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is required to audit GitHub proposals.");
  const source = await resolveProposalSource(input.organizationId, input.sourceId);
  if (!source.organizationAccountId)
    throw new Error("Reconnect this GitHub repository in Settings before proposing changes.");
  const activityId = randomUUID();
  await pool.query(
    `INSERT INTO activity_events
      (id, organization_id, actor_subject_id, action, item_kind, item_id, summary, metadata)
     VALUES ($1, $2, $3, 'knowledge:propose', 'github_markdown', $4, $5, $6::jsonb)`,
    [
      activityId,
      input.organizationId,
      input.subjectId,
      `${source.id}:${input.path}`,
      `Started GitHub proposal for ${input.path}.`,
      JSON.stringify({ status: "pending", sourceId: source.id, path: input.path }),
    ],
  );

  let result: { url: string; number: number; branch: string };
  try {
    const token = await getGitHubAccessToken(input.organizationId, source.organizationAccountId);
    const baseRef = await githubJson<{ object?: { sha?: string } }>(
      apiPath(source, `/git/ref/heads/${encodeURIComponent(source.defaultBranch)}`),
      token,
    );
    const baseSha = baseRef.object?.sha;
    if (!baseSha) throw new Error("GitHub did not return the default branch revision.");

    const proposalBranch = `proengram/proposal-${randomUUID().slice(0, 8)}`;
    await githubJson(apiPath(source, "/git/refs"), token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${proposalBranch}`, sha: baseSha }),
    });

    const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
    let existingSha: string | undefined;
    const existingResponse = await fetch(
      `${apiPath(source, `/contents/${encodedPath}`)}?ref=${encodeURIComponent(proposalBranch)}`,
      { cache: "no-store", headers: githubHeaders(token) },
    );
    if (existingResponse.ok) {
      const existing = (await existingResponse.json()) as { sha?: string };
      existingSha = existing.sha;
    } else if (existingResponse.status !== 404) {
      throw new Error("GitHub could not read the target Markdown file.");
    }

    await githubJson(apiPath(source, `/contents/${encodedPath}`), token, {
      method: "PUT",
      body: JSON.stringify({
        message: `ProEngram: ${input.title}`,
        content: Buffer.from(input.markdown, "utf8").toString("base64"),
        branch: proposalBranch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    const pullRequest = await githubJson<{ html_url?: string; number?: number }>(
      apiPath(source, "/pulls"),
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title.slice(0, 240),
          head: proposalBranch,
          base: source.defaultBranch,
          body: `${input.summary.slice(0, 4000)}\n\nProposed by ProEngram for Perminister user ${input.subjectId}.`,
        }),
      },
    );
    if (!pullRequest.html_url || !pullRequest.number) {
      throw new Error("GitHub did not return the pull request URL.");
    }
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
            sourceId: source.id,
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
          sourceId: source.id,
          path: input.path,
          pullRequestUrl: result.url,
        }),
        input.organizationId,
      ],
    )
    .catch(() => {
      console.error(
        "ProEngram could not mark a completed GitHub proposal in the activity log.",
        activityId,
      );
    });
  return { ...result, sourceId: source.id, repository: `${source.owner}/${source.repository}` };
}
