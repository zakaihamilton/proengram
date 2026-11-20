import { handleOAuthCallback } from "@/lib/auth/oauth-routes";
import { connectGoogleDriveAccount } from "@/lib/google-drive/connections";
import {
  exchangeGoogleDriveAuthorizationCode,
  fetchGoogleDriveProfile,
} from "@/lib/google-drive/oauth";
import {
  getGoogleDriveOAuthStateCookieName,
  verifyGoogleDriveOAuthState,
} from "@/lib/google-drive/oauth-state";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleOAuthCallback(request, {
    connectionKey: "googleDriveConnection",
    getStateCookieName: getGoogleDriveOAuthStateCookieName,
    verifyState: verifyGoogleDriveOAuthState,
    exchangeCode: exchangeGoogleDriveAuthorizationCode,
    fetchProfile: fetchGoogleDriveProfile,
    connect: connectGoogleDriveAccount,
  });
}
