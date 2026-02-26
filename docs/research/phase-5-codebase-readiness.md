# Phase 5 Codebase Readiness Assessment: Dream State Daemon

> Research Date: 2026-02-26
> Analyst: Claude Sonnet 4.6 (automated codebase analysis)
> Branch: worktree-phase-5
> Last Commit: 45244f1 (test(graph): add end-to-end knowledge graph integration tests)

---

## Executive Summary

The engram codebase is **highly ready** for Phase 5 implementation. Phases 1–4 have delivered a complete processing pipeline with all major components already implemented, tested, and integrated. Phase 5 requires building the **orchestration layer** that ties these components together into an autonomous background process — not rebuilding the underlying logic.

**Readiness Verdict**: The core pipeline (ingest → extract → consolidate) is 100% implemented. Phase 5 is almost entirely orchestration, scheduling, and MLX integration work. The database schema even has dedicated tables for dream state tracking (`dream_runs`, `dream_checkpoints`) that exist today and are waiting to be used.

**Estimated new code required**: ~4–6 new files. No existing files need major rewrites — only additive changes.

**Gaps to fill**:
1. Dream orchestrator (`src/dream/daemon.ts`) — the main pipeline runner
2. `dream` CLI command — already scaffolded as `npm run dream`, just missing the handler
3. launchd plist + installer script — pure configuration, no logic
4. MLX local model adapter (`src/dream/intelligence.ts`) — bridges mlx-lm to the extractor interface
5. Work queue / prioritization logic (`src/dream/scheduler.ts`)
6. Checkpoint/resume logic using the existing `dream_checkpoints` table

---

## A. Existing Infrastructure Inventory

### A.1 CLI Structure (`src/cli/index.ts`)

The CLI is built with `commander` and already has these commands:
- `sync` — ingest conversations from `~/.claude/projects/`
- `search <query>` — hybrid search over episodic store
- `remember <content>` — store semantic memory manually
- `extract <conversation-id>` — extract+consolidate facts from a specific conversation (full pipeline!)
- `stats` — database statistics
- `init` — database initialization + embedding model download
- `migrate` — import from legacy superpowers DB
- `validate` — migration integrity check
- `entities` — list knowledge graph entities
- `relationships <entity>` — show entity relationships
- `explore <entity>` — traverse knowledge graph

**The `dream` command is referenced** in `package.json` (`"dream": "tsx src/cli/index.ts dream"`) but **has no handler yet** in `src/cli/index.ts`. This is Phase 5's entry point.

**Critical observation**: The `extract` command (lines 185–315 of `cli/index.ts`) already implements the exact pipeline Phase 5 needs — it fetches exchanges, calls `extractFromConversation()`, then `consolidateFacts()`. The dream daemon is essentially this logic running autonomously over all unprocessed conversations.

### A.2 MCP Server (`src/mcp/server.ts`)

Four tools fully implemented via `@modelcontextprotocol/sdk`:
- `recall` — multi-source hybrid search (episodic + semantic + graph)
- `remember` — store memories with dedup
- `show` — read raw conversation files
- `explore` — knowledge graph traversal

Server uses lazy initialization (db + embeddings only loaded on first tool call). No changes needed for Phase 5 — the daemon runs as a separate process.

### A.3 Database Schema (`src/core/db.ts`)

Three memory layers fully implemented:

**Layer 1 — Episodic Store**:
- `exchanges` table with full exchange data, indexes on timestamp/project/session/conversation
- `tool_calls` table with FK to exchanges
- `conversations` table with metadata + `last_indexed` checkpoint
- `exchanges_fts` FTS5 virtual table (porter + unicode61 tokenizer)
- `vec_exchanges` sqlite-vec virtual table (256-dim float vectors)

**Layer 2 — Semantic Store**:
- `memories` table with type, confidence, importance, decay fields, `is_active` flag
- `conflicts` table for contradiction tracking
- `memories_fts` and `vec_memories` virtual tables

**Layer 3 — Knowledge Graph**:
- `entities` table with aliases (JSON array), mention count, temporal tracking
- `relationships` table with typed edges, weights, source memory references
- Unique constraint on `(source_entity_id, target_entity_id, type)` prevents duplicates
- `topic_clusters` table for community detection results
- `entities_fts` and `vec_entities` virtual tables

