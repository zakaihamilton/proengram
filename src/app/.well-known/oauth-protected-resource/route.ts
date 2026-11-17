import {
  protectedResourceMetadataOptions,
  protectedResourceMetadataResponse,
} from "@/lib/auth/protected-resource";

export const runtime = "nodejs";

export function GET(): Response {
  return protectedResourceMetadataResponse();
}

export function OPTIONS(): Response {
  return protectedResourceMetadataOptions();
}
