# Engram Phase 3: Semantic Extraction — Implementation Plan

## Context

Phase 1 built Engram's episodic memory foundation: JSONL parser, nomic-embed-text-v1.5 embeddings (256d), hybrid vector+FTS5 search with RRF fusion, MCP server, CLI, and comprehensive tests. Phase 2 added score normalization, embedding fixes (layer_norm for Matryoshka), and the migration pipeline from the legacy superpowers DB.

Phase 3 is the core differentiator — it transforms raw episodic data into distilled, structured knowledge through a multi-stage extraction, deduplication, and consolidation pipeline. This is what separates Engram from simple conversation search.

**What Phase 3 delivers:**
1. **Semantic extraction** — LLM-powered extraction of facts, preferences, decisions, patterns, solutions, and conventions from raw conversations
2. **Memory deduplication** — cosine similarity + NLI contradiction detection to prevent knowledge bloat
3. **Conflict resolution** — detect and resolve contradictory memories with temporal precedence
4. **FSRS-inspired confidence tracking** — per-memory stability that grows with use and decays with time
5. **Multi-source search** — unified recall across episodic + semantic stores with semantic boost
6. **`remember` MCP tool** — explicit memory creation bypassing the extraction pipeline
7. **`remember` CLI command** — command-line memory creation for testing and manual use

**What Phase 3 does NOT include** (deferred to Phase 4):
- Knowledge graph (entities, relationships, topic clusters)
- Dream state daemon scheduling (launchd integration)
- Community detection and Maps of Content
- Cross-encoder reranking

All research is complete (8 documents in `docs/research/`). The database schema for semantic tables is already defined in `src/core/db.ts`. This plan executes the implementation.

---

## New Dependency

```
@anthropic-ai/sdk  — Claude API client for Haiku/Sonnet extraction and conflict resolution
```

The `@xenova/transformers` package (already installed) provides the NLI model (DeBERTa-v3-base ONNX). No additional ML dependencies are needed.

---

## Architecture Overview

```
Conversations (episodic store)
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│                    EXTRACTION PIPELINE                     │
│                                                            │
│  Pre-process → Chunk (if >100 turns) → Extract Facts      │
│                                                            │
│  Three-Tier Intelligence Routing:                          │
│    Local LLM (optional) → Claude Haiku → Claude Sonnet     │
│                                                            │
│  Schema enforced via tool_use with strict: true            │
│  Atomic fact decomposition into 6 memory types             │
│  Optional reflexion pass for quality                       │
└──────────────────┬───────────────────────────────────────┘
                   │ extracted facts
                   ▼
┌──────────────────────────────────────────────────────────┐
│                   CONSOLIDATION PIPELINE                   │
│                                                            │
│  For each extracted fact:                                   │
│    1. Embed fact → find nearest neighbors in vec_memories   │
│    2. Cosine ≥ 0.95 → auto-merge (bump confidence)         │
│    3. Cosine 0.85-0.95 → NLI check (DeBERTa)              │
│       ├─ Entailment → merge as reinforcement               │
│       ├─ Contradiction → log conflict, escalate            │
│       └─ Neutral → insert as novel memory                  │
│    4. Cosine < 0.85 → insert as novel memory               │
│                                                            │
│  Conflict Resolution (when NLI detects contradiction):     │
│    LLM classifies: UPDATE | KEEP_BOTH | NOOP               │
│    Superseded memories: is_active=false, superseded_by set  │
└──────────────────┬───────────────────────────────────────┘
                   │ consolidated memories
                   ▼
┌──────────────────────────────────────────────────────────┐
│                    SEMANTIC STORE                          │
│                                                            │
│  memories table + memories_fts + vec_memories               │
│  conflicts table for contradiction tracking                 │
│  FSRS-inspired confidence decay per memory type             │
│  Retrieval-time scoring: relevance × recency × importance   │
└──────────────────────────────────────────────────────────┘
```

---

## File Plan

