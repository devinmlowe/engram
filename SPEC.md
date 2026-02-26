# Engram: Cognitive Memory System for Claude Code

> *An engram is the hypothetical physical trace of memory in neural tissue — the biochemical change that encodes what we've learned.*

## Vision

Engram is a local-first cognitive memory system that transforms raw Claude Code conversation history into structured, consolidated knowledge. Unlike traditional conversation search (which treats sessions as documents to retrieve), Engram mimics human memory architecture: **episodic memories are captured, consolidated into semantic knowledge during "dream state" off-hours processing, and emergent connections surface through graph analysis** — much like how a Zettelkasten's backlinks reveal Maps of Content that no individual note anticipated.

The system is optimized for Claude Opus 4.6's adaptive thinking, which consumes 2-3x more tokens per turn. Every token of injected memory must earn its place.

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │         Claude Code Session          │
                    │                                      │
                    │  MCP Server ◄── search/recall tools  │
                    │      │                               │
                    │      ▼                               │
                    │  Context Engineer                    │
                    │  (budget, placement, format)         │
                    └──────────┬──────────────────────────┘
                               │ queries
                    ┌──────────▼──────────────────────────┐
                    │         Retrieval Layer              │
                    │                                      │
                    │  Hybrid Search (Vector + BM25)       │
                    │  Cross-Encoder Reranking             │
                    │  Multi-hop Graph Traversal           │
                    └──────────┬──────────────────────────┘
                               │ reads from
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                     ▼
   ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
   │  Episodic   │    │   Semantic   │    │  Knowledge      │
   │  Store      │    │   Store      │    │  Graph          │
   │             │    │              │    │                 │
   │ Exchanges   │    │ Facts        │    │ Entities        │
   │ Embeddings  │    │ Preferences  │    │ Relationships   │
   │ Summaries   │    │ Decisions    │    │ Topic Clusters  │
   │ Tool Usage  │    │ Patterns     │    │ Maps of Content │
   └──────┬──────┘    └──────┬───────┘    └────────┬────────┘
          │                  │                      │
          └────────────────┐ │ ┌────────────────────┘
                           ▼ ▼ ▼
                    ┌──────────────────────────────────────┐
                    │         Dream State Daemon           │
                    │                                      │
                    │  Phase 1: Ingest (sync + embed)      │
                    │  Phase 2: Extract (facts + entities) │
                    │  Phase 3: Consolidate (merge + link) │
                    │  Phase 4: Reflect (patterns + MOCs)  │
                    │  Phase 5: Prune (decay + forget)     │
                    └─────────────────────────────────────┘