**Phase 5 Support Tables (already exist!)**:
```sql
CREATE TABLE dream_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  phases_completed TEXT,        -- JSON array of completed phases
  new_memories INTEGER DEFAULT 0,
  updated_memories INTEGER DEFAULT 0,
  new_entities INTEGER DEFAULT 0,
  new_relationships INTEGER DEFAULT 0,
  conflicts_detected INTEGER DEFAULT 0,
  memories_pruned INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE dream_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES dream_runs(id),
  phase TEXT NOT NULL,
  item_id TEXT NOT NULL,        -- conversation_id or memory_id
  processed_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX dream_checkpoints_run ON dream_checkpoints(run_id, phase);
```

These tables are fully defined and indexed. The checkpoint/resume mechanism just needs a reader.

### A.4 Core Types (`src/core/types.ts`)

Phase 5 types already defined:
```typescript
export type DreamPhase = "ingest" | "extract" | "consolidate" | "reflect" | "prune";

export interface DreamProgress {
  phase: DreamPhase;
  total: number;
  processed: number;
  errors: number;
  startedAt: number;
  lastCheckpoint?: number;
}

export interface DreamReport {
  startedAt: number;
  completedAt: number;
  phases: { phase: DreamPhase; itemsProcessed: number; errors: number; durationMs: number; }[];
  newMemories: number;
  updatedMemories: number;
  newEntities: number;
  newRelationships: number;
  conflictsDetected: number;
  memoriesPruned: number;
}
```

### A.5 Configuration (`src/core/config.ts`)

Dream configuration already built into `EngramConfig`:
```typescript
dream: {
  localModel?: string;          // MLX model path (ENGRAM_LOCAL_MODEL env var)
  apiModel: string;             // "claude-haiku-4-5-20251001"
  apiFallbackModel: string;     // "claude-sonnet-4-6"
  concurrency: number;          // 1 (parallelism within a phase)
  scheduleHour: number;         // 2 (2 AM default)
}
```

The `localModel` field is specifically designed for the MLX path. When `ENGRAM_LOCAL_MODEL` is set, the daemon should prefer local inference.

---

## B. Processing Pipeline Components

### B.1 Ingest Pipeline

**File**: `src/episodic/sync.ts` — `syncConversations()`

Fully implemented. Handles:
- `discoverConversations()` — scans `~/.claude/projects/*/` for JSONL files
- `copyIfNewer()` — atomic file copy to archive (temp + rename)
- Already-indexed detection via `conversations.last_indexed`
- Exclusion markers (`<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>`)
- Per-exchange embedding via `embedExchange()` with contextual metadata prefix
- `insertExchange()` + `upsertConversation()` for atomic DB writes

**What the daemon needs**: Call `syncConversations()` with `{ force: false }` to get only new/updated conversations. Then collect the list of newly indexed conversation IDs to feed into the extract phase.

### B.2 Extraction Pipeline

**File**: `src/semantic/extractor.ts` — `extractFromConversation()`

Fully implemented. Handles:
- Three-tier routing: auto → Haiku → Sonnet
- Long conversation chunking (`chunkConversation()`, default 25 exchanges with 5 overlap)
- Reflexion pass for completeness (optional)
- Tool-use structured output via `EXTRACT_MEMORIES_TOOL`
- Validation and parsing via `parseExtractionResponse()`

**Note on local tier**: `resolveModels()` at line 517 explicitly throws `"Local extraction tier not yet implemented"` when `tier: "local"` is passed. This is Phase 5's primary implementation target for MLX integration.

**File**: `src/graph/extractor.ts` — `extractEntities()` / `extractRelationships()`

Two-step entity+relationship extraction. Fully implemented with same Haiku→Sonnet fallback pattern. Uses `buildEntityExtractionPrompt()` and `buildRelationshipExtractionPrompt()` with prompt templates from `prompts/`.

### B.3 Consolidation Pipeline

**File**: `src/semantic/consolidator.ts` — `consolidateFacts()`

