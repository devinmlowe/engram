# Memory Architectures and Schema Design for AI Assistants

> Research compiled 2026-02-26 for engram Phase 3 (Semantic Extraction)
> Back-reference: [spec.md Phase 3](../../spec.md#phase-3-semantic-extraction)

---

## Executive Summary

This document surveys memory architectures and schemas from production AI assistant systems including MemGPT/Letta, Zep/Graphiti, Mem0, LangMem, OpenAI ChatGPT, Anthropic Claude, and EverMemOS. It covers memory type taxonomies, schema design, importance scoring, retrieval integration, evaluation benchmarks, and production lessons learned.

---

## 1. Memory Type Taxonomies

### 1.1 System-by-System Comparison

**MemGPT / Letta** -- Engineering-focused tiered architecture:

| Layer | Description | Persistence |
|-------|-------------|-------------|
| Message Buffer | Current conversation context | Session-scoped |
| Core Memory | Structured blocks (human, persona, custom) | Persistent, agent-edited |
| Recall Memory | Searchable conversation history | Persistent, auto-indexed |
| Archival Memory | Unlimited long-term storage with vector search | Persistent, agent-managed |

Agents edit their own core memory via tool calls (`memory_replace`, `memory_insert`, `memory_rethink`). Multiple agents can share memory blocks.

Source: [Memory Blocks: The Key to Agentic Context Management](https://www.letta.com/blog/memory-blocks)

**Zep** -- Three-tier temporal knowledge graph:

1. **Episodic Memory** (G_e): Raw events/messages with original timestamps
2. **Semantic Memory** (G_s): Extracted entities and fact-relationships, each embedded in 1024D
3. **Community Memory**: Clusters of connected entities with high-level summaries

Key innovation: **bi-temporal tracking** with four timestamps per edge.

Source: [Zep Paper](https://arxiv.org/html/2501.13956v1)

**Mem0** -- Two variants:

- **Mem0 (flat)**: Atomic facts with embeddings. Operations: ADD, UPDATE, DELETE, NOOP.
- **Mem0g (graph)**: Directed labeled graphs -- entities as nodes, relationships as edges.

Source: [Mem0 Paper](https://arxiv.org/html/2504.19413v1)

**LangMem** -- Most explicit three-type taxonomy:

- **Semantic Memory**: Collections (unbounded facts) or Profiles (bounded structured state)
- **Episodic Memory**: Full-context records of successful interactions
- **Procedural Memory**: Behavioral rules that evolve through feedback

Source: [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

**OpenAI ChatGPT** -- Pragmatic two-layer:

1. **Saved Memories**: Explicit timestamped facts
2. **Chat History Profiles**: Pre-computed summaries injected into system prompt (model usage %, device specs, activity patterns)

Source: [How ChatGPT Remembers You](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)

**Anthropic Claude** -- Deliberately simple file-based:

- Memory stored as Markdown files in `/memories` directory
- Operations: view, create, str_replace, insert, delete, rename
- No embedding-based search, hierarchical precedence

Source: [Exploring Anthropic's Memory Tool](https://www.leoniemonigatti.com/blog/claude-memory-tool.html)

### 1.2 Consensus Categories

The most consistently useful memory categories across all systems:

1. **User facts/preferences** (semantic): Name, role, communication style, technical preferences
2. **Decisions and context** (episodic-semantic hybrid): Past decisions with reasoning, project context
3. **Behavioral rules** (procedural): Learned interaction patterns, response formatting preferences
4. **Relational/entity knowledge** (graph): Connections between entities the user cares about
5. **Temporal state** (working): Currently active projects, recent summaries

---

## 2. Schema Design

### 2.1 Essential Fields (All Production Systems)

| Field | Description | Used By |
|-------|-------------|---------|
| `id` | Unique identifier | All |
| `content` | Natural language fact/memory text | All |
| `memory_type` | Category (fact, preference, decision, etc.) | Mem0, LangMem |
| `embedding` | Vector representation | Mem0, Zep, Supermemory |
| `created_at` | Creation timestamp | All |
| `updated_at` | Last modification | Mem0, Zep |
| `source_id` | Reference to originating conversation | Mem0, Zep |

### 2.2 Highly Valuable Fields

| Field | Description | Used By |
|-------|-------------|---------|
| `importance` | Numeric score (0.0-1.0) | Park et al., EverMemOS |
| `access_count` | Retrieval frequency | LRU-based systems |
| `last_accessed_at` | Most recent retrieval | Decay-based systems |
| `valid_from` / `valid_until` | Temporal validity window | Zep, Supermemory |
| `superseded_by` | ID of replacing memory | Zep, Mem0 |
| `confidence` | Extraction confidence | ChatGPT profiles |
| `tags` | Flexible classification | EverMemOS |

### 2.3 Versioning and Supersession Strategies

**Soft invalidation (Zep)**: Set `t_invalid` on old edge, create new edge. Both remain, preserving full temporal history.

**LLM-driven resolution (Mem0)**: Retrieve top-S similar memories, LLM decides ADD/UPDATE/DELETE/NOOP. Conflicting memories marked invalid, not deleted.

**Dual-layer timestamps (Supermemory)**: `documentDate` (when authored) and `eventDate` (when events occurred). Relationships: State Mutation (contradictions), Refinement (supplements), Inference (derived).

---

## 3. Memory Importance Scoring

### 3.1 Park et al. Foundation (Generative Agents, 2023)

```
retrieval_score = alpha * recency + beta * importance + gamma * relevance
```

**Recency**: `0.995 ^ hours_since_last_access` (exponential decay)

**Importance**: LLM-judged 1-10 scale. Prompt: rate where 1 = mundane (brushing teeth), 10 = extremely significant (breakup, college acceptance).

**Relevance**: Cosine similarity between memory embedding and query embedding.

Source: [Generative Agents (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)

### 3.2 Production Variants

**Weighted combination (Tribe AI, 2025):**
```
final_score = 0.60 * relevance + 0.25 * recency + 0.15 * importance
```
Heavily favors relevance -- most common failure is retrieving important-but-irrelevant memories.

**FadeMem's differential decay:**
- Long-term memory half-life: ~11.25 days at baseline importance
- Short-term memory half-life: ~5.02 days
- Important memories decay slower; trivial memories decay faster

Source: [FadeMem](https://www.co-r-e.com/method/agent-memory-forgetting)

### 3.3 Key Insight

Importance scoring **only at extraction time is insufficient**. Importance must be dynamic, influenced by subsequent access patterns. Memories that keep getting retrieved should gain importance; unused memories should decay.

---

## 4. Memory Retrieval Integration

### 4.1 Multi-Source Fusion with RRF

When combining results from multiple sources (semantic memories, raw conversations, entity graph), **Reciprocal Rank Fusion** is the dominant technique:

```
RRF_score(d) = SUM over retrievers: 1 / (rank_in_retriever + k)
```

Where k = 60. Ignores raw scores (incomparable across methods), focuses on rank positions.

### 4.2 Retrieval Pipeline (Zep's Three-Stage)

1. **Search**: Cosine similarity + BM25 + graph traversal (parallel)
2. **Reranking**: RRF, MMR for diversity, cross-encoder scoring
3. **Construction**: Format selected results with temporal metadata for prompt injection

### 4.3 Integration Patterns

- **Pre-computed injection (ChatGPT)**: Inject relevant memories into system prompt. No retrieval latency.
- **On-demand retrieval (Mem0)**: Retrieve at query time, append to context. More flexible.
- **Structured blocks (Letta)**: Dedicate specific context sections to different memory types with character budgets.

**Recommended**: Tiered approach -- high-priority memories always injected; secondary memories retrieved on demand.

---

## 5. Evaluation Benchmarks

### 5.1 Key Benchmarks

**LoCoMo** (Snap Research, ACL 2024):
- 300-turn conversations, ~9K tokens average
- Question types: single-hop, multi-hop, temporal, commonsense, adversarial
- Gap: Long-context models trail humans by 56% overall

Source: [LoCoMo](https://snap-research.github.io/locomo/)

**LongMemEval** (ICLR 2025):
- 500 questions, 115K-1.5M token histories
- Five competencies: Extraction, Multi-Session Reasoning, Knowledge Updates, Temporal Reasoning, Abstention

**MemBench** (ICLR 2026):
- Incremental multi-turn evaluation
- Five dimensions: extraction, multi-hop, updating, preference following, temporal reasoning

### 5.2 Current SOTA Performance

| System | LoCoMo J-Score | Notes |
|--------|---------------|-------|
| EverMemOS | 83.0% | Best overall |
| Mem0g | 68.44% | Graph-enhanced |
| Mem0 (flat) | ~62% | Flat memory |
| RAG baselines | ~61% | Standard |

---

## 6. Production Lessons and Pitfalls

### 6.1 Chain of Dependencies Problem

"Importance detection must work, retrieval must trigger at the right time, similarity search must surface relevant information, and the LLM must correctly integrate old snippets with new context. If any link breaks, the entire mechanism fails."

**Core issue**: Embeddings measure semantic closeness, not truth. Vector databases cannot understand that one statement replaces another.

Source: [The Problem with AI Agent Memory](https://medium.com/@DanGiannone/the-problem-with-ai-agent-memory-9d47924e7975)

### 6.2 Memory Bloat

As memories accumulate without curation, retrieval quality degrades:
- **Context rot**: More memories = more noise in retrieval
- **Contradictory context**: Old and new versions both retrieved
- **Latency creep**: Larger indexes slow down search
- **Token waste**: Irrelevant memories consume context budget

**Mitigation**: Periodic consolidation, strict importance thresholds, active pruning, hot/cold storage tiers.

### 6.3 Extraction Quality is Everything

Common failures:
- **Over-extraction**: Storing mundane artifacts as "memories"
- **Under-extraction**: Missing implicit important facts
- **Decontextualization**: Facts without sufficient context
- **Hallucinated memories**: LLM fabricates facts not in conversation

### 6.4 Key Design Decisions

1. **Memory formation timing**: Real-time, end-of-session, or background batch?
2. **Supersession strategy**: Soft invalidation, hard delete, or temporal versioning?
3. **Retrieval integration**: Pre-computed injection, on-demand, or hybrid?
4. **Forgetting policy**: Time-based decay, access-based eviction, or manual curation?
5. **Memory granularity**: Atomic facts, paragraph summaries, or structured profiles?
6. **Scope model**: Per-user, per-project, per-conversation, or hierarchical?

---

## 7. Recommendations for engram

### Memory Type Taxonomy

Engram's existing six-type taxonomy aligns well with production consensus:

| Type | Maps To |
|------|---------|
| `preference` | User facts/preferences (Mem0, ChatGPT) |
| `decision` | Decisions with context (LangMem semantic) |
| `pattern` | Behavioral rules (LangMem procedural) |
| `fact` | Ground truth (Mem0, Zep semantic) |
| `solution` | Problem-resolution pairs (unique to engram) |
| `convention` | Project conventions (LangMem procedural) |

This is well-aligned. No changes recommended.

### Importance Scoring Formula

```
retrieval_score = 0.55 * relevance + 0.25 * recency + 0.20 * importance
```

- **Relevance**: Cosine + BM25, fused with RRF
- **Recency**: Exponential decay from `last_accessed`
- **Importance**: LLM-judged at extraction, boosted on access, decayed on staleness

### Supersession

Use soft invalidation with `superseded_by` references. Never physically delete. This preserves temporal query capability.

---

## Sources

1. [Letta Docs: Intro to MemGPT](https://docs.letta.com/concepts/memgpt/)
2. [Memory Blocks (Letta Blog)](https://www.letta.com/blog/memory-blocks)
3. [Zep Paper](https://arxiv.org/html/2501.13956v1)
4. [Mem0 Paper](https://arxiv.org/html/2504.19413v1)
5. [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
6. [How ChatGPT Remembers You](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)
7. [Exploring Anthropic's Memory Tool](https://www.leoniemonigatti.com/blog/claude-memory-tool.html)
8. [Generative Agents (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)
9. [LoCoMo](https://snap-research.github.io/locomo/)
10. [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
11. [MemBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench)
12. [EverMemOS](https://www.arxiv.org/pdf/2601.02163)
13. [Supermemory Research](https://supermemory.ai/research)
14. [The Problem with AI Agent Memory](https://medium.com/@DanGiannone/the-problem-with-ai-agent-memory-9d47924e7975)
15. [FadeMem](https://www.co-r-e.com/method/agent-memory-forgetting)
16. [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564)
17. [Memori: SQL Native Memory Layer](https://github.com/MemoriLabs/Memori)
18. [OpenMemory](https://github.com/CaviraOSS/OpenMemory)
