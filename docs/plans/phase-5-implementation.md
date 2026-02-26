# Engram Phase 5: Dream State Daemon — Implementation Plan

## Context

Phases 1-4 built Engram's complete memory processing pipeline: episodic storage with hybrid search (Phase 1), score normalization and migration (Phase 2), semantic extraction with NLI contradiction detection and FSRS confidence decay (Phase 3), and the knowledge graph with entity extraction, resolution, community detection, and the `explore` MCP tool (Phase 4).

Phase 5 is the **orchestration layer** — a background daemon that autonomously runs the complete processing pipeline: syncing new conversations, extracting facts and entities, consolidating knowledge, analyzing the graph, and pruning decayed memories. All underlying components exist and are tested individually; this phase composes them into an autonomous background process.

**What Phase 5 delivers:**
1. **Pipeline orchestrator** (`src/dream/daemon.ts`) — five-phase sequential pipeline composing all existing Phase 1-4 components
2. **Checkpoint/resume** (`src/dream/scheduler.ts`) — crash-safe per-conversation checkpointing using existing `dream_checkpoints` table
3. **Local LLM adapter** (`src/dream/intelligence.ts`) — Ollama REST API integration with Claude API fallback
4. **CLI `dream` command** — on-demand trigger with phase selection and progress display
5. **launchd integration** — macOS Launch Agent for scheduled 2 AM runs
6. **Memory pruning** — PRUNE phase executing FSRS-based confidence decay on all active memories

**What Phase 5 does NOT include** (deferred to Phase 6):
- LLM-generated community summaries (topic cluster naming)
- Temporal pattern analysis
- Maps of Content generation
- Cross-encoder reranking
- Reflection observations (higher-order pattern synthesis)

**Research backing:**
- [Codebase readiness](../research/phase-5-codebase-readiness.md) — gap analysis, pipeline composition pattern
- [launchd patterns](../research/daemon-launchd-patterns.md) — Launch Agent configuration, signal handling
- [MLX/Ollama integration](../research/mlx-local-llm-integration.md) — model selection, structured output
- [Checkpoint/resume](../research/checkpoint-resume-patterns.md) — idempotent patterns, error handling
- [Memory consolidation](../research/memory-consolidation-pipelines.md) — Graphiti pipeline, priority scheduling

---

## New Dependencies

None required. Phase 5 uses only:
- Node.js built-in `fetch` for Ollama REST API calls (no npm package needed)
- Node.js built-in `child_process` for optional MLX subprocess fallback
- All existing npm dependencies (better-sqlite3, @anthropic-ai/sdk, graphology, etc.)

---

## Architecture Overview

```
                    CLI: engram dream          launchd: 2 AM trigger
                         │                          │
                         ▼                          ▼
                ┌────────────────────────────────────────┐
                │           Dream Daemon                  │
                │                                        │
                │  ┌──────────┐   ┌──────────────────┐  │
                │  │ Scheduler │   │  Intelligence     │  │
                │  │           │   │  Layer            │  │
                │  │ Priority  │   │                   │  │
                │  │ Checkpoint│   │  Ollama (local)   │  │
                │  │ Resume    │   │  ↓ fallback       │  │
                │  │           │   │  Claude API       │  │
                │  └─────┬─────┘   └────────┬──────────┘  │
                │        │                  │              │
                │  ┌─────▼──────────────────▼───────────┐ │
                │  │     Pipeline Orchestrator           │ │
                │  │                                     │ │
                │  │  Phase 1: INGEST                    │ │
                │  │    syncConversations()               │ │
                │  │                                     │ │
                │  │  Phase 2: EXTRACT                   │ │
                │  │    processConversation() per conv:  │ │
                │  │      extractFromConversation()      │ │
                │  │      extractEntities()              │ │
                │  │      resolveEntities()              │ │
                │  │      extractRelationships()         │ │
                │  │      findOrCreateRelationship()     │ │
                │  │                                     │ │
                │  │  Phase 3: CONSOLIDATE               │ │
                │  │    consolidateFacts() per batch      │ │
                │  │                                     │ │
                │  │  Phase 4: REFLECT                   │ │
                │  │    analyzeGraph() + persistAnalysis()│ │
                │  │                                     │ │
                │  │  Phase 5: PRUNE                     │ │
                │  │    scanAndPruneMemories()            │ │
                │  └─────────────────────────────────────┘ │
                │                                          │
                │  dream_runs ←→ dream_checkpoints (SQLite)│
                └──────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Dream Scheduler (`src/dream/scheduler.ts`)

**Purpose**: Manages the work queue, checkpointing, and run lifecycle using existing `dream_runs` and `dream_checkpoints` tables.

**Functions to implement:**

```typescript
// Run lifecycle
createRun(db): string                                    // INSERT dream_runs, returns run_id
completeRun(db, runId, report: DreamReport): void        // UPDATE dream_runs SET completed_at, stats
failRun(db, runId, error: string): void                  // UPDATE dream_runs SET error
getIncompleteRun(db): { id: string; phasesCompleted: DreamPhase[] } | null  // Find resumable run

