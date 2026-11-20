import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(settingName: string, label: string): Buffer {
  const value = process.env[settingName]?.trim();
  if (!value) throw new Error(`${label} token encryption is not configured.`);
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`${settingName} must be a 32-byte base64 or hex value.`);
  }
  return key;
}

export function isTokenEncryptionConfigured(settingName: string): boolean {
  try {
    encryptionKey(settingName, "Token");
    return true;
  } catch {
    return false;
  }
}

export function encryptToken(value: string, settingName: string, label: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(settingName, label), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(value: string, settingName: string, label: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext || extra) {
    throw new Error(`Stored ${label} credentials are invalid.`);
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(settingName, label),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(`Stored ${label} credentials could not be decrypted.`);
  }
}
