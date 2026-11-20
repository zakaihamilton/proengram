import { startOAuthConnection } from "@/lib/auth/oauth-routes";
import { createGitHubAuthorizationUrl, getGitHubOAuthConfiguration } from "@/lib/github/oauth";
import { getGitHubOAuthStateCookieName, signGitHubOAuthState } from "@/lib/github/oauth-state";
import { isGitHubTokenEncryptionConfigured } from "@/lib/github/token-crypto";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return startOAuthConnection(request, {
    connectionKey: "githubConnection",
    isEncryptionConfigured: isGitHubTokenEncryptionConfigured,
    getStateCookieName: getGitHubOAuthStateCookieName,
    signState: signGitHubOAuthState,
    getConfiguration: getGitHubOAuthConfiguration,
    createAuthorizationUrl: createGitHubAuthorizationUrl,
  });
}
