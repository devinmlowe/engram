# Score Normalization in Hybrid Search

## Observation (Phase 1 Verification, 2026-02-26)

After indexing 407 conversations (2,192 exchanges) from real Claude Code history and running verification searches, the relevance scores displayed in `recall` output are unintuitive:

```
search "SQLite WAL mode" → top results show 2-3% relevance
search "Fish shell configuration" → top results show 3% relevance
search "embedding model nomic" (vector-only) → 55-100% relevance
```

The results themselves are **correctly ranked** — the most relevant exchanges appear first. The issue is that the raw RRF fusion scores are small fractions that don't map to human expectations of "relevance percentage."

## Root Cause

RRF fusion scores are computed as:

```
score = Σ 1/(k + rank_i)
```

With k=60 and results appearing in both vector and FTS lists, a top-ranked result gets:

```
score = 1/(60+1) + 1/(60+1) ≈ 0.0328  →  3%
```

This is mathematically correct for ranking but misleading when displayed as a percentage. By contrast, vector-only mode uses a linear rank normalization (`1 - (rank-1)/maxRank`) which produces more intuitive 0-100% values.

## Impact

- **Ranking quality**: Not affected. Results are correctly ordered by relevance.
- **User perception**: The low percentages make good results look weak, which could cause users (or Claude) to distrust the recall output or over-search.
- **Cross-mode inconsistency**: Vector-only search shows 55-100%, hybrid shows 2-3% for the same quality of match. This makes the `mode` parameter affect perceived confidence.

## Research Topics for Phase 2

### 1. Score normalization strategies

- **Min-max normalization**: Rescale fused scores to [0, 1] based on the min/max of the current result set. Simple but makes scores relative rather than absolute.
- **Percentile mapping**: Map RRF scores to percentile ranks within the result set. Always produces intuitive spread.
- **Sigmoid scaling**: Apply `1 / (1 + exp(-α(score - μ)))` where μ and α are tuned from empirical score distributions. Requires calibration data.
- **CombSUM / CombMNZ**: Alternative fusion methods that produce naturally larger scores by summing normalized per-list scores rather than reciprocal ranks.

### 2. Calibrating against cosine similarity

The existing episodic-memory plugin reports cosine similarity (1 - distance) as the relevance score. Users expect scores in a similar range. Consider:

- Storing the raw vector distance alongside the fused score
- Using cosine similarity as the primary display score when vector search contributes to the result, with an indicator for FTS-only matches

### 3. Score meaning across layers

Phase 3+ will add semantic and graph results to the `recall` response. The scoring model needs to produce comparable scores across sources (episodic, semantic, graph) or clearly label them as non-comparable.

### 4. Literature

- Robertson et al., "The Probabilistic Relevance Framework: BM25 and Beyond" — BM25 score normalization
- Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods" — original RRF paper, discusses score interpretation
- Anthropic, "Introducing Contextual Retrieval" (2024) — contextual embeddings + BM25 fusion approach

## Recommendation

The simplest fix for Phase 2 is min-max normalization within each result set:

```typescript
function normalizeScores(results: { id: string; score: number }[]): void {
  if (results.length === 0) return;
  const min = results[results.length - 1].score;
  const max = results[0].score;
  const range = max - min || 1;
  for (const r of results) {
    r.score = (r.score - min) / range;
  }
}
```

This preserves ranking while giving the top result 100% and the bottom result 0%. It should be applied after RRF fusion and before token budgeting.
