# Phase 6: Reflection & Emergence -- Codebase Readiness Assessment

> **Referenced by:** [spec.md §Phase 6](../../spec.md) | [Phase 6 Implementation Plan](../plans/phase-6-implementation.md)
> **Related research:** [Emergence Patterns](phase-6-emergence-patterns.md) | [Temporal & Tooling](phase-6-temporal-and-tooling.md) | [Graph Analysis (Phase 4)](graph-analysis-research.md)

**Date:** 2026-02-26
**Branch:** worktree-phase-6-emergence
**Assessor:** Codebase analysis of all Phase 6 integration points

---

## 1. Executive Summary

**Overall Readiness: ~55%**

The codebase has strong foundations for Phase 6. Community detection (Louvain), bridge entity identification, coherence scoring, and graph analysis persistence are all implemented and tested in `src/graph/analyzer.ts`. The dream daemon already orchestrates a five-phase pipeline including REFLECT and PRUNE phases that call into the analyzer. The MCP server provides four tools (`recall`, `remember`, `show`, `explore`) with a clean pattern for adding new tools.

**Key gaps that require new implementation:**

| Deliverable | Readiness | Effort |
|---|---|---|
| Community detection (Louvain) | 95% -- exists, needs LLM naming | Low |
| Maps of Content generation | 40% -- table/persistence exist, no LLM naming, no MoC formatting | Medium |
| Bridge entity identification | 90% -- fully implemented, needs surfacing in MCP | Low |
| Temporal pattern analysis | 0% -- does not exist anywhere | High |
| `reflect` MCP tool | 0% -- tool does not exist, but pattern is established | Medium |
| Dream reflect/prune phases | 85% -- implemented, reflect phase needs MoC generation | Low |

**Critical path:** Temporal pattern analysis is the largest gap. Everything else builds on existing, tested infrastructure. The `reflect` MCP tool is the primary user-facing deliverable and depends on all other components being wired together.

---

## 2. Component-by-Component Analysis

### 2.1 Community Detection (Louvain)

**Current State: IMPLEMENTED**

- **File:** `/Users/USER/Documents/git/engram/.claude/worktrees/phase-6-emergence/src/graph/analyzer.ts`, lines 68-132
- `detectCommunities()` (line 76) calls `louvain.detailed()` with configurable resolution, returns community map, count, and modularity score
- `groupByCommunity()` (line 117) inverts node-to-community into community-to-nodes
- `computeCoherence()` (line 143) scores each community's internal vs external edge ratio
- Dependencies installed: `graphology` ^0.26.0, `graphology-communities-louvain` ^2.0.2

**Gap Analysis:**
- Community naming uses generic labels: `"Community ${community.communityId}"` (analyzer.ts, line 335). Phase 6 requires LLM-generated topic names based on the community's entities and relationships.
- No community summary generation. The `description` field is auto-generated boilerplate: `"Auto-detected community with ${n} entities (coherence: ${score})"` (line 336).
- The `topic_clusters.memory_ids` field is always stored as `JSON.stringify([])` (line 339) -- never populated with related memories.

**Integration Points:**
- Called by `runReflectPhase()` in `src/dream/daemon.ts` (line 441)
- Results persisted via `persistAnalysis()` to `topic_clusters` table
- `exploreEntity()` in `src/graph/search.ts` (line 200) looks up topic_clusters to show community context

**Complexity Estimate:** LOW -- the algorithm is complete; the gap is adding an LLM naming step after detection.

---

### 2.2 Maps of Content (MoC) Generation

**Current State: PARTIALLY IMPLEMENTED**

- **Schema:** `topic_clusters` table exists (`src/core/db.ts`, line 180) with fields: `id`, `name`, `description`, `entity_ids`, `memory_ids`, `coherence_score`, `created_at`, `updated_at`, `generation`
- **Type:** `TopicCluster` interface exists (`src/core/types.ts`, line 130) with all required fields
- **Persistence:** `persistAnalysis()` (`src/graph/analyzer.ts`, line 315) writes community results to the table
- **Retrieval:** `exploreEntity()` (`src/graph/search.ts`, line 200) reads topic_clusters and returns community info

