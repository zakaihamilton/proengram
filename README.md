# ProEngram

ProEngram is a company knowledge dashboard and remote MCP server. Each employee connects from their own ChatGPT or Claude account through Perminister OAuth. ProEngram stores shared saved answers and indexed knowledge in Nanogres-managed PostgreSQL, while GitHub Markdown remains the canonical editable source.

## Architecture

- **Identity and authorization:** Perminister handles dashboard sign-in and issues resource-scoped user tokens for MCP. ProEngram introspects each token and checks the user's current Perminister grant for every tool action.
- **Shared knowledge:** GitHub Markdown is synced into a searchable index in Nanogres PostgreSQL. Saved answers and citations are also shared with the user's company workspace.
- **Reviewable edits:** `propose_markdown_change` creates a GitHub pull request under `docs/`; it never merges automatically.
- **Policies:** ProEngram stores reviewed Sentry8 policy snapshots. Direct ProEngram MCP calls are not currently evaluated by Sentry8. See [`docs/sentry8-integration.md`](docs/sentry8-integration.md).
- **Dashboard:** The company dashboard uses Panel Frame UI. `/ui-preview` is a development-only gallery built with UI Preview Kit and synthetic content.

## Local setup

1. Install Node.js 24.22.1 or newer in the 24.x line, plus pnpm 12.18 or newer.
2. Copy `.env.example` to `.env.local` and fill in the settings below.
3. Create a dedicated ProEngram database and least-privilege runtime and migration roles in Nanogres. Put the runtime TLS connection string in `DATABASE_URL` and the migration-role connection string in `MIGRATION_DATABASE_URL`.
4. Install dependencies with `pnpm install`, apply the schema with `pnpm db:migrate`, then run `pnpm dev`. The migration command reads `.env.local` automatically.
5. Open `http://localhost:3000`. Use `/ui-preview` for the synthetic component gallery.

## Perminister setup

Create two separate confidential ProEngram app clients in Perminister:

1. **Dashboard OIDC client:** register `http://localhost:3000/auth/perminister/callback` as the callback URL (replace the origin in production). Enable the `openid`, `profile`, `email`, and `perminister_api` scopes. Give the app client the dashboard access needed for sign-in and `POST /api/authorize` checks.
2. **MCP resource client:** configure the exact canonical resource URI from `PERMINISTER_MCP_RESOURCE_URI` (locally `http://localhost:3000/mcp`) and the scopes `brain:read`, `policy:read`, `result:save`, and `knowledge:propose`. Use its confidential credentials for token introspection and live action checks. Remote assistant clients register separately with Perminister through OAuth discovery.

Set `PERMINISTER_ORGANIZATION_ID` to the lowercase organization identifier used by this deployment, and set `PERMINISTER_ISSUER` to the issuer returned by Perminister metadata. Keep both client secrets and the OAuth state signing secret in the hosting environment. Use an HTTPS origin, a dedicated cookie secret of at least 32 characters, and an HTTPS resource URI in production.

The MCP endpoint is `/mcp`. Protected Resource Metadata is published at the RFC 9728 path for that exact resource URL (for example, `/.well-known/oauth-protected-resource/mcp`). ChatGPT and Claude discover Perminister there and obtain a separate user token for the ProEngram resource.

## GitHub setup

Install a GitHub App on the one company knowledge repository. Grant repository Contents read/write and Pull Requests read/write permissions. Configure the app ID, installation ID, private key, owner, repository, and default branch in the environment. ProEngram syncs Markdown into Nanogres and limits proposed edits to `docs/*.md` or `docs/*.mdx` pull requests. Sync is capped at 500 Markdown files and 20 MB total; individual files above 300 KB are skipped.

## Database and migrations

`DATABASE_URL` and `MIGRATION_DATABASE_URL` are server-only. Apply schema changes with `pnpm db:migrate`; the migration runner uses a PostgreSQL advisory lock. For hosted deployments, run migrations from a controlled release step with the migration role, then run the app with the narrower runtime role.

## Sentry8 policy snapshots

The Policies page accepts a reviewed JSON catalog with `policyRevision` and a `rules` array. Import replaces the active snapshot. The Sentry8 Custom Policy API is a callback/evaluation interface, not a general active-policy export endpoint; live policy synchronization and enforcing direct MCP calls through Sentry8 require a supported identity-preserving adapter.

## Guardrails

Repnix orchestrates repository health checks. Run `pnpm health:audit` to inventory checks, `pnpm health:plan` to review setup recommendations, and `pnpm health` to run the selected checks. Knip checks for unused code, jscpd checks duplication, Biome handles formatting and lint, and the GitHub Actions workflow runs health checks plus a production build on pull requests and pushes to `main`.
