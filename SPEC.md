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

During dream state processing, each new conversation is analyzed:

```
Input: Raw conversation exchanges
  │
  ▼
Fact Extraction (Claude Haiku)
  Prompt: "Extract discrete facts, preferences, decisions,
           patterns, and solutions from this conversation.
           For each, provide: type, content (1-3 sentences),
           importance (0-1), and which exchanges support it."
  │
  ▼
Deduplication Check
  For each extracted memory:
  - Embed and search existing memories (cosine similarity > 0.85)
  - If near-duplicate found: reinforce (bump confidence + access_count)
  - If contradiction found: log conflict, keep both until resolved
  - If novel: insert new memory
  │
  ▼
Embedding + Indexing
  Embed memory content with nomic-embed-text-v1.5
  Index in vec_memories and memories_fts
```

### Confidence & Decay Model

```
confidence(t) = base_confidence × reinforcement_factor × decay_factor

reinforcement_factor = 1 + log(1 + access_count)
decay_factor = exp(-λ × days_since_last_access)

where:
  λ = 0.01 for preferences (slow decay — user preferences are stable)
  λ = 0.02 for decisions (medium decay — architectural choices evolve)
  λ = 0.05 for facts (faster decay — factual details change)
  λ = 0.005 for patterns (very slow decay — behavioral patterns are persistent)
  λ = 0.03 for solutions (medium decay — solutions become outdated)
```

Memories with `confidence < 0.1` are candidates for pruning during dream state.

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
- Fact extraction pipeline (Claude Haiku)
- Memory CRUD with confidence scoring
- Deduplication and conflict detection
- Semantic search integration into `recall`
- `remember` MCP tool
- **Milestone**: System extracts and recalls distilled knowledge

### Phase 4: Knowledge Graph
- Entity extraction and normalization
- Relationship detection
- Graph storage and traversal
- `explore` MCP tool
- **Milestone**: Entity-relationship queries work

### Phase 5: Dream State Daemon
- Daemon process with launchd integration
- Phase 1-3 processing pipeline (ingest, extract, consolidate)
- Local MLX integration for cost-free extraction
- Checkpoint and resume support
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