**Gap Analysis:**
1. **No LLM-based naming.** The research doc (`docs/research/graph-analysis-research.md`, section 5) specifies a community-to-LLM pipeline for generating meaningful topic names and descriptions. This is not implemented. The intelligence layer (`src/dream/intelligence.ts`) provides `generate()` and `generateStructured()` functions ready to use, but no prompt template exists for community naming.
2. **No prompt template.** The `prompts/` directory has templates for fact extraction, entity extraction, relationship extraction, and conflict resolution, but nothing for community/topic naming.
3. **No MoC document format.** There is no function to render a Map of Content as a formatted document (markdown, XML, or structured text) that the `reflect` tool could return to the user.
4. **`memory_ids` never populated.** The community-to-memory linkage is not computed. This would require joining `topic_clusters.entity_ids` -> `relationships.source_memories` -> `memories.id` to find memories relevant to each community.
5. **No hierarchical clustering.** The research doc discusses using the Louvain dendrogram for multi-level topic hierarchies. The `generation` field in the schema could support this, but currently only tracks sequential analysis runs, not hierarchy levels.

**Integration Points:**
- Will need: a new prompt template (`prompts/name-community.md`), a new function in `src/graph/analyzer.ts` or a new `src/graph/clusters.ts` module, integration with the intelligence layer
- Consumes: `GraphAnalysisResult.communities`, entity data from `src/graph/entity.ts`
- Produces: updated `topic_clusters` rows with meaningful names/descriptions

**Complexity Estimate:** MEDIUM -- requires new prompt template, LLM call integration, and memory linkage computation.

---

### 2.3 Bridge Entity Identification

**Current State: FULLY IMPLEMENTED**

- **File:** `/Users/USER/Documents/git/engram/.claude/worktrees/phase-6-emergence/src/graph/analyzer.ts`, lines 195-250
- `computeBetweenness()` (line 179) wraps `graphology-metrics/centrality/betweenness`
- `detectBridgeEntities()` (line 205) combines betweenness centrality with community span
- Bridge score formula: `bridgeScore = betweenness * communitySpan` (line 239)
- Results sorted descending by bridgeScore (line 247)
- Returned in `GraphAnalysisResult.bridgeEntities` with full metadata (line 60 in types.ts)

**Gap Analysis:**
- Bridge entities are computed and returned in `GraphAnalysisResult` but are **not persisted** to any table. The `persistAnalysis()` function (line 315) only writes communities to `topic_clusters`; bridge entities are discarded.
- Bridge entity information is not surfaced in the MCP `explore` tool output. The `ExploreResult` type (types.ts, line 90) has a `community` field but no bridge entity field.
- No dedicated query function to retrieve "what are the bridge entities?" from the database.

**Integration Points:**
- Already called by `analyzeGraph()` pipeline (line 295)
- Needs: persistence (new table or extension to existing), MCP tool exposure, and inclusion in the `reflect` tool output

**Complexity Estimate:** LOW -- the algorithm is done; needs a persistence target and MCP wiring.

---

### 2.4 Temporal Pattern Analysis

**Current State: DOES NOT EXIST**

There is no temporal pattern analysis anywhere in the codebase. This is the largest gap for Phase 6.

**What's needed:**
1. **Activity pattern detection:** Identify when topics/entities are most active over time (daily, weekly, seasonal patterns)
2. **Knowledge evolution tracking:** Track how entity relationships change across dream generations
3. **Topic emergence/decay detection:** Identify newly emerging topics and declining ones
4. **Cross-session pattern recognition:** Find patterns in how the user's work evolves

**Existing data available for temporal analysis:**
- `entities.first_seen`, `entities.last_seen`, `entities.mention_count` -- entity temporal metadata
- `relationships.created_at`, `relationships.updated_at` -- relationship temporal metadata
- `exchanges.timestamp` -- conversation timestamps
- `memories.created_at`, `memories.last_accessed` -- memory temporal data
- `topic_clusters.generation` -- community evolution across dream runs
- `dream_runs.started_at`, `dream_runs.completed_at` -- dream cycle history
- `dream_checkpoints.processed_at` -- processing history

**Gap Analysis:**
1. No temporal analysis functions exist
2. No schema for storing temporal patterns (e.g., `temporal_patterns` table)
3. No types for temporal pattern results
4. No prompt templates for LLM-based pattern interpretation
5. No integration with the dream daemon's reflect phase

