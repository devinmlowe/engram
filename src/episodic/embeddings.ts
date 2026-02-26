import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import type { EngramConfig } from "../core/types.js";

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let activeModel: "nomic" | "minilm" = "nomic";
let activeDimensions = 256;

const NOMIC_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";
const NOMIC_MAX_CHARS = 8000;
const MINILM_MAX_CHARS = 2000;
const TARGET_DIMS = 256;

/**
 * Initialize the embedding pipeline.
 * Tries nomic-embed-text-v1.5 first, falls back to all-MiniLM-L6-v2.
 */
export async function initEmbeddings(_config?: EngramConfig): Promise<void> {
  if (embeddingPipeline) return;

  try {
    embeddingPipeline = await pipeline("feature-extraction", NOMIC_MODEL);
    activeModel = "nomic";
  } catch {
    embeddingPipeline = await pipeline("feature-extraction", MINILM_MODEL);
    activeModel = "minilm";
  }
  activeDimensions = TARGET_DIMS;
}

/**
 * Truncate to TARGET_DIMS and L2-normalize.
 */
function truncateAndNormalize(vec: number[]): number[] {
  const sliced = vec.slice(0, TARGET_DIMS);
  let norm = 0;
  for (const v of sliced) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return sliced;
  return sliced.map((v) => v / norm);
}

/**
 * Raw embed — add prefix for nomic, truncate input, MRL truncate output.
 */
async function embed(text: string, prefix: string): Promise<number[]> {
  if (!embeddingPipeline) await initEmbeddings();

  const maxChars = activeModel === "nomic" ? NOMIC_MAX_CHARS : MINILM_MAX_CHARS;
  const input =
    activeModel === "nomic"
      ? `${prefix}${text.substring(0, maxChars)}`
      : text.substring(0, maxChars);

  const output = await embeddingPipeline!(input, {
    pooling: "mean",
    normalize: true,
  });

  return truncateAndNormalize(Array.from(output.data as Float32Array));
}

/**
 * Embed a search query. Uses `search_query:` prefix for nomic.
 */
export async function embedQuery(text: string): Promise<number[]> {
  return embed(text, "search_query: ");
}

/**
 * Embed a document for storage. Uses `search_document:` prefix for nomic.
 */
export async function embedDocument(text: string): Promise<number[]> {
  return embed(text, "search_document: ");
}

/**
 * Embed an exchange with contextual metadata (per D2).
 * Prepends project/date/branch/tools context before embedding.
 */
export async function embedExchange(
  userMsg: string,
  assistantMsg: string,
  meta: {
    project?: string;
    date?: string;
    branch?: string;
    tools?: string[];
  } = {},
): Promise<number[]> {
  const parts: string[] = [];

  // Contextual prefix
  const contextParts: string[] = [];
  if (meta.project) contextParts.push(`Project: ${meta.project}`);
  if (meta.date) contextParts.push(`Date: ${meta.date}`);
  if (meta.branch) contextParts.push(`Branch: ${meta.branch}`);
  if (contextParts.length > 0) {
    parts.push(`[${contextParts.join(" | ")}]`);
  }

  parts.push(`User: ${userMsg}`);
  parts.push(`Assistant: ${assistantMsg.substring(0, 500)}`);

  if (meta.tools && meta.tools.length > 0) {
    parts.push(`Tools used: ${meta.tools.join(", ")}`);
  }

  return embedDocument(parts.join("\n"));
}

/**
 * Get the active output dimensions (always 256 after MRL truncation).
 */
export function getActiveDimensions(): number {
  return activeDimensions;
}

/**
 * Get the active model name (for diagnostics).
 */
export function getActiveModel(): "nomic" | "minilm" {
  return activeModel;
}

/**
 * Reset the pipeline (for testing).
 */
export function resetEmbeddings(): void {
  embeddingPipeline = null;
  activeModel = "nomic";
  activeDimensions = 256;
}
