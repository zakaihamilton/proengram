import { connectGitHubAccount } from "@/lib/github/connections";
import { exchangeGitHubAuthorizationCode, fetchGitHubAccountProfile } from "@/lib/github/oauth";
import { handleOAuthCallback } from "@/lib/auth/oauth-routes";
import { getGitHubOAuthStateCookieName, verifyGitHubOAuthState } from "@/lib/github/oauth-state";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleOAuthCallback(request, {
    connectionKey: "githubConnection",
    getStateCookieName: getGitHubOAuthStateCookieName,
    verifyState: verifyGitHubOAuthState,
    exchangeCode: exchangeGitHubAuthorizationCode,
    fetchProfile: fetchGitHubAccountProfile,
    connect: connectGitHubAccount,
  });
}