### New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/semantic/nli.ts` | NLI contradiction detection via DeBERTa ONNX | ~120 |
| `src/semantic/memory.ts` | Memory CRUD: insert, update, deactivate, query, FTS/vec sync | ~250 |
| `src/semantic/decay.ts` | FSRS confidence model, importance boosting, pruning eligibility | ~150 |
| `src/semantic/extractor.ts` | Three-tier extraction routing, prompt building, chunking | ~300 |
| `src/semantic/consolidator.ts` | Dedup pipeline, NLI triage, conflict resolution, merging | ~280 |
| `src/semantic/search.ts` | Semantic store search: vector + FTS with memory-specific scoring | ~180 |
| `src/semantic/types.ts` | Phase 3-specific types (extraction results, NLI output, etc.) | ~80 |
| `prompts/extract-facts.md` | Extraction prompt template with few-shot examples | ~100 |
| `prompts/resolve-conflict.md` | Conflict resolution prompt template | ~60 |
| `tests/semantic/nli.test.ts` | NLI model loading, classification accuracy | ~120 |
| `tests/semantic/memory.test.ts` | CRUD operations, FTS/vec sync, deactivation | ~200 |
| `tests/semantic/decay.test.ts` | FSRS calculations, boundary conditions | ~150 |
| `tests/semantic/extractor.test.ts` | Prompt building, chunking, response parsing | ~200 |
| `tests/semantic/consolidator.test.ts` | Dedup logic, merge behavior, conflict logging | ~250 |
| `tests/semantic/search.test.ts` | Multi-source search, semantic boost, RRF fusion | ~180 |

### Modified Files

| File | Changes |
|------|---------|
| `src/episodic/search.ts` | Add `searchMultiSource()` orchestrator, `formatSemanticXml()` |
| `src/mcp/server.ts` | Add `remember` tool, update `recall` to include semantic results |
| `src/cli/index.ts` | Add `remember` and `extract` commands |
| `package.json` | Add `@anthropic-ai/sdk` dependency |

---

## Team Execution Strategy: 4 Parallel Streams

```
Stream A: NLI Pipeline              (semantic/nli.ts, tests)
Stream B: Memory CRUD + Decay       (semantic/memory.ts, decay.ts, types.ts, tests)
Stream C: Extraction Pipeline       (semantic/extractor.ts, prompts/*, tests)

    ── all three start simultaneously, no cross-dependencies ──

         │ A complete   │ B complete   │ C complete
         ▼              ▼              ▼
Stream D: Consolidation + Search + Integration
    (semantic/consolidator.ts, semantic/search.ts,
     episodic/search.ts, mcp/server.ts, cli/index.ts, tests)
```

**Zero merge conflicts in Streams A/B/C**: Each creates new files only.
Stream D modifies shared files but runs after A/B/C complete.

| File | A | B | C | D |
|------|---|---|---|---|
| `src/semantic/nli.ts` | CREATES | - | - | imports |
| `src/semantic/types.ts` | - | CREATES | - | imports |
| `src/semantic/memory.ts` | - | CREATES | - | imports |
| `src/semantic/decay.ts` | - | CREATES | - | imports |
| `src/semantic/extractor.ts` | - | - | CREATES | imports |
| `prompts/extract-facts.md` | - | - | CREATES | - |
| `prompts/resolve-conflict.md` | - | - | CREATES | imports (reads) |
| `src/semantic/consolidator.ts` | - | - | - | CREATES |
| `src/semantic/search.ts` | - | - | - | CREATES |
| `src/episodic/search.ts` | - | - | - | MODIFIES |
| `src/mcp/server.ts` | - | - | - | MODIFIES |
| `src/cli/index.ts` | - | - | - | APPENDS |
| `package.json` | - | - | MODIFIES | - |

---

## Stream A: NLI Contradiction Detection

### A1: Create NLI pipeline (`src/semantic/nli.ts`)

**Purpose**: Classify pairs of memory statements as entailment / contradiction / neutral using DeBERTa-v3-base ONNX via `@xenova/transformers`.

**Model**: `cross-encoder/nli-deberta-v3-base` (~184MB, ~30ms/pair on M4)

```typescript
// Key exports
export interface NliResult {
  entailment: number;   // 0-1 probability
  contradiction: number; // 0-1 probability
  neutral: number;       // 0-1 probability
  label: "entailment" | "contradiction" | "neutral";
}

export async function initNli(): Promise<void>;
export async function classifyNli(premise: string, hypothesis: string): Promise<NliResult>;
export async function classifyNliBatch(pairs: [string, string][]): Promise<NliResult[]>;
```

**Implementation details**:
- Lazy initialization: model loaded on first call, cached thereafter
- Uses `pipeline("zero-shot-classification", ...)` or `AutoModelForSequenceClassification` from `@xenova/transformers`
- Input: two text strings (existing memory vs. candidate memory)
- Output: softmax probabilities over 3 classes
- Batch support for processing multiple candidate pairs efficiently

**Commit**: `feat(semantic): add NLI contradiction detection pipeline`

### A2: NLI tests (`tests/semantic/nli.test.ts`)