Fully implemented. Handles:
- Per-fact embedding and nearest-neighbor search
- Three-tier similarity routing: auto-merge (≥0.95) → NLI classification (≥0.85) → novel insert
- NLI-based contradiction detection via DeBERTa-v3 (local ONNX)
- LLM-based conflict resolution with `resolve_conflict` tool call
- Deactivation of superseded memories + conflict record creation

**File**: `src/graph/resolver.ts` — `resolveEntities()`

Four-stage entity resolution. Fully implemented:
1. Exact name match (SQL lookup)
2. Alias lookup (SQL LIKE on JSON array)
3. Embedding cosine similarity via `vec_entities` (threshold: 0.95 auto-merge, 0.85 type-matched)
4. Create new entity (generates embedding + inserts)

### B.4 Graph Building

**File**: `src/graph/relationship.ts` — `findOrCreateRelationship()`

Idempotent relationship insertion. Handles duplicate detection and `source_memories` array accumulation.

**File**: `src/graph/analyzer.ts` — `analyzeGraph()` / `persistAnalysis()`

Community detection (Louvain), betweenness centrality, bridge entity detection, coherence scoring. Results persisted to `topic_clusters` table.

### B.5 Memory Decay / Prune

**File**: `src/semantic/decay.ts`

FSRS-inspired decay model fully implemented:
- `computeRetrievability()` — power-law decay: `0.9 ^ (days / stability)`
- `computeConfidence()` — composite: `confidence * corroboration * retrievability`
- `isPruneEligible()` — `confidence < 0.1` threshold
- `getMemoryHealth()` — full health assessment
- `onSuccessfulAccess()` / `onContradiction()` — stability updates

**What's missing**: A `pruneMemories()` orchestrator function that fetches all memories, calls `isPruneEligible()`, and archives eligible ones. The individual functions exist; they just need to be called in a loop.

### B.6 LLM Integration

**File**: `src/semantic/extractor.ts` — uses `@anthropic-ai/sdk`
**File**: `src/semantic/consolidator.ts` — uses `@anthropic-ai/sdk`
**File**: `src/graph/extractor.ts` — uses `@anthropic-ai/sdk`

All three use the same pattern: lazy singleton `Anthropic` client, initialized via `ANTHROPIC_API_KEY`. Each exposes `init*()`, `reset*()`, and `set*Client()` for testing.

**MLX integration (MISSING)**: No mlx-lm adapter exists. The `localModel` config field is defined but never used. Phase 5 must implement a local LLM adapter that either:
- Calls `mlx_lm.generate` via a Python subprocess
- Uses `ollama` HTTP API as a lower-friction alternative
- Or wraps a compatible HTTP endpoint

---

## C. Gap Analysis

### C.1 Missing: Dream Orchestrator (`src/dream/daemon.ts`)

**Status**: Does not exist.
**Purpose**: The main pipeline runner that coordinates phases sequentially.
**What it needs to do**:
```
1. Create a dream_runs record (startedAt, id)
2. Phase INGEST: call syncConversations(), collect newly indexed conversation IDs
3. Phase EXTRACT: for each new conversation_id not in dream_checkpoints(phase="extract"):
   a. Load exchanges from DB
   b. Call extractFromConversation() (local tier if MLX configured, else API)
   c. Call extractEntities() + extractRelationships() + resolveEntities()
   d. Insert checkpoint: dream_checkpoints(run_id, "extract", conversation_id)
4. Phase CONSOLIDATE: for each extracted fact batch:
   a. Call consolidateFacts()
   b. Call findOrCreateRelationship() for each relationship
   c. Insert checkpoint
5. Phase REFLECT: call analyzeGraph() + persistAnalysis()
6. Phase PRUNE: fetch memories where isPruneEligible() → deactivate
7. Update dream_runs(completed_at, phases_completed, stats)
8. Write DreamReport to logs
```

### C.2 Missing: `dream` CLI Command

**Status**: Referenced in `package.json` scripts but not implemented in `src/cli/index.ts`.
**SPEC specification** (lines 569–573):
```
engram dream                          — run all phases
engram dream --phase ingest           — quick sync after a session
engram dream --phase reflect          — force a reflection pass
engram dream --conversation <uuid>    — process a specific conversation
engram dream --phases all             — same as default
```
**Implementation**: Add a `program.command("dream")` handler that calls the daemon orchestrator. Commander already imported.

