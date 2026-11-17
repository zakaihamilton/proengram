import {
  protectedResourceMetadataOptions,
  protectedResourceMetadataResponse,
} from "@/lib/auth/protected-resource";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return protectedResourceMetadataResponse(path);
}

export function OPTIONS(): Response {
  return protectedResourceMetadataOptions();
}
