import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const value = process.env.GITHUB_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("GitHub token encryption is not configured.");

  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be a 32-byte base64 or hex value.");
  }
  return key;
}

export function isGitHubTokenEncryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptGitHubToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptGitHubToken(value: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext || extra) {
    throw new Error("Stored GitHub credentials are invalid.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored GitHub credentials could not be decrypted.");
  }
}
