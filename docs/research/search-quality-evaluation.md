# Search Quality Evaluation: Migration from all-MiniLM-L6-v2 to nomic-embed-text-v1.5

> Research notes for Phase 2 of the engram episodic memory system.
> **Referenced from**: [spec.md (Phase 2)](../../spec.md)
> Covers embedding model characteristics, evaluation methodology, contextual
> embedding techniques, cross-encoder reranking, and hybrid search tuning.

---

## 1. Nomic-embed-text-v1.5 Characteristics

### 1.1 Matryoshka Representation Learning (MRL)

Nomic-embed-text-v1.5 is trained with [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147) (MRL), a technique that explicitly trains the model to produce useful representations at multiple dimensionalities within a single embedding vector. The name references Russian nesting dolls: the first `d` dimensions of a 768-dimensional vector form a valid `d`-dimensional embedding.

**How MRL works:**

During training, the loss function is applied not just on the full 768-dimensional output, but simultaneously on truncated prefixes (e.g., dims 0..64, 0..128, 0..256, 0..512, 0..768). The optimizer learns to "front-load" the most important semantic information into the earliest dimensions. The first dimensions encode coarse, high-level semantics; later dimensions add progressively finer detail.

The practical benefit: you generate embeddings once at 768 dimensions, then truncate to your target dimensionality at query time or indexing time. No need to retrain or run a separate model.

**Truncation procedure (critical for correct usage):**

```typescript
// 1. Generate full 768d embedding from model
// 2. Apply layer normalization over the full vector
// 3. Truncate to desired dimensions (e.g., first 256)
// 4. L2-normalize the truncated vector

// In Python (from official docs):
embeddings = F.layer_norm(embeddings, normalized_shape=(embeddings.shape[1],))
embeddings = embeddings[:, :matryoshka_dim]
embeddings = F.normalize(embeddings, p=2, dim=1)
```

The layer-norm-before-truncation step is essential. Skipping it degrades quality because the raw activations at different positions may have different scales.

### 1.2 Quality at 256d vs 384d vs 768d

**MTEB benchmark scores for nomic-embed-text-v1.5** (from [model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)):

| Dimensionality | MTEB Average | Relative to 768d |
|----------------|-------------|-------------------|
| 768            | 62.28       | baseline          |
| 512            | 61.96       | -0.5%             |
| 256            | 61.04       | -2.0%             |
| 128            | 59.34       | -4.7%             |
| 64             | 56.10       | -9.9%             |

**Key takeaway for our 256d choice:** The 768d-to-256d reduction costs only ~2% on MTEB average. This is a 3x reduction in storage and memory with negligible quality loss. The drop is not linear -- most information is preserved in the first 256 dimensions thanks to MRL training.

**Comparison with all-MiniLM-L6-v2 at 384d:**

| Model                              | Dims | MTEB Avg | Max Seq Len | Params |
|-------------------------------------|------|----------|-------------|--------|
| all-MiniLM-L6-v2                    | 384  | ~56      | 256 tokens  | 22M    |
| nomic-embed-text-v1.5 (768d)        | 768  | 62.28    | 8192 tokens | 137M   |
| nomic-embed-text-v1.5 (256d)        | 256  | 61.04    | 8192 tokens | 137M   |

Even at 256 dimensions, nomic-embed-text-v1.5 scores approximately **5 points higher** on MTEB average than all-MiniLM-L6-v2 at its native 384 dimensions. The migration from 384d MiniLM to 256d Nomic represents both a quality improvement and a storage reduction.

Additional advantages of nomic-embed-text-v1.5:
- **8192 token context window** (vs 256 for MiniLM) -- critical for longer episodic memories
- **Task-specific prefixes** that improve retrieval quality (see below)
- **Fully open source** with reproducible training (Apache 2.0 license)

### 1.3 Task Prefix Requirements

Nomic-embed-text-v1.5 **requires** a task instruction prefix on all input text. Omitting the prefix will degrade quality. The four supported prefixes are:

| Prefix             | Use Case                                      | Example                                               |
|--------------------|-----------------------------------------------|-------------------------------------------------------|
| `search_document:` | Embedding documents/passages for indexing      | `search_document: Meeting with Sarah about Q3 budget` |
| `search_query:`    | Embedding user queries for retrieval           | `search_query: When did I discuss the budget?`        |
| `clustering:`      | Embedding text for clustering tasks            | `clustering: the quick brown fox`                     |
| `classification:`  | Embedding text for classification features     | `classification: the quick brown fox`                 |

