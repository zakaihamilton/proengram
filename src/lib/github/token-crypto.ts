import { decryptToken, encryptToken, isTokenEncryptionConfigured } from "@/lib/auth/token-crypto";

const SETTING = "GITHUB_TOKEN_ENCRYPTION_KEY";
const LABEL = "GitHub";

export function isGitHubTokenEncryptionConfigured(): boolean {
  return isTokenEncryptionConfigured(SETTING);
}

export function encryptGitHubToken(value: string): string {
  return encryptToken(value, SETTING, LABEL);
}

export function decryptGitHubToken(value: string): string {
  return decryptToken(value, SETTING, LABEL);
}
