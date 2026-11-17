import "server-only";

export type PerministerClientName = "dashboard" | "mcp";

export type PerministerClientConfig = {
  baseUrl: string;
  productId: string;
  clientId: string;
  clientSecret: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function getPerministerBaseUrl(): string {
  const value = process.env.PERMINISTER_URL?.trim() || "https://www.perminister.com";
  const url = new URL(value);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("PERMINISTER_URL must use HTTPS in production.");
  }
  return url.origin;
}

export function getPerministerClient(kind: PerministerClientName): PerministerClientConfig {
  const prefix = kind === "dashboard" ? "PERMINISTER_DASHBOARD" : "PERMINISTER_MCP";
  return {
    baseUrl: getPerministerBaseUrl(),
    productId: process.env.PERMINISTER_PRODUCT_ID?.trim() || "proengram",
    clientId: required(`${prefix}_CLIENT_ID`),
    clientSecret: required(`${prefix}_CLIENT_SECRET`),
  };
}

export function getOrganizationId(): string {
  return required("PERMINISTER_ORGANIZATION_ID").toLowerCase();
}

export function getMcpResourceUri(): string {
  const value =
    process.env.PERMINISTER_MCP_RESOURCE_URI?.trim() ||
    `${process.env.PROENGRAM_ORIGIN?.trim() || "http://localhost:3000"}/mcp`;
  const url = new URL(value);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      "PERMINISTER_MCP_RESOURCE_URI must not contain credentials, a query, or a fragment.",
    );
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("PERMINISTER_MCP_RESOURCE_URI must use HTTPS in production.");
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function getPublicOrigin(): string {
  const value = process.env.PROENGRAM_ORIGIN?.trim() || "http://localhost:3000";
  const url = new URL(value);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("PROENGRAM_ORIGIN must use HTTPS in production.");
  }
  return url.origin;
}

export function isCookieSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getCookieSecret(): string {
  const value = process.env.PROENGRAM_COOKIE_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PROENGRAM_COOKIE_SECRET must contain at least 32 characters.");
  }
  return "local-development-cookie-secret-change-before-deploy";
}
