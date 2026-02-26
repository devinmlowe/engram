# Score Normalization Strategies for Hybrid Search

> Research notes for Engram Phase 2 -- compiled 2026-02-26
> **Referenced from**: [spec.md (Phase 2)](../../spec.md) | [score-normalization.md](../score-normalization.md)
>
> **Problem**: Raw RRF fusion scores are 2-3% (mathematically correct but unintuitive).
> Vector-only mode shows 55-100%. We need normalized scores that are intuitive,
> consistent across search modes, and extensible to Phase 3+ multi-source retrieval.

---

## Table of Contents

1. [Background: Why RRF Scores Are Small](#1-background-why-rrf-scores-are-small)
2. [Strategy 1: Min-Max Normalization](#2-strategy-1-min-max-normalization)
3. [Strategy 2: CombSUM and CombMNZ](#3-strategy-2-combsum-and-combmnz)
4. [Strategy 3: Percentile-Based Normalization](#4-strategy-3-percentile-based-normalization)
5. [Strategy 4: Sigmoid / Logistic Scaling](#5-strategy-4-sigmoid--logistic-scaling)
6. [Strategy 5: Relative Score Fusion (RSF)](#6-strategy-5-relative-score-fusion-rsf)
7. [Production Systems Survey](#7-production-systems-survey)
8. [Cross-Source Score Comparability](#8-cross-source-score-comparability)
9. [Recommendation for Engram](#9-recommendation-for-engram)
10. [References](#10-references)

---

## 1. Background: Why RRF Scores Are Small

Reciprocal Rank Fusion computes:

```
score(d) = SUM_i  1 / (k + rank_i(d))
```

With k=60 (our current setting) and a document ranked #1 in both vector and FTS lists:

```
score = 1/(60+1) + 1/(60+1) = 0.01639 + 0.01639 = 0.03279  -->  ~3.3%
```

The theoretical maximum for two-list RRF with k=60 is `2/61 = 0.03279`. The theoretical
minimum for a document appearing in only one list at rank N is `1/(60+N)`. This means:

- **Top result**: ~3.3%
- **Result at rank 10 in one list only**: ~1.4%
- **Score range**: extremely compressed (1.4% to 3.3%)

The scores are correct for **ranking** but useless for **human interpretation** or
**threshold-based filtering**. Users and downstream consumers (like an LLM reading the
results) expect scores closer to 0-100% where higher means "more relevant."

---

## 2. Strategy 1: Min-Max Normalization

### How It Works

Rescale scores within the current result set to [0, 1]:

```
normalized = (score - min_score) / (max_score - min_score)
```

The top result gets 1.0 (100%), the bottom gets 0.0 (0%), and everything else spreads
linearly between them.

### Implementation

```typescript
interface ScoredResult {
  id: string;
  score: number;
}

function normalizeMinMax(results: ScoredResult[]): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    // Single result: assign a high but not perfect score
    // to indicate "we found something but can't compare"
    results[0].score = 0.85;
    return;
  }

  const max = results[0].score;  // assumes pre-sorted descending
  const min = results[results.length - 1].score;
  const range = max - min;

  if (range === 0) {
    // All scores identical: assign uniform mid-range score
    for (const r of results) {
      r.score = 0.5;
    }
    return;
  }

  for (const r of results) {
    r.score = (r.score - min) / range;
  }
}
```

### Edge Cases

| Scenario | Problem | Mitigation |
|----------|---------|------------|
| Single result | Division by zero (max === min) | Assign fixed score (0.85 or configurable) |
| All same score | Division by zero | Assign uniform score (0.5) |
| Outlier top result | Compresses all other scores near 0 | Consider trimmed min-max or percentile |
| Different query difficulties | "Easy" and "hard" queries both produce 0-1 range | Scores not comparable across queries |
| Bottom result always 0% | A relevant but lower-ranked result shows 0% | Apply floor (e.g., `floor + (1-floor) * normalized`) |

### Pros

- Dead simple to implement
- Always produces intuitive 0-1 range
- Preserves relative ordering perfectly
- No calibration data or training needed
- Used by Vespa (`normalize_linear`), Elasticsearch (linear retriever), OpenSearch

### Cons

- Scores are **relative** to the current result set, not absolute
- A mediocre top result still gets 100%
- Cannot compare scores across different queries
- Sensitive to outliers at the extremes
- Bottom result always gets 0%, which feels harsh even if it's somewhat relevant

### Variant: Floored Min-Max

Apply a minimum floor so even the worst result in a good set gets a meaningful score:

```typescript
function normalizeMinMaxFloored(
  results: ScoredResult[],
  floor: number = 0.1,
): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0].score = 0.85;
    return;
  }

  const max = results[0].score;
  const min = results[results.length - 1].score;
  const range = max - min;

  if (range === 0) {
    for (const r of results) r.score = 0.5;
    return;
  }

  for (const r of results) {
    r.score = floor + (1 - floor) * ((r.score - min) / range);
  }
}
```

This maps scores to [floor, 1.0] instead of [0, 1.0].

---

## 3. Strategy 2: CombSUM and CombMNZ

CombSUM and CombMNZ are **alternative fusion methods** to RRF. Instead of using
rank positions, they work with the actual retrieval scores -- but require those scores
to be normalized first.

### CombSUM

Sum the normalized scores from each retrieval system:

```
CombSUM(d) = SUM_i  norm_score_i(d)
```

If document d appears in both vector and FTS results:
```
CombSUM(d) = norm_vector_score(d) + norm_fts_score(d)
```

If it appears in only one list, the missing score is 0.

### CombMNZ

Like CombSUM, but multiplied by the number of lists the document appears in:

```
CombMNZ(d) = |lists containing d| * SUM_i  norm_score_i(d)
```

This gives a **bonus for appearing in multiple retrieval systems**, which is a strong
relevance signal. A document found by both vector and keyword search gets 2x boost.

### Implementation

```typescript
interface RawScoredItem {
  id: string;
  score: number;
}

/**
 * Normalize a single list's scores to [0, 1] using min-max.
 */
function normalizeList(items: RawScoredItem[]): Map<string, number> {
  const map = new Map<string, number>();
  if (items.length === 0) return map;

  const max = Math.max(...items.map(i => i.score));
  const min = Math.min(...items.map(i => i.score));
  const range = max - min || 1;

  for (const item of items) {
    map.set(item.id, (item.score - min) / range);
  }
  return map;
}

/**
 * CombSUM fusion: sum normalized scores across lists.
 * Returns scores in range [0, N] where N = number of lists.
 */
function combSUM(
  vectorResults: RawScoredItem[],
  ftsResults: RawScoredItem[],
): ScoredResult[] {
  const vecScores = normalizeList(vectorResults);
  const ftsScores = normalizeList(ftsResults);

  const allIds = new Set([...vecScores.keys(), ...ftsScores.keys()]);
  const combined: ScoredResult[] = [];

  for (const id of allIds) {
    const score = (vecScores.get(id) ?? 0) + (ftsScores.get(id) ?? 0);
    combined.push({ id, score });
  }

  return combined.sort((a, b) => b.score - a.score);
}

/**
 * CombMNZ fusion: sum normalized scores * number of lists containing doc.
 * Returns scores in range [0, N^2].
 */
function combMNZ(
  vectorResults: RawScoredItem[],
  ftsResults: RawScoredItem[],
): ScoredResult[] {
  const vecScores = normalizeList(vectorResults);
  const ftsScores = normalizeList(ftsResults);

  const allIds = new Set([...vecScores.keys(), ...ftsScores.keys()]);
  const combined: ScoredResult[] = [];

  for (const id of allIds) {
    const vecScore = vecScores.get(id) ?? 0;
    const ftsScore = ftsScores.get(id) ?? 0;
    const listCount = (vecScore > 0 ? 1 : 0) + (ftsScore > 0 ? 1 : 0);
    const score = listCount * (vecScore + ftsScore);
    combined.push({ id, score });
  }

  return combined.sort((a, b) => b.score - a.score);
}
```

### Score Ranges

With two retrieval lists:
- **CombSUM**: [0, 2.0] -- a document scoring 1.0 in both lists gets 2.0
- **CombMNZ**: [0, 4.0] -- same document gets 2 * 2.0 = 4.0

These are **much more spread out** than RRF's [0, 0.033] range but still need a final
normalization pass to get to [0, 1].

### Comparison with RRF

| Property | RRF | CombSUM/CombMNZ |
|----------|-----|-----------------|
| Input required | Rank positions only | Actual retrieval scores |
| Normalization needed | No (rank-based) | Yes (scores must be comparable) |
| Sensitivity to score quality | None (ignores scores) | High (garbage scores in, garbage out) |
| Outlier resistance | Excellent | Poor (inherits from raw scores) |
| Score spread | Very compressed | Naturally wider |
| Research consensus | Outperforms CombSUM/CombMNZ in most benchmarks | Slightly worse on average |
| Implementation complexity | Simple | Moderate (need per-list normalization) |

### Verdict for Engram

**Not recommended as a replacement for RRF.** Research (Cormack et al. 2009) shows RRF
consistently outperforms CombSUM and CombMNZ. However, the CombSUM/CombMNZ scoring
approach (normalize-then-sum) is worth considering as a **display score** computed
alongside RRF ranking. We could:

1. Rank documents using RRF (proven ranking quality)
2. Compute a CombSUM-style display score for presentation

This is essentially what "Relative Score Fusion" does (see Strategy 5).

---

## 4. Strategy 3: Percentile-Based Normalization

### How It Works

Map each result's position to a percentile rank within the result set:

```
percentile(d) = (rank(d) - 1) / (total_results - 1)  // 0 = top, 1 = bottom

// Inverted for "higher is better":
score(d) = 1 - (rank(d) - 1) / (total_results - 1)
```

This is essentially what our current vector-only mode does:
```typescript
scoreMap = new Map(items.map(r => [r.id, 1 - (r.rank - 1) / maxRank]));
```

### Implementation

```typescript
function normalizePercentile(results: ScoredResult[]): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0].score = 1.0;
    return;
  }

  const n = results.length;
  // Assumes results are pre-sorted by score descending
  for (let i = 0; i < n; i++) {
    results[i].score = 1 - i / (n - 1);
  }
}
```

### Properties

- Top result always gets 1.0 (100%)
- Bottom result always gets 0.0 (0%)
- Results are **uniformly distributed** between 0 and 1
- Completely ignores actual score values -- only rank matters

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Single result | Gets 1.0 (100%) |
| All same score | Linear spread from 100% to 0% (arbitrary but consistent) |
| Very close scores | Still spreads them uniformly -- may exaggerate differences |
| Very different scores | Compresses them uniformly -- may hide large gaps |

### Pros

- Always produces clean, intuitive spread
- No edge cases with division by zero (handled simply)
- Completely invariant to the input score distribution
- Easy for users and LLMs to interpret

### Cons

- Destroys all information about score magnitude
- Two adjacent results always appear equally spaced even if one is vastly more
  relevant than the other
- Like min-max, not comparable across queries
- A set of 10 poor results still shows the top one at 100%

### When to Use

Percentile normalization is best when:
- You only care about **relative ordering** (not magnitude)
- The score distribution is unpredictable or multi-modal
- You want guaranteed visual spread in a UI

It is a poor choice when:
- You need scores that indicate **absolute relevance quality**
- You want to set meaningful thresholds (e.g., "only show results above 70%")

---

## 5. Strategy 4: Sigmoid / Logistic Scaling

### Concept

Apply a sigmoid function to map raw scores to a (0, 1) range with a characteristic
S-curve that compresses extreme values and expands the mid-range:

```
normalized = 1 / (1 + exp(-alpha * (score - mu)))
```

Where:
- `mu` = the score value that maps to 0.5 (the "midpoint")
- `alpha` = steepness of the curve (how rapidly scores transition from 0 to 1)

### Implementation

```typescript
/**
 * Sigmoid normalization with configurable midpoint and steepness.
 */
function normalizeSigmoid(
  results: ScoredResult[],
  mu: number,
  alpha: number,
): void {
  for (const r of results) {
    r.score = 1 / (1 + Math.exp(-alpha * (r.score - mu)));
  }
}

/**
 * Auto-calibrated sigmoid: derive mu and alpha from the result set.
 * mu = median score, alpha chosen so that 95th percentile maps to ~0.9.
 */
function normalizeSigmoidAuto(results: ScoredResult[]): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0].score = 0.85;
    return;
  }

  const scores = results.map(r => r.score).sort((a, b) => a - b);
  const mu = scores[Math.floor(scores.length / 2)]; // median
  const p95 = scores[Math.floor(scores.length * 0.95)];

  // We want sigmoid(p95) ~ 0.9, so:
  // 0.9 = 1 / (1 + exp(-alpha * (p95 - mu)))
  // exp(-alpha * (p95 - mu)) = 1/9
  // alpha = ln(9) / (p95 - mu)
  const diff = p95 - mu;
  const alpha = diff > 0 ? Math.log(9) / diff : 10; // fallback steepness

  for (const r of results) {
    r.score = 1 / (1 + Math.exp(-alpha * (r.score - mu)));
  }
}
```

### Platt Scaling (Calibrated Sigmoid)

Platt scaling is the gold standard for converting classifier scores to calibrated
probabilities. It fits a logistic regression to map raw scores to true relevance
probabilities:

```
P(relevant | score) = 1 / (1 + exp(A * score + B))
```

Where A and B are learned from labeled relevance data (binary judgments of
relevant/not-relevant on a held-out set).

**Pros**: Produces genuinely calibrated probabilities that are meaningful across
queries. A score of 0.8 actually means "80% chance this is relevant."

**Cons**: Requires **labeled relevance data** to train. We do not currently have
relevance judgments for Engram queries, making this impractical for Phase 2.

### Bayesian BM25 Approach

The [Bayesian BM25](https://github.com/cognica-io/bayesian-bm25) project demonstrates
converting raw BM25 scores to calibrated probabilities using:

1. A **sigmoid likelihood model** to convert unbounded BM25 scores
2. A **composite Bayesian prior** using term frequency and document length
3. A **corpus-level base rate** that improves calibration without relevance labels

This achieves 68-77% reduction in calibration error. Applicable to our FTS5 scores
but not directly to fused RRF scores.

### Practical Parameters for RRF Scores

For Engram's two-list RRF with k=60:
- Raw score range: approximately [0.014, 0.033]
- Median score for a typical 10-result set: ~0.022
- Reasonable alpha: ~200 (steep, since the range is very narrow)
- Reasonable mu: 0.020

```typescript
// Hard-coded parameters for Engram's specific RRF configuration
const ENGRAM_RRF_MU = 0.020;
const ENGRAM_RRF_ALPHA = 200;

function normalizeRRFSigmoid(results: ScoredResult[]): void {
  normalizeSigmoid(results, ENGRAM_RRF_MU, ENGRAM_RRF_ALPHA);
}
```

### Pros

- Smooth, continuous mapping
- Can incorporate domain knowledge (choose mu and alpha intentionally)
- Compresses outliers gracefully
- With calibration data, produces genuine probabilities

### Cons

- Requires choosing or learning parameters
- Without calibration data, parameter choice is somewhat arbitrary
- Hard to explain to users ("we applied a sigmoid")
- Parameters need updating if k or the number of retrieval lists changes
- For very compressed input ranges (like RRF), alpha must be very large, making the
  function essentially a steep step function -- losing the smooth S-curve benefit

---

## 6. Strategy 5: Relative Score Fusion (RSF)

### How It Works

RSF is a **replacement for RRF** (not a post-processing step) that:

1. Independently normalizes each retriever's scores to [0, 1] using min-max
2. Combines them with a weighted sum

```
rsf(d) = alpha * norm_vector(d) + (1 - alpha) * norm_bm25(d)
```

Where `alpha` controls the balance between vector and keyword signals.

This is the **default algorithm in Weaviate v1.24+** and is essentially CombSUM with
min-max pre-normalization and explicit weighting.

### Implementation

```typescript
interface RawResult {
  id: string;
  score: number;  // raw score from retriever
}

/**
 * Relative Score Fusion: normalize each list's scores independently,
 * then combine with weighted sum.
 */
function relativeScoreFusion(
  vectorResults: RawResult[],
  ftsResults: RawResult[],
  alpha: number = 0.5,
): ScoredResult[] {
  // Normalize each list to [0, 1]
  const normVec = normalizeToMap(vectorResults);
  const normFts = normalizeToMap(ftsResults);

  const allIds = new Set([...normVec.keys(), ...normFts.keys()]);
  const combined: ScoredResult[] = [];

  for (const id of allIds) {
    const vecScore = normVec.get(id) ?? 0;
    const ftsScore = normFts.get(id) ?? 0;
    const score = alpha * vecScore + (1 - alpha) * ftsScore;
    combined.push({ id, score });
  }

  return combined.sort((a, b) => b.score - a.score);
}

function normalizeToMap(items: RawResult[]): Map<string, number> {
  const map = new Map<string, number>();
  if (items.length === 0) return map;

  const scores = items.map(i => i.score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min || 1;

  for (const item of items) {
    map.set(item.id, (item.score - min) / range);
  }
  return map;
}
```

### Score Properties

- Output range: [0, 1] (naturally, since it is a weighted sum of [0,1] values)
- Top result from the dominant retriever gets a score near `alpha` or `(1-alpha)`
- A document scoring top in **both** lists gets close to 1.0
- More informative than RRF because it preserves score magnitudes

### Comparison with RRF

Weaviate's internal benchmarks show RSF provides ~6% improvement in recall over ranked
fusion (RRF). The key advantage is that RSF preserves score distribution information
that RRF discards.

However, RSF requires access to **raw retrieval scores**, not just rankings. For
Engram, this means we need:
- Raw cosine distances from sqlite-vec
- Raw BM25 scores from FTS5

Our current implementation discards these and only passes rank positions to `rrfFuse`.

### Changes Required for Engram

To adopt RSF, we would need to:

1. Modify `vectorSearch()` to return `{ id, distance }` instead of `{ id, rank }`
2. Modify `ftsSearch()` to return `{ id, bm25Score }` instead of `{ id, rank }`
3. Convert vector distances to similarity: `similarity = 1 - distance` (for cosine)
4. Apply RSF instead of RRF

This is a moderate refactor of the search pipeline but produces inherently interpretable
scores.

---

## 7. Production Systems Survey

### Elasticsearch

**Two approaches offered:**

1. **RRF Retriever** (default): Standard RRF with k=60. Produces small unintuitive
   scores. Since 8.16, supports **weighted RRF** where each retriever gets a weight
   multiplier: `weight * 1/(rank + k)`.

2. **Linear Retriever** (8.16+): Min-max normalizes each retriever's scores
   independently, then computes weighted sum. This is essentially RSF. Configuration:
   ```json
   {
     "retriever": {
       "linear": {
         "retrievers": [
           { "retriever": {"knn": {...}}, "weight": 5 },
           { "retriever": {"standard": {...}}, "weight": 1.5, "normalizer": "minmax" }
         ]
       }
     }
   }
   ```

**Elasticsearch's trajectory**: Moving toward giving users both options, with the
linear retriever addressing the "unintuitive scores" complaint about RRF.

### OpenSearch

**Normalization processor** in the search pipeline (since 2.10):

- **Min-max normalization**: `(score - min) / (max - min)`
- **L2 normalization**: `score / sqrt(sum(score^2))` -- more outlier-resistant

Combined with score combination techniques:
- **Arithmetic mean**: `(norm_vec + norm_bm25) / 2`
- **Geometric mean**: `sqrt(norm_vec * norm_bm25)`
- **Harmonic mean**: `2 * norm_vec * norm_bm25 / (norm_vec + norm_bm25)`

**OpenSearch's recommendation**: Min-max normalization + arithmetic mean provides the
best results in their BEIR and Amazon ESCI benchmarks.

### Weaviate

**Two fusion algorithms:**

1. **Ranked Fusion** (legacy): Same as RRF with k=60.
2. **Relative Score Fusion** (default since v1.24): Min-max per list, then weighted
   sum with `alpha` parameter. Also supports **AutoCut**, which detects natural score
   clusters and truncates results at the first large gap.

### Vespa

**Three-phase ranking with `normalize_linear`:**

1. First phase: per-node scoring
2. Second phase: per-node reranking
3. **Global phase** (since 8.246): operates on merged results across all nodes.
   Provides `normalize_linear(expression)` which applies min-max normalization.

Usage: `normalize_linear(bm25_sum) + normalize_linear(closeness(embedding))`

This is the most explicit "normalize then combine" approach, letting users write
arbitrary scoring expressions.

### Azure AI Search

Uses RRF for hybrid search with a fixed formula. Normalizes the final RRF scores
to a 0-1 range for display using min-max within the result set. The documentation
acknowledges that raw RRF scores are not intuitive and recommends using the
normalized scores for display purposes.

### Summary Table

| System | Fusion Method | Score Normalization | Output Range |
|--------|--------------|---------------------|--------------|
| Elasticsearch | RRF or Linear | None (RRF) or MinMax (Linear) | Small fracs or [0,1] |
| OpenSearch | Plugin pipeline | MinMax or L2 | [0, 1] |
| Weaviate | RSF (default) | MinMax per list | [0, 1] |
| Vespa | Custom expressions | `normalize_linear` | [0, 1] |
| Azure AI Search | RRF | MinMax post-hoc | [0, 1] |

**Consensus**: Every major production system either uses min-max normalization or is
moving toward it. The question is whether to normalize **before** fusion (RSF approach)
or **after** fusion (post-hoc min-max on RRF scores).

---

## 8. Cross-Source Score Comparability

### The Phase 3+ Challenge

Engram will eventually return results from three sources:

| Source | What it searches | Score basis |
|--------|-----------------|-------------|
| Episodic | Raw conversation exchanges | RRF(vector, BM25) |
| Semantic | Extracted knowledge (memories) | Vector similarity + confidence |
| Graph | Entity relationships | Path weight + structural centrality |

These scores are fundamentally **different things**:
- Episodic: "how similar is the conversation to the query"
- Semantic: "how relevant is this knowledge + how confident are we in it"
- Graph: "how structurally connected is this entity to the query context"

### Approaches

#### Option A: Normalize Per-Source, Then Interleave

Normalize each source's scores to [0, 1] independently, then merge:

```typescript
interface MultiSourceResult {
  id: string;
  source: 'episodic' | 'semantic' | 'graph';
  score: number;       // normalized 0-1 within source
  rawScore: number;    // original score for debugging
}

function mergeMultiSource(
  episodic: MultiSourceResult[],
  semantic: MultiSourceResult[],
  graph: MultiSourceResult[],
  weights: { episodic: number; semantic: number; graph: number },
): MultiSourceResult[] {
  const all = [
    ...episodic.map(r => ({ ...r, score: r.score * weights.episodic })),
    ...semantic.map(r => ({ ...r, score: r.score * weights.semantic })),
    ...graph.map(r => ({ ...r, score: r.score * weights.graph })),
  ];
  return all.sort((a, b) => b.score - a.score);
}
```

**Pros**: Simple, each source is self-contained.
**Cons**: Scores are only meaningful within their source. A 0.9 episodic result
and a 0.9 semantic result are not necessarily equally relevant.

#### Option B: Source-Specific Display with Labels

Do not attempt to make scores comparable. Instead, label each result with its
source and let the consumer interpret:

```xml
<engram_memory query="Fish shell config" tokens_used="800" total_results="5">
  <episodic relevance="92%" date="2026-02-20" project="dotfiles">
    User: How do I configure Fish shell abbreviations?
    Assistant: You can use `abbr -a` to add abbreviations...
  </episodic>
  <semantic relevance="88%" type="preference" confidence="high">
    User prefers Fish shell over Bash for interactive use.
  </semantic>
  <graph relevance="75%" entity="Fish shell" relationship="configured_by">
    Fish shell -> configured_by -> ~/.config/fish/config.fish
  </graph>
</engram_memory>
```

**Pros**: Honest about what each score means. No false precision.
**Cons**: Harder for automated consumers to rank across sources.

#### Option C: RRF Across Sources (Recommended)

Apply RRF **again** at the cross-source level. Each source produces a ranked list,
and we fuse them:

```typescript
function crossSourceFuse(
  episodicRanked: { id: string; rank: number }[],
  semanticRanked: { id: string; rank: number }[],
  graphRanked: { id: string; rank: number }[],
  k: number = 60,
): ScoredResult[] {
  const scores = new Map<string, number>();

  for (const list of [episodicRanked, semanticRanked, graphRanked]) {
    for (const item of list) {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
    }
  }

  const results = Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  // Then normalize for display
  normalizeMinMax(results);
  return results;
}
```

**Pros**: Consistent with our existing approach. RRF handles heterogeneous scores
gracefully. The final min-max normalization produces intuitive display scores.
**Cons**: Adds another RRF layer. May over-smooth score differences between sources.

### How Zep Handles This

Zep (the closest production system to Engram's architecture) searches across
episodic, semantic, and community subgraphs using three parallel methods (cosine,
BM25, BFS). It then applies reranking via RRF or MMR on the combined results. The
specific score normalization is not documented, but the pattern is:

1. Each search method produces its own ranked list
2. Results are aggregated across layers
3. Rerankers (RRF, MMR, cross-encoder) produce the final ordering
4. Scores are implicit in the final ranking

### Recommendation for Engram Phase 3+

**Use Option C (RRF across sources) with min-max normalization for display.** This:
- Keeps the within-source scoring independent (each layer evolves separately)
- Uses a proven fusion method for cross-source ranking
- Produces intuitive display scores via min-max
- Preserves source labels so consumers know what each result is

Additionally, expose the raw per-source scores in metadata for debugging:

```typescript
interface EnrichedSearchResult extends SearchResult {
  rawScore: number;        // original score from the source
  normalizedScore: number; // min-max normalized for display
  sourceRanking: number;   // rank within this source's results
}
```

---

## 9. Recommendation for Engram

### Phase 2: Immediate Fix

**Use min-max normalization with a floor, applied after RRF fusion.**

Rationale:
- Simplest change (< 20 lines of code)
- Matches industry standard (every production system does this)
- No calibration data needed
- Preserves our proven RRF ranking
- Addresses the core UX problem immediately

Implementation:

```typescript
// In searchEpisodic(), after RRF fusion and before fetchExchanges:

function normalizeScores(
  fused: { id: string; score: number }[],
  mode: SearchMode,
): Map<string, number> {
  if (fused.length === 0) return new Map();

  if (fused.length === 1) {
    return new Map([[fused[0].id, 0.85]]);
  }

  const max = fused[0].score;
  const min = fused[fused.length - 1].score;
  const range = max - min;

  if (range === 0) {
    return new Map(fused.map(r => [r.id, 0.5]));
  }

  // Floor of 0.1 so even the last result shows some relevance
  const floor = 0.1;
  return new Map(
    fused.map(r => [
      r.id,
      floor + (1 - floor) * ((r.score - min) / range),
    ]),
  );
}
```

Expected output after this change:
```
search "SQLite WAL mode" -> top results show 100%, 82%, 65%, ...
search "Fish shell configuration" -> top results show 100%, 91%, 78%, ...
```

### Phase 2.5: Consider RSF Migration

If we find that min-max post-normalization is not discriminating enough (e.g., poor
results still show high scores), consider migrating from RRF to RSF:

1. Modify `vectorSearch` to return raw cosine distances
2. Modify `ftsSearch` to return raw BM25 scores
3. Replace `rrfFuse` with `relativeScoreFusion`

This produces inherently interpretable scores without post-processing. Weaviate's
benchmarks show ~6% recall improvement over RRF.

### Phase 3: Cross-Source Fusion

When semantic and graph layers are added:
1. Each layer produces its own ranked results
2. Apply RRF across the three source lists
3. Min-max normalize the final fused scores for display
4. Preserve source labels and raw scores in metadata

### Decision Matrix

| Criterion | Min-Max Post | RSF | Sigmoid | Percentile |
|-----------|-------------|-----|---------|------------|
| Implementation effort | Low | Medium | Medium | Low |
| Score interpretability | Good | Better | Best (if calibrated) | Good |
| Cross-query comparability | No | No | Yes (if calibrated) | No |
| Calibration data needed | No | No | Yes | No |
| Industry adoption | Universal | Weaviate, Elastic | Niche | Rare for search |
| Preserves score magnitude | Partially | Yes | Depends | No |
| **Recommendation** | **Phase 2** | **Phase 2.5** | **Phase 3+** | **Not recommended** |

---

## 10. References

### Academic Papers

- Cormack, G.V., Clarke, C.L.A., & Buettcher, S. (2009). "Reciprocal Rank Fusion
  outperforms Condorcet and Individual Rank Learning Methods." SIGIR '09.
  https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf

- Robertson, S., & Zaragoza, H. (2009). "The Probabilistic Relevance Framework:
  BM25 and Beyond." Foundations and Trends in IR.

- Kuleshov, V. & Ermon, S. (2017). "Not All Relevance Scores are Equal: Efficient
  Uncertainty and Calibration Modeling for Deep Retrieval Models."
  https://arxiv.org/abs/2105.04651

- Rasmussen, P. (2025). "Zep: A Temporal Knowledge Graph Architecture for Agent
  Memory." https://arxiv.org/abs/2501.13956

### Production Documentation

- Elasticsearch Linear Retriever:
  https://www.elastic.co/search-labs/blog/linear-retriever-hybrid-search

- Elasticsearch Weighted RRF:
  https://www.elastic.co/search-labs/blog/weighted-reciprocal-rank-fusion-rrf

- OpenSearch Normalization Processor:
  https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/

- OpenSearch Rank Normalization Overview:
  https://opensearch.org/blog/how-does-the-rank-normalization-work-in-hybrid-search/

- Weaviate Fusion Algorithms:
  https://weaviate.io/blog/hybrid-search-fusion-algorithms

- Weaviate Hybrid Search Documentation:
  https://docs.weaviate.io/weaviate/search/hybrid

- Vespa Phased Ranking:
  https://docs.vespa.ai/en/ranking/phased-ranking.html

- Azure AI Search Hybrid Scoring:
  https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking

- Bayesian BM25:
  https://github.com/cognica-io/bayesian-bm25

### Blog Posts and Tutorials

- MongoDB: Reciprocal Rank Fusion and Relative Score Fusion:
  https://medium.com/mongodb/reciprocal-rank-fusion-and-relative-score-fusion-classic-hybrid-search-techniques-3bf91008b81d

- Glaforge: Understanding RRF in Hybrid Search:
  https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/

- Elasticsearch Hybrid Search Recipes (benchmarked):
  https://softwaredoug.com/blog/2025/03/13/elasticsearch-hybrid-search-strategies

- OpenSearch: Introducing RRF for Hybrid Search:
  https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/
