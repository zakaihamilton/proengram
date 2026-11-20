import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["ssh2", "ws", "@huggingface/transformers", "onnxruntime-node"],
  outputFileTracingIncludes: {
    "/mcp": ["./.cache/proengram-embeddings/**/*"],
    "/knowledge": ["./.cache/proengram-embeddings/**/*"],
    "/api/cron/knowledge-embeddings": ["./.cache/proengram-embeddings/**/*"],
  },
  outputFileTracingExcludes: {
    "/knowledge/[id]": ["./.cache/proengram-embeddings/**/*"],
    "/knowledge/review": ["./.cache/proengram-embeddings/**/*"],
  },
};

export default nextConfig;