- Test: model initializes without error
- Test: clear entailment pair → entailment label (e.g., "User prefers Fish shell" vs "The user's preferred shell is Fish")
- Test: clear contradiction pair → contradiction label (e.g., "Project uses PostgreSQL" vs "Project uses SQLite")
- Test: neutral pair → neutral label (e.g., "User prefers dark mode" vs "Project uses React")
- Test: batch classification returns correct count
- Test: probabilities sum to ~1.0

**Commit**: `test(semantic): add NLI classification tests`

---

## Stream B: Memory CRUD + Decay Model

### B1: Create semantic types (`src/semantic/types.ts`)

**Purpose**: Phase 3-specific types not already in `core/types.ts`.

```typescript
// Extraction types
export interface ExtractedFact {
  type: MemoryType;
  content: string;
  context?: string;
  importance: number;        // 0-1, LLM-judged
  sourceExchangeIds: string[];
}

export interface ExtractionResult {
  conversationId: string;
  facts: ExtractedFact[];
  model: string;             // which model performed extraction
  tier: "local" | "haiku" | "sonnet";
  confidence: number;        // model self-reported confidence (1-10)
  durationMs: number;
}

// Consolidation types
export interface DeduplicationResult {
  action: "insert" | "merge" | "conflict" | "skip";
  memoryId: string;
  mergedWithId?: string;
  conflictId?: string;
  similarity?: number;
}

export interface ConflictResolution {
  action: "update" | "keep_both" | "noop";
  reasoning: string;
  updatedContent?: string;
}

// Decay types
export interface MemoryHealth {
  memoryId: string;
  retrievability: number;   // 0-1, current decay state
  stability: number;        // days until R drops to 0.9
  confidence: number;       // composite score
  pruneEligible: boolean;
}

// Extraction configuration
export interface ExtractionConfig {
  tier: "local" | "haiku" | "sonnet" | "auto";
  reflexionEnabled: boolean;
  chunkSize: number;         // turns per chunk
  chunkOverlap: number;      // overlap turns
  maxTurns: number;          // threshold for chunking
}
```

**Commit**: `feat(semantic): add Phase 3 type definitions`

### B2: Create memory CRUD (`src/semantic/memory.ts`)

**Purpose**: All database operations for the `memories` table, including FTS5 and vec0 synchronization.

```typescript
// Key exports
export function insertMemory(db: Database, memory: Memory, embedding: number[]): void;
export function updateMemory(db: Database, id: string, updates: Partial<Memory>): void;
export function deactivateMemory(db: Database, id: string, supersededBy: string): void;
export function getMemory(db: Database, id: string): Memory | null;
export function getActiveMemories(db: Database, type?: MemoryType): Memory[];
export function recordAccess(db: Database, id: string): void;
export function insertConflict(db: Database, conflict: Conflict): void;
export function getUnresolvedConflicts(db: Database): Conflict[];
export function resolveConflict(db: Database, id: string, resolution: string): void;
export function findNearestMemories(db: Database, embedding: number[], limit: number): Array<{ id: string; distance: number }>;
```

**Implementation details**:
- `insertMemory()`: Transactional — inserts into `memories`, `memories_fts`, and `vec_memories` atomically
- `updateMemory()`: FTS5 delete-then-insert sync pattern (same as episodic store)
- `deactivateMemory()`: Sets `is_active=false`, `superseded_by`, and `updated_at`
- `recordAccess()`: Increments `access_count`, updates `last_accessed`
- `findNearestMemories()`: vec0 MATCH query on `vec_memories`, returns distance + id
- All writes use `db.transaction()` for atomicity
- `source_exchanges` stored as JSON array string

**Commit**: `feat(semantic): implement memory CRUD with FTS5/vec0 sync`

### B3: Create decay model (`src/semantic/decay.ts`)

**Purpose**: FSRS-inspired confidence tracking, importance boosting, and pruning eligibility.

```typescript
// Key exports
export function computeRetrievability(memory: Memory, now?: number): number;
export function computeConfidence(memory: Memory, now?: number): number;
export function computeRetrievalScore(
  relevance: number, memory: Memory, now?: number
): number;
export function onSuccessfulAccess(memory: Memory): { stability: number; importance: number };
export function onContradiction(memory: Memory): { stability: number };
export function isPruneEligible(memory: Memory, now?: number): boolean;
export function getMemoryHealth(memory: Memory, now?: number): MemoryHealth;
```

**FSRS formulas** (from spec):

