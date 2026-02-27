# Engram System Architecture

Technical overview of the Engram cognitive memory system — layers, data flow, modules, and key algorithms.

---

## System Diagram

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

---

## Layer Architecture

### Layer 1: Episodic Store

Raw conversation exchanges indexed for retrieval. This is the foundation layer — structurally similar to conversation search but with richer metadata and hybrid search.

**Database tables:** `exchanges`, `exchanges_fts` (FTS5), `vec_exchanges` (sqlite-vec), `tool_calls`, `conversations`

**Key capabilities:**
- Contextual chunking with metadata prefix (project, date, branch, topic)
- Hybrid vector + BM25 search with RRF fusion
- Token estimation for budget enforcement

### Layer 2: Semantic Store

Extracted, consolidated knowledge derived from episodic memories. The layer that makes Engram a cognitive system rather than just search.

**Database tables:** `memories`, `vec_memories` (sqlite-vec), `memories_fts` (FTS5), `conflicts`

**Memory types:** preference, decision, pattern, fact, solution, convention

**Key capabilities:**
- Tiered deduplication (cosine similarity + NLI contradiction check)
- Confidence decay model (FSRS-inspired with per-type stability)
- Conflict detection and resolution

### Layer 3: Knowledge Graph

Entity-relationship graph enabling multi-hop reasoning and emergent topic discovery.

**Database tables:** `entities`, `relationships`, `topic_clusters`, `vec_entities` (sqlite-vec)

**Entity types:** project, tool, technology, person, concept, file, repo

**Relationship types:** uses, depends_on, related_to, part_of, configured_by, solved_by

**Key capabilities:**
- Community detection (Louvain algorithm via graphology)
- Bridge entity identification (betweenness centrality)
- Temporal pattern detection
- Auto-generated community names

### Layer 4: Dream State Daemon

Background process that performs memory consolidation — the computational equivalent of sleep-stage memory processing. Runs via macOS launchd.

---

## Data Flow

```
Claude Code conversations (~/.claude/projects/*/...)
  │
  ▼ [engram sync / dream --phase ingest]
  │
  ├── Parse JSONL → Exchange objects
  ├── Generate embeddings (nomic-embed-text-v1.5 @ 256 dims)
  ├── Index in SQLite + FTS5 + sqlite-vec
  │
  ▼ [dream --phase extract]
  │
  ├── Chunk conversations (20-30 turns, 5-turn overlap)
  ├── LLM extraction → atomic facts (type, content, importance)
  ├── LLM extraction → entities + relationships
  ├── Optional reflexion pass for completeness
  │
  ▼ [dream --phase consolidate]
  │
  ├── Embed extracted facts
  ├── Deduplication: cosine >= 0.95 → auto-merge
  ├── Deduplication: cosine 0.85-0.95 → NLI check
  ├── Conflict resolution: temporal recency > explicit correction
  ├── Entity resolution: merge aliases, normalize names
  │
  ▼ [dream --phase reflect]
  │
  ├── Build graphology graph from entities + relationships
  ├── Louvain community detection → topic clusters
  ├── Betweenness centrality → bridge entities
  ├── Temporal co-occurrence → patterns
  ├── LLM → higher-order observations
  │
  ▼ [dream --phase prune]
  │
  ├── Apply FSRS decay to confidence scores
  ├── Archive memories with confidence < 0.1
  ├── Merge redundant entities
  └── Clean orphan nodes
```

---

## Module Map

### `src/core/` — Foundation

| File | Responsibility |
|------|---------------|
| `types.ts` | All TypeScript interfaces and type definitions |
| `config.ts` | Configuration loading with environment variable overrides |
| `db.ts` | SQLite database initialization, schema creation, PRAGMA tuning |
| `cache.ts` | LRU cache with TTL for embeddings, search results, graph analysis |

### `src/episodic/` — Episodic Memory Layer

| File | Responsibility |
|------|---------------|
| `parser.ts` | JSONL conversation file parsing into Exchange objects |
| `store.ts` | Exchange and conversation CRUD operations |
| `sync.ts` | Conversation discovery, diffing, and indexing orchestration |
| `embeddings.ts` | Embedding model loading, document/query embedding, batch processing |
| `search.ts` | Hybrid search (vector + BM25 + RRF fusion), XML formatting |

