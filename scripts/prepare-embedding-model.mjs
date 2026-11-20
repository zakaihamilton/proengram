import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

const modelId = "onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX";
const revision = "d4c06bf";
const cacheDir = resolve(".cache/proengram-embeddings");
const markerPath = resolve(cacheDir, "model-ready.json");

await mkdir(cacheDir, { recursive: true });
env.cacheDir = cacheDir;

try {
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.modelId === modelId && marker.revision === revision) {
    await stat(resolve(cacheDir, modelId, revision, "config.json"));
    await stat(resolve(cacheDir, modelId, revision, "onnx/model_quantized.onnx"));
    console.log(`Embedding model ${modelId}@${revision} is already cached.`);
    process.exit(0);
  }
} catch {
  // Download or repair the local model cache below.
}

console.log(`Preparing local embedding model ${modelId}@${revision}...`);
const extractor = await pipeline("feature-extraction", modelId, {
  revision,
  dtype: "q8",
});
const output = await extractor("ProEngram local embedding model ready.", {
  pooling: "mean",
  normalize: true,
});
if (output.dims.length !== 2 || output.dims[1] !== 384) {
  throw new Error(`Expected a 384-dimensional embedding; received [${output.dims.join(", ")}].`);
}
await writeFile(markerPath, `${JSON.stringify({ modelId, revision, dimensions: 384 }, null, 2)}\n`);
console.log("The local embedding model is ready.");