### C.3 Missing: launchd Integration

**Status**: PLIST template exists in SPEC but no file on disk.
**Required files**:
- `launchd/com.engram.dreamstate.plist` — launchd configuration
- `scripts/install-daemon.sh` — install/uninstall helper
**Content fully specified in SPEC** (lines 511–537). Pure configuration, no logic.

### C.4 Missing: MLX Local Model Adapter (`src/dream/intelligence.ts`)

**Status**: Does not exist. The `dream.localModel` config field is set up but unused.
**Purpose**: Provide a unified LLM interface that routes to local MLX or falls back to Claude API.
**Research context**: `docs/research/local-inference-nli-models.md` has detailed guidance:
- Recommended model: Qwen 2.5 7B / Qwen 3 8B Q4_K_M via MLX-LM (~32 tok/s on M4)
- mlx-lm invocation: `mlx_lm.generate --model <path> --prompt <prompt> --max-tokens 4096`
- Confidence-based routing: local confidence ≥ 0.8 → stop; < 0.8 → escalate to API
- Hybrid reduces cloud costs by >60%

**Interface to implement**:
```typescript
export interface LocalModelAdapter {
  isAvailable(): Promise<boolean>;
  extract(prompt: string): Promise<{ facts: ExtractedFact[]; confidence: number }>;
  extractEntities(prompt: string): Promise<{ entities: ExtractedEntity[]; confidence: number }>;
}
```

### C.5 Missing: Work Queue / Prioritization (`src/dream/scheduler.ts`)

**Status**: Does not exist. Processing is currently linear.
**SPEC specification** (lines 560–568): The daemon prioritizes:
1. New conversations since last run
2. Conversations with high tool diversity
3. Conversations that mention entities already in the graph
4. Low-confidence memories due for re-evaluation
5. Graph regions with significant growth

**Minimal viable implementation**: Simple ordering — fetch unprocessed conversation IDs sorted by `created_at DESC LIMIT config.dream.concurrency * 100`.

**Full implementation**: Compute a priority score per conversation based on: (1) new since last run, (2) tool call count, (3) entity overlap with existing graph.

### C.6 Missing: Checkpoint/Resume Logic

**Status**: The `dream_checkpoints` table exists with correct schema. Nothing reads or writes it.
**Required additions** to daemon:
```typescript
// Check if already processed
function isCheckpointed(db, runId: string, phase: string, itemId: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND item_id = ?"
  ).get(runId, phase, itemId);
}

// Record checkpoint after successful processing
function recordCheckpoint(db, runId: string, phase: string, itemId: string): void {
  db.prepare(
    "INSERT INTO dream_checkpoints (id, run_id, phase, item_id) VALUES (?, ?, ?, ?)"
  ).run(crypto.randomUUID(), runId, phase, itemId);
}
```

**Resume logic**: If a run is incomplete (no `completed_at`), re-use its `run_id` and skip already-checkpointed items.

### C.7 Missing: Graph-Aware Extraction Loop

**Status**: The `extract` CLI command manually loads and processes a single conversation. The daemon needs a loop over all unprocessed conversations that also writes entities/relationships to the graph.
**Gap**: `src/cli/index.ts` lines 185–315 extract facts and call `consolidateFacts()` but do NOT call `extractEntities()`, `extractRelationships()`, or `resolveEntities()`. These are separate code paths that have never been composed into a single pipeline.

**The full pipeline requires**:
```
extractFromConversation()     → facts (semantic layer)
extractEntities()             → raw entities
resolveEntities()             → entity IDs in graph
extractRelationships()        → raw relationships (indexed by entity position)
findOrCreateRelationship()    → persisted graph edges
consolidateFacts()            → deduped memories
```

This composition does not exist anywhere yet. The daemon must build it.

---

## D. Dependencies and Build System

### D.1 Package Configuration

```json
{
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "main": "dist/cli/index.js",
  "bin": { "engram": "dist/cli/index.js" }
}
```

ESM throughout (`"type": "module"`). All imports use `.js` extensions.

### D.2 Key Dependencies