**What could be built:**
- **Entity activity timelines:** Group entity mentions by time period, compute activity trends
- **Topic evolution tracking:** Compare `topic_clusters` across generations to detect emergence, merging, splitting, and decay
- **Relationship velocity:** Track which relationships are strengthening or weakening over time
- **Session pattern analysis:** Analyze conversation timestamps for usage patterns

**Integration Points:**
- Would consume: entity/relationship temporal fields, topic_clusters across generations, exchange timestamps
- Would produce: temporal pattern records, trend metadata for MoC enrichment
- Would integrate with: dream daemon reflect phase, `reflect` MCP tool

**Complexity Estimate:** HIGH -- requires new module, new schema, new types, new analysis functions, possibly new prompt templates. This is the one component that is entirely greenfield.

---

### 2.5 `reflect` MCP Tool

**Current State: DOES NOT EXIST**

The MCP server (`src/mcp/server.ts`) has four tools: `recall` (line 139), `remember` (line 191), `show` (line 238), `explore` (line 262). No `reflect` tool exists.

**Existing pattern for adding tools:**

The server uses a clean pattern:
1. Define input schema with Zod (lines 74-125)
2. Register tool definition with JSON Schema in `ListToolsRequestSchema` handler (line 136)
3. Handle tool calls in `CallToolRequestSchema` handler (line 315)
4. Format output as text/XML content blocks

**What the `reflect` tool should provide:**
1. **Community overview:** List all detected communities with their topic names, entity counts, and coherence scores
2. **Bridge entity report:** Top bridge entities connecting different knowledge domains
3. **Temporal patterns:** Emerging/declining topics, activity trends
4. **Maps of Content:** Formatted hierarchical topic map
5. **Knowledge graph health:** Overall statistics (nodes, edges, modularity, orphan entities)

**Gap Analysis:**
- Tool definition and handler: need to be written from scratch
- Input schema: needs design (e.g., `{ focus?: "communities" | "bridges" | "patterns" | "overview" }`)
- Output format: needs design (XML format consistent with existing `recall` and `explore` tools)
- Backend functions: partially exist (communities, bridges) but need assembly into a unified reflection report

**Integration Points:**
- Will import: `analyzeGraph()` or read cached results from `topic_clusters`
- Will import: bridge entity data (needs persistence first)
- Will import: temporal patterns (needs implementation first)
- Will use: existing graph search/entity lookup functions
- Must follow: existing MCP tool patterns (Zod validation, XML output, error handling)

**Complexity Estimate:** MEDIUM -- the MCP integration pattern is well-established; complexity comes from assembling data from multiple sources and designing a useful output format.

---

### 2.6 Dream Processing (Reflect & Prune Phases)

**Current State: IMPLEMENTED**

- **File:** `/Users/USER/Documents/git/engram/.claude/worktrees/phase-6-emergence/src/dream/daemon.ts`
- `runReflectPhase()` (line 423): Calls `analyzeGraph()` and `persistAnalysis()`, records checkpoint
- `runPrunePhase()` (line 476): Scans all active memories, applies `isPruneEligible()` from decay.ts, deactivates eligible memories
- Pipeline orchestration (line 99): Runs phases sequentially with checkpointing and resume support
- Signal handling (line 65): Graceful shutdown on SIGTERM/SIGINT

**Gap Analysis:**
1. **Reflect phase is too simple.** Currently only runs `analyzeGraph()` + `persistAnalysis()` (lines 441-442). For Phase 6, it should also:
   - Run LLM-based community naming
   - Compute memory-to-community linkage
   - Detect bridge entities and persist them
   - Run temporal pattern analysis
   - Generate Maps of Content
2. **No weight recomputation.** The research doc recommends recomputing edge weights during reflect (using `computeEdgeWeight()` from `src/graph/relationship.ts`), but this is not done.
3. **Prune phase works correctly** and needs no Phase 6 changes. The FSRS-based decay model (`src/semantic/decay.ts`) is solid.

**Integration Points:**
- Reflect phase calls: `analyzeGraph()`, `persistAnalysis()` (both in `src/graph/analyzer.ts`)
- Needs to call: new community naming function, temporal analysis, bridge persistence
- Intelligence layer available: `generate()`, `generateStructured()` in `src/dream/intelligence.ts`
- Config available: `config.dream.localModel`, `config.dream.apiModel` for LLM routing