// Checkpointing
isCheckpointed(db, runId, phase, itemId): boolean         // SELECT 1 FROM dream_checkpoints
recordCheckpoint(db, runId, phase, itemId): void          // INSERT dream_checkpoints
getCheckpointedItems(db, runId, phase): Set<string>       // Batch fetch all checkpoints for a phase

// Priority queue
getUnprocessedConversations(db, runId): string[]           // Conversations not in checkpoints for this run
prioritizeConversations(db, conversationIds): string[]     // Sort by: recency, tool diversity, entity overlap

// Progress tracking
getPhaseProgress(db, runId, phase): DreamProgress          // Aggregate from checkpoints
```

**Key design decisions:**
- All checkpoint operations use SQLite transactions for atomicity
- `getCheckpointedItems()` loads the full set once per phase for O(1) lookups
- Priority scoring is simple: `score = recencyBonus + toolCountBonus + entityOverlapBonus`
- Resume logic: if `getIncompleteRun()` returns a run, skip phases in its `phasesCompleted` array

**Test file**: `tests/dream/scheduler.test.ts`
- Test run creation and completion
- Test checkpoint idempotency (inserting same checkpoint twice is safe)
- Test resume: create run, checkpoint some items, verify `getUnprocessedConversations` skips them
- Test priority ordering

---

### Step 2: Local LLM Intelligence Layer (`src/dream/intelligence.ts`)

**Purpose**: Provides a unified LLM interface that prefers local inference (Ollama) and falls back to Claude API.

**Functions to implement:**

```typescript
interface IntelligenceConfig {
  ollamaUrl?: string;    // default: "http://localhost:11434"
  ollamaModel?: string;  // default: "qwen2.5:7b"
  apiModel?: string;     // default from config.dream.apiModel
}

// Availability check
isOllamaAvailable(config): Promise<boolean>     // GET /api/tags, check model exists

// Structured generation (for fact/entity extraction)
generateStructured<T>(
  prompt: string,
  schema: object,         // JSON Schema for structured output
  config: IntelligenceConfig
): Promise<{ result: T; source: "local" | "api"; confidence: number }>

// Simple generation (for conflict resolution, summaries)
generate(
  prompt: string,
  config: IntelligenceConfig
): Promise<{ text: string; source: "local" | "api" }>
```

**Key design decisions:**
- Ollama's JSON schema mode (available since v0.5) enforces output structure via grammar
- Confidence estimation: if Ollama responds with valid JSON matching schema → confidence 1.0; if parse fails → confidence 0.0 → escalate to API
- Connection timeout: 5s for availability check, 120s for generation (long prompts)
- Model warm-start: first call may be slow (model loading); subsequent calls use Ollama's keep-alive
- No new npm dependencies: use native `fetch` for HTTP calls

**Integration with existing extractors:**
- The `src/semantic/extractor.ts` `resolveModels()` function has a `"local"` tier that throws "not yet implemented"
- Update it to call `intelligence.generateStructured()` when tier is `"local"` and `config.dream.localModel` is set
- The extractor's tool-use schema becomes the JSON schema passed to Ollama

**Test file**: `tests/dream/intelligence.test.ts`
- Mock HTTP responses for Ollama API
- Test fallback: Ollama unavailable → uses API client
- Test structured output parsing and validation
- Test timeout handling

---

### Step 3: Pipeline Orchestrator (`src/dream/daemon.ts`)

**Purpose**: The main entry point that composes all pipeline phases into a sequential processing run.

**Functions to implement:**

```typescript
interface DreamOptions {
  phases?: DreamPhase[];           // which phases to run (default: all)
  conversationId?: string;         // process specific conversation only
  dryRun?: boolean;                // show what would be processed
  verbose?: boolean;               // detailed progress output
  onProgress?: (progress: DreamProgress) => void;  // progress callback
}

// Main entry point
runDream(db, config, options: DreamOptions): Promise<DreamReport>

// Per-conversation full pipeline
processConversation(
  db, conversationId, config, options
): Promise<ConversationResult>

