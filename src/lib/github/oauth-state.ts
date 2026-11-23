import {
  getOAuthStateCookieName,
  type OAuthStatePayload,
  signOAuthState,
  verifyOAuthState,
} from "@/lib/auth/oauth-provider-state";

const PROVIDER = "github";
const AUDIENCE = "github-oauth";

export type GitHubOAuthState = OAuthStatePayload;

export function getGitHubOAuthStateCookieName(state: string): string {
  return getOAuthStateCookieName(state, PROVIDER, "GitHub");
}

export function signGitHubOAuthState(
  input: Omit<GitHubOAuthState, "state">,
): Promise<{ state: string; cookieToken: string }> {
  return signOAuthState(input, AUDIENCE);
}

export function verifyGitHubOAuthState(
  token: string,
  expectedState: string,
): Promise<GitHubOAuthState> {
  return verifyOAuthState(token, expectedState, AUDIENCE, "GitHub");
}