**Complexity Estimate:** LOW -- the orchestration infrastructure is in place; the reflect phase just needs more steps added to its function body.

---

## 3. Existing Test Coverage

### 3.1 Graph Analyzer Tests

**File:** `/Users/USER/Documents/git/engram/.claude/worktrees/phase-6-emergence/tests/graph/analyzer.test.ts`
**Coverage:** 477 lines, 21 test cases

| Function | Tests | Status |
|---|---|---|
| `loadGraph()` | 5 tests | Full: node/edge counts, attributes, empty graph, dedup |
| `detectCommunities()` | 5 tests | Full: community count, assignment, modularity, edge cases |
| `groupByCommunity()` | 1 test | Adequate: inversion logic |
| `computeCoherence()` | 3 tests | Full: clique=1.0, external edges, isolated nodes |
| `computeBetweenness()` | 3 tests | Full: non-negative, star center, empty graph |
| `detectBridgeEntities()` | 3 tests | Full: bridge identification, sort order, score filter |
| `analyzeGraph()` | 2 tests | Full: structure validation, empty graph |
| `persistAnalysis()` | 3 tests | Full: DB writes, generation increment, coherence scores |

**Test Infrastructure:**
- `createTestDb()` in `tests/helpers.ts` provides in-memory SQLite with full schema
- Helper functions `insertTestEntity()` and `insertTestRelationship()` for graph construction
- Two graph fixtures: star graph (`buildStarGraph`) and two-cliques-with-bridge (`buildTwoCliquesWithBridge`)

**What needs new tests for Phase 6:**
- LLM community naming (mock intelligence layer)
- Memory-to-community linkage computation
- Bridge entity persistence
- Temporal pattern analysis (entirely new)
- `reflect` MCP tool handler
- Enhanced reflect phase in daemon

### 3.2 Dream Daemon Tests

**File:** `/Users/USER/Documents/git/engram/.claude/worktrees/phase-6-emergence/tests/dream/daemon.test.ts`
**Coverage:** 617 lines, 19 test cases

| Area | Tests | Status |
|---|---|---|
| Pipeline orchestration | 5 tests | Full: phase order, selective phases, dry run, run lifecycle, resume |
| Error handling | 3 tests | Full: skip-and-continue, fatal errors, error checkpoints |
| Ingest phase | 2 tests | Full: sync call, checkpoint |
| Extract phase | 4 tests | Full: processing, skip checkpointed, checkpoint recording, graph extraction |
| Consolidate phase | 1 test | Adequate: fact consolidation |
| Reflect phase | 2 tests | Full: graph analysis call, checkpoint |
| Prune phase | 3 tests | Full: memory scanning, deactivation, count reporting |

**Mocking approach:** All external dependencies (sync, embeddings, extractors, analyzer, decay) are fully mocked with `vi.mock()`. Tests verify orchestration logic without hitting real LLMs or embeddings.

**What needs new tests for Phase 6:**
- Enhanced reflect phase with LLM naming and temporal analysis
- New test cases for bridge persistence within reflect phase
- Integration test for reflect phase producing MoC output

### 3.3 Test Gaps Summary

No existing tests for:
- `src/graph/search.ts` (explore entity, traverse neighborhood)
- `src/mcp/server.ts` (MCP tool handlers)
- Temporal pattern analysis (does not exist yet)
- Community naming via LLM
- Bridge entity persistence
- Maps of Content formatting

---

## 4. Schema Readiness

### 4.1 Tables That Exist and Are Sufficient

| Table | File | Status | Notes |
|---|---|---|---|
| `entities` | db.ts:131 | Ready | Has `first_seen`, `last_seen`, `mention_count` for temporal analysis |
| `relationships` | db.ts:148 | Ready | Has `created_at`, `updated_at`, `weight` for temporal tracking |
| `topic_clusters` | db.ts:180 | Mostly ready | Has all fields; `memory_ids` never populated |
| `memories` | db.ts:93 | Ready | Has `created_at`, `last_accessed`, `access_count` for temporal analysis |
| `exchanges` | db.ts:37 | Ready | Has `timestamp` for temporal analysis |
| `dream_runs` | db.ts:197 | Ready | Tracks dream cycle history |
| `dream_checkpoints` | db.ts:211 | Ready | Tracks per-item processing |

