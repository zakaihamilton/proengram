# ProEngram

ProEngram is a company knowledge dashboard and remote MCP server. Each employee connects from their own ChatGPT or Claude account through Perminister OAuth. ProEngram stores shared saved answers and indexed knowledge in Nanogres-managed PostgreSQL, while GitHub Markdown remains the canonical editable source.

## Architecture

- **Identity and authorization:** Perminister handles dashboard sign-in and supplies each user's ProEngram organizations. The dashboard remembers the active organization, and every protected action checks its current Perminister grant. MCP tools accept an organization ID when the user has more than one.
- **Shared knowledge:** GitHub Markdown and admin-selected Google Shared Drives are synced into a searchable, bilingual English/Hebrew index in Nanogres PostgreSQL for each organization. Saved answers, explicit decision/project memories, policy snapshots, revision history, and feedback are scoped to the same organization.
- **Reviewable edits:** `propose_markdown_change` creates a GitHub pull request under `docs/`; it never merges automatically.
- **Policies:** ProEngram stores reviewed Sentry8 policy snapshots. Direct ProEngram MCP calls are not currently evaluated by Sentry8. See [`docs/sentry8-integration.md`](docs/sentry8-integration.md).
- **Dashboard:** The company dashboard uses Panel Frame UI. `/ui-preview` is a development-only gallery built with UI Preview Kit and synthetic content.

## Local setup

1. Install Node.js 24.22.1 or newer in the 24.x line, plus pnpm 12.18 or newer.
2. Copy `.env.example` to `.env.local` and fill in the settings below.
3. Create a dedicated ProEngram database and least-privilege runtime and migration roles in Nanogres. Configure the Nanogres organization, database, and role names; grant this Vercel project's exact development OIDC identity. `vercel env pull .env.local` supplies a short-lived local OIDC token.
4. Install dependencies with `pnpm install`, apply the schema with `pnpm db:migrate`, then run `pnpm dev`. The migration command reads `.env.local` automatically.
5. Open `http://localhost:3000`. Use `/ui-preview` for the synthetic component gallery.

## Perminister setup

Create a separate dashboard and MCP client pair for each environment. The MCP client is bound to one canonical resource URI, so do not reuse its credentials between local development and production.

| Environment | Dashboard origin and callback | MCP resource URI |
| --- | --- | --- |
| Local | `http://localhost:3000` and `http://localhost:3000/auth/perminister/callback` | `http://localhost:3000/mcp` |
| Production | `https://proengram.vercel.app` and `https://proengram.vercel.app/auth/perminister/callback` | `https://proengram.vercel.app/mcp` |

For each dashboard client, enable `openid`, `profile`, `email`, and `perminister_api`. For each MCP client, register only that environment's resource URI and the scopes `brain:read`, `brain:feedback`, `policy:read`, `result:save`, and `knowledge:propose`. Keep registration invite-only. Remote assistant clients register separately with Perminister through OAuth discovery.

Copy `.env.example` to `.env.local` and enter the local client IDs and secrets there. In Vercel, set the matching production values in the `proengram` project's Production environment. Set `PROENGRAM_ORIGIN` and `PERMINISTER_MCP_RESOURCE_URI` to the corresponding row above. Set `PERMINISTER_ISSUER` to the issuer returned by Perminister metadata. Keep client secrets server-only, and set `PROENGRAM_COOKIE_SECRET` to a dedicated random value of at least 32 characters in each environment. Production origins and the MCP resource URI must use HTTPS. There is no deployment-wide Perminister organization setting; users choose from the organizations where they have ProEngram access.

The MCP endpoint is `/mcp`. Protected Resource Metadata is published at the RFC 9728 path for that exact resource URL (for example, `/.well-known/oauth-protected-resource/mcp`). ChatGPT and Claude discover Perminister there and obtain a separate user token for the ProEngram resource.

The dashboard stores its active organization in a browser cookie. MCP calls are stateless and do not use that cookie: call `list_organizations`, then pass the chosen `organizationId` to `search_knowledge`, `get_document`, `get_document_history`, `list_project_history`, `get_policy`, `save_result`, `save_memory`, `submit_knowledge_feedback`, `list_github_sources`, and `propose_markdown_change` when the account has multiple organizations. The ID may be omitted when the account has exactly one. Perminister checks the current grant for the selected organization and action. Use `list_github_sources` to select a `sourceId` for a proposal when an organization has multiple repositories. `save_memory` publishes a decision or project update immediately when explicitly requested; ProEngram does not run background AI extraction.

## GitHub setup

Create a GitHub OAuth App with this callback URL for each environment:

| Environment | GitHub OAuth App callback |
| --- | --- |
| Local | `http://localhost:3000/auth/github/callback` |
| Production | `https://proengram.vercel.app/auth/github/callback` |