### `src/semantic/` — Semantic Memory Layer

| File | Responsibility |
|------|---------------|
| `extractor.ts` | LLM-based fact extraction from conversations (tiered: local → Haiku → Sonnet) |
| `consolidator.ts` | Deduplication, merging, and conflict detection for extracted facts |
| `memory.ts` | Memory CRUD, nearest-neighbor search, access tracking |
| `decay.ts` | FSRS-inspired confidence decay model |
| `nli.ts` | Natural Language Inference for contradiction detection (DeBERTa-v3) |
| `search.ts` | Semantic memory search (vector + FTS) |
| `types.ts` | Semantic layer-specific types |

### `src/graph/` — Knowledge Graph Layer

| File | Responsibility |
|------|---------------|
| `extractor.ts` | LLM-based entity and relationship extraction |
| `entity.ts` | Entity CRUD, alias management, FTS search |
| `relationship.ts` | Relationship CRUD, weight updates |
| `resolver.ts` | Entity resolution — merging duplicates, normalizing names |
| `search.ts` | Graph traversal for the `explore` tool |
| `analyzer.ts` | Community detection (Louvain), centrality analysis, bridge detection |
| `naming.ts` | LLM-based community naming |
| `reflection.ts` | Reflection orchestration — communities, bridges, temporal, observations |
| `temporal.ts` | Temporal pattern detection (phase transitions, co-occurrence) |
| `types.ts` | Graph layer-specific types (ReflectResult, CommunityInfo, etc.) |

### `src/dream/` — Dream State Daemon

| File | Responsibility |
|------|---------------|
| `daemon.ts` | Main dream pipeline orchestrator — runs phases in sequence |
| `scheduler.ts` | Phase scheduling and checkpoint management |
| `intelligence.ts` | LLM routing (local → API), confidence-based tier selection |

### `src/mcp/` — MCP Server

| File | Responsibility |
|------|---------------|
| `server.ts` | MCP server setup, tool definitions, request handlers |

### `src/cli/` — Command-Line Interface

| File | Responsibility |
|------|---------------|
| `index.ts` | Commander.js CLI with all 15 subcommands |

### `src/migration/` — Data Migration

| File | Responsibility |
|------|---------------|
| `migrate.ts` | Migration from superpowers conversation-index DB |
| `validate.ts` | Post-migration integrity validation |
| `types.ts` | Migration-specific types |

---

## Search Pipeline

```
Query: "how did we set up the database?"
  │
  ▼ Embed query
  │  nomic-embed-text-v1.5 with "search_query:" prefix → float[256]
  │
  ├──▶ Vector search (sqlite-vec)
  │    SELECT top-20 by cosine distance from vec_exchanges + vec_memories
  │
  ├──▶ BM25 search (FTS5)
  │    SELECT top-20 from exchanges_fts + memories_fts using porter tokenizer
  │
  ▼ RRF Fusion
  │  score = Σ 1/(k + rank_i) where k=60
  │  Merge vector + BM25 results, sort by fused score
  │
  ▼ Cross-Encoder Reranking (optional)
  │  Xenova/bge-reranker-base scores top-20 query-document pairs
  │  final = 0.7 × reranker_score + 0.3 × rrf_score
  │  Return top-5
  │
  ▼ Context Budget
  │  Priority: semantic memories > graph entities > conversation summaries > raw exchanges
  │  Greedy fill until token budget reached (default: 1500)
  │  Token estimation: chars/4 × 1.1 safety factor
  │
  ▼ XML Formatting
     <engram_recall query="..." results="..." tokens="...">
       <memory>...</memory>
       <exchange>...</exchange>
     </engram_recall>
```

---

## Dream Pipeline

### Phase 1: INGEST

Syncs new conversation files from `~/.claude/projects/`, parses JSONL into exchanges, generates embeddings, and indexes in the database. Tracks last-indexed timestamp to only process new content.

### Phase 2: EXTRACT