| Package | Version | Purpose | Phase 5 Relevance |
|---------|---------|---------|-------------------|
| `@anthropic-ai/sdk` | ^0.78.0 | Claude API extraction | Already used; fallback path |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP server | Not needed for daemon |
| `@xenova/transformers` | ^2.17.2 | Embeddings + NLI (ONNX) | NLI used in consolidator |
| `better-sqlite3` | ^12.6.2 | SQLite storage | All DB operations |
| `commander` | ^14.0.3 | CLI framework | dream command |
| `graphology` + plugins | various | Graph analysis | analyzeGraph() |
| `sqlite-vec` | ^0.1.7-alpha.2 | Vector similarity search | vec_* tables |
| `zod` | ^4.3.6 | Input validation | MCP tool schemas |

**Missing for Phase 5**:
- No MLX/ollama client package. Options:
  - Node.js `child_process` to spawn `mlx_lm.generate` (Python subprocess)
  - `node-fetch` or native `fetch` to call Ollama REST API (localhost:11434)
  - No additional npm package needed for subprocess approach

### D.3 Build System

- TypeScript with `tsc` (strict mode, ESNext target, bundler module resolution)
- `tsx` for development (JIT TypeScript execution)
- `vitest` for tests
- Output: `dist/` directory
- Source maps + declaration files generated

### D.4 Test Infrastructure

Tests use `vitest` with a consistent pattern via `tests/helpers.ts`:
- `createTestDb()` — in-memory SQLite in temp dir, full schema
- `createSyntheticExchange()` / `createTestEntity()` / `createTestRelationship()` — fixture factories
- No test doubles for embeddings — tests that touch embeddings require the model to be downloaded

Test coverage across all modules:
- `tests/core/db.test.ts` — schema creation, WAL mode
- `tests/episodic/` — parser, embeddings, search, store, sync (5 files)
- `tests/semantic/` — extractor, consolidator, decay, memory, NLI, search, integration (7 files)
- `tests/graph/` — entity, relationship, extractor, resolver, analyzer, search, integration, search-integration (8 files)
- `tests/migration/` — migrate, validate (2 files)

Phase 5 will need new tests in `tests/dream/` for:
- `daemon.test.ts` — orchestrator unit tests (mock pipeline components)
- `scheduler.test.ts` — priority ordering
- `checkpoint.test.ts` — resume logic

---

## E. Architecture Diagram: Existing Pipeline

```
┌────────────────────────────────────────────────────────────────┐
│                     ~/.claude/projects/                        │
│                    (JSONL conversation files)                   │
└────────────────────────────┬───────────────────────────────────┘
                             │ discoverConversations()
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  INGEST  episodic/sync.ts: syncConversations()                 │
│                                                                │
│  parseConversationFile() → embedExchange() → insertExchange()  │
│                            [nomic-embed-text-v1.5, 256d]       │
│                                                                │
│  Output: exchanges table, vec_exchanges, exchanges_fts         │
└────────────────────────────┬───────────────────────────────────┘
                             │ conversation IDs (last_indexed updated)
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  EXTRACT  semantic/extractor.ts + graph/extractor.ts           │
│                                                                │
│  extractFromConversation()    → ExtractedFact[]                │
│    [Haiku → Sonnet fallback, chunked, optional reflexion]      │
│                                                                │
│  extractEntities()            → ExtractedEntity[]             │
│  extractRelationships()       → ExtractedRelationship[]        │
│    [Haiku → Sonnet fallback, two-step Graphiti pipeline]       │
│                                                                │
│  Prompts: prompts/extract-facts.md                             │
│           prompts/extract-entities.md                         │
│           prompts/extract-relationships.md                    │
└────────────────────────────┬───────────────────────────────────┘
                             │ facts + entities + relationships
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  CONSOLIDATE  semantic/consolidator.ts + graph/resolver.ts     │
│                                                                │
│  deduplicateFact():                                            │
│    vec similarity ≥ 0.95 → auto-merge (recordAccess)          │
│    vec similarity 0.85–0.95 → NLI (DeBERTa-v3 ONNX)          │
│      entailment > 0.7 → merge                                 │
│      contradiction > 0.7 → LLM conflict resolution            │
│    similarity < 0.85 → insertNovelMemory()                    │
│                                                                │
│  resolveEntity():                                              │
│    exact name → alias → embedding → create new                 │
│  findOrCreateRelationship() → upsert with weight              │
│                                                                │
│  Prompts: prompts/resolve-conflict.md                         │
└────────────────────────────┬───────────────────────────────────┘
                             │ memories + entities + relationships
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  REFLECT  graph/analyzer.ts                                    │
│                                                                │
│  analyzeGraph():                                               │
│    loadGraph() → Louvain community detection                   │
│    computeCoherence() per community                            │
│    detectBridgeEntities() via betweenness centrality          │
│  persistAnalysis() → topic_clusters table                      │
└────────────────────────────┬───────────────────────────────────┘
                             │ topic clusters
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  PRUNE  semantic/decay.ts                                      │
│                                                                │
│  isPruneEligible(): confidence < 0.1                           │
│    [computeConfidence = base * corroboration * retrievability] │
│  deactivateMemory() → is_active = 0, superseded_by set        │
└────────────────────────────────────────────────────────────────┘
```

