const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase() || "proengram";

export async function GET() {
  return Response.json(
    {
      schemaVersion: 1,
      productId,
      version: "1.0.0",
      roles: [
        {
          id: "knowledge-reader",
          name: "Knowledge reader",
          description: "Read the shared brain and knowledge base.",
          role: "viewer",
          scopeKinds: ["product"],
          actions: ["brain:read"],
        },
        {
          id: "knowledge-contributor",
          name: "Knowledge contributor",
          description: "Read, save results, and propose knowledge updates.",
          role: "editor",
          scopeKinds: ["product"],
          actions: ["brain:read", "result:save", "knowledge:propose"],
        },
        {
          id: "knowledge-manager",
          name: "Knowledge manager",
          description: "Manage knowledge, policies, and connected sources.",
          role: "admin",
          scopeKinds: ["product"],
          actions: [
            "brain:read",
            "policy:read",
            "result:save",
            "knowledge:propose",
            "source:sync",
          ],
        },
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