Configure `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `GITHUB_TOKEN_ENCRYPTION_KEY` in each environment. The encryption key must be 32 random bytes encoded as hex or base64; keep it separate per environment and retain it while encrypted tokens exist. ProEngram encrypts user access and refresh tokens in Nanogres and refreshes them server-side. GitHub OAuth asks each administrator to authorize `repo` access and expiring tokens; it does not require GitHub App installation or pre-registration of repositories. GitHub's `repo` scope grants the app read/write access to all public and private repositories the authorizing user can access. Admins then choose which of those repositories ProEngram will connect and index.

An organization admin connects one or more GitHub user accounts in that organization's Settings page, then chooses from repositories dynamically discovered for those accounts. Accounts and repositories are scoped to the ProEngram organization; admins can remove either at any time. ProEngram checks repository access before saving. Adding a repository queues its initial sync and creates a signed GitHub push webhook automatically. A 15-minute worker recovers queued and failed jobs, and a daily reconciliation checks every connected repository and repairs missing hooks. Admins can still click **Sync** for an immediate refresh. Configure `CRON_SECRET` in Vercel Production so scheduled routes accept only Vercel Schedule requests. Sync is capped at 500 Markdown files and 20 MB total; individual files above 300 KB are skipped. `propose_markdown_change` creates reviewable pull requests under `docs/` in the selected repository and never merges them automatically.

For an existing deployment, migration 003 carries any repository already stored in `github_repository_settings` into the new source table as needing authorization. An admin reconnects a GitHub account and selects the repository in Settings before it can sync again.

## Google Drive setup

Create a Google OAuth client for each environment and register this callback URL:

| Environment | Google OAuth callback |
| --- | --- |
| Local | `http://localhost:3000/auth/google-drive/callback` |
| Production | `https://proengram.vercel.app/auth/google-drive/callback` |

Set `GOOGLE_DRIVE_OAUTH_CLIENT_ID`, `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`, and `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` for each environment. Use a separate 32-byte hex or base64 encryption key per environment and retain it while encrypted Drive tokens exist. The OAuth client requests `drive.readonly` plus identity scopes so administrators can select Shared Drives and folders. Google may require OAuth consent screen verification for the restricted Drive scope before production use.

An organization administrator connects one Google account and chooses one or more Shared Drives or folders in Settings. Selecting a folder includes its subfolders. Selecting the whole drive indexes the full Shared Drive. **All members with `brain:read` can read every selected item**, even if their Google accounts cannot; admins should select only company-approved content. The connector indexes Docs, Sheets, Slides, and text-based PDFs. Unsupported files and image-only PDFs are recorded with a skip reason; OCR and media indexing are not included. Each file is capped at 25 MB, each drive at 5,000 entries, and a sync downloads at most 250 MB. The worker checks changes every 15 minutes and performs a daily reconciliation. Revision history is guaranteed from the first ProEngram sync; older Google revisions may not be available.

## Database and migrations

ProEngram exchanges Vercel OIDC tokens for 15-minute Nanogres client certificates. Set `NANOGRES_ORGANIZATION_ID`, `NANOGRES_DATABASE`, `NANOGRES_RUNTIME_ROLE`, `NANOGRES_MIGRATION_ROLE`, and `NANOGRES_MIGRATION_OWNER_ROLE` in each environment. This Nanogres organization identifies the shared infrastructure database; ProEngram customer organizations remain isolated by `organization_id` within that database. Add exact-match issuer, audience, and subject grants for development, preview, and production in Nanogres; keep each environment on its own scoped roles. Runtime connections use transaction pooling. Migrations use session pooling and assume the configured owner role before taking an advisory lock. The app never stores a PostgreSQL password or connection URL. Run `pnpm db:migrate` locally before deploying database-dependent changes when a development Vercel OIDC token is available. Vercel builds only compile the app with `pnpm build`; they never modify the database. The migration runner applies numbered SQL migrations idempotently.

## Sentry8 policy snapshots

The Policies page accepts a reviewed JSON catalog with `policyRevision` and a `rules` array. Import replaces the active snapshot. The Sentry8 Custom Policy API is a callback/evaluation interface, not a general active-policy export endpoint; live policy synchronization and enforcing direct MCP calls through Sentry8 require a supported identity-preserving adapter.

## Guardrails

Repnix orchestrates repository health checks. Run `pnpm health:audit` to inventory checks, `pnpm health:plan` to review setup recommendations, and `pnpm health` to run the selected checks. Knip checks for unused code, jscpd checks duplication, Biome handles formatting and lint, and the GitHub Actions workflow runs health checks plus a production build on pull requests and pushes to `main`.