### 4.2 Tables/Columns That Need Creation or Modification

1. **`bridge_entities` table (NEW)** -- Persist bridge entity analysis results
   ```sql
   CREATE TABLE IF NOT EXISTS bridge_entities (
     id TEXT PRIMARY KEY,
     entity_id TEXT NOT NULL REFERENCES entities(id),
     betweenness REAL NOT NULL,
     community_span INTEGER NOT NULL,
     bridge_score REAL NOT NULL,
     generation INTEGER NOT NULL,
     created_at INTEGER DEFAULT (unixepoch())
   );
   ```
   *Alternatively:* Store bridge entities as JSON in `topic_clusters` or an analysis results table.

2. **`temporal_patterns` table (NEW)** -- Store detected temporal patterns
   ```sql
   CREATE TABLE IF NOT EXISTS temporal_patterns (
     id TEXT PRIMARY KEY,
     pattern_type TEXT NOT NULL, -- 'emergence', 'decline', 'seasonal', 'burst'
     entity_ids TEXT,           -- JSON array of related entity IDs
     community_ids TEXT,        -- JSON array of related community IDs
     description TEXT,
     confidence REAL,
     time_range_start INTEGER,
     time_range_end INTEGER,
     generation INTEGER NOT NULL,
     created_at INTEGER DEFAULT (unixepoch())
   );
   ```

3. **`topic_clusters.parent_id` column (OPTIONAL)** -- For hierarchical MoC support
   - Would enable nested topic hierarchies using the Louvain dendrogram
   - Not strictly required for Phase 6 MVP

### 4.3 Schema Migration Strategy