---

## F. Recommendations

### F.1 Implementation Approach

**Recommended structure** (matches SPEC `docs/` layout):
```
src/
  dream/
    daemon.ts         # Orchestrator — the main pipeline runner
    scheduler.ts      # Work queue, prioritization, checkpoint tracking
    intelligence.ts   # LLM adapter: MLX subprocess OR Ollama OR Claude API
launchd/
  com.engram.dreamstate.plist
scripts/
  install-daemon.sh
```

**Add to CLI** (`src/cli/index.ts`):
```typescript
program
  .command("dream")
  .description("Run dream state processing pipeline")
  .option("--phase <phase>", "Run only this phase: ingest|extract|consolidate|reflect|prune")
  .option("--conversation <id>", "Process a specific conversation")
  .option("--phases <list>", "Comma-separated phases to run", "all")
  .option("--dry-run", "Show what would be processed without making changes")
  .option("--verbose", "Show detailed progress")
  .action(async (opts) => {
    const { runDream } = await import("../dream/daemon.js");
    // ...
  });
```

### F.2 MLX Integration Strategy

The SPEC and research document align on this approach:

**Option A (subprocess)**: Spawn `mlx_lm.generate` via Node.js `child_process`:
```typescript
import { spawn } from "node:child_process";

async function callMlxLm(prompt: string, maxTokens: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [
      "-m", "mlx_lm.generate",
      "--model", config.dream.localModel!,
      "--prompt", prompt,
      "--max-tokens", String(maxTokens),
    ]);
    // collect stdout, resolve on exit
  });
}
```

**Option B (Ollama REST)**: If user has Ollama running:
```typescript
const response = await fetch("http://localhost:11434/api/generate", {
  method: "POST",
  body: JSON.stringify({ model: "qwen2.5:7b", prompt, stream: false })
});
```

**Recommendation**: Implement Option B (Ollama) as the simpler path, with Option A as a stretch goal. Ollama wraps many models including MLX-optimized ones, handles model loading, and avoids Python subprocess management. The SPEC mentions `ENGRAM_LOCAL_MODEL` — this could be an Ollama model tag like `"qwen2.5:7b"`.

**Confidence-based routing** (from `local-inference-nli-models.md`):
- Local model returns confidence score in output
- Confidence ≥ 0.8 → accept local result
- Confidence < 0.8 → escalate to Claude Haiku API
- This is already supported by `ExtractionConfig.tier` — adding `"local"` tier support to `resolveModels()` in `extractor.ts`

### F.3 Checkpoint/Resume Implementation

The `dream_checkpoints` table is designed for this. Recommended approach:

1. **Run resumption**: On `dream` command start, check for an incomplete `dream_runs` record (has `started_at` but no `completed_at`). If found, resume it; otherwise create a new one.

2. **Per-item checkpointing**: After each conversation is processed in the extract phase, write a checkpoint. Before processing any conversation, check if it's already checkpointed for this run.

3. **Phase-level tracking**: The `phases_completed` JSON column in `dream_runs` records which phases finished. If the daemon crashes mid-consolidate, it can restart from that phase.

### F.4 Processing Order

To correctly compose the full pipeline (the key gap identified in C.7):

