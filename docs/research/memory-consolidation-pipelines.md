# Memory Consolidation and Knowledge Extraction Pipelines

## Research Document for Engram Phase 5: Dream State Daemon

**Date**: 2026-02-26
**Domain**: AI memory systems, knowledge extraction, consolidation pipelines, knowledge graphs
**Scope**: Patterns for background knowledge extraction and consolidation from conversational data, applicable to Engram's dream state daemon

---

## Table of Contents

1. [Memory Consolidation in Cognitive Science and AI](#1-memory-consolidation-in-cognitive-science-and-ai)
2. [Graphiti (Zep) -- Architecture and Pipeline](#2-graphiti-zep----architecture-and-pipeline)
3. [Microsoft GraphRAG -- Knowledge Graph Construction](#3-microsoft-graphrag----knowledge-graph-construction)
4. [MemGPT / Letta -- Memory Management](#4-memgpt--letta----memory-management)
5. [Mem0 -- Scalable Long-Term Memory](#5-mem0----scalable-long-term-memory)
6. [Cognee -- ECL Pipeline](#6-cognee----ecl-pipeline)
7. [Incremental Knowledge Updates](#7-incremental-knowledge-updates)
8. [Memory Decay and Pruning](#8-memory-decay-and-pruning)
9. [Conflict Detection and Resolution](#9-conflict-detection-and-resolution)
10. [Priority Scheduling for Processing](#10-priority-scheduling-for-processing)
11. [Batch vs Streaming Trade-offs](#11-batch-vs-streaming-trade-offs)
12. [Key Takeaways for Engram](#12-key-takeaways-for-engram)

---

## 1. Memory Consolidation in Cognitive Science and AI

### 1.1 Biological Memory Consolidation

The term "dream state daemon" draws directly from neuroscience. Biological memory consolidation involves:

- **Sleep-dependent consolidation**: During sleep (particularly slow-wave sleep and REM), the brain replays and reorganizes memories. Hippocampal traces are transferred to neocortical long-term storage.
- **Synaptic homeostasis**: Sleep downscales synaptic strengths that built up during waking, preserving the strongest connections while pruning weaker ones.
- **Memory reactivation**: Specific memory traces are selectively reactivated and strengthened during sleep, integrating them with existing knowledge.
- **Schema assimilation**: New memories are integrated into existing knowledge schemas, making them more accessible and interconnected.

This biological process maps directly to Engram's dream state daemon:

| Biological Process | Engram Equivalent |
|-------------------|-------------------|
| Memory reactivation during sleep | Processing unprocessed conversations |
| Hippocampal-to-neocortex transfer | Episodic memory to semantic memory extraction |
| Schema assimilation | Entity resolution and knowledge graph integration |
| Synaptic pruning | Confidence decay and memory deduplication |
| REM-driven creative connections | Community detection and cross-conversation linking |

### 1.2 AI Memory System Categories

The 2025 consensus across production AI memory systems identifies three layers:

| Layer | Description | Engram Equivalent |
|-------|-------------|-------------------|
| **Episodic** | Raw event records (conversations, messages) | JSONL parsed conversations |
| **Semantic** | Extracted facts, preferences, entities | Extracted memories + entities |
| **Procedural** | Behavioral rules and learned patterns | Conventions and patterns |

Most production systems implement some form of background consolidation to transform episodic data into semantic and structural knowledge. The approaches differ in timing (real-time vs batch), scope (per-message vs per-conversation), and depth (flat facts vs knowledge graphs).

(Sources: [Zep Paper](https://arxiv.org/html/2501.13956v1), [Survey of AI Agent Memory Frameworks](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks))

---

## 2. Graphiti (Zep) -- Architecture and Pipeline

### 2.1 Overview

Graphiti is the most relevant production system for Engram's design. It is a "real-time, temporally-aware knowledge graph engine that incrementally processes incoming data, instantly updating entities, relationships, and communities without batch recomputation."

Key metrics:
- **94.8% accuracy** on the Deep Memory Retrieval (DMR) benchmark
- **18.5% accuracy improvement** over MemGPT
- **90% latency reduction** compared to batch GraphRAG approaches
- Retrieval in **less than 200ms** (zero LLM calls at query time)

(Source: [Zep Paper](https://arxiv.org/html/2501.13956v1))

### 2.2 Three-Tier Knowledge Graph

Graphiti organizes knowledge into three subgraphs:

**1. Episode Graph (G_e)**: Raw conversational data
- Each message/conversation becomes an Episode node
- Episodes link to their source (user, session, timestamp)
- Preserves the original context for provenance

**2. Semantic Entity Graph (G_s)**: Extracted knowledge
- Entity nodes with names, types, descriptions, 1024D embeddings
- Edge/fact nodes connecting entities with typed relationships
- Bi-temporal timestamps on edges (valid_at, invalid_at, created_at, expired_at)

**3. Community Graph (G_c)**: Clustered knowledge
- Community nodes grouping related entities
- LLM-generated community summaries
- Updated incrementally via label propagation

### 2.3 Episode Ingestion Pipeline

When a new episode (message/conversation) arrives:

```
1. Context Retrieval
   ├── Retrieve last 3 episodes for coreference context
   └── Load relevant entity/edge context

2. Entity Extraction (LLM, zero-shot)
   ├── Extract speaker as first entity
   ├── Extract mentioned entities with types
   └── Reflection pass to catch missed entities

3. Entity Resolution (per extracted entity)
   ├── Generate name embedding (1024D)
   ├── Hybrid search for candidates (embedding + BM25)
   ├── MinHash string similarity heuristic
   └── LLM verification for ambiguous matches (0.6-0.85 similarity)

4. Edge/Fact Extraction (LLM)
   ├── Extract relationships between resolved entities
   ├── Assign relation types (SCREAMING_SNAKE_CASE)
   └── Resolve temporal expressions (valid_at, invalid_at)

5. Edge Deduplication
   ├── Search existing edges between same entity pairs
   ├── LLM comparison for candidate duplicates
   └── Merge or create new edge

6. Temporal Invalidation
   ├── Identify contradicting existing edges
   ├── Set expired_at on outdated edges
   └── Regenerate old edge's fact description for historical context

7. Community Update
   ├── Assign new entities to communities via label propagation
   └── Update affected community summaries
```

**Concurrency**: Steps 2-7 run with up to 10 concurrent LLM calls (configurable `SEMAPHORE_LIMIT`). Independent sub-tasks within each step run in parallel.

(Sources: [Zep Paper](https://arxiv.org/html/2501.13956v1), [Graphiti GitHub](https://github.com/getzep/graphiti), [Zep Blog: LLM Data Extraction](https://blog.getzep.com/llm-rag-knowledge-graphs-faster-and-more-dynamic/))

### 2.4 Key Design Decisions

**Separated prompt architecture**: Rather than a single "mega-prompt" (which was their initial approach), Graphiti uses specialized prompts for each task. This allows:
- Concurrent execution of independent prompts
- Better accuracy from focused instructions
- Easier debugging and iteration

**Zero LLM calls at retrieval time**: All LLM processing happens during ingestion. Retrieval uses only embeddings, BM25, and graph traversal. This is critical for real-time agent use.

**Reflexion technique**: After initial entity extraction, a second pass reviews the results to catch missed entities. This reduces extraction errors by approximately 15%.

**Bi-temporal modeling**: Every edge tracks both when the fact became true (valid_at) and when it was ingested (created_at). This enables historical queries and correct handling of out-of-order data.

### 2.5 Lessons for Engram

Graphiti processes episodes in real-time (immediately on ingestion). Engram's dream state daemon will process them in batch (periodically). This simplifies some aspects:

- No need for concurrent LLM calls (sequential processing is fine for batch)
- Can batch entity resolution across multiple conversations (more efficient)
- Community updates can be done once at the end of a batch, not per-episode
- The daemon has more time budget, allowing more thorough processing

---

## 3. Microsoft GraphRAG -- Knowledge Graph Construction

### 3.1 Pipeline Architecture

Microsoft's GraphRAG processes text through a multi-phase pipeline:

```
1. Text Chunking
   └── Split documents into TextUnits (default: 1200 tokens)

2. Entity & Relationship Extraction (per TextUnit)
   ├── LLM extracts entities (title, type, description)
   ├── LLM extracts relationships (source, target, description)
   └── Supports configurable entity types per domain

3. Entity Deduplication
   └── Merge entities with identical names, consolidate descriptions

4. Entity Summarization
   └── LLM condenses multiple descriptions per entity into one summary

5. Community Detection
   ├── Hierarchical Leiden algorithm
   └── Produces nested community structure

6. Community Summarization
   └── LLM generates reports for each community

7. Embedding Generation
   └── Embed entity descriptions, text units, community reports
```

### 3.2 Strengths and Weaknesses

**Strengths:**
- Excellent for "global queries" ("What are the main themes in this corpus?") via community summaries
- Hierarchical community structure enables multi-resolution querying
- Well-documented, Microsoft-backed, active development

**Weaknesses:**
- **Batch-only**: "Updates can trigger extensive recomputation of the entire graph." Not designed for incremental updates.
- **Slow**: "Multi-step summarization makes retrieval slow, often taking tens of seconds."
- **Expensive**: Multiple LLM calls per text unit, community summarization scales with graph size
- **No temporal modeling**: Unlike Graphiti, GraphRAG does not track when facts became true or expired

### 3.3 Relevant Patterns for Engram

**Auto-tuning**: GraphRAG's auto-tuning system generates domain-specific few-shot examples for entity extraction. For developer conversations, this would produce examples showing how to extract TypeScript-specific entities.

**Community summarization**: The hierarchical community reports are valuable for answering broad questions ("What technology stacks do I use?"). Engram should consider generating community summaries during the consolidation phase.

**Chunk size**: GraphRAG defaults to 1200 tokens per text unit. For Engram's conversations, a natural unit is 25 exchanges (as used in the existing extraction pipeline).

(Source: [Microsoft GraphRAG](https://microsoft.github.io/graphrag/), [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/))

---

## 4. MemGPT / Letta -- Memory Management

### 4.1 Architecture

Letta (formerly MemGPT) implements a tiered memory architecture:

| Layer | Description | Update Mechanism |
|-------|-------------|-----------------|
| **Message Buffer** | Current conversation context | Automatic (FIFO) |
| **Core Memory** | Structured blocks (human, persona, custom) | Agent self-edit via tool calls |
| **Recall Memory** | Searchable conversation history | Automatic indexing |
| **Archival Memory** | Long-term storage with vector search | Agent-managed writes |

### 4.2 Self-Editing Memory

The key innovation: agents edit their own memory via tool calls:

```python
# Agent can call these tools during conversation
memory_replace(block, old_text, new_text)  # Edit core memory block
memory_insert(block, text)                  # Add to core memory
memory_rethink(block, query)               # Reorganize a memory block
archival_insert(text)                      # Store in long-term archival
```

### 4.3 Relevance to Engram

Letta's approach is fundamentally different from Engram's dream state daemon:

- **Letta**: Memory management is inline (during conversation). The agent decides what to remember in real-time.
- **Engram**: Memory extraction is offline (background daemon). No agent involvement needed.

However, Letta's **Core Memory blocks** concept is useful: structured summaries of key topics that are always in context. Engram's consolidation phase could produce similar structured summaries:

```
# User Profile (auto-generated by dream daemon)
- Primary language: TypeScript
- Editor: Neovim in tmux
- Shell: Fish on M4 Mac Mini
- Active projects: engram, nova-voice
- Preferred patterns: ESM modules, SQLite for storage, Zod for validation
```

(Source: [Letta Docs: Intro to MemGPT](https://docs.letta.com/concepts/memgpt/), [Memory Blocks (Letta Blog)](https://www.letta.com/blog/memory-blocks))

---

## 5. Mem0 -- Scalable Long-Term Memory

### 5.1 Architecture

Mem0 implements a "scalable memory-centric architecture that dynamically extracts, consolidates, and retrieves salient information from ongoing conversations."

**Memory operations** (decided by LLM):
- **ADD**: New fact not present in existing memories
- **UPDATE**: Existing memory needs modification
- **DELETE**: Memory is contradicted or no longer valid
- **NOOP**: No memory action needed

### 5.2 Graph-Enhanced Variant (Mem0g)

Mem0g adds knowledge graph structure:
- Entities as nodes, relationships as edges
- Directed labeled graph
- Achieves 68.44% on LoCoMo benchmark (vs 62% for flat Mem0)

### 5.3 Extraction Pipeline

```
Input: New conversation message
  |
  v
1. Retrieve top-S similar existing memories (embedding search)
  |
  v
2. LLM evaluates: ADD / UPDATE / DELETE / NOOP for each existing memory
  |
  v
3. Execute decisions:
   - ADD: Insert new memory with embedding
   - UPDATE: Modify existing memory, re-embed
   - DELETE: Mark memory as invalid
   - NOOP: No change
```

### 5.4 Lessons for Engram

Mem0's ADD/UPDATE/DELETE/NOOP decision model is elegant for the consolidation phase. During Engram's dream state processing:

1. Extract facts from new conversation
2. For each extracted fact, retrieve similar existing facts (embedding search)
3. Classify the action:
   - **ADD**: Genuinely new information
   - **UPDATE**: Existing fact needs updating (e.g., version changed)
   - **SUPERSEDE**: Old fact is now false (soft invalidation)
   - **MERGE**: Same information expressed differently (deduplication)
   - **NOOP**: Already captured

This is more sophisticated than simple deduplication and handles the common case of evolving knowledge.

(Source: [Mem0 Paper](https://arxiv.org/html/2504.19413v1))

---

## 6. Cognee -- ECL Pipeline

### 6.1 Overview

Cognee is an open-source framework that provides "memory for AI agents in 5 lines of code." It has scaled from 2,000 pipeline runs to over 1 million in 2025, running in 70+ companies.

### 6.2 ECL Pipeline Architecture

Cognee's pipeline follows **Extract, Cognify, Load (ECL)**:

**Extract:**
- Ingest from 38+ data sources
- Parse and chunk content
- Generate initial embeddings

**Cognify:**
- Build knowledge graph structure
- Generate entity and relationship embeddings
- Run community detection
- Apply "memify" layer (feedback-driven edge weight adjustment)

**Load:**
- Index into searchable stores
- Enable multi-modal retrieval (graph traversal + vector + time filters)

### 6.3 Memory Consolidation ("Memphis")

Cognee's "Memphis" algorithms run as background processes:

- **Clean unused data**: Remove entities/edges that have never been accessed
- **Reconnect nodes**: Find new connections between previously unconnected entities
- **Improve structure**: Optimize community assignments based on access patterns

The "memify" layer refines the graph through feedback loops: responses that are rated positively increase the weight of the edges traversed to produce them. This creates a natural quality signal.

### 6.4 100% Local Operation

Cognee supports fully local operation with Ollama:

```python
import cognee
cognee.config.set_llm_config({
    "model": "ollama/qwen2.5:7b",
    "api_url": "http://localhost:11434"
})
cognee.config.set_embedding_config({
    "model": "ollama/nomic-embed-text",
    "api_url": "http://localhost:11434"
})
```

This validates the architecture of using Ollama for local LLM inference in a background processing pipeline.

(Sources: [Cognee GitHub](https://github.com/topoteretes/cognee), [From RAG to Graphs: How Cognee Builds AI Memory](https://memgraph.com/blog/from-rag-to-graphs-cognee-ai-memory), [Building 100% Local AI Memory with Cognee](https://dev.to/chinmay_bhosale_9ceed796b/cognee-with-ollama-3pp8))

---

## 7. Incremental Knowledge Updates

### 7.1 The Incremental Update Problem

When processing a new conversation:
1. New entities may match existing entities (resolution)
2. New facts may contradict existing facts (conflict)
3. New facts may supplement existing facts (enrichment)
4. Entity relationships may have changed (temporal update)

Processing must handle all four cases without reprocessing the entire graph.

### 7.2 iText2KG Incremental Pipeline

iText2KG processes documents sequentially against a growing global entity set:

```
For each new document:
  1. Extract local entities E_d
  2. For each entity e in E_d:
     a. Exact match against global entities? -> merge
     b. Cosine similarity > 0.7? -> merge
     c. Otherwise -> create new
  3. Extract relationships using resolved entity references
  4. Update global entity set: E = E ∪ (new entities)
```

Empirically-derived thresholds:
- **Entity merging**: cosine similarity >= 0.7
- **Relationship merging**: cosine similarity >= 0.56

(Source: [iText2KG](https://arxiv.org/html/2409.03284v1))

### 7.3 IncRML: Incremental Knowledge Graph Construction

IncRML (Incremental RML) tracks changes in source data and propagates only affected portions:

- **11-58x faster** than full recomputation for ingesting all versions of a dataset
- **4.5-28.5x faster** on average for individual updates
- Uses change detection on source data to identify what needs reprocessing

**Lesson for Engram**: Track which conversations have been processed and only process new ones. When the extraction model changes (e.g., upgraded prompt or model), mark conversations for reprocessing.

(Source: [IncRML](https://www.semantic-web-journal.net/content/incrml-incremental-knowledge-graph-construction-heterogeneous-data-sources))

### 7.4 ATOM: Atomic Fact Decomposition

The ATOM approach improves extraction quality by:

1. **Decompose input into atomic facts**: "The user prefers TypeScript and uses Fish shell on an M4 Mac Mini" becomes three atomic facts
2. **Build atomic knowledge graphs**: Extract entities and relationships from each atomic fact independently
3. **Merge atomic KGs in parallel**: Use entity resolution to combine

Benefits:
- Higher extraction exhaustivity (catches more entities)
- More consistent results across runs (stability)
- Natural parallelization

**Lesson for Engram**: Decompose conversations into atomic facts before entity extraction, rather than extracting from entire conversation chunks.

(Source: [Incremental KG Construction - Emergent Mind](https://www.emergentmind.com/topics/incremental-knowledge-graph-construction))

---

## 8. Memory Decay and Pruning

### 8.1 Why Decay Matters

Without decay, memory systems suffer from:
- **Context rot**: More memories = more noise in retrieval
- **Contradictory context**: Old and new versions both retrieved
- **Latency creep**: Larger indexes slow down search
- **Token waste**: Irrelevant memories consume context budget

Memory decay ensures the system naturally "forgets" stale, unused information while preserving frequently-accessed, important knowledge.

### 8.2 FSRS (Free Spaced Repetition Scheduler)

FSRS is the most sophisticated memory decay model currently in use. Engram Phase 3 already uses FSRS-inspired confidence decay.

**Core DSR model** (Difficulty, Stability, Retrievability):

- **Retrievability (R)**: Probability of recalling the memory. Decays over time.
- **Stability (S)**: Time in days for R to go from 1.0 to 0.9. Higher stability = slower decay.
- **Difficulty (D)**: How hard the memory is to recall. Range 1-10.

**Forgetting curve** (FSRS-5):

```
R(t) = (1 + t / (9 * S))^(-1)
```

Where `t` is time in days and `S` is stability. This is a power-law decay (better fit than exponential for real memory data).

**Key insight**: FSRS uses machine learning trained on actual review data. The parameters are not arbitrary but optimized from millions of Anki reviews. For Engram, we can adapt the decay function without the full training pipeline.

(Sources: [FSRS Algorithm](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm), [Implementing FSRS in 100 Lines](https://borretti.me/article/implementing-fsrs-in-100-lines), [Technical Explanation of FSRS](https://expertium.github.io/Algorithm.html))

### 8.3 Engram's Existing Decay Model

From Phase 3, Engram already implements confidence decay:

```
confidence(t) = initial_confidence * (1 + t / (9 * stability))^(-1)
```

Where:
- `initial_confidence` is set during extraction (LLM-judged 0.0-1.0)
- `stability` depends on how often the memory is accessed (increases on access)
- `t` is days since last access

### 8.4 Consolidation-Phase Decay Updates

The dream state daemon should update confidence scores during consolidation:

```typescript
function updateConfidenceScores(db: Database): void {
  const now = Math.floor(Date.now() / 1000);
  const dayInSeconds = 86400;

  // Update all memories with time-based decay
  db.prepare(`
    UPDATE memories SET
      confidence = initial_confidence * POWER(
        1.0 + CAST((? - COALESCE(last_accessed_at, created_at)) AS REAL) / (? * 9.0 * stability),
        -1.0
      ),
      updated_at = ?
    WHERE confidence > 0.01  -- Don't bother with effectively-zero memories
  `).run(now, dayInSeconds, now);

  // Boost stability for frequently-accessed memories
  db.prepare(`
    UPDATE memories SET
      stability = MIN(stability * 1.1, 365)  -- Cap at 1 year
    WHERE access_count > 5
      AND last_accessed_at > ? - (7 * ?)     -- Accessed in last week
  `).run(now, dayInSeconds);
}
```

### 8.5 Pruning Strategies

**Soft pruning** (recommended):
- Never delete memories
- Set a minimum confidence threshold for retrieval (e.g., 0.1)
- Memories below threshold are excluded from search results
- Can be "revived" if similar new information arrives

**Hard pruning** (for storage management):
- Archive memories below threshold to a separate table
- Compress embeddings for archived memories
- Delete memories older than N years with zero access

**Entity pruning:**
- Entities with no relationships and no recent mentions can be merged into their community summary
- Orphan entities (no edges, never accessed) can be archived

### 8.6 Generative Agents Scoring Formula

The Park et al. (2023) formula remains influential:

```
retrieval_score = alpha * recency + beta * importance + gamma * relevance
```

Where:
- `recency = 0.995^hours_since_last_access` (exponential decay)
- `importance` = LLM-judged 1-10 scale
- `relevance` = cosine similarity to query

**Production variant** (Tribe AI, 2025):
```
final_score = 0.60 * relevance + 0.25 * recency + 0.15 * importance
```

Heavily favoring relevance prevents retrieving important-but-irrelevant memories.

(Sources: [Generative Agents (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763), [FadeMem](https://www.co-r-e.com/method/agent-memory-forgetting))

---

## 9. Conflict Detection and Resolution

### 9.1 Types of Conflicts in Knowledge Bases

| Conflict Type | Example | Resolution Strategy |
|---------------|---------|---------------------|
| **Contradiction** | "Uses Python" vs "Uses TypeScript" | Check if both can be true (different projects) |
| **Supersession** | "Uses Node 18" then "Upgraded to Node 22" | Temporal invalidation of old fact |
| **Partial overlap** | "Prefers Vim" vs "Prefers Neovim" | Merge (Neovim is Vim-derived) |
| **Ambiguity** | Same entity name, different contexts | Entity resolution with disambiguation |
| **Granularity** | "Uses React" vs "Uses React 18.3" | Merge (more specific supersedes general) |

### 9.2 Graphiti's Temporal Conflict Resolution

Graphiti handles conflicts through temporal invalidation:

1. When a new edge is created between entities A and B
2. Search for existing edges between the same entity pair
3. LLM evaluates whether the new edge contradicts existing edges
4. If contradictory: set `expired_at` on the old edge, set `invalid_at` to the new edge's `valid_at`
5. The old edge's fact description is rewritten to reflect historical context

**Example:**
- Old: "User uses Fish shell" (valid_at: 2025-01-01)
- New: "User switched to Nushell" (valid_at: 2026-02-01)
- Resolution: Old edge expired, fact updated to "User previously used Fish shell before switching to Nushell"

### 9.3 Engram's Existing NLI-Based Conflict Detection

Phase 3 implemented NLI (Natural Language Inference) for contradiction detection:

```typescript
// Existing approach: embedding-based + NLI
async function detectContradictions(newFact: string, existingFacts: Memory[]): Promise<Contradiction[]> {
  // 1. Find semantically similar existing facts (embedding search)
  const candidates = await vectorSearch(newFact, { limit: 10, threshold: 0.6 });

  // 2. NLI classification for each candidate
  const contradictions: Contradiction[] = [];
  for (const candidate of candidates) {
    const result = await nliClassify(newFact, candidate.content);
    if (result.label === 'contradiction' && result.score > 0.7) {
      contradictions.push({ existing: candidate, confidence: result.score });
    }
  }

  return contradictions;
}
```

### 9.4 Enhanced Conflict Resolution for Dream State

The dream daemon can perform more thorough conflict resolution than real-time extraction:

```typescript
async function resolveConflicts(
  newFacts: ExtractedFact[],
  llm: LLMProvider,
): Promise<ConflictResolution[]> {
  const resolutions: ConflictResolution[] = [];

  for (const fact of newFacts) {
    // Find potentially conflicting existing facts
    const candidates = await findConflictCandidates(fact);

    if (candidates.length === 0) continue;

    // Use LLM for nuanced conflict resolution
    const resolution = await llm.chatStructured(
      [
        { role: 'system', content: CONFLICT_RESOLUTION_PROMPT },
        { role: 'user', content: JSON.stringify({ newFact: fact, existingFacts: candidates }) },
      ],
      ConflictResolutionSchema,
      { temperature: 0 },
    );

    for (const decision of resolution.decisions) {
      switch (decision.action) {
        case 'supersede':
          // New fact replaces old
          await supersedeFact(decision.existingId, fact.id);
          break;
        case 'merge':
          // Combine information from both
          await mergeFacts(decision.existingId, fact.id, decision.mergedContent);
          break;
        case 'coexist':
          // Both are true (different contexts)
          // No action needed
          break;
        case 'reject_new':
          // New fact is less reliable
          await markAsRejected(fact.id, decision.reason);
          break;
      }
    }
  }

  return resolutions;
}
```

(Sources: [Detect-Then-Resolve: KG Conflict Resolution with LLM](https://www.mdpi.com/2227-7390/12/15/2318), [Conflict Detection for Temporal Knowledge Graphs](https://arxiv.org/abs/2312.11053), [From Genesis to Maturity: Managing Knowledge Graphs](https://www.vldb.org/pvldb/vol18/p1390-geisler.pdf))

---

## 10. Priority Scheduling for Processing

### 10.1 Not All Conversations Are Equal

Some conversations contain more valuable information than others:

| Factor | High Priority | Low Priority |
|--------|-------------|-------------|
| **Length** | Long, detailed conversations | Brief, one-line exchanges |
| **Content type** | Architecture decisions, new project setup | Typo fixes, "hello" messages |
| **Recency** | Today's conversations | Months-old conversations |
| **User activity** | Active project context | Dormant project |
| **Entity density** | Many entities mentioned | No technical content |

### 10.2 Priority Scoring

```typescript
function calculateProcessingPriority(conversation: Conversation): number {
  let priority = 0;

  // Length bonus (more content = more to extract)
  const exchangeCount = conversation.exchanges.length;
  priority += Math.min(exchangeCount / 10, 5); // Max 5 points for 50+ exchanges

  // Recency bonus (newer = more relevant)
  const ageHours = (Date.now() / 1000 - conversation.timestamp) / 3600;
  priority += Math.max(0, 10 - ageHours / 24); // Max 10 points, decays over 10 days

  // Content density (rough heuristic: technical terms, file paths, code blocks)
  const technicalDensity = estimateTechnicalDensity(conversation.text);
  priority += technicalDensity * 3; // 0-3 points

  return priority;
}
```

### 10.3 Processing Order

```sql
-- Get conversations ordered by priority for processing
SELECT c.*,
  CASE
    WHEN c.exchange_count > 50 THEN 5
    WHEN c.exchange_count > 20 THEN 3
    WHEN c.exchange_count > 5 THEN 1
    ELSE 0
  END +
  CASE
    WHEN (unixepoch() - c.timestamp) < 86400 THEN 10  -- Last 24h
    WHEN (unixepoch() - c.timestamp) < 604800 THEN 5  -- Last week
    WHEN (unixepoch() - c.timestamp) < 2592000 THEN 2 -- Last month
    ELSE 0
  END AS priority
FROM conversations c
LEFT JOIN dream_pipeline_state ps
  ON c.id = ps.conversation_id AND ps.phase = 'extract_facts'
WHERE ps.status IS NULL OR ps.status = 'pending'
ORDER BY priority DESC, c.timestamp DESC
LIMIT ?;
```

### 10.4 Adaptive Processing Depth

Different conversations deserve different processing depth:

- **Full pipeline**: Long conversations with many technical entities. Run all extraction phases.
- **Light pipeline**: Short conversations. Extract basic facts only, skip entity/relationship extraction.
- **Skip**: Very brief conversations (< 3 exchanges) with no technical content.

```typescript
function selectPipelineDepth(conversation: Conversation): 'full' | 'light' | 'skip' {
  if (conversation.exchanges.length < 3) return 'skip';
  if (conversation.exchanges.length < 10) return 'light';
  return 'full';
}
```

---

## 11. Batch vs Streaming Trade-offs

### 11.1 Comparison

| Aspect | Batch (Engram's Approach) | Streaming (Graphiti's Approach) |
|--------|--------------------------|--------------------------------|
| **Latency** | Minutes to hours | Seconds |
| **Resource usage** | Bursty (high during processing) | Steady |
| **Complexity** | Lower (simpler error handling) | Higher (concurrent state) |
| **Cross-conversation** | Can analyze relationships across conversations | Limited to current + recent context |
| **Cost** | Can use cheaper models (batch pricing) | Needs fast response |
| **Deduplication** | More effective (sees more data) | Limited to current + retrieved context |
| **Resumability** | Natural (checkpoint between items) | Requires careful state management |

### 11.2 Why Batch is Better for Engram

1. **Cross-conversation entity resolution**: When processing in batch, the daemon can see entities extracted from multiple conversations and resolve them more accurately.

2. **Global consolidation**: Community detection, confidence decay, and summary generation benefit from seeing the complete graph, not just incremental changes.

3. **Resource management**: Background processing during off-hours does not compete with interactive Claude Code sessions for CPU/memory/LLM bandwidth.

4. **Cost optimization**: Local LLM inference can be slower but is free. The batch model tolerates this latency.

5. **Simpler error handling**: Individual conversation failures do not block real-time use. Retry on the next batch run.

### 11.3 Hybrid Approach (Future)

For future optimization, a hybrid approach:
- **Real-time**: `remember` MCP tool extracts and stores facts immediately (lightweight, no entity extraction)
- **Batch**: Dream daemon performs deep extraction (entities, relationships, communities, conflict resolution)
- **Real-time index**: New facts are immediately searchable via embedding + FTS5
- **Batch enrichment**: Dream daemon enhances facts with entity links, relationship edges, community membership

This is essentially what Engram already does: the `remember` tool handles real-time fact storage, and the dream daemon handles deep extraction.

---

## 12. Key Takeaways for Engram

### Pipeline Design

The dream state daemon's consolidation pipeline:

```
Phase 1: INGEST
  Discover new conversations since last run
  Parse JSONL files, assign conversation IDs
  Priority-sort conversations

Phase 2: EXTRACT FACTS
  For each unprocessed conversation:
    Send to local LLM with fact extraction prompt
    Store extracted facts in memories table
    Checkpoint after each conversation

Phase 3: EXTRACT ENTITIES
  For each conversation with facts but no entities:
    Send to local LLM with entity extraction prompt
    Resolve against existing entity graph (alias -> embedding -> LLM)
    Store entities and entity-conversation links
    Checkpoint after each conversation

Phase 4: EXTRACT RELATIONSHIPS
  For each conversation with entities but no relationships:
    Send to local LLM with relationship extraction prompt
    Resolve against existing edges (deduplication)
    Apply temporal invalidation for contradicting edges
    Checkpoint after each conversation

Phase 5: CONSOLIDATE
  Update confidence scores (FSRS-based decay)
  Run conflict detection on new facts vs existing
  Update community assignments (label propagation)
  Generate/update community summaries (optional, LLM-powered)
  Prune low-confidence memories (soft prune)
  Update graph analysis metrics (centrality, bridge nodes)
  Write run summary
```

### Integration with Existing Engram Architecture

| Existing Component | Dream State Enhancement |
|-------------------|------------------------|
| JSONL parser | Source data for ingestion |
| Embedding pipeline | Embedding new entities/facts |
| Semantic extraction (Phase 3) | Extended with entity/relationship extraction |
| Knowledge graph (Phase 4) | Populated by dream daemon |
| Multi-source search | Enhanced with graph-enriched results |
| MCP server (`recall`) | No changes needed -- benefits from richer data |
| CLI | New `dream` subcommand for status/control |

### LLM Provider Architecture

```
┌─────────────────────────────────────────────┐
│              LLMProvider Interface            │
│  chat() / chatStructured() / shutdown()      │
├──────────┬──────────┬───────────────────────┤
│  Ollama  │  MLX-LM  │  Anthropic (fallback) │
│  Local   │  Local   │  API                  │
│  Free    │  Free    │  Paid                 │
└──────────┴──────────┴───────────────────────┘
```

### Key Design Principles

1. **Batch over streaming**: Process conversations in bulk during off-hours.
2. **Local first**: Use Ollama/MLX for cost-free extraction. Anthropic API as fallback.
3. **Per-conversation checkpointing**: Crash-safe, resumable at conversation granularity.
4. **Idempotent**: Content-addressed IDs + upserts = safe to re-run.
5. **Additive, non-destructive**: Never delete memories; use soft invalidation and temporal tracking.
6. **Progressive extraction**: Skip short conversations; full pipeline for rich ones.
7. **Separated prompts**: One LLM call per extraction task (facts, entities, relationships). No mega-prompts.
8. **Observable**: Health file, run history, CLI status, dead letter queue for failures.

### Consolidation Specific Operations

These operations run once per daemon run (not per conversation):

1. **Confidence decay**: Apply FSRS-based time decay to all memories
2. **Community update**: Re-run label propagation on the entity graph
3. **Community summaries**: LLM-generate summaries for changed communities
4. **Graph metrics**: Update centrality scores, detect bridge entities
5. **Deduplication sweep**: Find and merge near-duplicate memories across conversations
6. **Conflict sweep**: Detect contradictions that were missed during per-conversation extraction

---

## Sources

### Primary Research Papers
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/html/2501.13956v1) -- Arxiv, Jan 2025
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/html/2504.19413v1) -- Arxiv, Apr 2025
- [Generative Agents: Interactive Simulacra of Human Behavior](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) -- ACM, 2023
- [iText2KG: Incremental Knowledge Graphs Using LLMs](https://arxiv.org/html/2409.03284v1) -- Arxiv, Sep 2024
- [Detect-Then-Resolve: KG Conflict Resolution with LLM](https://www.mdpi.com/2227-7390/12/15/2318) -- Mathematics, 2024
- [Conflict Detection for Temporal Knowledge Graphs](https://arxiv.org/abs/2312.11053) -- Arxiv, Dec 2023
- [From Genesis to Maturity: Managing Knowledge Graphs](https://www.vldb.org/pvldb/vol18/p1390-geisler.pdf) -- VLDB, 2025
- [IncRML: Incremental Knowledge Graph Construction](https://www.semantic-web-journal.net/content/incrml-incremental-knowledge-graph-construction-heterogeneous-data-sources)

### Production Systems
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Microsoft GraphRAG](https://microsoft.github.io/graphrag/)
- [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/)
- [Letta Docs: Intro to MemGPT](https://docs.letta.com/concepts/memgpt/)
- [Memory Blocks (Letta Blog)](https://www.letta.com/blog/memory-blocks)
- [Cognee GitHub](https://github.com/topoteretes/cognee)

### Blog Posts and Guides
- [Graphiti: Knowledge Graph Memory for an Agentic World (Neo4j)](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Zep Blog: LLM Data Extraction at Scale](https://blog.getzep.com/llm-rag-knowledge-graphs-faster-and-more-dynamic/)
- [Zep Blog: Beyond Static Graphs](https://blog.getzep.com/beyond-static-knowledge-graphs/)
- [Survey of AI Agent Memory Frameworks (Graphlit)](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [From RAG to Graphs: How Cognee Builds AI Memory (Memgraph)](https://memgraph.com/blog/from-rag-to-graphs-cognee-ai-memory)
- [Building 100% Local AI Memory with Cognee](https://dev.to/chinmay_bhosale_9ceed796b/cognee-with-ollama-3pp8)
- [From LLMs to Knowledge Graphs in 2025](https://medium.com/@claudiubranzan/from-llms-to-knowledge-graphs-building-production-ready-graph-systems-in-2025-2b4aff1ec99a)
- [The Problem with AI Agent Memory](https://medium.com/@DanGiannone/the-problem-with-ai-agent-memory-9d47924e7975)

### Memory Decay and Scoring
- [FSRS Algorithm Wiki](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)
- [Technical Explanation of FSRS](https://expertium.github.io/Algorithm.html)
- [Implementing FSRS in 100 Lines](https://borretti.me/article/implementing-fsrs-in-100-lines)
- [FSRS GitHub](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)
- [FadeMem](https://www.co-r-e.com/method/agent-memory-forgetting)
- [Spaced Repetition Systems Have Gotten Way Better](https://domenic.me/fsrs/)

### Incremental KG Construction
- [Incremental KG Construction (Emergent Mind)](https://www.emergentmind.com/topics/incremental-knowledge-graph-construction)
- [Building AI Agents with Knowledge Graph Memory (Graphiti Guide)](https://medium.com/@saeedhajebi/building-ai-agents-with-knowledge-graph-memory-a-comprehensive-guide-to-graphiti-3b77e6084dec)

### Benchmarks and Evaluation
- [LoCoMo](https://snap-research.github.io/locomo/)
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- [MemBench (ICLR 2026)](https://github.com/HUST-AI-HYZ/MemoryAgentBench)
- [EverMemOS](https://www.arxiv.org/pdf/2601.02163)
