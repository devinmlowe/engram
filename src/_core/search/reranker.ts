/**
 * Cross-encoder reranking for Engram search results.
 *
 * Uses BGE-reranker-base via @xenova/transformers for local inference.
 * Singleton model loader keeps the model warm after first load.
 * Gracefully degrades when the model is unavailable.
 *
 * Moved from retrieval/reranker.ts during Phase 1 core extraction.
 */

import { applyModelCacheDir } from "../embeddings/model-cache.js";
import type { SearchResult, RerankerConfig } from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────

/**
 * A loaded cross-encoder: scores (query, passage) pairs with one relevance
 * logit per pair. Built from a tokenizer + sequence-classification model
 * rather than the `text-classification` pipeline: in @xenova/transformers
 * v2 that pipeline only accepts plain strings, so feeding it
 * `{text, text_pair}` objects throws `text.split is not a function`, and
 * even a plain-string call collapses the single logit to a constant 1.0
 * through softmax. Pairs must go through the tokenizer's `text_pair` option.
 */
export interface CrossEncoder {
  /** Relevance logits for pairs (queries[i], passages[i]). Higher = more relevant. */
  score(queries: string[], passages: string[]): Promise<number[]>;
}

interface TokenizerLike {
  (text: string[], options: Record<string, unknown>): Record<string, unknown>;
}
interface SeqClsModelLike {
  (inputs: Record<string, unknown>): Promise<{ logits: { dims: number[]; data: ArrayLike<number> } }>;
}

/** Read one relevance logit per row from a [rows, labels] logits tensor. */
export function logitsToScores(logits: { dims: number[]; data: ArrayLike<number> }): number[] {
  const rows = logits.dims[0] ?? 0;
  const cols = logits.dims[1] ?? 1;
  const scores: number[] = [];
  for (let i = 0; i < rows; i++) {
    // Single-label rerankers (bge-reranker) have one column; for multi-label
    // heads the last column is the "relevant" class by convention.
    scores.push(Number(logits.data[i * cols + (cols - 1)]));
  }
  return scores;
}

/** Wrap a transformers.js tokenizer + AutoModelForSequenceClassification. */
export function createCrossEncoder(tokenizer: TokenizerLike, model: SeqClsModelLike): CrossEncoder {
  return {
    async score(queries, passages) {
      if (queries.length !== passages.length) {
        throw new Error(`cross-encoder: ${queries.length} queries vs ${passages.length} passages`);
      }
      if (queries.length === 0) return [];
      const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true });
      const { logits } = await model(inputs);
      const scores = logitsToScores(logits);
      if (scores.length !== queries.length) {
        throw new Error(`cross-encoder: expected ${queries.length} scores, got ${scores.length}`);
      }
      return scores;
    },
  };
}

// ─── Singleton State ────────────────────────────────────────────

let rerankerPipeline: CrossEncoder | null = null;
let loadAttempted = false;
let loadError: Error | null = null;

const DEFAULT_MODEL = "Xenova/bge-reranker-base";

/**
 * Lazily initialize the cross-encoder reranker pipeline.
 * Uses singleton pattern — model is loaded once and cached.
 */
export async function initReranker(
  model: string = DEFAULT_MODEL,
): Promise<void> {
  if (rerankerPipeline) return;
  if (loadAttempted) return; // Don't retry on previous failure

  loadAttempted = true;

  try {
    // Dynamic import to avoid pulling in transformers when reranking is disabled
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@xenova/transformers");
    applyModelCacheDir(env);
    const [tokenizer, seqCls] = await Promise.all([
      AutoTokenizer.from_pretrained(model),
      AutoModelForSequenceClassification.from_pretrained(model),
    ]);
    rerankerPipeline = createCrossEncoder(
      tokenizer as unknown as TokenizerLike,
      seqCls as unknown as SeqClsModelLike,
    );
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      `[engram] Reranker model "${model}" failed to load: ${loadError.message}. Continuing without reranking.`,
    );
  }
}

/**
 * Check if the reranker model is loaded and available.
 */
export function isRerankerAvailable(): boolean {
  return rerankerPipeline !== null;
}

// ─── Score Normalization ────────────────────────────────────────

/**
 * Normalize raw cross-encoder logits to [0, 1] using min-max scaling.
 * Returns normalized scores in the same order as input.
 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  if (scores.length === 1) return [1.0];

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;

  if (range === 0) return scores.map(() => 0.5);

  return scores.map((s) => (s - min) / range);
}

// ─── Score Blending ─────────────────────────────────────────────

/**
 * Blend reranker scores with original RRF scores.
 * final = blendWeight * rerankerScore + (1 - blendWeight) * originalScore
 */
export function blendScores(
  rerankerScores: number[],
  originalScores: number[],
  blendWeight: number,
): number[] {
  return rerankerScores.map((rs, i) => {
    const os = originalScores[i] ?? 0;
    return blendWeight * rs + (1 - blendWeight) * os;
  });
}

// ─── Reranking ──────────────────────────────────────────────────

/**
 * Rerank search results using the cross-encoder model.
 *
 * Pipeline:
 * 1. Build query-candidate pairs
 * 2. Batch inference through cross-encoder
 * 3. Normalize scores to [0, 1]
 * 4. Optionally blend with original RRF scores
 * 5. Sort by final score descending
 * 6. Return top K results
 *
 * @param query - The search query
 * @param candidates - Search results from RRF fusion
 * @param config - Reranker configuration (topK, blendWeight)
 * @returns Reranked search results, or original results if reranker unavailable
 */
export async function rerankResults(
  query: string,
  candidates: SearchResult[],
  config?: Partial<RerankerConfig>,
): Promise<SearchResult[]> {
  const topK = config?.topK ?? 5;
  const blendWeight = config?.blendWeight ?? 0.7;
  const model = config?.model ?? DEFAULT_MODEL;

  // Graceful degradation: return original results if reranker not available
  if (!rerankerPipeline) {
    await initReranker(model);
    if (!rerankerPipeline) {
      return candidates.slice(0, topK);
    }
  }

  if (candidates.length === 0) return [];

  // Parallel arrays: pair i = (query, candidates[i].content). The query is
  // passed verbatim (may be long / multi-line — the tokenizer truncates).
  const queries = candidates.map(() => query);
  const passages = candidates.map((c) => c.content);

  try {
    // Batch inference: all pairs in one forward pass; one raw logit per pair
    const rawScores = await rerankerPipeline.score(queries, passages);

    // Normalize to [0, 1]
    const normalizedScores = normalizeScores(rawScores);

    // Blend with original RRF scores
    const originalScores = candidates.map((c) => c.score);
    const finalScores = blendScores(
      normalizedScores,
      originalScores,
      blendWeight,
    );

    // Attach final scores and sort descending
    const scored = candidates.map((c, i) => ({
      result: c,
      finalScore: finalScores[i],
    }));

    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Return top K with updated scores
    return scored.slice(0, topK).map(({ result, finalScore }) => ({
      ...result,
      score: finalScore,
    }));
  } catch (err) {
    console.warn(
      `[engram] Reranking failed: ${err instanceof Error ? err.message : String(err)}. Using original ranking.`,
    );
    return candidates.slice(0, topK);
  }
}

/**
 * Reset reranker state (for testing).
 */
export function resetReranker(): void {
  rerankerPipeline = null;
  loadAttempted = false;
  loadError = null;
}

/**
 * Install a pre-built cross-encoder (for testing without model files).
 */
export function setCrossEncoderForTesting(encoder: CrossEncoder | null): void {
  rerankerPipeline = encoder;
  loadAttempted = encoder !== null;
  loadError = null;
}