```typescript
// For each conversation to process:
async function processConversation(db, conversationId, config) {
  // Load exchanges
  const rows = db.prepare("SELECT * FROM exchanges WHERE conversation_id = ? ORDER BY exchange_index")
    .all(conversationId);
  const exchanges = rows.map(rowToExchange);
  
  // 1. Semantic extraction
  const extractionResult = await extractFromConversation(conversationId, exchanges, metadata, {
    tier: config.dream.localModel ? "local" : "auto"
  });
  
  // 2. Consolidate facts into memories
  const consolidationResults = await consolidateFacts(db, extractionResult.facts, conversationId);
  
  // 3. Entity extraction
  const entityResult = await extractEntities(exchanges, metadata);
  
  // 4. Entity resolution (creates/merges entities in graph)
  const resolvedEntities = await resolveEntities(db, entityResult.entities);
  
  // 5. Relationship extraction (now using resolved entity IDs)
  const entityList = resolvedEntities.map((r, idx) => ({
    index: idx,
    id: r.resolution.entityId,
    name: r.extracted.name,
    type: r.extracted.type,
  }));
  const relResult = await extractRelationships(exchanges, metadata, entityList);
  
  // 6. Persist relationships
  for (const rel of relResult.relationships) {
    const sourceId = entityList[rel.sourceEntityIndex].id;
    const targetId = entityList[rel.targetEntityIndex].id;
    findOrCreateRelationship(db, sourceId, targetId, rel.type, rel.context);
  }
  
  return {
    memoriesCreated: consolidationResults.filter(r => r.action === "insert").length,
    memoriesMerged: consolidationResults.filter(r => r.action === "merge").length,
    conflictsDetected: consolidationResults.filter(r => r.action === "conflict").length,
    entitiesCreated: resolvedEntities.filter(r => r.resolution.action === "create").length,
    relationshipsCreated: relResult.relationships.length,
  };
}
```

This composition is the single most important thing Phase 5 needs to build.

---

## G. File-Level Mapping

### Files That Need Changes

| File | Change Type | What Changes |
|------|-------------|--------------|
| `src/cli/index.ts` | Additive | Add `dream` command handler (30–50 lines) |
| `src/semantic/extractor.ts` | Additive | Implement `"local"` tier in `resolveModels()` — call MLX adapter instead of throwing |
| `src/core/config.ts` | None needed | `dream.localModel` field already exists |
| `src/core/types.ts` | None needed | `DreamPhase`, `DreamProgress`, `DreamReport` already defined |
| `src/core/db.ts` | None needed | `dream_runs`, `dream_checkpoints` tables already created |

### Files That Need to Be Created

| File | Purpose | Key Dependencies |
|------|---------|-----------------|
| `src/dream/daemon.ts` | Main orchestrator — pipeline phases, run tracking | `sync.ts`, `extractor.ts`, `consolidator.ts`, `graph/extractor.ts`, `graph/resolver.ts`, `analyzer.ts`, `decay.ts` |
| `src/dream/scheduler.ts` | Work queue, prioritization, checkpoint read/write | `better-sqlite3`, `core/types.ts` |
| `src/dream/intelligence.ts` | Local LLM adapter (Ollama/MLX) with API fallback | `child_process` or `fetch`, `semantic/extractor.ts` interfaces |
| `launchd/com.engram.dreamstate.plist` | macOS launchd scheduling | None (XML config) |
| `scripts/install-daemon.sh` | launchd install/uninstall | Shell script |
| `tests/dream/daemon.test.ts` | Orchestrator tests | Vitest, `tests/helpers.ts` |
| `tests/dream/scheduler.test.ts` | Scheduler/checkpoint tests | Vitest, `tests/helpers.ts` |

### Files That Are Complete As-Is

These files require no modification for Phase 5:

