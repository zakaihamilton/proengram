import { Card } from "panel-frame-ui";
import { getPerministerBaseUrl } from "@/lib/auth/config";

export function SetupChecklistCard({
  githubCallbackUrl,
  googleDriveCallbackUrl,
}: {
  githubCallbackUrl: string;
  googleDriveCallbackUrl: string;
}) {
  return (
    <Card className="content-card setup-card">
      <div className="card-heading">
        <div>
          <h2>Initial setup</h2>
          <p>
            Keep application secrets server-side; database access uses short-lived workload
            certificates.
          </p>
        </div>
      </div>
      <ol className="setup-list">
        <li>
          Create a dedicated <code>proengram</code> database and runtime/migration roles in
          Nanogres, then grant this environment&apos;s exact Vercel OIDC identity.
        </li>
        <li>
          Configure separate Perminister clients for dashboard OIDC and MCP resource introspection.
        </li>
        <li>
          Create a GitHub OAuth App with callback URL <code>{githubCallbackUrl}</code>, then
          configure its server-side client ID and secret plus a 32-byte token encryption key. Each
          connected account authorizes the <code>repo</code> scope; admins select which accessible
          repositories ProEngram connects.
        </li>
        <li>
          Connect GitHub accounts and select repositories from the live repository list. No
          repository names are hard-coded or installed ahead of time.
        </li>
        <li>
          Create a Google OAuth client with callback URL <code>{googleDriveCallbackUrl}</code>.
          Configure its client ID and secret plus a separate 32-byte token encryption key. Google
          may require verification for the read-only Drive scope.
        </li>
        <li>
          Connect the Google account and select Shared Drives or folders approved for company-wide
          reading. Every ProEngram member with <code>brain:read</code> can read that selected
          corpus.
        </li>
        <li>
          Apply numbered database migrations with <code>pnpm db:migrate</code>.
        </li>
        <li>
          Run <code>pnpm health:audit</code> and review the available Repnix guardrails.
        </li>
      </ol>
      <p className="metric-note">
        Perminister: <code>{getPerministerBaseUrl()}</code>
      </p>
    </Card>
  );
}