```

## Core Principles

### 1. Memory is Not Search

The current episodic-memory plugin is a search engine for conversations. Engram is a **cognitive system** — it extracts meaning, consolidates patterns, detects contradictions, and surfaces emergent connections. Raw conversations are the input, not the output.

### 2. Token Discipline

With Opus 4.6's 2-3x token overhead for adaptive thinking, memory injection must be surgical:
- **Hard budget**: Retrieved memories capped at ~2,000 tokens (1% of 200K context)
- **Primacy placement**: Memories injected at the beginning of context (avoiding "lost in the middle")
- **Just-in-time retrieval**: Never preload — retrieve only when needed
- **Progressive disclosure**: Return pointers first, full content only on request

### 3. Emergent Discovery

Like a Zettelkasten, the value is in the connections:
- Opportunistic bidirectional linking (link at point of contact, not exhaustively)
- Maps of Content emerge from graph density (topic clusters that weren't explicitly created)
- The dream state daemon is the librarian who notices patterns across the collection

### 4. Local-First, Offline-Capable

All processing runs locally. No cloud dependencies except optional Claude API calls for extraction/summarization (which can be replaced with local MLX models for true offline operation).

---

## Layer 1: Episodic Store

### Purpose
Indexed, searchable archive of raw conversation exchanges. This is the foundation — improved from the current plugin but structurally similar.

### Data Source
- Primary: `~/.claude/projects/*/` (JSONL conversation files)
- Migration: Import from existing `~/.config/superpowers/conversation-index/db.sqlite`

### Schema

```sql
-- Core exchange storage
CREATE TABLE exchanges (
    id TEXT PRIMARY KEY,              -- deterministic hash: archive_path:line_range
    conversation_id TEXT NOT NULL,    -- source conversation UUID
    project TEXT NOT NULL,
    timestamp TEXT NOT NULL,          -- ISO 8601
    user_message TEXT,
    assistant_message TEXT,
    session_id TEXT,
    cwd TEXT,
    git_branch TEXT,
    model_version TEXT,
    exchange_index INTEGER,           -- position within conversation
    token_estimate INTEGER,           -- approximate token count
    created_at INTEGER DEFAULT (unixepoch()),
    last_accessed INTEGER             -- for decay tracking
);

-- FTS5 full-text search (replaces LIKE queries)
CREATE VIRTUAL TABLE exchanges_fts USING fts5(
    user_message,
    assistant_message,
    content='exchanges',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Vector embeddings (nomic-embed-text-v1.5 @ 256 dims via MRL)
CREATE VIRTUAL TABLE vec_exchanges USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[256]
);

-- Tool usage tracking
CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    exchange_id TEXT NOT NULL REFERENCES exchanges(id),
    tool_name TEXT NOT NULL,
    tool_input TEXT,                   -- JSON
    tool_result_summary TEXT,          -- truncated result
    is_error BOOLEAN DEFAULT FALSE,
    timestamp TEXT
);

-- Conversation-level metadata and summaries
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,              -- conversation UUID
    project TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    exchange_count INTEGER,
    summary TEXT,                      -- AI-generated
    primary_topics TEXT,               -- JSON array of extracted topics
    archive_path TEXT,
    last_indexed INTEGER
);
```

### Embedding Strategy

**Model**: nomic-embed-text-v1.5 via `@xenova/transformers`
- 768 native dimensions, truncated to **256 via Matryoshka Representation Learning**
- 8,192 token context window (vs. 512 for all-MiniLM-L6-v2)
- 86.2% BEIR accuracy (vs. 78.1%)
- Task prefixes: `search_query:` for queries, `search_document:` for stored content

**Contextual Chunking** (per Anthropic's contextual retrieval technique):
Before embedding each exchange, prepend a metadata context prefix:

```
[Project: {project} | Date: {date} | Branch: {branch} | Topic: {extracted_topic}]
User: {user_message}
Assistant: {assistant_message_first_500_chars}
Tools used: {tool_names}
```

This metadata prefix reduces retrieval failures by ~49% (Anthropic 2024).

### Search

**Hybrid search with RRF fusion:**
1. **Vector search**: Embed query with `search_query:` prefix, find top-20 nearest neighbors
2. **BM25 search**: Query FTS5 index, find top-20 keyword matches
3. **Reciprocal Rank Fusion**: Merge results using `score = Σ 1/(k + rank_i)` where k=60
4. **Reranking** (optional): Cross-encoder rerank top-20 → return top-5

---

## Layer 2: Semantic Store

### Purpose
Extracted, consolidated knowledge derived from episodic memories. This is what makes Engram fundamentally different from conversation search.

### Memory Types

| Type | Example | Extraction Trigger |
|------|---------|-------------------|
| **Preference** | "User prefers Fish shell, uses tmux always" | User states preference or corrects behavior |
| **Decision** | "Project X uses SQLite over Postgres for portability" | Architectural choice with rationale |
| **Pattern** | "User follows TDD: red-green-refactor cycle" | Repeated behavior across 3+ sessions |
| **Fact** | "Home network uses UniFi Dream Machine" | Stated factual information |
| **Solution** | "better-sqlite3 version mismatch: rebuild with matching Node" | Problem + resolution pair |
| **Convention** | "Commit messages use conventional commits format" | Repeated practice or explicit instruction |

### Schema

```sql
-- Semantic memories (extracted facts, preferences, decisions)
CREATE TABLE memories (
    id TEXT PRIMARY KEY,              -- UUID
    type TEXT NOT NULL,               -- preference|decision|pattern|fact|solution|convention
    content TEXT NOT NULL,            -- the distilled knowledge (1-3 sentences)
    context TEXT,                     -- broader context/rationale
    confidence REAL DEFAULT 0.5,      -- 0.0-1.0, increases with reinforcement
    importance REAL DEFAULT 0.5,      -- 0.0-1.0, scored by extraction
    access_count INTEGER DEFAULT 0,
    last_accessed INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER,
    source_exchanges TEXT,            -- JSON array of exchange IDs that support this memory
    superseded_by TEXT,               -- ID of newer memory that replaced this one
    is_active BOOLEAN DEFAULT TRUE
);

-- Memory embeddings for semantic search
CREATE VIRTUAL TABLE vec_memories USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[256]
);

-- FTS for keyword search on memories
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    context,
    content='memories',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Conflict log (when new facts contradict existing ones)
CREATE TABLE conflicts (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id),
    conflicting_memory_id TEXT NOT NULL REFERENCES memories(id),
    description TEXT,                  -- what the conflict is
    resolution TEXT,                   -- how it was resolved (if at all)
    resolved_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
);
```

### Extraction Pipeline

During dream state processing, each new conversation is analyzed. The pipeline draws from production patterns in Mem0, Zep/Graphiti, and LangMem — see [docs/research/semantic-extraction-techniques.md](docs/research/semantic-extraction-techniques.md) for the full survey.

```
Input: Raw conversation exchanges
  │
  ▼
Pre-processing
  - Filter to human + assistant text messages (tool calls as optional context)
  - For conversations > 100 turns: chunk into overlapping windows of
    ~20-30 turns with 5-turn overlap (prevents context loss at boundaries)
  - Prepend conversation metadata: project, branch, date range
  │
  ▼
Fact Extraction (Three-Tier Intelligence)
  Tier 1 — Local LLM (default): Qwen 3 8B Q4_K_M via MLX-LM (~32 tok/s)
  Tier 2 — Cloud API (fallback): Claude Haiku 4.5 via tool use (strict: true)
  Tier 3 — Cloud API (complex): Claude Sonnet for multi-hop reasoning
  │
  Extraction uses Claude tool use with strict: true for guaranteed schema
  compliance (constrained decoding for local models). Each memory is
  extracted as an atomic fact — complex statements decomposed into
  discrete, independently verifiable claims. See AFEV framework in
  docs/research/semantic-extraction-techniques.md §1.2.
  │
  Prompt pattern (Mem0-style typed facts):
    "Extract discrete facts, preferences, decisions, patterns, and
     solutions. For each, provide: type, content (1 atomic sentence),
     importance (0-1), and which exchanges support it.
     Replace all pronouns with actual entity names.
     Do NOT extract from system messages or casual greetings.
     Return empty array if no extractable information."
  │
  Confidence-based routing: local model self-reports confidence (1-10).
  Score >= 8 terminates locally; < 8 escalates to Claude Haiku.
  See docs/research/local-inference-nli-models.md §5 for routing details.
  │
  ▼
Reflexion Pass (optional, quality gate)
  Second LLM call reviews extraction against source text:
    "Which facts, preferences, or decisions were missed?"
  Catches implicit preferences and unstated assumptions.
  Pattern from Zep/Graphiti — see docs/research/semantic-extraction-techniques.md §1.3.
  │
  ▼
Deduplication Check (Tiered Thresholds)
  For each extracted memory:
  1. Embed with nomic-embed-text-v1.5 and search existing memories
  2. Cosine similarity >= 0.95: auto-merge (bump confidence + access_count)
  3. Cosine similarity 0.85-0.95: run NLI contradiction check
     - DeBERTa-v3-base via transformers.js/ONNX (~30ms per pair)
     - Entailment > 0.7 → merge as reinforcement
     - Contradiction > 0.7 → log conflict, keep both
     - Neutral → treat as distinct, insert new memory
  4. Cosine similarity < 0.85: insert as novel memory
  │
  Thresholds validated against production systems (Cognee, FalkorDB,
  SemDeDup). See docs/research/deduplication-conflict-detection.md §1.2.
  │
  ▼
Conflict Resolution (for detected contradictions)
  Resolution priority: temporal recency > explicit correction >
  corroboration count > source reliability.
  │
  For ambiguous conflicts (NLI contradiction 0.5-0.7):
  - Escalate to LLM with both memories + source context
  - LLM classifies: UPDATE (supersede old), KEEP_BOTH, or NOOP
  - Pattern from Mem0's ADD/UPDATE/DELETE/NOOP classification
  │
  Superseded memories are NOT deleted — marked with superseded_by
  link and is_active=false. Preserves temporal query capability.
  See docs/research/deduplication-conflict-detection.md §2.3.
  │
  ▼
Embedding + Indexing
  Embed memory content with nomic-embed-text-v1.5
  Index in vec_memories and memories_fts
```

### Confidence & Decay Model

The confidence model combines insights from FSRS (Free Spaced Repetition Scheduler), Bayesian confidence updating, and the Park et al. Generative Agents retrieval scoring. See [docs/research/deduplication-conflict-detection.md](docs/research/deduplication-conflict-detection.md) §4-5 for the full research survey.

**Storage-time confidence** (determines memory health and pruning eligibility):

```
confidence(t) = base_confidence × corroboration_factor × decay_factor

corroboration_factor = min(1.0, 0.5 + 0.1 × num_confirmations)
  — starts at 0.5 for single-source, approaches 1.0 with multiple confirmations
  — each independent conversation confirming this memory counts as +1

decay_factor = 0.9 ^ (days_since_last_access / stability)
  — FSRS-inspired: stability is per-memory, grows with successful access
  — stability_initial varies by type (see below)
  — on successful access: stability *= (1 + growth_rate × (1 - R))
    where R is retrievability at access time ("desirable difficulty" effect)
  — on contradiction: stability *= 0.8 (failure penalty)

stability_initial by type:
  preference: 90 days  (slow decay — user preferences are stable)
  decision:   60 days  (medium — architectural choices evolve)
  fact:       30 days  (faster — factual details change)
  pattern:    120 days (very slow — behavioral patterns are persistent)
  solution:   45 days  (medium — solutions become outdated)
  convention: 75 days  (slow — conventions are sticky)
```

**Retrieval-time scoring** (determines result ranking in recall):

```
retrieval_score = 0.55 × relevance + 0.25 × recency + 0.20 × importance

relevance:  cosine similarity (vector) + BM25 (keyword), fused with RRF
recency:    decay_factor from above (0.0-1.0)
importance: LLM-judged at extraction (0.0-1.0), boosted on access
```

This three-factor model follows the Park et al. Generative Agents approach but weights relevance more heavily, following Tribe AI's production recommendation — the most common failure mode is retrieving important-but-irrelevant memories. See [docs/research/memory-architectures-schemas.md](docs/research/memory-architectures-schemas.md) §3.

Memories with `confidence < 0.1` are candidates for pruning during dream state. Pruned memories are archived (not deleted) with full provenance.

---

## Layer 3: Knowledge Graph

### Purpose
Entity-relationship graph that enables multi-hop reasoning, emergent topic discovery, and Maps of Content generation. This is the Zettelkasten layer — where backlinks surface connections that no individual memory anticipated.

### Schema

```sql
-- Named entities extracted from memories and exchanges
CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,                -- canonical name
    type TEXT NOT NULL,                -- project|tool|technology|person|concept|file|repo
    description TEXT,
    aliases TEXT,                       -- JSON array of alternative names
    first_seen INTEGER,
    last_seen INTEGER,
    mention_count INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
);

-- Relationships between entities
CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL REFERENCES entities(id),
    target_entity_id TEXT NOT NULL REFERENCES entities(id),
    type TEXT NOT NULL,                -- uses|depends_on|related_to|part_of|configured_by|solved_by
    weight REAL DEFAULT 1.0,           -- strength of relationship
    context TEXT,                       -- why this relationship exists
    source_memories TEXT,               -- JSON array of memory IDs
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER
);

-- Emergent topic clusters (Maps of Content)
CREATE TABLE topic_clusters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,                -- auto-generated or refined by reflection
    description TEXT,
    entity_ids TEXT,                    -- JSON array of entity IDs in this cluster
    memory_ids TEXT,                    -- JSON array of relevant memory IDs
    coherence_score REAL,              -- how tightly connected the cluster is
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER,
    generation INTEGER DEFAULT 1       -- which reflection pass created this
);

-- Entity embeddings for semantic entity search
CREATE VIRTUAL TABLE vec_entities USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[256]
);
```

### Graph Analysis

The dream state daemon performs graph analysis to discover structure:

**Community Detection** (Louvain algorithm):
- Group densely-connected entities into communities
- Communities become candidate Maps of Content
- Coherence score = internal edge density / external edge density

**Bridge Detection**:
- Find entities that connect otherwise-separate communities
- These are the "surprising connections" — like discovering that your UniFi network debugging skills directly informed your approach to debugging SQLite WAL issues

**Temporal Patterns**:
- Track which entities co-occur in the same time periods
- Detect "project phases" where certain tools/concepts cluster together
- Surface: "During the nova-voice phase, you frequently used: tmux, MLX, daemon patterns, AppleScript"

---

## Layer 4: Dream State Daemon

> **Implementation reference**: [Phase 5 Implementation Plan](docs/plans/phase-5-implementation.md) | [Codebase Readiness](docs/research/phase-5-codebase-readiness.md)

### Purpose
Background process that performs memory consolidation during off-hours — the computational equivalent of sleep-stage memory processing. Runs as a managed daemon with embedded intelligence for deciding what to process and when.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Dream State Daemon                   │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Scheduler   │  │  Work Queue  │  │  Monitor   │ │
│  │             │  │              │  │            │ │
│  │ cron/launchd│  │ Phase 1-5    │  │ Logs       │ │
│  │ triggers    │──▶│ tasks        │  │ Health     │ │
│  │             │  │              │  │ Progress   │ │
│  └─────────────┘  └──────┬───────┘  └────────────┘ │
│                          │                           │
│  ┌───────────────────────▼───────────────────────┐  │
│  │              Processing Pipeline               │  │
│  │                                                │  │
│  │  Phase 1: INGEST                               │  │
│  │    Sync new conversations → parse → embed      │  │
│  │                                                │  │
│  │  Phase 2: EXTRACT                              │  │
│  │    Analyze new exchanges → extract facts →     │  │
│  │    extract entities → detect relationships     │  │
│  │                                                │  │
│  │  Phase 3: CONSOLIDATE                          │  │
│  │    Deduplicate memories → resolve conflicts →  │  │
│  │    merge similar entities → update graph       │  │
│  │                                                │  │
│  │  Phase 4: REFLECT                              │  │
│  │    Community detection → generate MOCs →       │  │
│  │    find bridge entities → temporal analysis →  │  │
│  │    higher-order observations                   │  │
│  │                                                │  │
│  │  Phase 5: PRUNE                                │  │
│  │    Decay scores → archive low-confidence →     │  │
│  │    merge redundant entities → clean orphans    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │              Intelligence Layer                 │  │
│  │                                                │  │
│  │  Local LLM (MLX) for:                          │  │
│  │  - Fact extraction from conversations          │  │
│  │  - Entity recognition and normalization        │  │
│  │  - Conflict detection and resolution proposals │  │
│  │  - Reflection summaries and observations       │  │
│  │  - Deciding processing priority                │  │
│  │                                                │  │
│  │  Falls back to Claude API when:                │  │
│  │  - Local model confidence is low               │  │
│  │  - Complex reasoning needed (conflict resolve) │  │
│  │  - Reflection phase (higher-order patterns)    │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Daemon Lifecycle

**Scheduling**: macOS `launchd` plist for reliable scheduling (survives logout/reboot)

```xml
<!-- ~/Library/LaunchAgents/com.engram.dreamstate.plist -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.engram.dreamstate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/engram</string>
        <string>dream</string>
        <string>--phases</string>
        <string>all</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>2</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>~/.local/share/engram/logs/dream.log</string>
    <key>StandardErrorPath</key>
    <string>~/.local/share/engram/logs/dream-error.log</string>
</dict>
</plist>
```

**Process Model**:
- Phases run sequentially (each depends on the previous)
- Within each phase, work items are processed with configurable concurrency
- Checkpointing: progress saved after each work item so crashes don't lose work
- Idempotent: safe to re-run any phase (skips already-processed items)

### Intelligence Layer

The daemon is "smarter" than simple polling because it includes an embedded reasoning layer:

**Local MLX Model** (primary — no API costs, no rate limits):
- Used for: fact extraction, entity recognition, simple conflict detection
- Model: Quantized Llama 3.1 8B or Qwen 2.5 7B via MLX
- Runs on M4 MacMini's Neural Engine efficiently

**Claude API** (fallback — for complex reasoning):
- Used for: reflection phase, complex conflict resolution, higher-order pattern synthesis
- Model: Claude Haiku (cost-efficient) with Sonnet fallback
- Rate-limited to avoid unexpected costs

**Decision Intelligence**:
The daemon doesn't just process everything linearly — it prioritizes:
- New conversations since last run (always first)
- Conversations with high tool diversity (likely problem-solving sessions)
- Conversations that mention entities already in the graph (reinforcement)
- Low-confidence memories due for re-evaluation
- Graph regions that have grown significantly (may need new MOCs)

### On-Demand Triggers

Besides the scheduled 2 AM run, the daemon can be triggered:
- `engram dream --phase ingest` — quick sync after a session
- `engram dream --phase reflect` — force a reflection pass
- `engram dream --conversation <uuid>` — process a specific conversation
- Session-start hook: lightweight ingest-only pass (non-blocking, background)

---

## Layer 5: Context Engineer (Retrieval Interface)

### Purpose
Controls how memories are formatted and injected into Claude's context window. This is the critical optimization layer for Opus 4.6.

### MCP Server Tools

```typescript
// Tool 1: Recall — intelligent memory retrieval
{
  name: "recall",
  description: "Retrieve relevant memories for the current context",
  input: {
    query: string,           // what to search for
    types?: string[],        // filter: ["episodic", "semantic", "graph"]
    budget?: number,         // max tokens to return (default: 1500)
    depth?: "shallow" | "deep"  // shallow = summaries, deep = full content
  }
}

// Tool 2: Remember — explicitly store a memory
{
  name: "remember",
  description: "Explicitly store something for future recall",
  input: {
    content: string,         // what to remember
    type: string,            // preference|decision|fact|pattern|solution|convention
    importance?: number      // 0.0-1.0
  }
}

// Tool 3: Explore — traverse the knowledge graph
{
  name: "explore",
  description: "Explore connections in the knowledge graph",
  input: {
    entity: string,          // starting entity name
    depth?: number,          // hops to traverse (default: 2)
    relationship_types?: string[]
  }
}

// Tool 4: Reflect — ask the system for insights
{
  name: "reflect",
  description: "Get higher-order observations and patterns",
  input: {
    topic?: string,          // focus area (optional)
    timeframe?: string       // "last week", "last month", "all time"
  }
}
```

### Retrieval Strategy

When `recall` is invoked:

```
1. Query Reformulation
   - Add task prefix: "search_query: {query}"
   - If query is short/ambiguous, expand with session context

2. Multi-Source Search (parallel)
   ├─ Episodic: hybrid vector+BM25 on exchanges → top 20
   ├─ Semantic: hybrid vector+BM25 on memories → top 20
   └─ Graph: entity lookup + 1-hop neighbors → related entities

3. Cross-Source Fusion
   - RRF merge all results
   - Boost semantic memories (they're pre-distilled, higher signal density)
   - Boost graph entities that connect to multiple results

4. Budget Enforcement
   - Rank by fusion score
   - Greedily fill token budget (1500 default)
   - Prefer: semantic memories > conversation summaries > raw exchanges
   - Always include source pointers for traceability

5. Format for Context
   - XML structure for clear delineation:
   <engram_memory query="..." tokens_used="..." total_results="...">
     <semantic type="preference" confidence="0.92">
       User prefers Fish shell; all user-facing scripts must be Fish-compatible.
       Bash tool runs in Bash, but tmux/generated commands must target Fish.
     </semantic>
     <semantic type="decision" confidence="0.87">
       SQLite chosen over Postgres for portability in local-first tools.
       Source: engram design session, 2026-02-25
     </semantic>
     <episodic date="2026-02-20" project="nova-voice" similarity="0.84">
       Daemon architecture: launchd for scheduling, MLX for local inference,
       Claude API fallback for complex reasoning. Heartbeat + hook pattern.
     </episodic>
     <graph entity="SQLite" connections="12">
       Related: better-sqlite3, sqlite-vec, FTS5, WAL mode, episodic-memory
     </graph>
   </engram_memory>
```

### Placement Strategy

Memories are injected in the **primacy zone** (early in context) to avoid the "lost in the middle" effect. The MCP server returns formatted XML that Claude naturally places near the top of its working context.

---

## Data Migration Plan

### Phase 1: Port Episodic Data

```
Source: ~/.config/superpowers/conversation-index/db.sqlite
Target: ~/.local/share/engram/engram.db

Steps:
1. Read all exchanges from source database
2. Re-embed with nomic-embed-text-v1.5 @ 256 dims (replacing all-MiniLM-L6-v2 @ 384 dims)
3. Index into FTS5 virtual table (new — source only has LIKE search)
4. Import conversation summaries from parallel -summary.txt files
5. Import tool_calls table (schema compatible)
6. Port archive files from ~/.config/superpowers/conversation-archive/
```

### Phase 2: Bootstrap Semantic Layer

```
Run dream state on entire historical dataset:
1. Process each archived conversation through fact extraction
2. Build initial memory set (expect ~500-2000 semantic memories from history)
3. Deduplicate and set initial confidence scores
4. Extract entities and relationships
5. Build initial graph
```

### Phase 3: Bootstrap Knowledge Graph

```
1. Run community detection on initial graph
2. Generate first Maps of Content
3. Identify bridge entities
4. Run reflection pass for higher-order observations
5. Output: initial "state of knowledge" summary
```

---

## Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Node.js (TypeScript) | Claude Code plugin ecosystem compatibility |
| Database | SQLite + WAL | Local-first, single-file, excellent concurrency |
| Vector Search | sqlite-vec | Integrated with SQLite, no external service |
| Full-Text Search | SQLite FTS5 | Built-in, Porter stemming, efficient BM25 |
| Embeddings | nomic-embed-text-v1.5 via @xenova/transformers | Local, 8K context, MRL for flexible dims |
| Reranking | BGE Reranker via transformers.js (optional) | Local cross-encoder, significant quality boost |
| Local LLM | MLX via mlx-lm (Python) or llama.cpp | M4 Neural Engine, zero API cost |
| Cloud LLM | Claude API (Haiku/Sonnet) | Fallback for complex reasoning |
| Daemon | macOS launchd | Reliable scheduling, survives reboot |
| MCP Server | @modelcontextprotocol/sdk | Claude Code integration |
| Graph Analysis | Custom (community detection, centrality) | Lightweight, no heavy dependencies |
| CLI | Commander.js or yargs | Standard Node.js CLI |

### Directory Structure

```
engram/
├── SPEC.md                    # This document
├── CLAUDE.md                  # Project-specific Claude Code instructions
├── package.json
├── tsconfig.json
├── src/
│   ├── core/
│   │   ├── db.ts              # Database connection, migrations, schema
│   │   ├── config.ts          # Configuration management
│   │   └── types.ts           # Shared TypeScript types
│   ├── episodic/
│   │   ├── sync.ts            # Conversation file sync
│   │   ├── parser.ts          # JSONL → structured exchanges
│   │   ├── embeddings.ts      # nomic-embed-text-v1.5 wrapper
│   │   └── search.ts          # Hybrid vector + BM25 search
│   ├── semantic/
│   │   ├── extractor.ts       # Fact/preference/decision extraction
│   │   ├── consolidator.ts    # Deduplication, conflict detection
│   │   ├── memory.ts          # Memory CRUD and scoring
│   │   └── decay.ts           # Confidence decay model
│   ├── graph/
│   │   ├── entities.ts        # Entity extraction and normalization
│   │   ├── relationships.ts   # Relationship management
│   │   ├── analysis.ts        # Community detection, bridges, temporal
│   │   └── clusters.ts        # Topic cluster / MOC generation
│   ├── dream/
│   │   ├── daemon.ts          # Dream state orchestrator
│   │   ├── phases.ts          # Phase 1-5 implementations
│   │   ├── scheduler.ts       # Work queue and prioritization
│   │   └── intelligence.ts    # LLM interface (local MLX + Claude API)
│   ├── retrieval/
│   │   ├── recall.ts          # Multi-source search + fusion
│   │   ├── reranker.ts        # Cross-encoder reranking
│   │   ├── context.ts         # Token budgeting and formatting
│   │   └── placement.ts       # XML output for primacy placement
│   ├── migration/
│   │   ├── import-episodic.ts # Port from superpowers DB
│   │   └── bootstrap.ts       # Initial semantic + graph bootstrap
│   ├── mcp/
│   │   └── server.ts          # MCP server (recall, remember, explore, reflect)
│   └── cli/
│       ├── index.ts           # CLI entry point
│       ├── dream.ts           # Dream state commands
│       ├── search.ts          # Search commands
│       ├── stats.ts           # Statistics and health
│       └── migrate.ts         # Migration commands
├── prompts/
│   ├── extract-facts.md       # Fact extraction prompt template
│   ├── extract-entities.md    # Entity extraction prompt template
│   ├── resolve-conflict.md    # Conflict resolution prompt template
│   ├── reflect.md             # Reflection/observation prompt template
│   └── summarize.md           # Conversation summarization prompt template
├── launchd/
│   └── com.engram.dreamstate.plist  # macOS launchd configuration
├── tests/
│   ├── episodic/
│   ├── semantic/
│   ├── graph/
│   ├── dream/
│   └── retrieval/
└── scripts/
    ├── migrate.sh             # One-shot migration from episodic-memory
    ├── install-daemon.sh      # Install launchd plist
    └── health-check.sh        # Daemon health verification
```

---

## Implementation Phases

### Phase 0: Project Setup
- Initialize repo, TypeScript config, dependencies
- Database schema and migration system
- Basic CLI scaffolding

### Phase 1: Episodic Foundation
- Port sync and parser from existing plugin
- Replace embedding model (nomic-embed-text-v1.5)
- Implement FTS5 indexing
- Hybrid search with RRF fusion
- MCP server with `recall` tool (episodic only)
- **Milestone**: Drop-in replacement for current episodic-memory search

### Phase 2: Data Migration

**Source**: `~/.config/superpowers/conversation-index/db.sqlite` — 7,660 exchanges, 145,386 tool calls, 36 projects, 384d embeddings (all-MiniLM-L6-v2)
**Target**: `~/.local/share/engram/engram.db` — re-embedded at 256d (nomic-embed-text-v1.5), with FTS5

**Exclusions**: The `double-shot-latte` project (4,055 exchanges, 53% of source) is excluded — it contains only automated conversation-state classifier infrastructure noise (zero human-authored exchanges, 86% error responses). See analysis in [docs/research/data-migration-strategy.md](docs/research/data-migration-strategy.md).

**Effective migration scope**: ~3,605 exchanges, ~145K tool calls, ~35 projects. Estimated runtime: 3-6 minutes.

Tasks:
- Import script for superpowers database with double-shot-latte exclusion
- Schema mapping: derive `conversation_id` from `basename(archive_path, '.jsonl')`, `exchange_index` from `line_start` ordering, `token_estimate` via chars/4 heuristic. See [docs/research/data-migration-strategy.md](docs/research/data-migration-strategy.md)
- Fix Matryoshka truncation bug in `embeddings.ts` — missing `layer_norm` before slice. See [docs/research/data-migration-strategy.md](docs/research/data-migration-strategy.md)
- Re-embed all historical exchanges with corrected nomic-embed-text-v1.5 pipeline (batch size 32, ~40-80 exchanges/sec). See [docs/research/sqlite-bulk-operations.md](docs/research/sqlite-bulk-operations.md)
- Populate FTS5 via `rebuild` command after bulk insert (sub-second at this scale). See [docs/research/sqlite-bulk-operations.md](docs/research/sqlite-bulk-operations.md)
- Build conversations table from `GROUP BY archive_path` aggregation
- Score normalization: apply min-max with floor to RRF fusion scores for intuitive 0-100% display. See [docs/score-normalization.md](docs/score-normalization.md) and [docs/research/score-normalization-strategies.md](docs/research/score-normalization-strategies.md)
- Verify search quality: NDCG@5 primary metric, A/B comparison against old system with 30-50 test queries. See [docs/research/search-quality-evaluation.md](docs/research/search-quality-evaluation.md)
- Cross-encoder reranking available (`Xenova/bge-reranker-base`, ~50-150ms) but default OFF to isolate variables
- **Milestone**: All historical data accessible via new system with improved search quality

### Phase 3: Semantic Extraction

The semantic layer transforms raw episodic data into distilled knowledge — the core differentiator between engram and conversation search. Research across Mem0, Zep/Graphiti, LangMem, Letta, and EverMemOS validates the extraction→dedup→conflict→index pipeline architecture. The key design decisions below are informed by four research documents:

- [Extraction techniques and prompt patterns](docs/research/semantic-extraction-techniques.md)
- [Deduplication, conflict detection, and decay models](docs/research/deduplication-conflict-detection.md)
- [Memory architecture comparisons and schema validation](docs/research/memory-architectures-schemas.md)
- [Local inference options and hybrid architecture](docs/research/local-inference-nli-models.md)

**Extraction Pipeline** (see Layer 2 Extraction Pipeline for full flow):
- Three-tier intelligence: local LLM (Qwen 3 8B Q4_K_M via MLX) → Claude Haiku 4.5 → Claude Sonnet, with confidence-based routing at 0.8 threshold. Rationale: local-first honors the offline-capable principle; cloud fallback ensures quality for complex conversations. At 100-500 conversations/night, hybrid costs ~$5-15/month vs $37.50 cloud-only. See [local-inference-nli-models.md §6](docs/research/local-inference-nli-models.md).
- Claude tool use with `strict: true` for guaranteed schema compliance (constrained decoding for local models). Rationale: all surveyed production systems enforce structured output; prompt-only JSON is unreliable. See [semantic-extraction-techniques.md §1.1](docs/research/semantic-extraction-techniques.md).
- Atomic fact decomposition: complex statements split into discrete, independently verifiable claims. Rationale: improves dedup precision, retrieval granularity, and conflict detection. Validated by AFEV framework. See [semantic-extraction-techniques.md §1.2](docs/research/semantic-extraction-techniques.md).
- Whole-conversation extraction as primary approach (not per-turn). For >100 turns, overlapping windows of 20-30 turns with 5-turn overlap. Rationale: engram processes history after-the-fact, so full context is available. See [semantic-extraction-techniques.md §4.3](docs/research/semantic-extraction-techniques.md).
- Optional reflexion pass: second LLM call reviews extraction for missed facts. Rationale: Zep/Graphiti show this catches implicit preferences and unstated assumptions. See [semantic-extraction-techniques.md §1.3](docs/research/semantic-extraction-techniques.md).

**Memory CRUD with confidence scoring:**
- Six memory types (preference, decision, pattern, fact, solution, convention) validated against production taxonomy. Mem0, LangMem, and Bedrock AgentCore converge on similar categories. See [memory-architectures-schemas.md §1.2](docs/research/memory-architectures-schemas.md).
- FSRS-inspired confidence model with per-memory stability, Bayesian corroboration factor, and three-factor retrieval scoring (0.55 relevance + 0.25 recency + 0.20 importance). Rationale: FSRS produces 20-30% fewer false decays than fixed-lambda exponential; corroboration factor ensures multi-source memories are more durable. See [deduplication-conflict-detection.md §5.3](docs/research/deduplication-conflict-detection.md).
- Importance scored by LLM at extraction (Park et al. 1-10 scale), dynamically boosted on access. Rationale: static importance is insufficient; memories that keep getting retrieved should gain importance. See [memory-architectures-schemas.md §3.3](docs/research/memory-architectures-schemas.md).

**Deduplication and conflict detection:**
- Tiered cosine similarity thresholds: >= 0.95 auto-merge, 0.85-0.95 NLI check, < 0.85 distinct. Production-validated by Cognee, FalkorDB, SemDeDup. See [deduplication-conflict-detection.md §1.2](docs/research/deduplication-conflict-detection.md).
- NLI contradiction detection via DeBERTa-v3-base cross-encoder in transformers.js/ONNX (~30ms per pair, ~90% MNLI accuracy). Runs entirely in Node.js with no Python dependency. See [local-inference-nli-models.md §1](docs/research/local-inference-nli-models.md).
- Conflict resolution: temporal recency > explicit correction > corroboration count > source reliability. Superseded memories marked (not deleted) with `superseded_by` link. See [deduplication-conflict-detection.md §2.3](docs/research/deduplication-conflict-detection.md).

**Semantic search integration into `recall`:**
- Extend hybrid search to query both episodic and semantic stores in parallel
- RRF fusion across all sources, with semantic memories boosted (higher signal density)
- Token budget allocation: prefer semantic memories > conversation summaries > raw exchanges

**`remember` MCP tool:**
- Explicit memory creation with type, content, and optional importance
- Bypass extraction pipeline — direct insert with high base confidence (user-stated)
- Deduplicate against existing memories before insert

**New dependency**: `@xenova/transformers` for NLI cross-encoder (DeBERTa-v3-base ONNX). Already a dependency for embeddings — adds only the NLI model weights (~184MB).

Tasks:
- Implement `src/semantic/extractor.ts` — fact extraction with three-tier intelligence routing
- Implement `src/semantic/consolidator.ts` — tiered dedup with NLI contradiction detection
- Implement `src/semantic/memory.ts` — CRUD operations, FSRS-inspired confidence, importance scoring
- Implement `src/semantic/decay.ts` — per-memory stability tracking, Bayesian corroboration
- Create `prompts/extract-facts.md` — extraction prompt template with few-shot examples
- Create `prompts/resolve-conflict.md` — conflict resolution prompt template
- Extend `src/episodic/search.ts` to support multi-source (episodic + semantic) search
- Extend `src/mcp/server.ts` with `remember` tool
- Add NLI pipeline initialization to embeddings module (DeBERTa-v3-base ONNX)
- Integration tests: extraction → dedup → conflict → retrieval end-to-end
- **Milestone**: System extracts and recalls distilled knowledge, with validated dedup and conflict detection

### Phase 4: Knowledge Graph

The knowledge graph layer transforms isolated semantic memories into a connected entity-relationship network — the Zettelkasten layer where backlinks surface connections that no individual memory anticipated. Research across Graphiti/Zep, Microsoft GraphRAG, iText2KG, and the graphology ecosystem validates the entity-extraction→resolution→graph-building→analysis pipeline. The key design decisions below are informed by three research documents:

- [Knowledge graph storage patterns, entity resolution, and SQLite traversal](docs/research/knowledge-graph-sqlite-implementation.md)
- [Entity extraction, relationship detection, and incremental graph building](docs/research/entity-extraction-knowledge-graphs.md)
- [Graph analysis algorithms, community detection, and graphology library](docs/research/graph-analysis-research.md)

**Entity Extraction Pipeline** (Graphiti-inspired separation of concerns):
- Two-step extraction: (1) extract entities, (2) extract relationships between resolved entities. Rationale: Graphiti evolved from a single mega-prompt to separate focused prompts — produces cleaner output and enables concurrent execution. See [entity-extraction-knowledge-graphs.md §3](docs/research/entity-extraction-knowledge-graphs.md).
- Entity types: `project`, `tool`, `technology`, `person`, `concept`, `file`, `repo` — validated against Graphiti and Microsoft GraphRAG type systems. See [entity-extraction-knowledge-graphs.md §1.1](docs/research/entity-extraction-knowledge-graphs.md).
- Relationship types: `uses`, `depends_on`, `related_to`, `part_of`, `configured_by`, `solved_by` — derived from developer conversation patterns. See [entity-extraction-knowledge-graphs.md §2](docs/research/entity-extraction-knowledge-graphs.md).
- Claude tool use with `strict: true` for guaranteed schema compliance, reusing the Phase 3 extraction pattern. Same three-tier routing: local → Haiku → Sonnet.
- Coreference resolution instruction in entity extraction prompt: "Replace all pronouns and informal references with specific entity names." See [entity-extraction-knowledge-graphs.md §1.2](docs/research/entity-extraction-knowledge-graphs.md).

**Entity Resolution and Normalization:**
- Four-stage cascading pipeline: (1) exact name match, (2) alias lookup, (3) embedding cosine similarity via vec_entities, (4) LLM verification for ambiguous cases. Rationale: production systems (Graphiti, iText2KG) converge on hybrid search + LLM verification. See [knowledge-graph-sqlite-implementation.md §2](docs/research/knowledge-graph-sqlite-implementation.md).
- Similarity thresholds: ≥0.95 auto-merge, 0.85-0.95 likely match (merge with LLM confirmation), 0.70-0.85 review zone, <0.70 distinct entity. Validated by iText2KG (0.7 threshold) and Graphiti (embedding + full-text + LLM). See [entity-extraction-knowledge-graphs.md §4](docs/research/entity-extraction-knowledge-graphs.md).
- Alias management: canonical name selection with alias tracking. When entities merge, the more frequent name becomes canonical and the other becomes an alias. See [knowledge-graph-sqlite-implementation.md §2](docs/research/knowledge-graph-sqlite-implementation.md).

**Graph Storage and Traversal:**
- Existing `entities` + `relationships` edge table pattern is validated. Add composite unique constraint on `(source_entity_id, target_entity_id, type)` to prevent duplicate edges. See [knowledge-graph-sqlite-implementation.md §1](docs/research/knowledge-graph-sqlite-implementation.md).
- SQLite recursive CTEs for simple 1-2 hop traversal with depth limits and cycle prevention. For complex multi-hop analysis, load graph into graphology in-memory (loading 10K entities + 50K relationships takes <100ms, <50MB RAM). See [graph-analysis-research.md §4](docs/research/graph-analysis-research.md).
- Add FTS5 on entity names/descriptions for text-based entity search alongside vector search on vec_entities. See [knowledge-graph-sqlite-implementation.md §7](docs/research/knowledge-graph-sqlite-implementation.md).

**Graph Analysis (graphology library):**
- `graphology` selected as the graph analysis library — pure data structure with zero visualization dependencies, comprehensive algorithm packages, native TypeScript, active maintenance (~571K weekly npm downloads). See [graph-analysis-research.md §1](docs/research/graph-analysis-research.md).
- Packages needed: `graphology`, `graphology-communities-louvain`, `graphology-metrics`, `graphology-traversal`, `graphology-shortest-path`, `graphology-components` — adds ~2-3MB with zero viz overhead. See [graph-analysis-research.md §1](docs/research/graph-analysis-research.md).
- Louvain community detection for topic cluster generation (Leiden algorithm preferred theoretically but no maintained JS/TS implementation). At engram's expected scale (100-10K nodes), Louvain runs in ~50ms. See [graph-analysis-research.md §2](docs/research/graph-analysis-research.md).
- Bridge detection via betweenness centrality (graphology-metrics): identify entities that connect otherwise-separate communities — the "surprising connections." See [graph-analysis-research.md §3](docs/research/graph-analysis-research.md).
- Edge weight scoring: four-factor model combining frequency (35%), recency (25%), extraction confidence (20%), and connected entity importance (20%). Uses same power-law decay formula as FSRS memory model for conceptual consistency. See [graph-analysis-research.md §7](docs/research/graph-analysis-research.md).

**`explore` MCP Tool:**
- Entity-centric graph navigation with configurable traversal depth (default 2 hops)
- Five query patterns: entity lookup, neighborhood traversal, path finding, community membership, related entities by type
- XML output format consistent with existing `recall` tool: `<graph entity="..." connections="...">` tags
- Zero LLM calls at query time — all intelligence is in the indexing phase (Graphiti pattern)

**Graph-enhanced `recall`:**
- Extend multi-source search to include graph results alongside episodic and semantic
- Entity lookup + 1-hop neighbor expansion enriches recall results with related entities
- RRF fusion across all three sources, with graph entities that connect to multiple results boosted

**New dependencies**: `graphology`, `graphology-communities-louvain`, `graphology-metrics`, `graphology-traversal`, `graphology-shortest-path`, `graphology-components`

Tasks:
- Implement `src/graph/entities.ts` — entity CRUD with FTS5/vec0 sync, alias management
- Implement `src/graph/relationships.ts` — relationship CRUD, weight management, bidirectional traversal
- Implement `src/graph/extractor.ts` — LLM-based entity+relationship extraction from conversations/memories
- Implement `src/graph/resolver.ts` — four-stage entity resolution pipeline (exact→alias→embedding→LLM)
- Implement `src/graph/search.ts` — hybrid entity search (vector + FTS), neighborhood queries
- Implement `src/graph/analysis.ts` — graphology integration for community detection, centrality, bridge detection
- Create `prompts/extract-entities.md` — entity extraction prompt with developer-domain few-shot examples
- Create `prompts/extract-relationships.md` — relationship extraction prompt
- Extend `src/core/db.ts` with FTS5 for entities, unique constraints on relationships
- Extend `src/mcp/server.ts` with `explore` tool
- Extend `src/episodic/search.ts` to include graph results in multi-source search
- Add `src/cli/index.ts` graph commands: `entities`, `relationships`, `explore`
- Integration tests: extraction → resolution → graph building → traversal → search end-to-end
- **Milestone**: Entity-relationship queries work, graph analysis produces topic clusters

### Phase 5: Dream State Daemon

**Research documents:**
- [Codebase readiness assessment and gap analysis](docs/research/phase-5-codebase-readiness.md)
- [macOS launchd daemon patterns for Node.js](docs/research/daemon-launchd-patterns.md)
- [MLX/Ollama local LLM integration strategies](docs/research/mlx-local-llm-integration.md)
- [Checkpoint and resume patterns for pipelines](docs/research/checkpoint-resume-patterns.md)
- [Memory consolidation pipeline patterns (Graphiti, GraphRAG, Mem0)](docs/research/memory-consolidation-pipelines.md)

**Codebase readiness**: Phases 1-4 delivered all processing components. Phase 5 is primarily **orchestration work** — composing `syncConversations()`, `extractFromConversation()`, `consolidateFacts()`, `extractEntities()`, `resolveEntities()`, `extractRelationships()`, `findOrCreateRelationship()`, `analyzeGraph()`, and `isPruneEligible()` into an autonomous pipeline. The database schema already has `dream_runs` and `dream_checkpoints` tables. Types (`DreamPhase`, `DreamProgress`, `DreamReport`) and config (`dream.localModel`, `dream.scheduleHour`, `dream.concurrency`) are pre-defined.

**Pipeline orchestrator** (`src/dream/daemon.ts`):
- Sequential five-phase pipeline: INGEST → EXTRACT → CONSOLIDATE → REFLECT → PRUNE
- Full composition of the extraction pipeline (the key gap identified in codebase analysis): semantic fact extraction + entity extraction + entity resolution + relationship extraction + relationship persistence + fact consolidation — composed per-conversation in a single `processConversation()` function
- Run tracking via `dream_runs` table (started_at, completed_at, phases_completed, error stats)
- See [phase-5-codebase-readiness.md §F.3](docs/research/phase-5-codebase-readiness.md) for the full pipeline composition pattern

**Checkpoint and resume** (`src/dream/scheduler.ts`):
- Per-conversation checkpointing using SQLite transactions — each conversation's results committed atomically. See [checkpoint-resume-patterns.md §3](docs/research/checkpoint-resume-patterns.md)
- Run resumption: incomplete `dream_runs` (has `started_at` but no `completed_at`) are resumed, skipping already-checkpointed items
- Idempotent processing: content-addressed IDs, upsert semantics, safe to re-run any phase
- Error handling: skip-and-continue for extraction failures (non-fatal), fail-fast for infrastructure errors (DB corruption). See [checkpoint-resume-patterns.md §7](docs/research/checkpoint-resume-patterns.md)
- Priority scheduling: new conversations first, then by tool diversity and entity graph overlap. See [memory-consolidation-pipelines.md §7](docs/research/memory-consolidation-pipelines.md)

**Local LLM integration** (`src/dream/intelligence.ts`):
- Ollama REST API as default provider (grammar-enforced JSON schema output, widely installed, simpler than raw MLX subprocess). See [mlx-local-llm-integration.md §4](docs/research/mlx-local-llm-integration.md)
- Model: Qwen 2.5 7B Instruct (4-bit), ~50-65 tok/s on M4, ~4.5 GB memory. See [mlx-local-llm-integration.md §2](docs/research/mlx-local-llm-integration.md)
- Confidence-based routing: local extraction confidence ≥ 0.8 → accept; < 0.8 → escalate to Claude Haiku API
- Unified interface: `LocalModelAdapter` with `isAvailable()`, `generate()`, `generateStructured()` methods
- Graceful degradation: if Ollama unavailable, falls back to API extraction (existing Haiku → Sonnet tier)

**launchd integration**:
- Launch Agent (not Daemon) with `StartCalendarInterval` — runs at 2 AM, processes all pending work, exits cleanly. See [daemon-launchd-patterns.md §2](docs/research/daemon-launchd-patterns.md)
- PID lock file prevents concurrent runs
- Signal handling: SIGTERM (graceful phase completion), SIGINT (immediate checkpoint + exit)
- Install/uninstall script at `scripts/install-daemon.sh`

**CLI `dream` command**:
- `engram dream` — run all phases
- `engram dream --phase ingest` — quick sync after a session
- `engram dream --phase reflect` — force a reflection pass
- `engram dream --conversation <uuid>` — process a specific conversation
- `engram dream --dry-run` — show what would be processed
- `engram dream --verbose` — detailed progress output

**Memory pruning** (PRUNE phase):
- Iterate all active memories, compute `isPruneEligible()` (confidence < 0.1 threshold)
- Eligible memories: set `is_active = 0`, record in `dream_runs.memories_pruned`
- Existing `decay.ts` functions handle all decay math; the daemon just needs the iteration loop

**New files**:
- `src/dream/daemon.ts` — pipeline orchestrator
- `src/dream/scheduler.ts` — work queue, checkpoint tracking, priority scoring
- `src/dream/intelligence.ts` — local LLM adapter (Ollama/MLX) with API fallback
- `launchd/com.engram.dreamstate.plist` — macOS launchd configuration
- `scripts/install-daemon.sh` — daemon install/uninstall helper
- `tests/dream/daemon.test.ts` — orchestrator tests
- `tests/dream/scheduler.test.ts` — checkpoint/scheduler tests

**Modified files**:
- `src/cli/index.ts` — add `dream` command handler
- `src/semantic/extractor.ts` — implement `"local"` tier in `resolveModels()` (currently throws)

**No modifications needed**: All pipeline components from Phases 1-4 are complete and tested.

- **Milestone**: Autonomous background processing

### Phase 6: Reflection & Emergence
- Community detection algorithm
- Maps of Content generation
- Bridge entity identification
- Temporal pattern analysis
- `reflect` MCP tool
- Phase 4-5 dream processing (reflect, prune)
- **Milestone**: System discovers emergent patterns

### Phase 7: Optimization & Polish
- Cross-encoder reranking
- Context budget tuning
- Performance optimization (batch operations, caching)
- Claude Code plugin packaging
- Documentation and user guide
- **Milestone**: Production-ready system

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|---------------|
| Retrieval relevance | >85% of recalls return useful results | Sample 50 queries, rate relevance |
| Token efficiency | <2,000 tokens per recall | Measure output size |
| Semantic coverage | >80% of user preferences captured | Compare extracted memories to known preferences |
| Graph connectivity | Average entity has 3+ relationships | Graph statistics |
| Dream latency | Full run <30 minutes | Time daemon execution |
| Search latency | <500ms for recall queries | Benchmark search path |
| Memory accuracy | <5% contradiction rate | Audit semantic memories |
| Emergent discovery | System surfaces non-obvious connections | Qualitative evaluation |

---

## Open Questions

1. **Local LLM selection**: MLX Llama 3.1 8B vs Qwen 2.5 7B for extraction quality vs speed?
2. **Reranker necessity**: Is cross-encoder reranking worth the latency for typical queries?
3. **Graph algorithm**: Louvain vs Label Propagation for community detection?
4. **Conflict resolution**: Auto-resolve via LLM or flag for user review?
5. **Multi-user**: Is this ever multi-user, or strictly single-user local?
6. **PKM integration**: Should Engram also index `~/markdown-notes/` or stay scoped to Claude conversations?
7. **Plugin distribution**: Claude Code plugin marketplace or standalone tool?