| File | Status |
|------|--------|
| `src/episodic/sync.ts` | Complete — `syncConversations()` is the INGEST phase |
| `src/episodic/embeddings.ts` | Complete — `initEmbeddings()`, `embedDocument()`, `embedExchange()` |
| `src/episodic/parser.ts` | Complete — `parseConversationFile()` |
| `src/episodic/store.ts` | Complete — `insertExchange()`, `upsertConversation()` |
| `src/episodic/search.ts` | Complete — multi-source search |
| `src/semantic/extractor.ts` | Nearly complete — just add `"local"` tier routing |
| `src/semantic/consolidator.ts` | Complete — `consolidateFacts()` |
| `src/semantic/nli.ts` | Complete — DeBERTa-v3 ONNX via @xenova/transformers |
| `src/semantic/memory.ts` | Complete — all CRUD with FTS5+vec0 sync |
| `src/semantic/decay.ts` | Complete — FSRS decay model |
| `src/semantic/search.ts` | Complete — hybrid semantic search |
| `src/graph/extractor.ts` | Complete — entity+relationship extraction |
| `src/graph/resolver.ts` | Complete — four-stage entity resolution |
| `src/graph/entity.ts` | Complete — entity CRUD |
| `src/graph/relationship.ts` | Complete — relationship CRUD + weight computation |
| `src/graph/analyzer.ts` | Complete — community detection + analysis |
| `src/graph/search.ts` | Complete — entity-centric search |
| `src/mcp/server.ts` | Complete — 4 MCP tools |
| `src/core/db.ts` | Complete — all tables including dream state tables |
| `src/core/config.ts` | Complete — `dream.localModel`, `dream.scheduleHour` etc. |
| `src/core/types.ts` | Complete — all Phase 5 types pre-defined |
| `prompts/extract-facts.md` | Complete |
| `prompts/extract-entities.md` | Complete |
| `prompts/extract-relationships.md` | Complete |
| `prompts/resolve-conflict.md` | Complete |

---

## H. Risk Assessment

### H.1 Low Risk (Well-Understood)

- **Pipeline composition**: All components exist and are tested individually. The composition is straightforward orchestration.
- **Checkpoint/resume**: Schema exists, queries are simple SQL.
- **launchd integration**: Pure configuration — the SPEC has exact XML.
- **CLI `dream` command**: Same pattern as existing commands.

### H.2 Medium Risk (Implementation Choices)

- **MLX/Ollama integration**: Python subprocess management or HTTP client. Error handling for model not found, timeout, malformed output. Recommend Ollama first for simpler setup story.
- **Memory pruning**: `deactivateMemory()` exists but the prune loop doesn't. The threshold (`confidence < 0.1`) may need tuning — no production data yet to validate it.
- **Pipeline composition for entities+facts in one pass**: The first time the full `processConversation()` pipeline (C.7) runs end-to-end at scale will surface edge cases (entities referencing memories before they're inserted, etc.).

### H.3 Higher Risk (Unknown Unknowns)

- **Local model quality for structured extraction**: Qwen 2.5 7B Q4_K_M at 32 tok/s should work, but structured JSON output reliability with the existing tool-use prompts is untested locally. The prompts use Anthropic-style `tool_choice: { type: "tool" }` which won't work with Ollama — need to adapt to prompt-based structured output.
- **Cold-start performance**: First dream run on a large historical dataset (hundreds of conversations) could take hours. Rate limiting and concurrency controls need to be correct.
- **SQLite WAL + concurrent MCP access**: If the MCP server is running while the daemon processes, WAL mode handles concurrent reads fine, but write conflicts could occur during heavy consolidation. The current `concurrency: 1` default is conservative and correct.

---

## I. Open Questions for Planning

1. **Local model interface**: Ollama REST API (simpler, optional install) or MLX Python subprocess (required install, Apple-specific)? The SPEC says "MLX" but Ollama is a more universal path.

2. **Prune archival format**: When memories are pruned (`is_active = 0`), should they remain in the DB forever (current behavior) or be exported to a JSON archive file in `~/.local/share/engram/archive/`?

3. **Extract scope**: Should Phase 5 process ALL historical conversations (full backfill) or only conversations indexed since the last dream run? The `dream_checkpoints` table supports both, but the first full run could be very expensive.

4. **Reflect phase scope**: `analyzeGraph()` runs on the full graph every time. For large graphs, this could be slow. Consider incremental community detection for Phase 5, with full re-analysis optional.

5. **Test strategy for daemon**: The daemon interacts with live models (embeddings, NLI, Claude API). Tests should mock these with `setClient()` / `resetExtractor()` / `resetNli()` which already exist.

---

*Document generated by automated codebase analysis on 2026-02-26.*
*All file paths verified against the worktree at phase-5 branch head (45244f1).*