Engram uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` idempotent schema in `src/core/db.ts:createSchema()`. New tables can be added to the same function. No formal migration framework exists, but the approach is crash-safe for additive changes.

---

## 5. Type System Readiness

### 5.1 Types That Exist and Are Sufficient

| Type | File | Status |
|---|---|---|
| `GraphAnalysisResult` | graph/types.ts:57 | Ready -- includes communities, bridgeEntities, modularity |
| `CommunityResult` | graph/types.ts:51 | Ready -- communityId, entityIds, coherenceScore |
| `TopicCluster` | core/types.ts:130 | Ready -- name, description, entityIds, memoryIds, coherenceScore, generation |
| `DreamPhase` | core/types.ts:177 | Ready -- includes "reflect" and "prune" |
| `DreamReport` | core/types.ts:193 | Mostly ready -- may need new fields for Phase 6 metrics |
| `ExploreResult` | graph/types.ts:90 | Ready -- includes community field |
| `IntelligenceConfig` | dream/intelligence.ts:15 | Ready |
| `GenerationResult<T>` | dream/intelligence.ts:23 | Ready |

### 5.2 Types That Need Addition

1. **`ReflectResult` type** -- Output of the `reflect` MCP tool
   ```typescript
   interface ReflectResult {
     communities: Array<{
       name: string;
       description: string;
       entityCount: number;
       coherenceScore: number;
       topEntities: string[];
     }>;
     bridgeEntities: Array<{
       name: string;
       type: EntityType;
       bridgeScore: number;
       connectedCommunities: string[];
     }>;
     temporalPatterns: Array<{
       type: 'emergence' | 'decline' | 'seasonal' | 'burst';
       description: string;
       entities: string[];
       confidence: number;
     }>;
     graphHealth: {
       totalNodes: number;
       totalEdges: number;
       modularity: number;
       communityCount: number;
       orphanNodes: number;
     };
   }
   ```

2. **`TemporalPattern` type** -- For temporal analysis results
   ```typescript
   interface TemporalPattern {
     id: string;
     type: 'emergence' | 'decline' | 'seasonal' | 'burst';
     entityIds: string[];
     communityIds: string[];
     description: string;
     confidence: number;
     timeRange: { start: number; end: number };
     generation: number;
   }
   ```

3. **`CommunityNaming` type** -- LLM naming result
   ```typescript
   interface CommunityNaming {
     communityId: number;
     name: string;
     description: string;
     topicKeywords: string[];
   }
   ```

4. **`MapOfContent` type** -- Formatted topic map
   ```typescript
   interface MapOfContent {
     title: string;
     generatedAt: number;
     generation: number;
     topics: Array<{
       name: string;
       description: string;
       entities: Array<{ name: string; type: EntityType }>;
       relatedMemories: number;
       coherence: number;
     }>;
     bridges: Array<{
       entity: string;
       connects: string[]; // community names
       score: number;
     }>;
   }
   ```

### 5.3 Existing Types That May Need Extension

- **`DreamReport`** (core/types.ts:193): May need `communitiesDetected`, `bridgesIdentified`, `temporalPatterns` fields
- **`ExploreResult`** (graph/types.ts:90): May want a `bridges` field alongside the existing `community` field

---

## 6. Risk Assessment

### 6.1 High Risk

**Temporal Pattern Analysis Complexity**

The temporal pattern module is entirely greenfield with no existing code or tests. It requires:
- Defining what patterns to detect (emergence, decline, burst, seasonal)
- Writing analysis algorithms over time-series entity/relationship data
- Possibly using LLM for pattern interpretation
- New schema, types, and test infrastructure

**Mitigation:** Start with simple, rule-based patterns (entity mention frequency trends, community generation comparison) before adding LLM-based interpretation. Define a minimal viable set of pattern types for Phase 6 MVP.

### 6.2 Medium Risk

**LLM Cost and Latency in Community Naming**

Each community requires an LLM call for naming. With the intelligence layer (`src/dream/intelligence.ts`), this prefers Ollama (local) and falls back to Claude API. However:
- If many communities exist (10+), the naming step could be slow and expensive
- Local Ollama may not produce high-quality topic names for nuanced technical domains

**Mitigation:** Batch communities into a single LLM call where possible (multiple communities per prompt). Cache generated names across dream generations -- only rename communities whose entity composition has changed significantly.

**Memory-to-Community Linkage Computation**

Populating `topic_clusters.memory_ids` requires traversing: community entity IDs -> relationships involving those entities -> `source_memories` on those relationships -> corresponding memory IDs. This is a multi-join operation that could be slow for large graphs.

**Mitigation:** Compute lazily during the reflect phase. Use a single SQL query with appropriate joins rather than N+1 lookups.

### 6.3 Low Risk

**MCP Tool Integration**

The `reflect` tool follows established patterns from the four existing tools. The server code (`src/mcp/server.ts`) has clear patterns for:
- Zod input validation
- Lazy DB initialization
- Error handling with `isError: true` responses
- XML/text output formatting

Adding a fifth tool is straightforward.

**Bridge Entity Persistence**

Bridge entities are already computed correctly. Persisting them is a simple INSERT to a new table, following the same pattern as `persistAnalysis()`.

**Test Infrastructure**

The existing `createTestDb()` helper and mock patterns in daemon tests provide solid foundations for new tests. Adding tests for new components follows established conventions.

---

## 7. Recommended Implementation Order

The following sequence minimizes coupling and enables incremental testing:

### Step 1: Bridge Entity Persistence (LOW effort, unblocks Step 5)

- Add `bridge_entities` table to `src/core/db.ts` schema
- Add `persistBridgeEntities()` function to `src/graph/analyzer.ts`
- Update `runReflectPhase()` in daemon to call persistence
- Add tests for bridge persistence

**Why first:** Zero dependencies on other new work. Unblocks the reflect tool's bridge entity reporting. Small, testable change.

### Step 2: Community Naming via LLM (MEDIUM effort, unblocks Step 4)

- Create `prompts/name-community.md` template
- Create `src/graph/clusters.ts` module with `nameCommunities()` function
- Integrate with intelligence layer (`generateStructured()` from `src/dream/intelligence.ts`)
- Compute and populate `memory_ids` on topic clusters
- Update `persistAnalysis()` or create new `persistNamedClusters()` function
- Add tests with mocked intelligence layer

**Why second:** Depends on no other new code. Core deliverable for Maps of Content. Can be tested independently.

### Step 3: Temporal Pattern Analysis (HIGH effort, unblocks Step 5)

- Define `TemporalPattern` type in `src/graph/types.ts` or new `src/graph/temporal.ts`
- Add `temporal_patterns` table to schema
- Implement basic pattern detectors:
  - Entity emergence: entities with `first_seen` within recent N days and high mention_count
  - Entity decline: entities with `last_seen` far in the past and no recent relationships
  - Topic evolution: compare `topic_clusters` across consecutive generations
  - Activity bursts: detect spikes in entity mentions within short time windows
- Persist patterns to database
- Add tests with synthetic temporal data

**Why third:** Most complex component, but independent of MCP integration. Can be developed and tested in isolation before wiring into the reflect phase.

### Step 4: Maps of Content Formatting (LOW effort, unblocks Step 5)

- Create `formatMapOfContent()` function that assembles:
  - Named communities from Step 2
  - Bridge entities from Step 1
  - Temporal patterns from Step 3
  - Graph health metrics from existing `analyzeGraph()`
- Output format: structured XML consistent with existing MCP tool output patterns
- Add tests for formatting

**Why fourth:** Pure formatting layer with no persistence concerns. Depends on Steps 1-3 for data sources.

### Step 5: `reflect` MCP Tool (MEDIUM effort, final integration)

- Define `ReflectInputSchema` with Zod
- Add tool definition to `ListToolsRequestSchema` handler
- Add tool handler to `CallToolRequestSchema`
- Support `focus` parameter for filtered views: `"overview"`, `"communities"`, `"bridges"`, `"patterns"`
- Use `formatMapOfContent()` from Step 4 for output
- Add MCP integration tests

**Why fifth:** Integration layer that depends on all previous steps. Can use cached data from `topic_clusters`, `bridge_entities`, and `temporal_patterns` tables for fast responses (no need to run analysis in real-time).

### Step 6: Enhanced Dream Reflect Phase (LOW effort, final wiring)

- Update `runReflectPhase()` in `src/dream/daemon.ts` to:
  1. Recompute edge weights using `computeEdgeWeight()` from `src/graph/relationship.ts`
  2. Run `analyzeGraph()` (existing)
  3. Run `nameCommunities()` (Step 2)
  4. Persist named clusters with memory linkage
  5. Persist bridge entities (Step 1)
  6. Run temporal pattern analysis (Step 3)
  7. Persist temporal patterns
- Update daemon tests with new mock expectations

**Why last:** Ties everything together in the dream pipeline. All components are individually tested by this point.

---

## Appendix: File Reference

### Files That Need Modification

| File | Changes |
|---|---|
| `src/core/db.ts` | Add `bridge_entities` and `temporal_patterns` tables |
| `src/core/types.ts` | Add `TemporalPattern`, extend `DreamReport` |
| `src/graph/types.ts` | Add `CommunityNaming`, `MapOfContent`, `ReflectResult` types |
| `src/graph/analyzer.ts` | Add `persistBridgeEntities()` function |
| `src/dream/daemon.ts` | Enhance `runReflectPhase()` with new steps |
| `src/mcp/server.ts` | Add `reflect` tool definition and handler |
| `tests/graph/analyzer.test.ts` | Add bridge persistence tests |
| `tests/dream/daemon.test.ts` | Update reflect phase expectations |

### Files That Need Creation

| File | Purpose |
|---|---|
| `src/graph/clusters.ts` | LLM-based community naming and MoC generation |
| `src/graph/temporal.ts` | Temporal pattern detection and analysis |
| `prompts/name-community.md` | LLM prompt template for community naming |
| `tests/graph/clusters.test.ts` | Tests for community naming |
| `tests/graph/temporal.test.ts` | Tests for temporal pattern analysis |
| `tests/mcp/server.test.ts` | Tests for MCP tool handlers (including reflect) |

### Files That Need No Changes

| File | Reason |
|---|---|
| `src/graph/entity.ts` | Entity CRUD is complete |
| `src/graph/relationship.ts` | Relationship CRUD is complete (includes `computeEdgeWeight`) |
| `src/graph/search.ts` | Graph search and explore are complete |
| `src/graph/extractor.ts` | Entity/relationship extraction is complete |
| `src/dream/intelligence.ts` | LLM interface is ready to use |
| `src/dream/scheduler.ts` | Scheduling/checkpointing is complete |
| `src/semantic/decay.ts` | FSRS decay model is complete |
| `tests/helpers.ts` | Test infrastructure is sufficient |