For each new conversation:
1. Chunk into overlapping windows (20-30 turns, 5-turn overlap)
2. Three-tier LLM extraction: local MLX → Claude Haiku → Claude Sonnet
3. Extract atomic facts with type, content, importance, source exchanges
4. Extract entities with type, name, description, aliases
5. Extract relationships between entities
6. Optional reflexion pass for completeness

### Phase 3: CONSOLIDATE

For each extracted fact:
1. Embed and search existing memories
2. Cosine >= 0.95: auto-merge (bump confidence and access count)
3. Cosine 0.85-0.95: NLI check (DeBERTa-v3-base)
   - Entailment > 0.7 → merge as reinforcement
   - Contradiction > 0.7 → log conflict, keep both
   - Neutral → insert as distinct
4. Cosine < 0.85: insert as novel memory

For entities: resolve aliases, merge duplicates, normalize names.

### Phase 4: REFLECT

1. Build graphology graph from entities and relationships
2. Louvain community detection → topic clusters with coherence scores
3. LLM-generated community names and descriptions
4. Betweenness centrality → bridge entities spanning communities
5. Temporal co-occurrence analysis → phase transitions, activity patterns
6. LLM-generated higher-order observations

### Phase 5: PRUNE

1. Apply FSRS-inspired decay: `confidence(t) = base × corroboration × 0.9^(days/stability)`
2. Archive memories with confidence < 0.1 (preserved with full provenance)
3. Merge redundant entities with overlapping aliases
4. Clean orphan nodes with no relationships

---

## Database Tables

### Episodic Layer

| Table | Purpose |
|-------|---------|
| `exchanges` | Raw conversation turns with metadata (project, timestamp, git branch, etc.) |
| `exchanges_fts` | FTS5 full-text index on user/assistant messages |
| `vec_exchanges` | sqlite-vec vector index (256-dim embeddings) |
| `tool_calls` | Tool usage tracking linked to exchanges |
| `conversations` | Conversation-level metadata, summaries, and archive paths |

### Semantic Layer

| Table | Purpose |
|-------|---------|
| `memories` | Extracted facts with type, confidence, importance, decay tracking |
| `vec_memories` | sqlite-vec vector index for semantic memory search |
| `memories_fts` | FTS5 full-text index on memory content |
| `conflicts` | Contradiction log between memories |

### Graph Layer

| Table | Purpose |
|-------|---------|
| `entities` | Named entities with type, aliases, mention count |
| `relationships` | Typed, weighted edges between entities |
| `topic_clusters` | Emergent topic groupings (Maps of Content) |
| `vec_entities` | sqlite-vec vector index for entity search |

---

## Key Algorithms

### Reciprocal Rank Fusion (RRF)

Merges results from multiple search methods (vector + BM25) into a single ranked list:

```
score(d) = Σ_r 1 / (k + rank_r(d))
```

Where `k = 60` (fusion constant) and `rank_r(d)` is the rank of document `d` in result set `r`. Higher k values reduce the influence of high-ranked outliers.

### FSRS Confidence Decay

Each memory has a stability value that grows with successful access:

```
confidence(t) = base_confidence × corroboration_factor × decay_factor

corroboration_factor = min(1.0, 0.5 + 0.1 × num_confirmations)
decay_factor = 0.9 ^ (days_since_last_access / stability)

On access: stability *= (1 + growth_rate × (1 - R))
  where R is retrievability at access time ("desirable difficulty")
On contradiction: stability *= 0.8
```

Initial stability varies by memory type: preferences (90 days) decay slowest, facts (30 days) decay fastest.

### Louvain Community Detection

Iteratively optimizes modularity by moving nodes between communities:

1. Each node starts in its own community
2. For each node, compute modularity gain of moving to each neighbor's community
3. Move to the community with highest positive gain
4. Repeat until no moves improve modularity
5. Build a new graph where communities become nodes
6. Repeat from step 1

Implemented via `graphology-communities-louvain`. Communities become topic clusters with coherence scores based on internal vs external edge density.

### Retrieval Scoring

At query time, results are scored with a three-factor model:

```
retrieval_score = 0.55 × relevance + 0.25 × recency + 0.20 × importance
```

Relevance comes from RRF-fused search scores, recency from the decay factor, and importance from LLM-judged extraction scores.
