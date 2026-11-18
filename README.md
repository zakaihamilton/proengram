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
3. Create a dedicated ProEngram database and least-privilege runtime and migration roles in Nanogres. Configure the Nanogres organization, database, and role names; grant this Vercel project's exact development OIDC identity. `vercel env pull .env.local` supplies a short-lived local OIDC token.
4. Install dependencies with `pnpm install`, apply the schema with `pnpm db:migrate`, then run `pnpm dev`. The migration command reads `.env.local` automatically.
5. Open `http://localhost:3000`. Use `/ui-preview` for the synthetic component gallery.

## Perminister setup

Create a separate dashboard and MCP client pair for each environment. The MCP client is bound to one canonical resource URI, so do not reuse its credentials between local development and production.

| Environment | Dashboard origin and callback | MCP resource URI |
| --- | --- | --- |
| Local | `http://localhost:3000` and `http://localhost:3000/auth/perminister/callback` | `http://localhost:3000/mcp` |
| Production | `https://proengram.vercel.app` and `https://proengram.vercel.app/auth/perminister/callback` | `https://proengram.vercel.app/mcp` |

For each dashboard client, enable `openid`, `profile`, `email`, and `perminister_api`. For each MCP client, register only that environment's resource URI and the scopes `brain:read`, `policy:read`, `result:save`, and `knowledge:propose`. Keep registration invite-only. Remote assistant clients register separately with Perminister through OAuth discovery.

Copy `.env.example` to `.env.local` and enter the local client IDs and secrets there. In Vercel, set the matching production values in the `proengram` project's Production environment. Set `PROENGRAM_ORIGIN` and `PERMINISTER_MCP_RESOURCE_URI` to the corresponding row above, and set `PERMINISTER_ORGANIZATION_ID` to the lowercase organization identifier used by this deployment. Set `PERMINISTER_ISSUER` to the issuer returned by Perminister metadata. Keep client secrets server-only, and set `PROENGRAM_COOKIE_SECRET` to a dedicated random value of at least 32 characters in each environment. Production origins and the MCP resource URI must use HTTPS.

The MCP endpoint is `/mcp`. Protected Resource Metadata is published at the RFC 9728 path for that exact resource URL (for example, `/.well-known/oauth-protected-resource/mcp`). ChatGPT and Claude discover Perminister there and obtain a separate user token for the ProEngram resource.

## GitHub setup

Install a GitHub App on the one company knowledge repository. Grant repository Contents read/write and Pull Requests read/write permissions. Configure the app ID, installation ID, private key, owner, repository, and default branch in the environment. ProEngram syncs Markdown into Nanogres and limits proposed edits to `docs/*.md` or `docs/*.mdx` pull requests. Sync is capped at 500 Markdown files and 20 MB total; individual files above 300 KB are skipped.

## Database and migrations

ProEngram exchanges Vercel OIDC tokens for 15-minute Nanogres client certificates. Set `NANOGRES_ORGANIZATION_ID`, `NANOGRES_DATABASE`, `NANOGRES_RUNTIME_ROLE`, `NANOGRES_MIGRATION_ROLE`, and `NANOGRES_MIGRATION_OWNER_ROLE` in each environment. Add exact-match issuer, audience, and subject grants for development, preview, and production in Nanogres; keep each environment on its own scoped roles. Runtime connections use transaction pooling. Migrations use session pooling and assume the configured owner role before taking an advisory lock. The app never stores a PostgreSQL password or connection URL. Apply schema changes with `pnpm db:migrate`.

## Sentry8 policy snapshots

The Policies page accepts a reviewed JSON catalog with `policyRevision` and a `rules` array. Import replaces the active snapshot. The Sentry8 Custom Policy API is a callback/evaluation interface, not a general active-policy export endpoint; live policy synchronization and enforcing direct MCP calls through Sentry8 require a supported identity-preserving adapter.

## Guardrails

Repnix orchestrates repository health checks. Run `pnpm health:audit` to inventory checks, `pnpm health:plan` to review setup recommendations, and `pnpm health` to run the selected checks. Knip checks for unused code, jscpd checks duplication, Biome handles formatting and lint, and the GitHub Actions workflow runs health checks plus a production build on pull requests and pushes to `main`.