// Individual phase runners
runIngestPhase(db, config, runId, options): Promise<PhaseResult>
runExtractPhase(db, config, runId, conversationIds, options): Promise<PhaseResult>
runConsolidatePhase(db, config, runId, options): Promise<PhaseResult>
runReflectPhase(db, config, runId, options): Promise<PhaseResult>
runPrunePhase(db, config, runId, options): Promise<PhaseResult>
```

**The critical composition** (`processConversation`):
```
1. Load exchanges from DB for this conversation
2. extractFromConversation() → ExtractedFact[]
3. Store facts temporarily for batch consolidation
4. extractEntities() → ExtractedEntity[]
5. resolveEntities() → ResolvedEntity[] (creates/merges in graph)
6. extractRelationships() → ExtractedRelationship[]
7. For each relationship: findOrCreateRelationship() (persists to graph)
8. Return per-conversation stats
```

**Phase sequence:**
1. **INGEST**: Call `syncConversations()`. Collect newly indexed conversation IDs from the sync result.
2. **EXTRACT**: For each unprocessed conversation (minus checkpointed ones):
   - Call `processConversation()` — full extraction + entity + relationship pipeline
   - Accumulate extracted facts for batch consolidation
   - Record checkpoint per conversation
3. **CONSOLIDATE**: Call `consolidateFacts()` on accumulated facts in batches.
4. **REFLECT**: Call `analyzeGraph()` + `persistAnalysis()` — full graph re-analysis.
5. **PRUNE**: Iterate all active memories, compute `isPruneEligible()`, deactivate eligible ones.

**Signal handling:**
- SIGTERM: Set `shuttingDown = true`, complete current conversation, checkpoint, exit cleanly
- SIGINT: Same as SIGTERM
- uncaughtException: Log error, fail current run, exit with code 1

**Logging:**
- Write structured log entries to `config.logsDir/dream.log`
- Each entry: `{ timestamp, phase, conversationId?, action, details }`
- Progress: log at start/end of each phase, every N conversations processed

**Test file**: `tests/dream/daemon.test.ts`
- Mock all pipeline components (extractor, consolidator, graph extractor, etc.)
- Test full pipeline composition with mock data
- Test phase selection (run only specific phases)
- Test dry-run mode
- Test checkpoint/resume: process 3 conversations, crash after 2, verify resume processes only the 3rd
- Test signal handling: start processing, send SIGTERM, verify clean exit with checkpoint
- Test error handling: one conversation fails, others still process (skip-and-continue)

---

### Step 4: CLI `dream` Command (`src/cli/index.ts`)

**Purpose**: Add the `dream` command handler to the CLI.

**Implementation:**
```typescript
program
  .command("dream")
  .description("Run dream state processing pipeline")
  .option("--phase <phase>", "Run only a specific phase: ingest|extract|consolidate|reflect|prune")
  .option("--conversation <id>", "Process a specific conversation")
  .option("--dry-run", "Show what would be processed without making changes")
  .option("--verbose", "Show detailed progress")
  .action(async (opts) => {
    const { runDream } = await import("../dream/daemon.js");
    const { initEmbeddings } = await import("../episodic/embeddings.js");
    const config = loadConfig();
    const db = initDatabase(config);

    try {
      await initEmbeddings(config);

      const phases = opts.phase ? [opts.phase] : undefined;
      const report = await runDream(db, config, {
        phases,
        conversationId: opts.conversation,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        onProgress: (p) => {
          if (opts.verbose) {
            process.stdout.write(`\r  [${p.phase}] ${p.processed}/${p.total} (${p.errors} errors)`);
          }
        },
      });

      // Print report
      console.log("\nDream complete:");
      for (const phase of report.phases) {
        console.log(`  ${phase.phase}: ${phase.itemsProcessed} items, ${phase.errors} errors (${phase.durationMs}ms)`);
      }
      console.log(`\n  New memories:     ${report.newMemories}`);
      console.log(`  Updated memories: ${report.updatedMemories}`);
      console.log(`  New entities:     ${report.newEntities}`);
      console.log(`  New relationships:${report.newRelationships}`);
      console.log(`  Conflicts:        ${report.conflictsDetected}`);
      console.log(`  Pruned:           ${report.memoriesPruned}`);
    } finally {
      db.close();
    }
  });
