const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase() || "proengram";

export async function GET() {
  return Response.json(
    {
      schemaVersion: 1,
      productId,
      version: "1.1.0",
      roles: [
        {
          id: "knowledge-reader",
          name: "Knowledge reader",
          description: "Read shared knowledge, provide feedback, and review suggestions.",
          role: "viewer",
          scopeKinds: ["product"],
          actions: ["brain:read", "brain:feedback", "knowledge:approve"],
        },
        {
          id: "knowledge-contributor",
          name: "Knowledge contributor",
          description: "Read, save, propose knowledge updates, and review suggestions.",
          role: "editor",
          scopeKinds: ["product"],
          actions: [
            "brain:read",
            "brain:feedback",
            "result:save",
            "knowledge:propose",
            "knowledge:approve",
          ],
        },
        {
          id: "knowledge-manager",
          name: "Knowledge manager",
          description: "Manage knowledge, policies, and connected sources.",
          role: "admin",
          scopeKinds: ["product"],
          actions: [
            "brain:read",
            "brain:feedback",
            "policy:read",
            "result:save",
            "knowledge:propose",
            "knowledge:approve",
            "source:manage",
            "source:sync",
          ],
        },
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
