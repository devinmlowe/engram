# Semantic Deduplication, Conflict Detection, and Memory Consolidation

> Research compiled 2026-02-26 for engram Phase 3 (Semantic Extraction)
> Back-reference: [spec.md Phase 3](../../spec.md#phase-3-semantic-extraction)

---

## Executive Summary

This document surveys the current state of the art for semantic deduplication, contradiction detection, confidence scoring, memory consolidation, and computational forgetting in knowledge systems. These are the core algorithms Phase 3 needs for the deduplication check and conflict detection pipeline.

---

## 1. Semantic Deduplication

### 1.1 Embedding-Based Approaches

The dominant approach uses pre-trained embedding models to represent text as dense vectors, then measures cosine similarity to identify near-duplicates. **SemDeDup** (Abbas et al., ICLR 2024) demonstrated that semantic deduplication can remove 50% of training data with minimal performance loss while actually *improving* out-of-distribution performance.

**How SemDeDup works:**
1. Generate embeddings using a pre-trained model
2. Cluster embeddings into k clusters using k-means
3. Compute pairwise cosine similarities within each cluster
4. Identify pairs above a similarity threshold as semantic duplicates
5. From each duplicate group, keep the most "unique" representative

Sources: [SemDeDup Paper](https://arxiv.org/abs/2303.09540), [NVIDIA NeMo Documentation](https://docs.nvidia.com/nemo-framework/user-guide/25.07/datacuration/semdedup.html)

### 1.2 Cosine Similarity Thresholds in Practice

| Use Case | Threshold | Notes |
|---|---|---|
| Near-exact duplicate detection | 0.95-0.99 | Very strict; catches paraphrases |
| Production entity dedup (KG) | **0.95** | Used by Cognee, FalkorDB |
| Aggressive dataset dedup | 0.90-0.95 | Standard for training data |
| Semantic similarity search | 0.80-0.90 | "Related but not duplicate" |
| Loose topic matching | 0.70-0.80 | Broadly related content |

**Recommended tiered approach for engram:**
- **>= 0.95**: Auto-merge as near-duplicates (bump confidence + access_count)
- **0.85-0.95**: Flag as potential duplicates for LLM-based verification
- **< 0.85**: Treat as distinct entries

### 1.3 Cascading Pipeline (Best Practice)

1. **Stage 1 -- Embedding Similarity (Medium Cost):** Sentence-transformer embeddings + cosine similarity catches semantic duplicates that differ lexically.
2. **Stage 2 -- NLI Classification (Higher Cost):** For ambiguous cases in the 0.85-0.95 range, run NLI to distinguish entailment, contradiction, and neutral.
3. **Stage 3 -- LLM Verification (Expensive):** For the remaining ambiguous cases, ask an LLM to classify: ADD / UPDATE / DELETE / NOOP (Mem0's approach).

Sources: [FutureSearch](https://futuresearch.ai/semantic-deduplication/), [Rise of Semantic Entity Resolution](https://towardsdatascience.com/the-rise-of-semantic-entity-resolution/)

---

## 2. Contradiction and Conflict Detection

### 2.1 NLI for Contradiction Detection

Natural Language Inference (NLI) classifies the relationship between a premise and hypothesis into **entailment**, **contradiction**, or **neutral**. This maps directly to detecting when a new memory contradicts an existing one.

**State-of-the-art models:**

| Model | SNLI | MNLI-mm | Params | Notes |
|---|---|---|---|---|
| cross-encoder/nli-deberta-v3-large | 92.20% | 90.49% | 400M | Highest accuracy |
| cross-encoder/nli-deberta-v3-base | 92.38% | 90.04% | 86M | Good speed/accuracy |
| DeBERTa-v3-base-mnli-fever-anli | -- | High | 86M | Best for fact verification |
| cross-encoder/nli-deberta-v3-xsmall | ~90% | ~88% | 22M | Fast inference |

Sources: [HuggingFace model cards](https://huggingface.co/cross-encoder/nli-deberta-v3-large)

### 2.2 Contradiction Detection Thresholds

- **Contradiction score > 0.7**: High confidence contradiction -- flag for resolution
- **Contradiction score 0.5-0.7**: Possible contradiction -- queue for LLM verification
- **Contradiction score < 0.5**: Likely not contradictory

The NLI approach is particularly well-suited because:
- It can compare any two text statements pairwise
- It distinguishes contradiction from mere difference (neutral)
- Cross-encoder models are fast (~30ms per pair) for pre-filtered candidate sets

Source: [NLI Cross Encoders: 6 Ways to Use Them](https://huggingface.co/blog/dleemiller/nli-xenc-ways-to-use)

### 2.3 Advanced Approaches

**Atomic Fact Decomposition:** Decomposing complex statements into atomic facts before performing NLI. "User prefers Python and dislikes JavaScript" becomes two atomic facts, enabling targeted contradiction detection. ([Atomic-SNLI](https://arxiv.org/html/2601.06528))

**Knowledge Graph Conflict Types:**

1. **Specificity conflicts**: Differences in granularity ("lives in California" vs. "lives in San Francisco")
2. **Contradictory conflicts**: Incompatible assertions ("lives in New York" vs. "lives in London")
3. **Temporal conflicts**: Facts valid in non-overlapping time periods, temporal precedence, mutual exclusion

**Detect-Then-Resolve** (2024): Two-stage LLM-based approach -- first detect conflicts using structured comparison, then resolve using source reliability, temporal recency, and contextual cues. ([MDPI](https://www.mdpi.com/2227-7390/12/15/2318))

---

## 3. Memory Consolidation Algorithms

### 3.1 Complementary Learning Systems (CLS) Theory

The dominant framework from cognitive science (McClelland, McNaughton & O'Reilly, 1995):

**Two systems:**
- **Hippocampus (fast learner)**: Rapidly encodes specific episodes using separated representations. Analogous to episodic/conversation memory.
- **Neocortex (slow learner)**: Gradually extracts general statistical structure. Analogous to consolidated semantic memory.

**Consolidation mechanism**: Memories stored in the hippocampus are "replayed" during offline periods (sleep), causing gradual synaptic changes in the neocortex. Each replay incrementally adjusts neocortical representations.

**Critical insight**: Unregulated memory transfer can cause overfitting. Memories should **only consolidate when it aids generalization** -- not everything should be promoted to long-term memory.

Sources: [CLS Theory Update (Kumaran et al., 2016)](https://www.cnbc.cmu.edu/~tai/nc19journalclubs/KumaranHassabisMcC16CLSUpdate.pdf), [Organizing Memories for Generalization (Nature Neuroscience, 2023)](https://www.nature.com/articles/s41593-023-01382-9)

### 3.2 Computational Memory Operations

The 2025 survey "Rethinking Memory in LLM-based Agents" (Liu et al.) defines six core operations:

1. **Consolidation**: Transform short-term experiences into persistent memory
2. **Updating**: Modify existing memories with new information
3. **Indexing**: Organize for efficient retrieval
4. **Forgetting**: Selectively remove outdated/irrelevant memories
5. **Retrieval**: Access relevant memories for current context
6. **Compression**: Reduce footprint while preserving essentials

Source: [Rethinking Memory in LLM-based Agents](https://arxiv.org/html/2505.00675v1)

### 3.3 A-Mem: Self-Organizing Memory (NeurIPS 2025)

Introduces **agentic memory** inspired by Zettelkasten:
- New memories generate comprehensive notes with contextual descriptions, keywords, and tags
- System analyzes historical memories to identify relevant connections
- **Memory evolution**: New memories trigger updates to existing memories' contextual representations
- The memory network **continuously refines** as new information integrates

Particularly relevant to engram's Zettelkasten-inspired design.

Source: [A-Mem Paper](https://arxiv.org/abs/2502.12110)

---

## 4. Confidence Scoring

### 4.1 Bayesian Confidence Updates

The theoretical gold standard:

```
P(hypothesis | evidence) ∝ P(evidence | hypothesis) * P(hypothesis)
```

- **Prior**: Initial confidence when memory is first extracted
- **Likelihood**: How well new evidence supports or contradicts the memory
- **Posterior**: Updated confidence incorporating new evidence

Each confirmation increases posterior; each contradiction decreases it. Magnitude depends on source reliability.

### 4.2 Temporal Confidence Decay

The **TempValid** model (ACL 2024) treats decay coefficients as **learnable parameters**, applying exponential decay. Key finding: **exponential decay patterns are consistently observed** across many rules and datasets in temporal knowledge graphs.

Source: [TempValid (ACL 2024)](https://aclanthology.org/2024.acl-long.580.pdf)

### 4.3 Recommended Composite Confidence Model

```
confidence(memory, t) = base_confidence
                        * corroboration_factor
                        * temporal_decay(t)
                        * source_reliability

corroboration_factor = min(1.0, 0.5 + 0.1 * num_confirmations)
temporal_decay(t) = exp(-lambda * days_since_last_access)
```

Where:
- `base_confidence`: Initial extraction confidence (0.0-1.0)
- `corroboration_factor`: Starts at 0.5 for single-source, approaches 1.0 with multiple confirmations
- `temporal_decay(t)`: Exponential decay from last access (not creation)
- `source_reliability`: Weight based on conversation context quality

---

## 5. Forgetting and Decay

### 5.1 Ebbinghaus Forgetting Curve

```
R(t) = e^(-t/S)
```

Where R is retrievability, t is time elapsed, S is stability (memory strength). Each successful retrieval increases stability, making the memory decay more slowly.

### 5.2 Power Law vs. Exponential

**Individual memories decay exponentially**, but **aggregate forgetting follows a power law**. The power law emerges from the superposition of exponential decays with different rates. A memory system should model individual items with exponential decay (with per-item stability parameters).

Source: [Power Law of Forgetting](https://memory.psych.upenn.edu/files/pubs/KahaAdle02.pdf)

### 5.3 FSRS Algorithm (State of the Art)

The **Free Spaced Repetition Scheduler** is the most sophisticated open-source forgetting model, now default in Anki, producing **20-30% fewer reviews** for the same retention level.

**Three-component model (DSR):**
- **Difficulty (D)**: How inherently hard the item is (0-10)
- **Stability (S)**: Time in days for retrievability to decay from 100% to 90%
- **Retrievability (R)**: Current probability of recall

**Formula:**
```
R(t) = 0.9^(t/S)
```

**Key principles encoded:**
1. Harder material has slower stability growth
2. Higher stability leads to diminishing returns on stability growth
3. Lower retrievability at access time yields greater stability increase ("desirable difficulty")

Source: [FSRS Algorithm Wiki](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)

### 5.4 Recommended Implementation for engram

```typescript
function retrievability(memory: Memory, now: number): number {
  const daysSinceAccess = (now - memory.lastAccessed) / 86400;
  return Math.pow(0.9, daysSinceAccess / memory.stability);
}

function updateAfterAccess(memory: Memory, wasUseful: boolean): void {
  if (wasUseful) {
    const R = retrievability(memory, Date.now() / 1000);
    const growth = STABILITY_GROWTH * (1 - R); // desirable difficulty
    memory.stability *= (1 + growth);
  } else {
    memory.stability *= FAILURE_PENALTY; // e.g., 0.8
  }
  memory.lastAccessed = Math.floor(Date.now() / 1000);
  memory.accessCount += 1;
}
```

**Design decisions:**
- **Last-accessed time** (not creation time) drives decay
- **Stability grows with use** -- frequently confirmed memories become harder to forget
- **Access count matters** -- memories confirmed by multiple conversations get higher base stability

---

## 6. Recommended Architecture for engram Phase 3

### Deduplication Pipeline
1. Embed new memory with nomic-embed-text-v1.5
2. FAISS/sqlite-vec nearest-neighbor search against existing memories
3. Auto-merge at cosine similarity >= 0.95 (bump confidence via Bayesian update)
4. NLI contradiction check for candidates in 0.80-0.95 range (DeBERTa-v3)
5. LLM verification for ambiguous cases (contradiction score 0.4-0.7)

### Conflict Resolution
1. Temporal recency > explicit correction > corroboration count > source reliability
2. Superseded memories marked (not deleted) with `superseded_by` link
3. Maintain contradiction audit trail in `conflicts` table

### Confidence and Decay
1. Composite confidence: `base * corroboration * temporal_decay * source_reliability`
2. FSRS-inspired decay: `R(t) = 0.9^(t/S)` with per-memory stability
3. Stability increases with each access/confirmation; decreases on contradiction
4. Memories below retrievability threshold (R < 0.1) are candidates for archival

### Consolidation (Periodic, Dream State)
1. Cluster related memories using embedding similarity
2. Generate consolidated summaries for dense clusters
3. Only consolidate when it aids generalization (CLS theory)
4. A-Mem-style linking: new memories trigger re-evaluation of existing memories

---

## Sources

### Papers
- [SemDeDup (ICLR 2024)](https://arxiv.org/abs/2303.09540)
- [Zep/Graphiti (arXiv)](https://arxiv.org/abs/2501.13956)
- [A-Mem (NeurIPS 2025)](https://arxiv.org/abs/2502.12110)
- [Rethinking Memory in LLM-based Agents](https://arxiv.org/html/2505.00675v1)
- [TempValid (ACL 2024)](https://aclanthology.org/2024.acl-long.580.pdf)
- [CLS Theory Update](https://www.cnbc.cmu.edu/~tai/nc19journalclubs/KumaranHassabisMcC16CLSUpdate.pdf)
- [Power Law of Forgetting](https://memory.psych.upenn.edu/files/pubs/KahaAdle02.pdf)
- [Atomic-SNLI](https://arxiv.org/html/2601.06528)
- [Detect-Then-Resolve](https://www.mdpi.com/2227-7390/12/15/2318)
- [Conflict Detection for Temporal KGs](https://arxiv.org/pdf/2312.11053)

### Tools and Libraries
- [FSRS Algorithm](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)
- [SemHash](https://github.com/MinishLab/semhash)
- [NVIDIA NeMo Curator](https://docs.nvidia.com/nemo/curator/latest/curate-text/process-data/deduplication/semdedup.html)
- [cross-encoder/nli-deberta-v3-large](https://huggingface.co/cross-encoder/nli-deberta-v3-large)

### Production References
- [Entity Resolution at Scale (Shereshevsky)](https://medium.com/@shereshevsky/entity-resolution-at-scale-deduplication-strategies-for-knowledge-graph-construction-7499a60a97c3)
- [Bayesian Confidence Updating](https://www.itad.com/article/bayesian-confidence-updating-3-lessons-from-applying-this-technique/)
- [Production KG Systems 2025](https://medium.com/@claudiubranzan/from-llms-to-knowledge-graphs-building-production-ready-graph-systems-in-2025-2b4aff1ec99a)