**For RAG/retrieval (our use case):**
- At indexing time: prepend `search_document: ` to each chunk before embedding
- At query time: prepend `search_query: ` to the user's query before embedding
- The asymmetric prefixes teach the model that queries and documents have different distributions

**Format details:**
- The prefix is literal text prepended to the input string, separated by a space
- Example: `"search_query: What happened in yesterday's meeting?"`
- There is no special delimiter -- it is simply the prefix followed by a space and then the text
- For semantic similarity (not Q&A), use `search_document:` for both sides

**Important:** If you want to do symmetric semantic similarity search (e.g., finding similar memories to a given memory, not answering a question), encode both sides with `search_document:`.

### 1.4 Retrieval-Specific Performance

On retrieval-specific benchmarks, nomic-embed-text-v1.5 significantly outperforms MiniLM:
- On product retrieval tasks, MiniLM achieved only 56% Top-5 accuracy and 28% Top-1 accuracy, among the lowest scores tested
- Nomic Embed v1 achieved 86.2% Top-5 accuracy on the same benchmark
- On the LoCo (Long Context) benchmark: nomic scores 85.53 vs OpenAI text-embedding-3-small at 82.40

Sources:
- [Nomic Embed v1.5 Model Card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)
- [Nomic Embed Matryoshka Announcement](https://www.nomic.ai/news/nomic-embed-matryoshka)
- [MRL Paper (NeurIPS 2022)](https://arxiv.org/abs/2205.13147)
- [HuggingFace MRL Blog Post](https://huggingface.co/blog/matryoshka)
- [Supermemory Embedding Benchmarks](https://supermemory.ai/blog/best-open-source-embedding-models-benchmarked-and-ranked/)

---

## 2. Evaluation Methodology for Personal Knowledge Bases

### 2.1 Building a Test Query Set from Real Usage

In a personal memory system, ground truth labels are expensive to create and the relevance judgments are inherently subjective. The recommended approach:

**Step 1: Collect representative queries**

Harvest real queries from:
- CLI search history (`engram search` invocations)
- MCP tool calls (search_memories, get_context parameters)
- Manually composed queries that represent typical use patterns

Aim for 30-50 diverse queries covering:
- Factual recall: "When did I last update the database schema?"
- Semantic/conceptual: "discussions about authentication approaches"
- Keyword-heavy: "TypeScript MCP server error handling"
- Temporal: "meetings last week"
- Vague/exploratory: "that conversation about deployment"

**Step 2: Establish relevance judgments**

For each query, manually identify the "correct" or "highly relevant" memories from the corpus. Use a graded relevance scale:

| Score | Label           | Definition                                                  |
|-------|-----------------|-------------------------------------------------------------|
| 3     | Highly relevant  | Directly answers the query; this is what the user wanted    |
| 2     | Relevant         | Contains useful related information                         |
| 1     | Marginally relevant | Tangentially related; might be useful in context          |
| 0     | Not relevant     | Unrelated to the query                                      |

**Step 3: Freeze the test set**

Store the query set and judgments as a JSON fixture:

```json
{
  "queries": [
    {
      "id": "q001",
      "text": "When did I discuss the database migration?",
      "type": "factual_recall",
      "relevant_memories": [
        { "memory_id": "mem_abc123", "relevance": 3 },
        { "memory_id": "mem_def456", "relevance": 2 }
      ]
    }
  ]
}
```

### 2.2 Metrics: MRR@k, NDCG@k, Recall@k

**Recall@k** -- "Did we find all the relevant items in the top k?"

```
Recall@k = |relevant items in top k| / |total relevant items|
```

Best for: measuring completeness. Critical when missing a relevant memory is costly (e.g., forgetting a decision was already made). However, it is not rank-aware -- finding the relevant item at position 1 vs position 5 scores the same.

**MRR@k (Mean Reciprocal Rank)** -- "How quickly do we surface the first relevant result?"

```
MRR = (1/|Q|) * SUM(1/rank_i)  for each query i
```

Best for: single-answer queries where you mainly care about the top result. Simple to compute and interpret. MRR = 1.0 means the correct answer is always rank 1.

**NDCG@k (Normalized Discounted Cumulative Gain)** -- "Are the most relevant items ranked highest?"

```
DCG@k = SUM(relevance_i / log2(i+1))  for i = 1..k
NDCG@k = DCG@k / IDCG@k
```

Best for: graded relevance with multiple relevant items at different importance levels. Rewards putting higher-relevance items at higher ranks. The logarithmic discount means position 1 matters much more than position 5.

**Recommendation for top-5 retrieval in a personal memory system:**

Use **NDCG@5 as the primary metric** because:
- We have graded relevance (some memories are more relevant than others)
- Position matters -- the user sees results in order
- It penalizes systems that bury highly-relevant results at position 4-5

Use **Recall@5 as a secondary metric** to ensure we are not missing important memories entirely.

Use **MRR@5 as a diagnostic** to track first-hit quality (important for single-answer queries like "when did X happen?").

### 2.3 A/B Comparison Methodology

To verify the migration preserved or improved quality:

**Protocol:**

1. **Freeze corpus**: Use the same set of memories for both systems
2. **Run old system**: Execute all test queries against the MiniLM-based search, record ranked results
3. **Run new system**: Execute the same queries against the nomic+FTS5 hybrid search, record ranked results
4. **Compute metrics**: Calculate NDCG@5, Recall@5, MRR@5 for both systems
5. **Statistical comparison**: Use paired t-test or Wilcoxon signed-rank test on per-query NDCG scores

**Implementation pattern:**

```typescript
interface SearchResult {
  memoryId: string;
  rank: number;
  score: number;
}

interface EvalResult {
  queryId: string;
  system: 'old' | 'new';
  results: SearchResult[];
  ndcg5: number;
  recall5: number;
  mrr5: number;
}

// Run both systems on same queries, compare per-query metrics
function compareSystemsAtK(
  oldResults: EvalResult[],
  newResults: EvalResult[],
  k: number
): {
  ndcgDelta: number;      // positive = new is better
  recallDelta: number;
  mrrDelta: number;
  degradedQueries: string[]; // queries where new system was worse
} { ... }
```

**Key: examine the degraded queries.** Even if average metrics improve, investigate every query where the new system scored lower. These are the regressions that users will notice.

### 2.4 Qualitative Evaluation Rubric (No Ground Truth)

When you cannot pre-label every relevant memory, use a lightweight human evaluation:

**Side-by-side comparison rubric:**

For each test query, present the top-5 results from both systems (blinded, random order) and rate:

| Criterion             | Score | Description                                              |
|-----------------------|-------|----------------------------------------------------------|
| Relevance             | 1-5   | How well do the results address the query intent?        |
| Ranking quality       | 1-5   | Are the most relevant results ranked highest?            |
| Coverage              | 1-5   | Do the results cover different aspects of the query?     |
| Surprise value        | 1-5   | Did the system surface useful memories you forgot about? |

**Preference judgment (simpler alternative):**

For each query, show both result sets and ask: "Which set of results is more helpful?" Record:
- System A wins / System B wins / Tie
- Track win rate across all queries; target >= 50% win rate for the new system

**LLM-as-judge approach (scalable):**

Use an LLM to rate relevance of each result to the query on a 0-3 scale. This provides consistency and scales beyond manual review. However, calibrate the LLM judge against a subset of human judgments first to verify alignment.

Sources:
- [Weaviate: Retrieval Evaluation Metrics](https://weaviate.io/blog/retrieval-evaluation-metrics)
- [RAG Evaluation Without Ground Truth](https://medium.com/data-science/how-to-evaluate-rag-if-you-dont-have-ground-truth-data-590697061d89)
- [RAG Metrics for Technical Leaders](https://nirantk.com/writing/rag-metrics-for-technical-leaders/)
- [Evidently AI: RAG Evaluation Guide](https://www.evidentlyai.com/llm-guide/rag-evaluation)

---

## 3. Contextual Embedding Techniques

### 3.1 Anthropic's Contextual Retrieval

[Anthropic's contextual retrieval](https://www.anthropic.com/news/contextual-retrieval) technique addresses a fundamental problem: when documents are split into chunks, each chunk loses the context of the surrounding document. A chunk saying "revenue grew by 3%" is far less useful without knowing which company and which quarter.

**The technique:**

Before embedding or indexing, prepend a short context string to each chunk that situates it within its source document. This context is generated by an LLM that has access to the full document.

**Prompt template (from Anthropic):**

```
<document>
{{WHOLE_DOCUMENT}}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
{{CHUNK_CONTENT}}
</chunk>
Please give a short succinct context to situate this chunk within the
overall document for the purposes of improving search retrieval of the
chunk. Answer only with the succinct context and nothing else.
```

The generated context is typically 50-100 tokens and is prepended to the chunk for both embedding and BM25 indexing.

### 3.2 Performance Impact

Anthropic's internal benchmarks across codebases, scientific papers, and fiction showed:

| Technique                                 | Retrieval Failure Rate | Improvement |
|-------------------------------------------|----------------------|-------------|
| Baseline (standard chunking)              | 5.7%                | --          |
| Contextual Embeddings alone               | 3.7%                | 35%         |
| Contextual Embeddings + Contextual BM25   | 2.9%                | **49%**     |
| Above + Reranking                         | 1.9%                | **67%**     |

The 49% improvement comes from applying contextual prefixes to *both* the embedding index and the BM25/keyword index, then combining with rank fusion.

### 3.3 Applying Contextual Embeddings to Engram

For a personal episodic memory system, we can adapt this technique without needing an LLM call for every memory. Our memories already have rich metadata (conversation source, participants, timestamps, topics). We can construct a deterministic context prefix:

**Recommended metadata prefix format:**

```
[Source: {source}] [Date: {date}] [Participants: {participants}] [Topics: {topics}]
{memory_content}
```

**Example:**

```
[Source: Claude Code conversation] [Date: 2026-02-25] [Participants: user, claude]
[Topics: database migration, embeddings, search quality]
We decided to migrate from all-MiniLM-L6-v2 to nomic-embed-text-v1.5 with 256 dimensions
using Matryoshka truncation. The key reasons were better MTEB scores and longer context window.
```

**Why this works for engram:**

1. **Source attribution**: Helps disambiguate memories from different contexts (Slack conversation vs code session vs meeting notes)
2. **Temporal anchoring**: Dates improve temporal queries ("what did I discuss last week?")
3. **Participant context**: Enables queries like "what did Sarah say about..."
4. **Topic tags**: Provide keyword anchors that benefit BM25 and help vector search

**Important tradeoff:** The metadata prefix consumes tokens from the embedding model's attention. For nomic-embed-text-v1.5 with its 8192 token window, a 50-100 token prefix is negligible. For MiniLM's 256 token limit, this would have been problematic -- another reason the migration helps.

**Cost consideration:** Unlike Anthropic's approach (which calls Claude Haiku per chunk at ~$1.02/million tokens), our deterministic prefix is free. For higher-quality contextual embeddings, you could optionally use an LLM to generate richer context for memories that lack good metadata, but this is not necessary for the initial implementation.

Sources:
- [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [DataCamp: Contextual Retrieval Guide](https://www.datacamp.com/tutorial/contextual-retrieval-anthropic)
- [Voyage AI: Contextualized Chunk Embeddings](https://docs.voyageai.com/docs/contextualized-chunk-embeddings)

---

## 4. Cross-Encoder Reranking

### 4.1 How Cross-Encoder Reranking Works

Bi-encoders (like nomic-embed-text-v1.5) encode queries and documents independently, then compare via cosine similarity. This is fast but loses cross-attention between query and document tokens.

Cross-encoders take the query and document as a single concatenated input and output a relevance score using full transformer attention. This is more accurate but requires a forward pass per (query, document) pair -- O(n) passes for n candidates vs O(1) for bi-encoder lookup.

**The retrieve-then-rerank pattern:**
1. Bi-encoder retrieves top-K candidates (fast, O(1) per query)
2. Cross-encoder reranks those K candidates (accurate, O(K) forward passes)
3. Return top-k from reranked list

### 4.2 Available Models in transformers.js / @huggingface/transformers

The following reranker models are available as ONNX for use in JavaScript/TypeScript:

| Model                                | Params | ONNX Available | Notes                           |
|--------------------------------------|--------|----------------|----------------------------------|
| `Xenova/bge-reranker-base`           | 278M   | Yes            | Good balance of speed/quality    |
| `Xenova/bge-reranker-large`          | 560M   | Yes            | Higher quality, slower           |
| `mogolloni/bge-reranker-v2-m3-onnx`  | 568M   | Yes (pre-converted) | Multilingual, latest BGE     |
| `Xenova/ms-marco-MiniLM-L-6-v2`     | 22M    | Yes            | Fastest, lower quality           |
| `jinaai/jina-reranker-v1-tiny-en`    | ~33M   | Yes            | Very fast, English only          |
| `jinaai/jina-reranker-v1-turbo-en`   | ~138M  | Yes            | Good speed/quality balance       |

**Recommendation for engram:** Start with `Xenova/bge-reranker-base` (278M params). It offers strong reranking quality while being small enough for local inference. If latency is too high, fall back to `Xenova/ms-marco-MiniLM-L-6-v2`.

### 4.3 Latency on Apple Silicon

Specific Apple Silicon benchmarks for these models are sparse in public literature. General guidance:

- **bge-reranker-base (278M)**: Expect ~50-150ms for 10-20 candidates on M-series chips via ONNX Runtime. The model performs 278M parameter forward passes per candidate pair, but ONNX Runtime leverages Apple's ANE (Apple Neural Engine) and Metal for acceleration.
- **Int8 quantized models**: ONNX int8 quantization can reduce latency by 50-60% (one benchmark showed 20-30s dropping to 8-15s on CPU for large batches; for 10-20 candidates the absolute numbers are much smaller).
- **Batch processing**: Pass all (query, candidate) pairs in a single batch rather than sequential calls. This amortizes model loading overhead.

**Practical latency budget:** For a CLI/MCP tool returning 5 results, total search time should stay under 500ms. If bi-encoder retrieval takes ~50ms and RRF fusion takes ~5ms, that leaves ~445ms for optional reranking of 20 candidates -- well within budget for bge-reranker-base on Apple Silicon.

### 4.4 Is Reranking Worth It?

For 10-20 candidate results in a personal memory system:

**Arguments for reranking:**
- Cross-encoders consistently improve NDCG@5 by 5-15% over bi-encoder alone
- Anthropic's results show reranking adds another 18% improvement on top of contextual hybrid search (from 49% to 67% failure rate reduction)
- With only 10-20 candidates, the latency overhead is small (tens to low hundreds of ms)
- Personal memories often have subtle relevance distinctions that cross-attention captures better

**Arguments against:**
- Adds model loading time on first query (~1-3 seconds for cold start)
- Adds ~278MB to memory footprint
- Increases implementation complexity
- For a personal system with <100K memories, the bi-encoder + hybrid search may already be sufficient

**Recommendation:** Implement reranking as an optional layer that can be toggled. Default to OFF for the initial migration (to isolate variables), then enable and measure the quality impact. If NDCG@5 improves by >3% on the test set, keep it on.

### 4.5 TypeScript Implementation Pattern

```typescript
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
} from '@huggingface/transformers';

// Types
interface RerankCandidate {
  id: string;
  text: string;
  originalScore: number;
}

interface RerankResult {
  id: string;
  text: string;
  originalScore: number;
  rerankerScore: number;
}

// Singleton model loader (avoid repeated cold starts)
let _rerankerModel: any = null;
let _rerankerTokenizer: any = null;

async function getReranker() {
  if (!_rerankerModel) {
    const modelId = 'Xenova/bge-reranker-base';
    _rerankerTokenizer = await AutoTokenizer.from_pretrained(modelId);
    _rerankerModel = await AutoModelForSequenceClassification.from_pretrained(
      modelId,
      { quantized: false }
    );
  }
  return { model: _rerankerModel, tokenizer: _rerankerTokenizer };
}

async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
  topK: number = 5
): Promise<RerankResult[]> {
  const { model, tokenizer } = await getReranker();

  // Build parallel arrays for batch tokenization
  const queries = candidates.map(() => query);
  const passages = candidates.map((c) => c.text);

  // Tokenize all pairs in one call
  const inputs = tokenizer(queries, {
    text_pair: passages,
    padding: true,
    truncation: true,
  });

  // Run model inference (single batch forward pass)
  const { logits } = await model(inputs);
  const scores: number[] = Array.from(logits.data);

  // Combine scores with candidates and sort
  const results: RerankResult[] = candidates.map((c, i) => ({
    ...c,
    rerankerScore: scores[i],
  }));

  results.sort((a, b) => b.rerankerScore - a.rerankerScore);
  return results.slice(0, topK);
}
```

Sources:
- [Xenova/bge-reranker-base on Hugging Face](https://huggingface.co/Xenova/bge-reranker-base)
- [Xenova/bge-reranker-base Discussion: Usage](https://huggingface.co/Xenova/bge-reranker-base/discussions/1)
- [BGE Reranker Documentation](https://bge-model.com/tutorial/5_Reranking/5.1.html)
- [mogolloni/bge-reranker-v2-m3-onnx](https://huggingface.co/mogolloni/bge-reranker-v2-m3-onnx)

---

## 5. Hybrid Search Tuning

### 5.1 Reciprocal Rank Fusion (RRF)

RRF combines ranked lists from multiple retrieval systems into a single list. The score for each document is:

```
RRF_score(d) = SUM( 1 / (k + rank_s(d)) )  for each system s
```

Where `rank_s(d)` is the rank of document `d` in system `s`, and `k` is a smoothing constant.

**Why RRF is ideal for our use case:**
- Score-agnostic: BM25 scores and cosine similarities are on different scales; RRF only uses ranks
- Simple to implement: no normalization or calibration needed
- Rewards consensus: documents ranked highly by both systems get the highest fused scores
- Well-studied: the original paper and subsequent work consistently show it matches or beats more complex fusion methods

### 5.2 RRF k Parameter Sensitivity

The `k` parameter controls how much the rank position affects the fused score:

| k value | Behavior                                                     | Use case                          |
|---------|--------------------------------------------------------------|-----------------------------------|
| 1       | Extremely top-heavy; rank 1 dominates. Score ratio between rank 1 and rank 2 is 1.5x | When you trust top results strongly |
| 20      | Moderate top-heaviness; still rewards top ranks but less aggressively | When one system is much better |
| 60      | Standard; smooth decay. Score ratio between rank 1 and rank 2 is ~1.02x | **Default recommendation**        |
| 100+    | Very flat; consensus-oriented. Even low-ranked results contribute meaningfully | When you want broad agreement     |

**Score ratio examples at k=60:**
- Rank 1: 1/(60+1) = 0.01639
- Rank 2: 1/(60+2) = 0.01613
- Rank 10: 1/(60+10) = 0.01429
- Rank 50: 1/(60+50) = 0.00909

The difference between rank 1 and rank 2 is only ~1.6%, which means a document must be ranked highly by *both* systems to dominate. This is the desired behavior for hybrid search where each system has different strengths.

**Recommendation:** Start with `k=60` (the empirically validated default from the original Cormack et al. paper). Only tune if evaluation shows one retrieval system consistently outperforming the other, in which case lower `k` values (20-40) can give more weight to top-ranked results from the stronger system.

### 5.3 When Vector Search Wins vs When BM25 Wins

Understanding the strengths of each system helps diagnose fusion problems:

**BM25/keyword search wins when:**
- Query contains specific names, identifiers, or technical terms ("TypeScript", "MCP server", "bge-reranker-base")
- Query uses exact phrases that appear in the content
- Content has domain-specific jargon that the embedding model may not distinguish well
- Query is short and keyword-centric ("database schema migration")
- Rare terms are important (BM25's IDF component boosts rare, distinctive words)

**Vector/semantic search wins when:**
- Query is conceptual or paraphrased ("discussions about making the system faster" matching content about "performance optimization")
- Synonyms or related concepts matter ("authentication" matching "login", "credentials", "OAuth")
- Query is a natural language question ("what did we decide about the deployment strategy?")
- Content was expressed differently than the query (different vocabulary, same meaning)
- Query is vague or exploratory ("that thing about error handling")

**Both contribute (hybrid excels) when:**
- Query mixes specific terms with conceptual intent ("TypeScript embedding migration approach")
- Some relevant documents match keywords while others match semantics
- Temporal queries where dates are keywords but intent is semantic

**Empirical caveat:** One benchmark study found pure vector search achieved 84% category precision vs 78% for hybrid on academic papers, noting that BM25 introduced false positives from keyword coincidence. This underscores the importance of tuning rather than blindly assuming hybrid is always better. Measure on your data.

### 5.4 Optimal Fetch-K (Candidates per Source)

The fetch-K parameter determines how many candidates each retrieval system contributes before fusion. This is distinct from the final top-k returned to the user.

**Guidance:**

| Final top-k | Recommended fetch-K per source | Rationale                                     |
|-------------|-------------------------------|-----------------------------------------------|
| 5           | 15-20                         | 3-4x oversampling ensures fusion has enough signal |
| 10          | 25-40                         | More candidates = better fusion quality        |
| 20          | 50-75                         | Diminishing returns above 3-4x                 |

**For engram (top-5 retrieval):**
- Fetch 20 candidates from vector search
- Fetch 20 candidates from FTS5/BM25
- Apply RRF fusion
- Return top 5

**Why 20 per source for top-5:**
- Ensures documents ranked 5-20 by one system can still surface if the other system ranks them highly
- With 20+20=40 candidates and possible overlap, RRF has enough data to make meaningful fusion decisions
- Beyond ~20 per source, additional candidates rarely change the top-5 (diminishing returns)
- 20 candidates is cheap -- both vector search and FTS5 can return 20 results in single-digit milliseconds

**If reranking is enabled:**
- Fetch 20 per source (40 total, ~25-35 unique after dedup)
- Apply RRF fusion to get fused ranking
- Take top 20 from fused list
- Rerank those 20 with cross-encoder
- Return top 5

### 5.5 Weighted RRF Variant

Standard RRF weights all systems equally. If evaluation reveals one system consistently outperforms, use weighted RRF:

```
wRRF_score(d) = SUM( w_s / (k + rank_s(d)) )  for each system s
```

Where `w_s` is the weight for system `s`.

**Starting weights:**
- `w_vector = 1.0` (semantic search is the primary system)
- `w_bm25 = 1.0` (start equal, adjust based on evaluation)

If evaluation shows BM25 adding noise for conceptual queries, reduce to `w_bm25 = 0.7`. If BM25 is critical for keyword queries, keep at 1.0 or increase. The evaluation framework from Section 2 will guide this tuning.

Sources:
- [OpenSearch: Introducing RRF for Hybrid Search](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/)
- [Azure AI Search: Hybrid Search Scoring (RRF)](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking)
- [Weaviate: Hybrid Search Explained](https://weaviate.io/blog/hybrid-search-explained)
- [ParadeDB: What is RRF?](https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion)
- [Elastic: Comprehensive Hybrid Search Guide](https://www.elastic.co/what-is/hybrid-search)

---

## 6. Summary of Recommendations for Phase 2 Migration

| Decision Point                        | Recommendation                          | Confidence |
|---------------------------------------|----------------------------------------|------------|
| Target embedding dimensions           | 256d (via Matryoshka truncation)        | High       |
| Expected quality vs old system        | +5 MTEB points even at 256d vs MiniLM 384d | High    |
| Task prefixes                         | `search_document:` at index time, `search_query:` at query time | Required |
| Metadata context prefix               | Deterministic `[Source][Date][Topics]` format | Medium |
| Primary evaluation metric             | NDCG@5                                  | High       |
| RRF k parameter                       | k=60 (default, tune only if needed)     | High       |
| Fetch-K per retrieval source          | 20 candidates each                      | Medium     |
| Cross-encoder reranking               | Implement but default OFF; enable after baseline evaluation | Medium |
| Reranker model                        | Xenova/bge-reranker-base (278M)         | Medium     |
| Test query set size                   | 30-50 diverse queries                   | Medium     |

### Migration Verification Checklist

1. [ ] Create test query set (30-50 queries with graded relevance judgments)
2. [ ] Run baseline metrics against old system (MiniLM + simple vector search)
3. [ ] Run new system metrics (nomic 256d + FTS5 hybrid + RRF k=60)
4. [ ] Compare NDCG@5, Recall@5, MRR@5 -- new system should be >= old on all
5. [ ] Examine every query where new system degraded -- understand why
6. [ ] Optional: Enable reranking, measure incremental improvement
7. [ ] Optional: Add metadata context prefixes, measure incremental improvement
8. [ ] Tune RRF weights based on query-type analysis