```
// Per-memory stability (days until retrievability drops to 0.9)
INITIAL_STABILITY = {
  preference: 90, decision: 60, fact: 30,
  pattern: 120, solution: 45, convention: 75
}

// Retrievability at time t
retrievability(t) = 0.9 ^ (days_since_last_access / stability)

// Confidence composite
confidence(t) = base_confidence × corroboration_factor × decay_factor
  where corroboration_factor = min(1.0, 0.5 + 0.1 × num_confirmations)
  where decay_factor = retrievability(t)

// On successful access: stability grows (desirable difficulty)
new_stability = stability * (1 + growth_rate * (1 - R))
  where R = retrievability at access time, growth_rate = 0.2

// On contradiction: stability shrinks
new_stability = stability * 0.8

// Retrieval scoring (for ranking in search)
retrieval_score = 0.55 × relevance + 0.25 × recency + 0.20 × importance
  where recency = retrievability(t)
```

**Pruning**: Memories with `confidence < 0.1` are prune-eligible. Pruning itself is Phase 5 (dream state), but the eligibility check lives here.

**Commit**: `feat(semantic): implement FSRS-inspired decay and confidence model`

### B4: Memory CRUD tests (`tests/semantic/memory.test.ts`)

- Test: `insertMemory()` writes to all three tables (memories, FTS, vec)
- Test: `getMemory()` returns correct memory by ID
- Test: `updateMemory()` updates content and syncs FTS
- Test: `deactivateMemory()` sets `is_active=false` and `superseded_by`
- Test: `recordAccess()` increments `access_count` and updates `last_accessed`
- Test: `findNearestMemories()` returns correct neighbors by distance
- Test: `insertConflict()` and `getUnresolvedConflicts()` round-trip
- Test: `resolveConflict()` sets resolution and `resolved_at`
- Test: FTS search finds inserted memory by keyword

**Commit**: `test(semantic): add memory CRUD and conflict tracking tests`

### B5: Decay model tests (`tests/semantic/decay.test.ts`)

- Test: fresh memory has retrievability ~1.0
- Test: retrievability decays over time (30 days for fact → ~0.9^1 = 0.9)
- Test: corroboration factor starts at 0.5, grows with confirmations
- Test: confidence composite = base × corroboration × decay
- Test: `onSuccessfulAccess()` increases stability proportional to difficulty
- Test: `onContradiction()` reduces stability by 20%
- Test: `isPruneEligible()` returns true when confidence < 0.1
- Test: `computeRetrievalScore()` weights relevance > recency > importance
- Test: initial stability varies by memory type (pattern=120d > preference=90d > fact=30d)

**Commit**: `test(semantic): add FSRS decay model tests`

---

## Stream C: Extraction Pipeline

### C1: Create extraction prompt template (`prompts/extract-facts.md`)

**Purpose**: Structured prompt for LLM-based fact extraction from conversations.

