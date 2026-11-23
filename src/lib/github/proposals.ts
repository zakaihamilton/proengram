import "server-only";

import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { apiPath, githubHeaders, githubJson, MAX_MARKDOWN_BYTES } from "./api-client";
import { getGitHubAccessToken } from "./connections";
import {
  type GitHubRepositorySourceRow,
  getRepositorySource,
  mapSource,
  type ResolvedGitHubSource,
} from "./sources";

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
  if (result.rows.length === 0) {
    throw new Error("Connect a GitHub repository for this organization in Settings first.");
  }
  if (result.rows.length > 1) {
    throw new Error("Pass sourceId from list_github_sources to choose a repository.");
  }
  return { ...mapSource(result.rows[0]), organizationId };
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
  if (!safeMarkdownPath(input.path)) {
    throw new Error("Only Markdown files inside docs/ can be proposed.");
  }
  if (Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new Error("The proposed Markdown exceeds 300 KB.");
  }
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is required to audit GitHub proposals.");
  const source = await resolveProposalSource(input.organizationId, input.sourceId);
  if (!source.organizationAccountId) {
    throw new Error("Reconnect this GitHub repository in Settings before proposing changes.");
  }
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
