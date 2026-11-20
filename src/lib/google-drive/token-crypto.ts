import { decryptToken, encryptToken, isTokenEncryptionConfigured } from "@/lib/auth/token-crypto";

const SETTING = "GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY";
const LABEL = "Google Drive";

export function isGoogleDriveTokenEncryptionConfigured(): boolean {
  return isTokenEncryptionConfigured(SETTING);
}

export function encryptGoogleDriveToken(value: string): string {
  return encryptToken(value, SETTING, LABEL);
}

export function decryptGoogleDriveToken(value: string): string {
  return decryptToken(value, SETTING, LABEL);
}