```

No separate test file needed — the CLI is tested through the daemon tests and integration tests.

---

### Step 5: launchd Integration

**Files to create:**

**`launchd/com.engram.dreamstate.plist`**:
- Launch Agent (user-level, not system daemon)
- `StartCalendarInterval`: Hour=2, Minute=0 (2 AM daily)
- `ProgramArguments`: `/usr/local/bin/node`, `dist/cli/index.js`, `dream`
- `EnvironmentVariables`: `ANTHROPIC_API_KEY`, `ENGRAM_LOCAL_MODEL`, `NODE_ENV=production`
- `StandardOutPath`: `~/.local/share/engram/logs/dream.log`
- `StandardErrorPath`: `~/.local/share/engram/logs/dream-error.log`
- `Nice`: 10 (low priority)
- `ProcessType`: Background
- `ThrottleInterval`: 3600 (at most once per hour if restarted)

**`scripts/install-daemon.sh`**:
```bash
#!/bin/bash
# Install: copies plist to ~/Library/LaunchAgents/, loads via launchctl
# Uninstall: unloads via launchctl, removes plist
# Status: launchctl list | grep engram
```

No test file — these are configuration files validated by manual installation.

---

### Step 6: Local Tier Integration in Extractor

**File**: `src/semantic/extractor.ts`

**Change**: In `resolveModels()`, replace the `throw new Error("Local extraction tier not yet implemented")` with a call to the intelligence layer:

```typescript
case "local":
  if (!config?.dream?.localModel) {
    // No local model configured, escalate to auto tier
    return resolveModels("auto", config);
  }
  return {
    model: config.dream.localModel,
    tier: "local",
    isLocal: true,
  };
```

And in `extractFromConversation()`, when `isLocal` is true, route through `intelligence.generateStructured()` instead of the Anthropic SDK client.

**Test**: Add a test case in `tests/semantic/extractor.test.ts` for local tier routing.

---

### Step 7: Integration Testing

**File**: `tests/dream/integration.test.ts`

End-to-end test with real (mocked) pipeline:
1. Create test DB with synthetic conversations
2. Run `runDream()` with all phases
3. Verify: exchanges indexed, facts extracted, memories created, entities resolved, relationships persisted, graph analyzed, prunable memories deactivated
4. Verify: dream_runs and dream_checkpoints populated correctly
5. Verify: running dream again processes nothing (idempotent)

---

## Execution Order

The implementation steps should be executed in this order due to dependencies:

```
Step 1: Scheduler (foundation)
    ↓
Step 2: Intelligence Layer (needed by daemon)
    ↓
Step 3: Daemon Orchestrator (depends on 1 + 2)
    ↓
Step 4: CLI Command (thin wrapper around 3)
    ↓
Step 5: launchd Integration (configuration only, depends on 4)
    ↓
Step 6: Local Tier in Extractor (connects intelligence to existing code)
    ↓
Step 7: Integration Tests (validates the whole thing)
```

Steps 1 and 2 can be parallelized (no dependencies between them).
Steps 4 and 5 can be parallelized (both depend only on Step 3).

---

## File Summary

### New Files (7)

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/dream/daemon.ts` | ~350 | Pipeline orchestrator, phase runners, signal handling |
| `src/dream/scheduler.ts` | ~200 | Run lifecycle, checkpoints, priority queue |
| `src/dream/intelligence.ts` | ~180 | Ollama/MLX adapter with API fallback |
| `launchd/com.engram.dreamstate.plist` | ~45 | macOS Launch Agent configuration |
| `scripts/install-daemon.sh` | ~60 | launchd install/uninstall script |
| `tests/dream/daemon.test.ts` | ~300 | Orchestrator unit tests |
| `tests/dream/scheduler.test.ts` | ~200 | Checkpoint/scheduler tests |
| `tests/dream/intelligence.test.ts` | ~150 | Intelligence layer tests |
| `tests/dream/integration.test.ts` | ~200 | End-to-end pipeline test |

### Modified Files (2)

| File | Change | Lines Changed (est.) |
|------|--------|---------------------|
| `src/cli/index.ts` | Add `dream` command handler | +50 |
| `src/semantic/extractor.ts` | Implement `"local"` tier routing | +30 |

### Unchanged Files (30+)

All Phase 1-4 source files, all existing tests, prompts, MCP server, config, types, database schema.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Ollama not installed | Graceful fallback to API; `isOllamaAvailable()` check at startup |
| First run on large history | Priority queue processes newest first; configurable batch limit |
| Pipeline composition edge cases | Extensive integration test with synthetic data |
| SQLite WAL write conflicts | `concurrency: 1` default; daemon runs when MCP server is idle (2 AM) |
| Model loading latency | Ollama keep-alive; intelligence layer retries after timeout |
| Extraction failures (bad API response) | Skip-and-continue per conversation; log error; checkpoint |

---

## Success Criteria

- [ ] `engram dream` runs all 5 phases to completion
- [ ] Pipeline correctly composes: ingest → extract facts + entities + relationships → consolidate → analyze graph → prune
- [ ] Checkpoint/resume: killing the daemon mid-run and restarting processes only unfinished work
- [ ] Local LLM extraction works via Ollama when available, falls back to API when not
- [ ] launchd plist can be installed and triggers the daemon on schedule
- [ ] All new tests pass, all existing 314 tests still pass
- [ ] `engram dream --dry-run` shows what would be processed without side effects
- [ ] `engram dream --phase ingest` runs only the ingest phase (quick sync)
