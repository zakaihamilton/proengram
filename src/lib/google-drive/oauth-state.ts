import {
  getOAuthStateCookieName,
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from "@/lib/auth/oauth-provider-state";

const PROVIDER = "gdrive";
const AUDIENCE = "google-drive-oauth";

export type GoogleDriveOAuthState = OAuthStatePayload;

export function getGoogleDriveOAuthStateCookieName(state: string): string {
  return getOAuthStateCookieName(state, PROVIDER, "Google Drive");
}

export function signGoogleDriveOAuthState(
  input: Omit<GoogleDriveOAuthState, "state">,
): Promise<{ state: string; cookieToken: string }> {
  return signOAuthState(input, AUDIENCE);
}

export function verifyGoogleDriveOAuthState(
  token: string,
  expectedState: string,
): Promise<GoogleDriveOAuthState> {
  return verifyOAuthState(token, expectedState, AUDIENCE, "Google Drive");
}
