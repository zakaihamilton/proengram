import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestWorkloadCredential, validateIdentityUrl } from "../src/lib/db/workload-tunnel.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function baseCredential(overrides = {}) {
  return {
    clientCert: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
    clientKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    host: "127.0.0.1",
    port: 6434,
    user: "n_org_app",
    database: "n_org_db",
    tlsServerName: "db.nanogres.test",
    sshHost: "db.nanogres.test",
    sshPort: 8443,
    sshPath: "/_nanogres/workload-ssh",
    sshUsername: "nanogres-workload",
    sshHostKeySha256: "a".repeat(64),
    pooling: "transaction",
    ...overrides,
  };
}

test("validateIdentityUrl requires a clean HTTPS URL", () => {
  assert.equal(
    validateIdentityUrl("https://nanogres.vercel.app/api/workload-identity"),
    "https://nanogres.vercel.app/api/workload-identity",
  );
  assert.throws(
    () => validateIdentityUrl("http://nanogres.vercel.app/api/workload-identity"),
    /clean HTTPS URL/,
  );
  assert.throws(
    () => validateIdentityUrl("https://user:pass@nanogres.vercel.app/api/workload-identity"),
    /clean HTTPS URL/,
  );
  assert.throws(
    () => validateIdentityUrl("https://nanogres.vercel.app/api/workload-identity?foo=bar"),
    /clean HTTPS URL/,
  );
});

test("requestWorkloadCredential accepts valid runtime and migration credentials", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(baseCredential()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const runtime = await requestWorkloadCredential({
    endpoint: "https://nanogres.vercel.app/api/workload-identity",
    oidcToken: "oidc-jwt",
    organizationId: "org-1",
    database: "proengram",
    role: "runtime_role",
    requiredPooling: "transaction",
  });
  assert.equal(runtime.credential.port, 6434);
  assert.equal(runtime.sshPrivateKey.includes("OPENSSH PRIVATE KEY"), true);

  globalThis.fetch = async () =>
    new Response(JSON.stringify(baseCredential({ port: 6435, pooling: "session" })), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const migration = await requestWorkloadCredential({
    endpoint: "https://nanogres.vercel.app/api/workload-identity",
    oidcToken: "oidc-jwt",
    organizationId: "org-1",
    database: "proengram",
    role: "migration_role",
    requiredPooling: "session",
  });
  assert.equal(migration.credential.port, 6435);
});

test("requestWorkloadCredential rejects invalid endpoints, expired certs, and wrong pooling", async () => {
  const invalidCases = [
    [
      baseCredential({
        pooling: "session",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
      /expired/,
    ],
    [baseCredential({ pooling: "session", host: "10.0.0.1" }), /invalid workload SSH endpoint/],
    [
      baseCredential({ pooling: "session", sshHostKeySha256: "not-hex" }),
      /invalid workload SSH endpoint/,
    ],
    [baseCredential({ pooling: "transaction" }), /unexpected workload pooling mode/],
  ];

  for (const [payload, expectedError] of invalidCases) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      () =>
        requestWorkloadCredential({
          endpoint: "https://nanogres.vercel.app/api/workload-identity",
          oidcToken: "oidc-jwt",
          organizationId: "org-1",
          database: "proengram",
          role: "migration_role",
          requiredPooling: "session",
        }),
      expectedError,
    );
  }
});
