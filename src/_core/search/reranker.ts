/**
 * Cross-encoder reranking for Engram search results.
 *
 * Uses BGE-reranker-base via @xenova/transformers for local inference.
 * Singleton model loader keeps the model warm after first load.
 * Gracefully degrades when the model is unavailable.
 *
 * Moved from retrieval/reranker.ts during Phase 1 core extraction.
 */

import type { SearchResult, RerankerConfig } from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────

interface RerankerPipeline {
  (inputs: { text: string; text_pair: string }[], options?: Record<string, unknown>): Promise<
    { label: string; score: number }[][]
  >;
}

// ─── Singleton State ────────────────────────────────────────────

let rerankerPipeline: RerankerPipeline | null = null;
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
    const { pipeline } = await import("@xenova/transformers");
    rerankerPipeline = (await pipeline(
      "text-classification",
      model,
    )) as unknown as RerankerPipeline;
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

  // Build query-candidate pairs for batch inference
  const pairs = candidates.map((c) => ({
    text: query,
    text_pair: c.content,
  }));

  try {
    // Batch inference: all pairs in one forward pass
    const outputs = await rerankerPipeline(pairs);

    // Extract raw scores from model output
    // BGE reranker outputs classification logits; we use the score directly
    const rawScores = outputs.map((output) => {
      // Output is array of {label, score} per pair
      // For rerankers, we want the relevance score
      if (Array.isArray(output) && output.length > 0) {
        return output[0].score;
      }
      return 0;
    });

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
