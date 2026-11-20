import "server-only";

export async function createKnowledgeSearchEmbedding(query: string): Promise<{
  queryVector?: number[];
  embeddingModelVersion?: string;
}> {
  try {
    const { embedText, EMBEDDING_MODEL_VERSION } = await import("@/lib/knowledge/embeddings");
    return {
      queryVector: await embedText(query),
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
    };
  } catch {
    // Lexical search remains available if local inference is unavailable.
    return {};
  }
}
