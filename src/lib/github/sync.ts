import "server-only";

import { randomUUID } from "node:crypto";
import { replaceBrainChunks, writeActivity, writeItemVersion } from "@/lib/db/brain";
import { getPool } from "@/lib/db/pool";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { apiPath, githubJson, MAX_MARKDOWN_BYTES } from "./api-client";
import { getGitHubAccessToken } from "./connections";
import { getRepositorySource } from "./sources";

const MAX_MARKDOWN_FILES = 500;
const MAX_TOTAL_MARKDOWN_BYTES = 20_000_000;
const MARKDOWN_FETCH_BATCH_SIZE = 8;

type GitHubTreeEntry = { path?: string; type?: string; sha?: string; url?: string; size?: number };
type GitHubBlob = { encoding?: string; content?: string; size?: number };

export async function syncGitHubMarkdown(
  organizationId: string,
  sourceId: string,
  subjectId: string,
  options: { commitSha?: string; skipIfUnchanged?: boolean } = {},
) {
  const pool = await getPool();
  if (!pool) throw new Error("Nanogres PostgreSQL is not configured.");
  const source = await getRepositorySource(organizationId, sourceId);
  if (!source?.organizationAccountId) {
    throw new Error("Reconnect this GitHub repository in Settings before syncing.");
  }
  const organizationAccountId = source.organizationAccountId;
  const syncId = randomUUID();
  await pool.query(
    `INSERT INTO source_syncs (id, organization_id, source, source_id, status)
     VALUES ($1, $2, 'github', $3, 'running')`,
    [syncId, organizationId, source.id],
  );

  try {
    const token = await getGitHubAccessToken(organizationId, organizationAccountId);
    const commitSha = options.commitSha
      ? options.commitSha
      : (
          await githubJson<{ sha?: string }>(
            apiPath(source, `/commits/${encodeURIComponent(source.defaultBranch)}`),
            token,
          )
        ).sha;
    if (!commitSha || !/^[a-f0-9]{40,64}$/i.test(commitSha)) {
      throw new Error("GitHub did not return a valid commit for the repository branch.");
    }
    if (options.skipIfUnchanged && source.lastSyncedCommitSha === commitSha) {
      await pool.query(
        `UPDATE source_syncs
            SET status = 'succeeded', item_count = 0,
                message = 'Repository content is already up to date.', completed_at = now()
          WHERE id = $1`,
        [syncId],
      );
      return {
        itemCount: 0,
        repository: `${source.owner}/${source.repository}`,
        commitSha,
        skipped: true,
      };
    }
    const tree = await githubJson<{ truncated?: boolean; tree?: GitHubTreeEntry[] }>(
      apiPath(source, `/git/trees/${encodeURIComponent(commitSha)}?recursive=1`),
      token,
    );
    if (tree.truncated) throw new Error("The GitHub tree is too large for a single safe sync.");
    const entries = (tree.tree ?? []).filter(
      (entry) => entry.type === "blob" && entry.path && entry.sha && /\.mdx?$/i.test(entry.path),
    );
    if (entries.length > MAX_MARKDOWN_FILES) {
      throw new Error("The repository exceeds the Markdown file limit.");
    }

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
    await withDatabaseTransaction(async (client) => {
      const currentSource = await client.query<{
        organization_account_id: string | null;
        default_branch: string;
        status: string;
      }>(
        `SELECT organization_account_id, default_branch, status
           FROM github_repository_sources
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE`,
        [organizationId, source.id],
      );
      const current = currentSource.rows[0];
      if (
        current?.status !== "active" ||
        current.organization_account_id !== organizationAccountId ||
        current.default_branch !== source.defaultBranch
      ) {
        throw new Error("The GitHub source changed during sync. Queue another sync to refresh it.");
      }
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
        const stored = await client.query<{ id: string }>(
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
             updated_at = now()
           RETURNING id`,
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
        const itemId = stored.rows[0]?.id;
        if (!itemId) throw new Error("A synced GitHub document could not be retrieved.");
        const versionId = await writeItemVersion(client, {
          organizationId,
          itemId,
          title: title.slice(0, 240),
          markdown: document.markdown,
          sourceRevision: document.sha,
        });
        await replaceBrainChunks(client, {
          organizationId,
          itemId,
          versionId,
          markdown: document.markdown,
          title: title.slice(0, 240),
        });
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
    }, pool);

    await pool.query(
      `UPDATE source_syncs
          SET status = 'succeeded', item_count = $2, message = $3, completed_at = now()
        WHERE id = $1`,
      [syncId, documents.length, `Synced ${source.owner}/${source.repository}`],
    );
    await pool.query(
      `UPDATE github_repository_sources
          SET last_synced_at = now(),
              last_synced_commit_sha = $3,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, source.id, commitSha],
    );
    return {
      itemCount: documents.length,
      repository: `${source.owner}/${source.repository}`,
      commitSha,
      skipped: false,
    };
  } catch (error) {
    await pool.query(
      `UPDATE source_syncs SET status = 'failed', message = $2, completed_at = now() WHERE id = $1`,
      [syncId, error instanceof Error ? error.message.slice(0, 400) : "GitHub sync failed."],
    );
    throw error;
  }
}
