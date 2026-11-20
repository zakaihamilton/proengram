import "server-only";

import { env, pipeline, type FeatureExtractionPipelineType } from "@huggingface/transformers";
import { resolve } from "node:path";

export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL_ID = "onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX";
export const EMBEDDING_MODEL_REVISION = "d4c06bf";
export const EMBEDDING_MODEL_VERSION = `${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_REVISION}:q8`;

let extractorPromise: Promise<FeatureExtractionPipelineType> | undefined;
const createFeatureExtractor = pipeline as unknown as (
  task: "feature-extraction",
  model: string,
  options: { revision: string; dtype: "q8"; local_files_only: boolean },
) => Promise<FeatureExtractionPipelineType>;

function getExtractor(): Promise<FeatureExtractionPipelineType> {
  if (!extractorPromise) {
    env.cacheDir = resolve(process.cwd(), ".cache/proengram-embeddings");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useFS = true;
    env.useFSCache = true;
    env.useBrowserCache = false;
    env.useCustomCache = false;
    extractorPromise = createFeatureExtractor("feature-extraction", EMBEDDING_MODEL_ID, {
      revision: EMBEDDING_MODEL_REVISION,
      dtype: "q8",
      local_files_only: true,
    });
  }
  return extractorPromise;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const normalizedTexts = texts.map((text) => text.trim());
  if (normalizedTexts.some((text) => text.length === 0)) {
    throw new Error("Embedding input cannot be empty.");
  }
  const extractor = await getExtractor();
  const output = await extractor(normalizedTexts, { pooling: "mean", normalize: true });
  if (
    output.dims.length !== 2 ||
    output.dims[0] !== normalizedTexts.length ||
    output.dims[1] !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(`Expected ${EMBEDDING_DIMENSIONS}-dimensional embeddings.`);
  }
  const values = Array.from(output.data, Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding output contains a non-finite number.");
  }
  return normalizedTexts.map((_, index) => {
    const start = index * EMBEDDING_DIMENSIONS;
    return values.slice(start, start + EMBEDDING_DIMENSIONS);
  });
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) throw new Error("The local embedding model returned no output.");
  return embedding;
}
