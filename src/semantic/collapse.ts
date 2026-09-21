/**
 * Intra-batch near-duplicate collapse (W9a).
 *
 * `deduplicateFact` checks each candidate against the memory store one at a
 * time, so candidates that arrive together in one extraction batch (or one
 * dream run) can only dedup against each other once the first is written.
 * These helpers collapse such candidates *before* insertion:
 *
 * - `collapseExact`      — identical normalised content (case, whitespace,
 *                          punctuation folded)
 * - `collapseByEmbedding`— cosine similarity at or above the caller's merge
 *                          threshold (the consolidator passes its own 0.95)
 * - `collapseAcrossBatches` — normalised-content collapse across a dream
 *                          run's per-conversation batches
 *
 * Merging keeps the higher-confidence fact (absent confidence counts as 0.5,
 * ties broken by importance, then first-seen) and unions source exchanges,
 * so nothing about provenance is lost. Pure functions; no DB access.
 */

import type { ExtractedFact } from "./types.js";
import { cosineSimilarity } from "../_core/search/vector.js";

/** Confidence used for ordering when the model did not emit one. */
const DEFAULT_CONFIDENCE = 0.5;

/** Lowercase, strip punctuation/symbols, collapse whitespace. */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Union that preserves first-seen order and drops repeats. */
function unionIds(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of [...a, ...b]) if (!out.includes(id)) out.push(id);
  return out;
}

function prefersFirst(a: ExtractedFact, b: ExtractedFact): boolean {
  const ca = a.confidence ?? DEFAULT_CONFIDENCE;
  const cb = b.confidence ?? DEFAULT_CONFIDENCE;
  if (ca !== cb) return ca > cb;
  if (a.importance !== b.importance) return a.importance > b.importance;
  return true;
}

/**
 * Merge two facts judged to be the same statement. `first` is the earlier
 * occurrence; its source exchanges lead the union.
 */
export function mergeFacts(first: ExtractedFact, second: ExtractedFact): ExtractedFact {
  const winner = prefersFirst(first, second) ? first : second;
  const loser = winner === first ? second : first;
  const merged: ExtractedFact = {
    ...winner,
    sourceExchangeIds: unionIds(first.sourceExchangeIds, second.sourceExchangeIds),
  };
  const context = winner.context ?? loser.context;
  if (context !== undefined) merged.context = context;
  return merged;
}

export interface CollapseResult {
  /** Surviving facts in first-seen order. */
  survivors: ExtractedFact[];
  /** For each input index, the index into `survivors` it collapsed into. */
  memberOf: number[];
}

/** Collapse facts whose normalised content is identical. */
export function collapseExact(facts: readonly ExtractedFact[]): CollapseResult {
  const survivors: ExtractedFact[] = [];
  const memberOf: number[] = [];
  const byKey = new Map<string, number>();

  for (const fact of facts) {
    const key = normalizeContent(fact.content) || fact.content;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, survivors.length);
      memberOf.push(survivors.length);
      survivors.push(fact);
    } else {
      survivors[existing] = mergeFacts(survivors[existing], fact);
      memberOf.push(existing);
    }
  }

  return { survivors, memberOf };
}

export interface EmbeddingCollapseResult extends CollapseResult {
  /** Embedding of each survivor (the winning member's vector). */
  embeddings: number[][];
}

/**
 * Greedy collapse of facts whose embeddings are at least `threshold` cosine
 * similar to an earlier survivor. `embeddings[i]` must correspond to
 * `facts[i]`.
 */
export function collapseByEmbedding(
  facts: readonly ExtractedFact[],
  embeddings: readonly number[][],
  threshold: number,
): EmbeddingCollapseResult {
  if (embeddings.length !== facts.length) {
    throw new Error(
      `collapseByEmbedding: ${facts.length} facts but ${embeddings.length} embeddings`,
    );
  }

  const survivors: ExtractedFact[] = [];
  const survivorEmbeddings: number[][] = [];
  const memberOf: number[] = [];

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const embedding = embeddings[i];
    let target = -1;
    for (let j = 0; j < survivors.length; j++) {
      if (cosineSimilarity(embedding, survivorEmbeddings[j]) >= threshold) {
        target = j;
        break;
      }
    }
    if (target === -1) {
      memberOf.push(survivors.length);
      survivors.push(fact);
      survivorEmbeddings.push(embedding);
    } else {
      if (!prefersFirst(survivors[target], fact)) {
        survivorEmbeddings[target] = embedding;
      }
      survivors[target] = mergeFacts(survivors[target], fact);
      memberOf.push(target);
    }
  }

  return { survivors, memberOf, embeddings: survivorEmbeddings };
}

export interface FactBatch {
  conversationId: string;
  facts: ExtractedFact[];
}

/**
 * Collapse normalised-identical facts across a run's batches. A repeat in a
 * later batch is removed and its source exchanges folded into the first
 * occurrence. Batches keep their order and identity; inputs are not mutated.
 */
export function collapseAcrossBatches<T extends FactBatch>(
  batches: readonly T[],
): { batches: T[]; collapsed: number } {
  const out: T[] = batches.map((batch) => ({ ...batch, facts: [...batch.facts] }));
  const seen = new Map<string, { batch: number; index: number }>();
  const drop: Array<Set<number>> = out.map(() => new Set<number>());
  let collapsed = 0;

  for (let b = 0; b < out.length; b++) {
    for (let f = 0; f < out[b].facts.length; f++) {
      const fact = out[b].facts[f];
      const key = normalizeContent(fact.content) || fact.content;
      const prior = seen.get(key);
      if (prior === undefined) {
        seen.set(key, { batch: b, index: f });
        continue;
      }
      out[prior.batch].facts[prior.index] = mergeFacts(
        out[prior.batch].facts[prior.index],
        fact,
      );
      drop[b].add(f);
      collapsed++;
    }
  }

  for (let b = 0; b < out.length; b++) {
    if (drop[b].size > 0) {
      out[b].facts = out[b].facts.filter((_, i) => !drop[b].has(i));
    }
  }

  return { batches: out, collapsed };
}