**Content** (Mem0-inspired with engram's 6-type taxonomy):

```markdown
# Fact Extraction Prompt

## System
You are a memory extraction specialist. Analyze conversations between a user and
Claude Code (an AI coding assistant) and extract discrete, atomic facts.

## Instructions
- Extract facts, preferences, decisions, patterns, solutions, and conventions
- Each fact must be ONE atomic, independently verifiable statement
- Replace ALL pronouns with specific entity names
- Score importance on 0.0-1.0 scale (trivial greeting = 0.1, architectural decision = 0.9)
- Reference which exchange(s) support each fact by index
- Do NOT extract from system messages, tool results, or casual greetings
- Return empty array if no extractable information exists

## Type Definitions
- **preference**: User-stated preference or corrected behavior
- **decision**: Architectural choice with rationale
- **pattern**: Repeated behavior across conversations
- **fact**: Stated factual information about environment, tools, or setup
- **solution**: Problem + resolution pair
- **convention**: Repeated practice or explicit instruction

## Few-Shot Examples
[2-3 conversation → extraction examples per type]
```

**This file is read at runtime** by the extractor to build the prompt. Keeping it as markdown allows easy iteration without code changes.

**Commit**: `feat(semantic): add extraction prompt template with few-shot examples`

### C2: Create conflict resolution prompt (`prompts/resolve-conflict.md`)

**Purpose**: Prompt template for LLM-based conflict resolution when NLI detects contradiction.

```markdown
# Conflict Resolution Prompt

## System
Two memories contradict each other. Classify how to resolve the conflict.

## Inputs
- existing_memory: the current stored fact
- new_memory: the newly extracted fact
- existing_source: conversation context for old memory
- new_source: conversation context for new memory

## Classification
Respond with exactly one of:
- UPDATE: New memory supersedes old (e.g., user changed preference)
- KEEP_BOTH: Both are valid in different contexts
- NOOP: New memory is less reliable, keep existing

## Priority Rules
1. Explicit correction > implicit contradiction
2. More recent > older (temporal precedence)
3. Multiple confirmations > single mention
4. User-stated > inferred
```

**Commit**: `feat(semantic): add conflict resolution prompt template`

### C3: Implement extraction pipeline (`src/semantic/extractor.ts`)

**Purpose**: Extract semantic memories from raw conversations using three-tier intelligence routing.

```typescript
// Key exports
export interface ExtractorOptions {
  config: ExtractionConfig;
  anthropicApiKey?: string;  // from ANTHROPIC_API_KEY env
}

export async function initExtractor(options: ExtractorOptions): Promise<void>;

export async function extractFromConversation(
  conversationId: string,
  exchanges: Array<{ index: number; userMessage: string; assistantMessage: string }>,
  metadata: { project: string; branch?: string; dateRange: string },
): Promise<ExtractionResult>;

export function chunkConversation(
  exchanges: Array<{ index: number; userMessage: string; assistantMessage: string }>,
  chunkSize?: number,
  overlap?: number,
): Array<Array<{ index: number; userMessage: string; assistantMessage: string }>>;

export function buildExtractionPrompt(
  exchanges: Array<{ index: number; userMessage: string; assistantMessage: string }>,
  metadata: { project: string; branch?: string; dateRange: string },
): string;

export function parseExtractionResponse(response: unknown): ExtractedFact[];
```

**Implementation details**:

1. **Pre-processing**:
   - Filter to user + assistant text messages
   - For conversations > 100 turns: chunk into overlapping windows (20-30 turns, 5-turn overlap)
   - Prepend conversation metadata (project, branch, date range)

2. **Three-tier routing**:
   ```
   if (config.tier === "auto") {
     try local LLM (if configured) → check confidence
     if confidence < 8 → escalate to Haiku
     if Haiku fails → escalate to Sonnet
   } else {
     use specified tier directly
   }
   ```

3. **Claude API integration**:
   - Use `@anthropic-ai/sdk` with `tool_use` and strict schema
   - Tool definition enforces the `ExtractedFact[]` schema
   - Model: `claude-haiku-4-5-20251001` (primary), `claude-sonnet-4-6` (fallback)

4. **Response parsing**:
   - Parse tool_use result into `ExtractedFact[]`
   - Validate types match the 6-type taxonomy
   - Clamp importance to [0.0, 1.0]
   - Filter empty content

5. **Optional reflexion pass** (when `reflexionEnabled: true`):
   - Second LLM call reviews extraction against source
   - Prompt: "Which facts, preferences, or decisions were missed?"
   - Merges results, deduplicating by content similarity

**Commit**: `feat(semantic): implement three-tier extraction pipeline`

### C4: Extraction tests (`tests/semantic/extractor.test.ts`)

- Test: `chunkConversation()` correctly splits at 100+ turns with overlap
- Test: `chunkConversation()` returns single chunk for <100 turns
- Test: `buildExtractionPrompt()` includes metadata, exchange content, and prompt template
- Test: `buildExtractionPrompt()` filters non-text content
- Test: `parseExtractionResponse()` handles valid tool_use response
- Test: `parseExtractionResponse()` rejects invalid types
- Test: `parseExtractionResponse()` clamps importance to [0,1]
- Test: `parseExtractionResponse()` returns empty array for empty response
- Test: extraction with mock API client returns correct structure (mock `@anthropic-ai/sdk`)

**Commit**: `test(semantic): add extraction pipeline tests`

### C5: Add `@anthropic-ai/sdk` dependency

```bash
npm install @anthropic-ai/sdk
```

**Commit**: `chore: add @anthropic-ai/sdk dependency for semantic extraction`

---

## Stream D: Consolidation + Search + Integration

**Depends on**: Streams A, B, C all complete.

### D1: Implement consolidation pipeline (`src/semantic/consolidator.ts`)

**Purpose**: Deduplicate extracted facts against existing semantic store, detect conflicts, and merge or insert.

```typescript
// Key exports
export async function consolidateFacts(
  db: Database,
  facts: ExtractedFact[],
  conversationId: string,
): Promise<DeduplicationResult[]>;

export async function deduplicateFact(
  db: Database,
  fact: ExtractedFact,
  conversationId: string,
): Promise<DeduplicationResult>;

export async function resolveConflict(
  existingMemory: Memory,
  newFact: ExtractedFact,
  nliResult: NliResult,
): Promise<ConflictResolution>;
```

**Deduplication algorithm** (per extracted fact):

```
1. Embed the fact content
2. Find top-5 nearest neighbors in vec_memories
3. For each neighbor, compute cosine similarity:

   similarity ≥ 0.95:
     → Auto-merge: bump confidence, add source exchanges, recordAccess()
     → Return { action: "merge", mergedWithId }

   similarity 0.85-0.95:
     → Run NLI(existing.content, fact.content)
     → entailment > 0.7:  merge as reinforcement
     → contradiction > 0.7: resolve conflict
     → neutral:  insert as novel memory

   similarity < 0.85:
     → Skip this neighbor (no match)

4. If no neighbor matched: insert as novel memory
   → Return { action: "insert", memoryId: newUuid }
```

**Conflict resolution flow**:
```
1. NLI detects contradiction (score > 0.7)
2. Call LLM with resolve-conflict.md prompt
3. LLM classifies: UPDATE | KEEP_BOTH | NOOP
4. UPDATE: deactivateMemory(old), insertMemory(new) with superseded_by link
5. KEEP_BOTH: insertMemory(new), insertConflict() for tracking
6. NOOP: skip insertion, return { action: "skip" }
```

**Implementation details**:
- Processes facts sequentially (order matters for dedup within same batch)
- Uses `embedExchange()` from episodic/embeddings.ts for fact embedding (with `search_document:` prefix)
- Cosine similarity computed from vec0 distance (distance = 1 - cosine for normalized vectors)
- Conflict resolution reads `prompts/resolve-conflict.md` for prompt template
- All DB mutations wrapped in transactions

**Commit**: `feat(semantic): implement consolidation pipeline with dedup and conflict resolution`

### D2: Consolidation tests (`tests/semantic/consolidator.test.ts`)

- Test: novel fact (no neighbors) → action: "insert"
- Test: near-duplicate (sim ≥ 0.95) → action: "merge", confidence bumped
- Test: similar + entailment (sim 0.85-0.95, NLI entail) → action: "merge"
- Test: similar + contradiction → action: "conflict", conflict logged
- Test: similar + neutral → action: "insert" (treated as distinct)
- Test: conflict resolution UPDATE → old memory deactivated, new inserted
- Test: conflict resolution KEEP_BOTH → both active, conflict tracked
- Test: conflict resolution NOOP → no insertion
- Test: batch consolidation processes facts sequentially
- Test: dedup within same batch (fact A inserted, then similar fact B merges with A)

**Commit**: `test(semantic): add consolidation and dedup tests`

### D3: Implement semantic search (`src/semantic/search.ts`)

**Purpose**: Search the semantic memory store with decay-aware scoring.

```typescript
// Key exports
export async function searchSemantic(
  db: Database,
  options: SearchOptions,
): Promise<SearchResult[]>;
```

**Search pipeline**:
1. Embed query with `embedQuery()`
2. Vector search on `vec_memories` (top-20)
3. FTS search on `memories_fts` (top-20)
4. RRF fusion (reuse `rrfFuse()` from episodic/search.ts)
5. **Decay-aware re-scoring**: For each result, compute `computeRetrievalScore(rrfScore, memory)`
6. Re-sort by composite score
7. Normalize with `normalizeMinMaxFloored()`
8. Format results with memory type, confidence, and importance metadata

**Key difference from episodic search**: Semantic results include `type`, `confidence`, and `importance` in metadata, and scores are weighted by the FSRS decay model.

**Commit**: `feat(semantic): implement decay-aware semantic search`

### D4: Semantic search tests (`tests/semantic/search.test.ts`)

- Test: search returns memories matching query
- Test: results include type, confidence, importance in metadata
- Test: decay-aware scoring weights relevance > recency > importance
- Test: deactivated memories (is_active=false) excluded from results
- Test: type filter narrows results to specified memory types
- Test: empty query returns empty results
- Test: scores are normalized to [0.1, 1.0] range

**Commit**: `test(semantic): add semantic search tests`

### D5: Extend episodic search for multi-source (`src/episodic/search.ts`)

**Modifications**:

1. Add `searchMultiSource()` function that orchestrates across episodic + semantic:
   ```typescript
   export async function searchMultiSource(
     db: Database, options: SearchOptions
   ): Promise<RecallResponse>;
   ```

2. **Multi-source pipeline**:
   - Query episodic and semantic stores in parallel
   - Apply cross-source RRF fusion (RRF across two ranked lists)
   - **Semantic boost**: semantic results get 1.2x multiplier before fusion (higher signal density)
   - Re-normalize combined results
   - Token budget allocation: semantic memories first (higher value per token), then episodic

3. Add `formatSemanticXml()` for semantic results within the XML output:
   ```xml
   <semantic type="preference" confidence="85%" importance="high">
     User prefers Fish shell and uses tmux always
   </semantic>
   ```

4. Update `formatRecallXml()` to handle mixed episodic + semantic results

**Commit**: `feat(search): add multi-source search across episodic and semantic stores`

### D6: Multi-source search tests

Tests added to existing `tests/episodic/search.test.ts`:

- Test: `searchMultiSource()` returns results from both stores
- Test: semantic results have 1.2x boost before fusion
- Test: token budget prioritizes semantic over episodic
- Test: `formatRecallXml()` outputs both `<episodic>` and `<semantic>` tags
- Test: with no semantic memories, falls back to episodic-only
- Test: source filtering (`sources: ["semantic"]`) returns only semantic results

**Commit**: `test(search): add multi-source search integration tests`

### D7: Add `remember` tool to MCP server (`src/mcp/server.ts`)

**Modifications**:

1. Add `remember` tool definition:
   ```typescript
   {
     name: "remember",
     description: "Explicitly store something for future recall. " +
       "Use for important facts, preferences, decisions, or patterns.",
     inputSchema: {
       type: "object",
       properties: {
         content: { type: "string", minLength: 2 },
         type: {
           type: "string",
           enum: ["preference", "decision", "pattern", "fact", "solution", "convention"]
         },
         importance: { type: "number", minimum: 0, maximum: 1, default: 0.7 }
       },
       required: ["content", "type"]
     }
   }
   ```

2. **Handler behavior**:
   - Bypass extraction pipeline (direct insert)
   - High base confidence: 0.9 (user-stated facts are authoritative)
   - **Deduplicate before insert**: embed content, check vec_memories for sim ≥ 0.95
     - If near-duplicate found: merge (bump confidence), return "Updated existing memory"
     - If no duplicate: insert new memory, return "Remembered: {content}"
   - Generate embedding, insert into all three tables atomically

3. Update `recall` handler to use `searchMultiSource()` instead of `searchEpisodic()`:
   - Default `sources: ["episodic", "semantic"]`
   - Add optional `sources` parameter to recall schema

**Commit**: `feat(mcp): add remember tool and multi-source recall`

### D8: Add CLI commands (`src/cli/index.ts`)

**Append** two new commands:

1. `engram remember <content>`:
   ```
   Options:
     -t, --type <type>    Memory type (preference|decision|pattern|fact|solution|convention)
     -i, --importance <n>  Importance score (0.0-1.0, default 0.7)
   ```
   Uses same logic as MCP `remember` tool.

2. `engram extract <conversation-id>`:
   ```
   Options:
     --tier <tier>    Intelligence tier (auto|haiku|sonnet, default auto)
     --reflexion      Enable reflexion pass
     --dry-run        Show extracted facts without storing
   ```
   Runs extraction + consolidation on a single conversation. Useful for testing and manual processing.

3. Update `engram stats` to include semantic memory counts.

**Commit**: `feat(cli): add remember and extract commands`

### D9: Update package.json scripts

Add `extract` script for convenience:
```json
"extract": "tsx src/cli/index.ts extract"
```

**Commit**: `chore: update package.json scripts for Phase 3`

---

## Integration Testing

### D10: End-to-end integration test (`tests/semantic/integration.test.ts`)

Full pipeline test with mocked LLM:

1. Insert synthetic exchanges into episodic store
2. Run extraction → get facts
3. Run consolidation → facts deduplicated and inserted into semantic store
4. Run `searchMultiSource()` → results include semantic memories
5. Insert duplicate fact → verify merge (confidence bumped)
6. Insert contradictory fact → verify conflict logged
7. Use `remember` to add explicit memory → verify in search results
8. Verify deactivated memories excluded from search

~300 lines estimated.

**Commit**: `test(semantic): add end-to-end integration tests`

### D11: Full test suite verification

```bash
npm run test:run  # all tests pass
npm run build     # TypeScript compiles cleanly
```

**Commit** (if fixes needed): `fix: resolve Phase 3 integration test failures`

---

## Execution Timeline

### Phase 1: Parallel Foundation (Streams A + B + C)

| Agent | Steps | New Files | Independent? |
|-------|-------|-----------|-------------|
| Stream A | A1, A2 | nli.ts, nli.test.ts | Yes |
| Stream B | B1-B5 | types.ts, memory.ts, decay.ts, tests | Yes |
| Stream C | C1-C5 | extractor.ts, prompts/*, tests, package.json | Yes |

All three start simultaneously. No dependencies between them.

### Phase 2: Integration (Stream D, after A+B+C complete)

| Agent | Steps | Files Modified/Created |
|-------|-------|----------------------|
| Stream D | D1-D11 | consolidator.ts, semantic/search.ts, episodic/search.ts, mcp/server.ts, cli/index.ts, tests |

Stream D depends on all three foundation streams being complete.

### Phase 3: Final Verification

One agent runs:
```bash
npm run test:run  # all tests green
npm run build     # TypeScript compiles cleanly
```

---

## Verification Checklist

After implementation, verify:

1. **Tests pass**: `npm run test:run` (all existing + ~1,400 new test lines)
2. **Build compiles**: `npm run build` (strict TypeScript)
3. **NLI works**: Classification tests show correct entailment/contradiction/neutral
4. **Memory CRUD works**: Insert, update, deactivate, query all round-trip correctly
5. **Decay model works**: FSRS calculations produce expected values at boundary conditions
6. **Extraction works**: Mock conversations produce typed, atomic facts
7. **Consolidation works**: Duplicate facts merge, contradictions create conflicts
8. **Multi-source search works**: `engram search "query"` returns both episodic and semantic results
9. **Remember works**: `engram remember "User prefers dark mode" -t preference` stores and is retrievable
10. **MCP server works**: `remember` and updated `recall` tools function correctly

For live testing (optional, requires ANTHROPIC_API_KEY):
```bash
# Extract from a specific conversation
npm run dev -- extract <conversation-id> --dry-run

# Store an explicit memory
npm run dev -- remember "I prefer Fish shell" -t preference

# Search across all stores
npm run dev -- search "Fish shell preference"

# Check stats
npm run dev -- stats
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| DeBERTa ONNX model not compatible with @xenova/transformers@2.17.2 | Test with `Xenova/nli-deberta-v3-xsmall` as lightweight fallback |
| @anthropic-ai/sdk breaking changes | Pin exact version; schema-first approach decouples from SDK internals |
| NLI model download fails in CI | Tests use `vi.mock()` for model; integration test skips if model unavailable |
| Local LLM (MLX) not available | Graceful fallback: skip local tier, go directly to Haiku |
| vec_memories empty on first run | `findNearestMemories()` returns empty array → all facts insert as novel |
| FTS5 sync corruption | Same delete-then-insert pattern proven in Phase 1 episodic store |
| Prompt template drift | Prompts stored as separate files, tested via snapshot tests |
| Token cost runaway | Extraction uses Haiku ($1/MTok input) by default; Sonnet only as explicit fallback |
| Memory bloat from over-extraction | Importance threshold: discard facts with importance < 0.2 |

---

## Commit Sequence Summary

### Stream A (NLI)
1. `feat(semantic): add NLI contradiction detection pipeline`
2. `test(semantic): add NLI classification tests`

### Stream B (Memory + Decay)
1. `feat(semantic): add Phase 3 type definitions`
2. `feat(semantic): implement memory CRUD with FTS5/vec0 sync`
3. `feat(semantic): implement FSRS-inspired decay and confidence model`
4. `test(semantic): add memory CRUD and conflict tracking tests`
5. `test(semantic): add FSRS decay model tests`

### Stream C (Extraction)
1. `feat(semantic): add extraction prompt template with few-shot examples`
2. `feat(semantic): add conflict resolution prompt template`
3. `feat(semantic): implement three-tier extraction pipeline`
4. `test(semantic): add extraction pipeline tests`
5. `chore: add @anthropic-ai/sdk dependency for semantic extraction`

### Stream D (Consolidation + Integration)
1. `feat(semantic): implement consolidation pipeline with dedup and conflict resolution`
2. `test(semantic): add consolidation and dedup tests`
3. `feat(semantic): implement decay-aware semantic search`
4. `test(semantic): add semantic search tests`
5. `feat(search): add multi-source search across episodic and semantic stores`
6. `test(search): add multi-source search integration tests`
7. `feat(mcp): add remember tool and multi-source recall`
8. `feat(cli): add remember and extract commands`
9. `chore: update package.json scripts for Phase 3`
10. `test(semantic): add end-to-end integration tests`
11. `fix: resolve Phase 3 integration test failures` (if needed)
