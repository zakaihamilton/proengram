import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { authorizeCronRequest } from "../src/lib/auth/cron.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "virtual:server-only", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:server-only") {
      return { format: "module", shortCircuit: true, source: "" };
    }
    return nextLoad(url, context);
  },
});

const { verifyGitHubWebhookSignature } = await import("../src/lib/github/webhook-api.ts");

const originalCronSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

test("authorizeCronRequest enforces CRON_SECRET presence and timing-safe matching", () => {
  delete process.env.CRON_SECRET;
  const unconfigured = authorizeCronRequest(new Request("https://proengram.test/api/cron/sync"));
  assert.equal(unconfigured?.status, 503);

  process.env.CRON_SECRET = "super-secret-cron-token";
  assert.equal(
    authorizeCronRequest(new Request("https://proengram.test/api/cron/sync"))?.status,
    401,
  );
  assert.equal(
    authorizeCronRequest(
      new Request("https://proengram.test/api/cron/sync", {
        headers: { authorization: "Bearer wrong" },
      }),
    )?.status,
    401,
  );
  assert.equal(
    authorizeCronRequest(
      new Request("https://proengram.test/api/cron/sync", {
        headers: { authorization: "Bearer super-secret-cron-tokem" },
      }),
    )?.status,
    401,
  );
  assert.equal(
    authorizeCronRequest(
      new Request("https://proengram.test/api/cron/sync", {
        headers: { authorization: "Bearer super-secret-cron-token" },
      }),
    ),
    null,
  );
});

test("verifyGitHubWebhookSignature validates HMAC-SHA256 signatures safely", () => {
  const secret = "webhook-secret-key";
  const payload = Buffer.from('{"ref":"refs/heads/main"}', "utf8");
  const validSignature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

  assert.equal(verifyGitHubWebhookSignature(payload, validSignature, secret), true);
  assert.equal(verifyGitHubWebhookSignature(payload, null, secret), false);
  assert.equal(verifyGitHubWebhookSignature(payload, "sha1=deadbeef", secret), false);
  assert.equal(verifyGitHubWebhookSignature(payload, `sha256=${"0".repeat(64)}`, secret), false);
  assert.equal(verifyGitHubWebhookSignature(payload, validSignature, "other-secret"), false);
});
