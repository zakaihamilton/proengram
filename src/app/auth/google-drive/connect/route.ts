import { startOAuthConnection } from "@/lib/auth/oauth-routes";
import {
  createGoogleDriveAuthorizationUrl,
  getGoogleDriveOAuthConfiguration,
} from "@/lib/google-drive/oauth";
import {
  getGoogleDriveOAuthStateCookieName,
  signGoogleDriveOAuthState,
} from "@/lib/google-drive/oauth-state";
import { isGoogleDriveTokenEncryptionConfigured } from "@/lib/google-drive/token-crypto";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return startOAuthConnection(request, {
    connectionKey: "googleDriveConnection",
    isEncryptionConfigured: isGoogleDriveTokenEncryptionConfigured,
    getStateCookieName: getGoogleDriveOAuthStateCookieName,
    signState: signGoogleDriveOAuthState,
    getConfiguration: getGoogleDriveOAuthConfiguration,
    createAuthorizationUrl: ({ state, codeChallenge }) =>
      createGoogleDriveAuthorizationUrl({ state, codeChallenge }),
  });
}
