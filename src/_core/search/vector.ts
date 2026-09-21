/**
 * Vector similarity helpers shared by the consolidator, the cross-batch
 * collapse, the commitments dedupe and every sqlite-vec neighbour scorer.
 */

/** Cosine similarity over the shared prefix of two vectors; 0 when either is all zeros. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** sqlite-vec L2 distance between unit vectors → cosine similarity (1 - d²/2). */
export function l2ToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}
