# Engram Phase 6: Reflection & Emergence -- Implementation Plan

## Context

Phases 1-4 built Engram's complete memory processing pipeline: episodic storage with hybrid search (Phase 1), score normalization and migration (Phase 2), semantic extraction with NLI contradiction detection and FSRS confidence decay (Phase 3), and the knowledge graph with entity extraction, resolution, community detection, and the `explore` MCP tool (Phase 4). Phase 5 delivered the dream state daemon -- an autonomous five-phase pipeline (INGEST, EXTRACT, CONSOLIDATE, REFLECT, PRUNE) with checkpoint/resume, local LLM integration via Ollama, and launchd scheduling.

Phase 6 adds **intelligence to the graph analysis layer**. Where Phase 4 built the structural machinery (Louvain communities, betweenness centrality, coherence scoring) and Phase 5 wired it into the daemon, Phase 6 makes the output meaningful. Generic "Community N" labels become LLM-generated topic names. Bridge entities get persisted with narrative explanations. Temporal patterns emerge from entity timelines and community evolution. A new `reflect` MCP tool surfaces all of this to Claude during conversations.

**What Phase 6 delivers:**
1. **LLM-generated community naming** (`src/graph/naming.ts`) -- meaningful topic labels replacing "Community N" via the intelligence layer
2. **Bridge entity persistence + narratives** -- bridge scores written to `bridge_scores` table with LLM-generated explanations
3. **Temporal pattern analysis** (`src/graph/temporal.ts`) -- co-occurrence detection, phase transitions, community evolution tracking
4. **Memory-to-community linkage** -- populate `topic_clusters.memory_ids` by scanning memories for entity mentions
5. **Reflection orchestration** (`src/graph/reflection.ts`) -- compose all analysis steps into a unified pipeline
6. **`reflect` MCP tool** -- new tool with `communities`, `bridges`, `temporal`, `health` modes
7. **Enhanced REFLECT dream phase** -- full reflection pipeline replacing the basic `analyzeGraph()` + `persistAnalysis()` call
8. **Enhanced PRUNE phase** -- entity cleanup (merge redundant, remove orphans, prune stale clusters)
9. **New schema** -- `bridge_scores`, `temporal_patterns`, `reflection_observations` tables

**What Phase 6 does NOT include** (deferred to Phase 7):
- Cross-encoder reranking
- Context budget tuning
- Batch operation performance optimization
- Claude Code plugin packaging
- Hierarchical multi-level MOC (Louvain dendrogram-based topic nesting)
- User guide documentation

**Research backing:**
- [Codebase readiness assessment (~55% ready)](../research/phase-6-codebase-readiness.md) -- gap analysis, integration points, schema readiness
- [Emergence patterns: community naming, MOC, bridges, temporal, reflection](../research/phase-6-emergence-patterns.md) -- algorithm selection, prompt design, metacognition patterns
- [Temporal analysis implementation, MCP tool design, incremental graph analysis](../research/phase-6-temporal-and-tooling.md) -- reference architectures (Graphiti), MCP patterns, SQL-native temporal queries
- [Graph analysis algorithms (from Phase 4)](../research/graph-analysis-research.md) -- Louvain, betweenness centrality, edge weight model

---

## New Dependencies

None required. Phase 6 uses only:
- Existing `graphology` packages (graphology ^0.26.0, graphology-communities-louvain ^2.0.2, graphology-metrics)
- Existing `@anthropic-ai/sdk` for API fallback
- Native `fetch` for Ollama REST API calls
- Existing `better-sqlite3` for all persistence
- Existing `@modelcontextprotocol/sdk` for MCP server

---

## Architecture Overview

```
                   CLI: engram reflect         MCP: reflect tool
                        |                            |
                        v                            v
               +--------------------------------------------+
               |           Reflection Pipeline               |
               |                                            |
               |  src/graph/reflection.ts                   |
               |  runReflection(db, config)                 |
               |                                            |
               |  1. recomputeEdgeWeights()                 |
               |       src/graph/analyzer.ts                |
               |       + computeEdgeWeight() from           |
               |         src/graph/relationship.ts          |
               |                                            |
               |  2. analyzeGraph() [existing]              |
               |       community detection (Louvain)        |
               |       coherence scoring                    |
               |       bridge entity detection              |
               |                                            |
               |  3. nameCommunities()                      |
               |       src/graph/naming.ts                  |
               |       + generateStructured() from          |
               |         src/dream/intelligence.ts          |
               |                                            |
               |  4. persistBridgeScores()                  |
               |       src/graph/analyzer.ts                |
               |       -> bridge_scores table               |
               |                                            |
               |  5. analyzeTemporalPatterns()              |
               |       src/graph/temporal.ts                |
               |       -> temporal_patterns table           |
               |                                            |
               |  6. linkMemoriesToCommunities()            |
               |       src/graph/reflection.ts              |
               |       -> topic_clusters.memory_ids         |
               |                                            |
               |  7. generateObservations()                 |
               |       src/graph/reflection.ts              |
               |       -> reflection_observations table     |
               |                                            |
               +--------------------------------------------+
                        |                            |
                        v                            v
              Dream Daemon REFLECT          MCP reflect output
              (src/dream/daemon.ts)         (XML formatted)
                        |
                        v
              Dream Daemon PRUNE
              + entity cleanup
              + orphan removal
              + stale cluster pruning

SQLite Tables:
  [entities] [relationships] [topic_clusters]  -- existing
  [bridge_scores] [temporal_patterns] [reflection_observations]  -- new
```

---

## Implementation Steps

### Step 1: Schema Additions (`src/core/db.ts`, `src/core/types.ts`, `src/graph/types.ts`)

**Complexity: LOW**

**Purpose**: Add the three new tables and all new TypeScript types needed by subsequent steps. This is foundational work with no algorithmic complexity.

**Schema additions to `src/core/db.ts` `createSchema()` function:**

```sql
-- Bridge entity scores per dream generation
CREATE TABLE IF NOT EXISTS bridge_scores (
    entity_id TEXT NOT NULL REFERENCES entities(id),
    betweenness REAL NOT NULL,
    community_span INTEGER NOT NULL,
    bridge_score REAL NOT NULL,
    narrative TEXT,
    generation INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (entity_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_bridge_scores_generation
  ON bridge_scores(generation);
CREATE INDEX IF NOT EXISTS idx_bridge_scores_score
  ON bridge_scores(bridge_score DESC);

-- Detected temporal patterns
CREATE TABLE IF NOT EXISTS temporal_patterns (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN (
        'entity_burst', 'community_shift', 'phase_transition',
        'topic_emergence', 'topic_decay', 'bridge_formation'
    )),
    description TEXT NOT NULL,
    entity_ids TEXT,           -- JSON array of entity IDs
    time_start INTEGER,
    time_end INTEGER,
    confidence REAL DEFAULT 0.5,
    metadata TEXT,             -- JSON object for pattern-specific data
    generation INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_temporal_patterns_generation
  ON temporal_patterns(generation);
CREATE INDEX IF NOT EXISTS idx_temporal_patterns_type
  ON temporal_patterns(type);

-- Higher-order observations from reflection
CREATE TABLE IF NOT EXISTS reflection_observations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN (
        'community_summary', 'bridge_narrative', 'temporal_insight',
        'growth_observation', 'quality_assessment'
    )),
    content TEXT NOT NULL,
    related_entity_ids TEXT,   -- JSON array of entity IDs
    confidence REAL DEFAULT 0.7,
    generation INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_reflection_obs_generation
  ON reflection_observations(generation);
```

**New types in `src/graph/types.ts`:**

```typescript
// ---- Community Naming ----

export interface CommunityNaming {
  communityId: number;
  name: string;
  description: string;
  topicKeywords: string[];
}

// ---- Bridge Scores ----

export interface BridgeScore {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  betweenness: number;
  communitySpan: number;
  bridgeScore: number;
  narrative?: string;
  generation: number;
}

// ---- Temporal Patterns ----

export type TemporalPatternType =
  | "entity_burst"
  | "community_shift"
  | "phase_transition"
  | "topic_emergence"
  | "topic_decay"
  | "bridge_formation";

export interface TemporalPattern {
  id: string;
  type: TemporalPatternType;
  description: string;
  entityIds: string[];
  timeStart: number;
  timeEnd: number;
  confidence: number;
  metadata: Record<string, unknown>;
  generation: number;
}

// ---- Reflection Observations ----

export type ObservationType =
  | "community_summary"
  | "bridge_narrative"
  | "temporal_insight"
  | "growth_observation"
  | "quality_assessment";

export interface ReflectionObservation {
  id: string;
  type: ObservationType;
  content: string;
  relatedEntityIds: string[];
  confidence: number;
  generation: number;
}

// ---- Reflect Result (MCP tool output) ----

export interface ReflectResult {
  communities: Array<{
    name: string;
    description: string;
    entityCount: number;
    coherenceScore: number;
    topEntities: Array<{ name: string; type: EntityType }>;
    memoryCount: number;
  }>;
  bridges: Array<{
    entityName: string;
    entityType: EntityType;
    bridgeScore: number;
    communitySpan: number;
    narrative?: string;
    connectedCommunities: string[];
  }>;
  temporalPatterns: TemporalPattern[];
  health: {
    totalNodes: number;
    totalEdges: number;
    modularity: number;
    communityCount: number;
    orphanNodes: number;
    averageCoherence: number;
    generationCount: number;
  };
  observations: ReflectionObservation[];
  generation: number;
  generatedAt: number;
}
```

**Extension to `src/core/types.ts` `DreamReport`:**

Add optional Phase 6 metrics to the existing `DreamReport` interface:

```typescript
// Add to existing DreamReport interface:
communitiesNamed?: number;
bridgesIdentified?: number;
temporalPatternsDetected?: number;
observationsGenerated?: number;
entitiesMerged?: number;
orphansPruned?: number;
clustersPruned?: number;
```

**Test file**: `tests/core/db.test.ts` (extend existing)
- Test that `bridge_scores`, `temporal_patterns`, and `reflection_observations` tables are created on `initDatabase()`
- Test INSERT/SELECT round-trip on each new table
- Test CHECK constraints on `type` columns (invalid values rejected)
- Test composite PRIMARY KEY on `bridge_scores` (entity_id, generation)

**Estimated lines**: ~100 in db.ts additions, ~120 in types, ~60 new tests

---

### Step 2: Community Naming via LLM (`src/graph/naming.ts`)

**Complexity: MEDIUM**

**Purpose**: Replace generic "Community N" labels with meaningful topic names generated by the intelligence layer. This is the core user-visible quality improvement.

**New file: `src/graph/naming.ts`**

```typescript
import type Database from "better-sqlite3";
import type { IntelligenceConfig, GenerationResult } from "../dream/intelligence.js";
import type { CommunityResult } from "./types.js";
import type { CommunityNaming } from "./types.js";

/**
 * Generate a meaningful name and description for a single community
 * based on its member entities and their relationships.
 *
 * Uses generateStructured() from the intelligence layer (Ollama -> Claude API fallback).
 */
export async function generateCommunityName(
  db: Database.Database,
  community: CommunityResult,
  intelligenceConfig: IntelligenceConfig,
): Promise<CommunityNaming>

/**
 * Name all communities in a graph analysis result.
 * Processes communities sequentially (one LLM call per community).
 * Skips communities with fewer than 2 entities (assigns generic name).
 */
export async function nameCommunities(
  db: Database.Database,
  communities: CommunityResult[],
  intelligenceConfig: IntelligenceConfig,
): Promise<CommunityNaming[]>

/**
 * Persist named communities to the topic_clusters table.
 * Replaces the existing persistAnalysis() naming with LLM-generated names.
 * Increments the generation counter.
 */
export function persistNamedCommunities(
  db: Database.Database,
  communities: CommunityResult[],
  namings: CommunityNaming[],
  generation: number,
): void
```

**Prompt design** (inline system prompt, no separate file needed since it is short):

The system prompt instructs the LLM to analyze a community's entities and produce a JSON object `{ name: string, description: string, topicKeywords: string[] }`. The user prompt provides:
- Entity names and their types (from the `entities` table, looked up by `community.entityIds`)
- Relationship types between entities within the community (from `relationships` table, filtered to community members)
- Community coherence score for context

**Schema for `generateStructured()`**:

```typescript
const communityNameSchema = {
  properties: {
    name: { type: "string", description: "3-6 word topic name for this community" },
    description: { type: "string", description: "1-2 sentence description of what this community represents" },
    topicKeywords: {
      type: "array",
      items: { type: "string" },
      description: "3-5 keywords characterizing this topic cluster",
    },
  },
  required: ["name", "description", "topicKeywords"],
};
```

**Key design decisions:**
- One LLM call per community (not batched) for reliability and structured output quality
- Communities with fewer than 2 entities get a default name derived from the single entity's name and type
- If the LLM call fails for a community, fall back to `"Topic: {entity1Name}, {entity2Name}, ..."` (first 3 entity names)
- `nameCommunities()` is idempotent: if called again with the same communities, it regenerates names (the daemon controls when to call it)

**Test file**: `tests/graph/naming.test.ts`
- Mock `generateStructured()` from the intelligence layer using `vi.mock("../dream/intelligence.js")`
- Test `generateCommunityName()` with a 3-entity community: verify it passes entity names/types to the LLM and returns the structured result
- Test fallback: when LLM call throws, verify the function returns a default name from entity names
- Test `nameCommunities()` with 3 communities: verify it calls `generateCommunityName()` for each
- Test skip logic: community with 1 entity gets a default name without an LLM call
- Test `persistNamedCommunities()`: verify rows in `topic_clusters` have the LLM-generated names and descriptions
- Test generation incrementing: run persist twice, verify generation numbers increment

**Estimated lines**: ~200 in naming.ts, ~250 in tests

---

### Step 3: Bridge Entity Persistence (`src/graph/analyzer.ts`)

**Complexity: LOW**

**Purpose**: Persist bridge entity analysis results to the `bridge_scores` table so they survive across dream runs and can be queried by the `reflect` MCP tool.

**Additions to `src/graph/analyzer.ts`:**

```typescript
/**
 * Persist bridge entity scores to the bridge_scores table.
 *
 * Writes one row per bridge entity per generation. The (entity_id, generation)
 * composite primary key ensures no duplicates within a generation.
 */
export function persistBridgeScores(
  db: Database.Database,
  bridgeEntities: GraphAnalysisResult["bridgeEntities"],
  generation: number,
): void
```

**Implementation details:**
- Use `INSERT OR REPLACE INTO bridge_scores` with the composite primary key
- Wrap all inserts in a transaction for atomicity
- Only persist entities with `bridgeScore > 0` (already filtered by `detectBridgeEntities()`)
- The `narrative` column is left NULL at this stage; it gets populated during reflection orchestration (Step 6) via the intelligence layer

**Also add a query function:**

```typescript
/**
 * Retrieve bridge scores for a specific generation.
 * Joins with entities table to include name and type.
 */
export function getBridgeScores(
  db: Database.Database,
  generation: number,
  limit?: number,
): BridgeScore[]

/**
 * Get the latest generation number from bridge_scores.
 */
export function getLatestBridgeGeneration(
  db: Database.Database,
): number
```

**Test additions to `tests/graph/analyzer.test.ts`:**
- Test `persistBridgeScores()`: insert 3 bridge entities, verify rows in DB
- Test generation tracking: persist twice with different generations, verify both exist
- Test composite key: persist same entity twice in same generation, verify no duplicate error (OR REPLACE)
- Test `getBridgeScores()`: verify it returns bridge data with entity names and types
- Test empty graph: `persistBridgeScores()` with empty array does nothing

**Estimated lines**: ~80 in analyzer.ts, ~100 in tests

---

### Step 4: Temporal Pattern Analysis (`src/graph/temporal.ts`)

**Complexity: HIGH**

**Purpose**: Detect meaningful time-based patterns in the knowledge graph by analyzing entity timelines, relationship creation patterns, and community evolution across dream generations. This is the largest greenfield component in Phase 6.

**New file: `src/graph/temporal.ts`**

```typescript
import type Database from "better-sqlite3";
import type { TemporalPattern, TemporalPatternType } from "./types.js";

/**
 * Configuration for temporal analysis.
 */
export interface TemporalConfig {
  windowDays: number;         // co-occurrence window size (default: 7)
  burstThreshold: number;     // mentions/day threshold for burst detection (default: 3)
  decayDaysThreshold: number; // days since last_seen for decay detection (default: 60)
  jaccardThreshold: number;   // min Jaccard distance for community shift (default: 0.3)
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  windowDays: 7,
  burstThreshold: 3,
  decayDaysThreshold: 60,
  jaccardThreshold: 0.3,
};

// ---- Pattern Detectors ----

/**
 * Detect entity activity bursts -- entities with unusually high mention
 * rates in recent time windows.
 *
 * Algorithm:
 * 1. For each entity, compute mentions per day over last windowDays
 * 2. Compare against entity's historical average (total mentions / days since first_seen)
 * 3. If recent rate > burstThreshold * historical average, flag as burst
 *
 * Uses SQL: entities.first_seen, entities.last_seen, entities.mention_count
 */
export function detectEntityBursts(
  db: Database.Database,
  config?: Partial<TemporalConfig>,
): TemporalPattern[]

/**
 * Detect topic emergence -- entities that appeared recently (first_seen within
 * windowDays) and already have multiple relationships.
 *
 * Algorithm:
 * 1. Find entities where first_seen is within last windowDays * 4 (28 days default)
 * 2. Filter to those with mention_count >= 2 and at least 1 relationship
 * 3. Higher confidence for more relationships and mentions
 */
export function detectTopicEmergence(
  db: Database.Database,
  config?: Partial<TemporalConfig>,
): TemporalPattern[]

/**
 * Detect topic decay -- entities that have not been seen recently and have
 * declining relationship activity.
 *
 * Algorithm:
 * 1. Find entities where last_seen is older than decayDaysThreshold
 * 2. Filter to those with at least some prior activity (mention_count >= 3)
 * 3. Confidence scales with how long since last_seen
 */
export function detectTopicDecay(
  db: Database.Database,
  config?: Partial<TemporalConfig>,
): TemporalPattern[]

/**
 * Detect community evolution by comparing topic_clusters across consecutive
 * dream generations using Jaccard similarity.
 *
 * Algorithm:
 * 1. Load topic_clusters for the two most recent generations
 * 2. For each community in the newer generation, find the best-matching
 *    community in the older generation by Jaccard(entity_ids)
 * 3. Classify changes:
 *    - Jaccard < 0.3: new community (community_shift)
 *    - Jaccard > 0.7 but size changed by >30%: growth/contraction
 *    - No match in newer generation for old community: community died
 *
 * Uses SQL: topic_clusters table with generation column
 */
export function detectCommunityEvolution(
  db: Database.Database,
  config?: Partial<TemporalConfig>,
): TemporalPattern[]

/**
 * Detect project phase transitions by computing entity frequency vectors
 * per time window and measuring cosine distance between consecutive windows.
 *
 * Algorithm:
 * 1. Divide timeline into windows of windowDays
 * 2. For each window, build vector: entity_id -> relationship_count in that window
 * 3. Compute cosine distance between consecutive window vectors
 * 4. If distance exceeds threshold, flag as phase_transition
 *
 * Uses SQL: relationships.created_at to bin relationship creation by time window
 */
export function detectPhaseTransitions(
  db: Database.Database,
  config?: Partial<TemporalConfig>,
): TemporalPattern[]

/**
 * Detect bridge formation -- entities that recently gained cross-community
 * connections (appeared in bridge_scores for the first time in the latest generation
 * but were not bridges in the previous generation).
 *
 * Uses SQL: bridge_scores table across generations
 */
export function detectBridgeFormation(
  db: Database.Database,
): TemporalPattern[]

// ---- Orchestration ----

/**
 * Run all temporal pattern detectors and return the combined results.
 * Persists detected patterns to the temporal_patterns table.
 */
export function analyzeTemporalPatterns(
  db: Database.Database,
  generation: number,
  config?: Partial<TemporalConfig>,
): TemporalPattern[]

/**
 * Persist temporal patterns to the temporal_patterns table.
 * Clears any existing patterns for this generation before inserting.
 */
export function persistTemporalPatterns(
  db: Database.Database,
  patterns: TemporalPattern[],
): void

/**
 * Retrieve temporal patterns for a given generation.
 */
export function getTemporalPatterns(
  db: Database.Database,
  generation: number,
  type?: TemporalPatternType,
): TemporalPattern[]
```

**Key design decisions:**
- All temporal analysis is SQL-native. Uses existing columns: `entities.first_seen`, `entities.last_seen`, `entities.mention_count`, `relationships.created_at`, `topic_clusters.generation`.
- No new npm dependencies required.
- Detectors are pure functions that query the DB and return pattern objects. No LLM calls in the detection phase -- LLM interpretation happens in Step 6 (reflection observations).
- `analyzeTemporalPatterns()` runs all detectors sequentially and deduplicates overlapping patterns.
- Confidence values are computed heuristically (0.0-1.0) based on signal strength (e.g., how far above the burst threshold, how low the Jaccard similarity).
- The `metadata` JSON field on `temporal_patterns` stores detector-specific data (e.g., the Jaccard score for community shifts, the cosine distance for phase transitions).

**Helper functions (internal):**

```typescript
/**
 * Compute Jaccard similarity between two entity ID arrays.
 */
function jaccardSimilarity(a: string[], b: string[]): number

/**
 * Compute cosine distance between two frequency vectors.
 */
function cosineDistance(a: Map<string, number>, b: Map<string, number>): number

/**
 * Get the current unix timestamp.
 */
function nowUnix(): number
```

**Test file**: `tests/graph/temporal.test.ts`
- **Setup**: Use `createTestDb()` and insert synthetic entities/relationships with controlled timestamps using `insertTestEntity()` and `insertTestRelationship()` helpers
- Test `detectEntityBursts()`: Create entities with varying mention counts and first_seen/last_seen. Verify a high-frequency entity triggers a burst pattern.
- Test `detectTopicEmergence()`: Create a recently-appeared entity (first_seen within 28 days) with 3+ relationships. Verify it is flagged as emerging.
- Test `detectTopicDecay()`: Create an entity with `last_seen` 90 days ago and 5 historical mentions. Verify it is flagged as decaying.
- Test `detectCommunityEvolution()`: Insert two generations of topic_clusters with partially overlapping entity sets. Verify community_shift patterns are detected for low-Jaccard pairs.
- Test `detectPhaseTransitions()`: Insert relationships across distinct time windows with very different entity compositions. Verify phase_transition detection.
- Test `detectBridgeFormation()`: Insert bridge_scores for two generations where entity X appears only in the latest. Verify bridge_formation pattern.
- Test `analyzeTemporalPatterns()` integration: run full analysis on synthetic data, verify patterns are persisted to the temporal_patterns table.
- Test empty graph: all detectors return empty arrays without errors.
- Test `jaccardSimilarity()` helper: verify known Jaccard values for test inputs.

**Estimated lines**: ~450 in temporal.ts, ~500 in tests

---

### Step 5: Memory-to-Community Linkage (`src/graph/reflection.ts`)

**Complexity: LOW**

**Purpose**: Populate the currently-empty `topic_clusters.memory_ids` field by scanning memories for entity mentions. This connects the semantic memory store to the graph analysis layer.

**New file: `src/graph/reflection.ts`** (will be expanded in Step 6)

```typescript
import type Database from "better-sqlite3";

/**
 * Link memories to communities by tracing: community entity IDs ->
 * relationships involving those entities -> source_memories on those
 * relationships -> corresponding memory IDs.
 *
 * Updates topic_clusters.memory_ids with the discovered memory IDs.
 *
 * Algorithm:
 * For each topic cluster in the given generation:
 *   1. Parse entity_ids JSON array
 *   2. Query relationships where source_entity_id OR target_entity_id is in entity_ids
 *   3. Parse source_memories JSON from each matching relationship
 *   4. Deduplicate memory IDs
 *   5. UPDATE topic_clusters SET memory_ids = JSON(deduplicated IDs)
 */
export function linkMemoriesToCommunities(
  db: Database.Database,
  generation: number,
): { clustersUpdated: number; memoriesLinked: number }
```

**Implementation approach:**
- Single SQL query per cluster using `WHERE source_entity_id IN (?, ?, ...)` -- the entity_ids array is typically small (2-20 entities per community)
- Parse `relationships.source_memories` (JSON array of memory IDs stored as TEXT)
- Filter to only active memories (`WHERE is_active = 1` on memories table)
- Update in a transaction for atomicity

**Test additions** (in the Step 6 test file, `tests/graph/reflection.test.ts`):
- Insert entities, relationships with `source_memories`, and topic_clusters. Call `linkMemoriesToCommunities()`. Verify `memory_ids` is populated correctly.
- Test with relationships having empty `source_memories`: verify no crash, empty result
- Test deduplication: same memory referenced by multiple relationships, appears once in memory_ids

**Estimated lines**: ~80 in reflection.ts, ~60 in tests

---

### Step 6: Reflection Orchestration (`src/graph/reflection.ts`)

**Complexity: MEDIUM**

**Purpose**: Compose all analysis steps into a single `runReflection()` function that the dream daemon and the `reflect` MCP tool both call. Also generates higher-order observations (meta-insights) via the intelligence layer.

**Expand `src/graph/reflection.ts`:**

```typescript
import type Database from "better-sqlite3";
import type { EngramConfig } from "../core/types.js";
import type {
  ReflectResult,
  ReflectionObservation,
  ObservationType,
} from "./types.js";

/**
 * Run the full reflection pipeline:
 *
 * 1. Recompute edge weights (four-factor model)
 * 2. Analyze graph (communities, coherence, bridges)
 * 3. Name communities via LLM
 * 4. Persist named communities
 * 5. Persist bridge scores
 * 6. Analyze temporal patterns
 * 7. Link memories to communities
 * 8. Generate higher-order observations
 * 9. Persist observations
 *
 * Returns a ReflectResult suitable for the MCP tool.
 */
export async function runReflection(
  db: Database.Database,
  config: EngramConfig,
): Promise<ReflectResult>

/**
 * Recompute all edge weights in the relationships table using
 * computeEdgeWeight() from src/graph/relationship.ts.
 *
 * For each relationship:
 * 1. Look up source and target entity importance (from memories)
 * 2. Build EdgeWeightFactors from relationship and entity metadata
 * 3. Compute new weight
 * 4. UPDATE relationships SET weight = newWeight WHERE id = relId
 */
export function recomputeEdgeWeights(
  db: Database.Database,
): { updated: number }

/**
 * Generate higher-order observations about the knowledge graph.
 * Uses the intelligence layer to synthesize insights from the
 * reflection data.
 *
 * Observation types:
 * - community_summary: "Your work clusters into N major themes: ..."
 * - bridge_narrative: "X connects A-domain to B-domain because ..."
 * - temporal_insight: "Activity in X has increased 3x over the past month"
 * - growth_observation: "Your knowledge graph grew by N entities this cycle"
 * - quality_assessment: "Graph modularity is strong at 0.72, indicating well-separated topics"
 */
export async function generateObservations(
  db: Database.Database,
  reflectResult: Partial<ReflectResult>,
  config: EngramConfig,
): Promise<ReflectionObservation[]>

/**
 * Persist observations to the reflection_observations table.
 */
export function persistObservations(
  db: Database.Database,
  observations: ReflectionObservation[],
): void

/**
 * Build a ReflectResult by reading cached data from the database.
 * Used by the MCP tool for fast responses without re-running analysis.
 *
 * Reads from: topic_clusters, bridge_scores, temporal_patterns,
 * reflection_observations (all for the latest generation).
 */
export function buildReflectResultFromCache(
  db: Database.Database,
): ReflectResult | null
```

**Pipeline composition detail for `runReflection()`:**

```
Step 1: recomputeEdgeWeights(db)
    |     Uses computeEdgeWeight() from src/graph/relationship.ts
    |     Queries all relationships + their source/target entity metadata
    v
Step 2: analyzeGraph(db)  [from src/graph/analyzer.ts]
    |     Returns GraphAnalysisResult with communities, bridges, modularity
    v
Step 3: nameCommunities(db, communities, intellConfig)  [from src/graph/naming.ts]
    |     One LLM call per community
    |     Returns CommunityNaming[]
    v
Step 4: persistNamedCommunities(db, communities, namings, generation)
    |     Writes to topic_clusters
    v
Step 5: persistBridgeScores(db, bridges, generation)
    |     Writes to bridge_scores
    v
Step 6: analyzeTemporalPatterns(db, generation)  [from src/graph/temporal.ts]
    |     Runs all detectors, persists to temporal_patterns
    v
Step 7: linkMemoriesToCommunities(db, generation)
    |     Updates topic_clusters.memory_ids
    v
Step 8: generateObservations(db, partialResult, config)
    |     LLM-generated higher-order insights
    v
Step 9: persistObservations(db, observations)
    |     Writes to reflection_observations
    v
Return: ReflectResult
```

**Key design decisions:**
- `runReflection()` is the single entry point for both the daemon and direct MCP calls. The daemon calls it during the REFLECT phase. The MCP tool normally reads cached data via `buildReflectResultFromCache()`, but can optionally trigger a fresh run.
- `recomputeEdgeWeights()` uses `computeEdgeWeight()` from `src/graph/relationship.ts` (line 273) with factors built from each relationship's `source_memories` length (mention count), the target entity's `last_seen` (recency), and average memory confidence/importance.
- `generateObservations()` uses `generate()` (free-text) rather than `generateStructured()` -- observations are natural language summaries, not structured data.
- `buildReflectResultFromCache()` is critical for MCP tool performance -- it reads pre-computed data from the DB rather than running the full pipeline on every `reflect` tool call.

**Test file**: `tests/graph/reflection.test.ts`
- Mock `generateStructured()` and `generate()` from intelligence layer
- Mock `analyzeGraph()` to return a known `GraphAnalysisResult`
- Test `runReflection()`: verify it calls each pipeline step in order and returns a valid `ReflectResult`
- Test `recomputeEdgeWeights()`: insert relationships with known factors, verify weights are updated
- Test `linkMemoriesToCommunities()`: (carried from Step 5 tests)
- Test `generateObservations()`: verify LLM is called with community/bridge/temporal summary data
- Test `buildReflectResultFromCache()`: pre-populate all tables for a generation, verify the result matches
- Test `buildReflectResultFromCache()` with no data: returns null
- Test error handling: if LLM call fails in `generateObservations()`, observations are empty but pipeline continues

**Estimated lines**: ~350 in reflection.ts, ~400 in tests

---

### Step 7: `reflect` MCP Tool (`src/mcp/server.ts`, `src/cli/index.ts`)

**Complexity: MEDIUM**

**Purpose**: Add the fifth MCP tool that surfaces emergent graph structure to Claude during conversations. Also add a corresponding CLI command.

**Input schema (`src/mcp/server.ts`):**

```typescript
const ReflectInputSchema = z.object({
  mode: z.enum(["communities", "bridges", "temporal", "health", "all"]).optional().default("all"),
  refresh: z.boolean().optional().default(false),
});
```

**Tool definition** (added to the `ListToolsRequestSchema` handler):

```typescript
{
  name: "reflect",
  description:
    "View emergent patterns and structure in the knowledge graph. " +
    "Shows topic communities with meaningful names, bridge entities " +
    "connecting different domains, temporal patterns, and graph health. " +
    "Use after working on a topic to understand how it connects to " +
    "other knowledge domains.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["communities", "bridges", "temporal", "health", "all"],
        default: "all",
        description:
          "What to reflect on: communities (topic clusters), " +
          "bridges (connecting entities), temporal (time patterns), " +
          "health (graph statistics), or all.",
      },
      refresh: {
        type: "boolean",
        default: false,
        description:
          "Force a fresh analysis instead of using cached results. " +
          "Slower but ensures up-to-date data.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Reflect on Knowledge Graph",
    readOnlyHint: false,  // refresh=true triggers writes
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}
```

**Tool handler** (added to the `CallToolRequestSchema` handler):

```typescript
if (name === "reflect") {
  const params = ReflectInputSchema.parse(args);
  const database = getDb();

  let result: ReflectResult | null;

  if (params.refresh) {
    if (!config) config = loadConfig();
    const { runReflection } = await import("../graph/reflection.js");
    result = await runReflection(database, config);
  } else {
    const { buildReflectResultFromCache } = await import("../graph/reflection.js");
    result = buildReflectResultFromCache(database);
  }

  if (!result) {
    return {
      content: [{
        type: "text",
        text: "<engram_reflection mode=\"" + params.mode + "\">\n" +
              "  <status>No reflection data available. Run 'engram dream --phase reflect' first.</status>\n" +
              "</engram_reflection>",
      }],
    };
  }

  const xml = formatReflectXml(result, params.mode);
  return { content: [{ type: "text", text: xml }] };
}
```

**Output formatting function** (`formatReflectXml`):

```typescript
function formatReflectXml(result: ReflectResult, mode: string): string
```

The XML output follows the established pattern from `recall` (`<engram_recall>`) and `explore` (`<engram_graph>`):

```xml
<engram_reflection mode="all" generation="5" timestamp="2026-02-26T02:15:00Z">
  <communities count="4" modularity="0.72">
    <community name="TypeScript Development Tools" coherence="0.85" entities="8" memories="12">
      <description>Tools and workflows for TypeScript/Node.js development</description>
      <top_entities>
        <entity name="TypeScript" type="technology" />
        <entity name="Vitest" type="tool" />
        <entity name="ESLint" type="tool" />
      </top_entities>
    </community>
    <!-- ... more communities ... -->
  </communities>

  <bridges count="3">
    <bridge entity="SQLite" type="technology" score="2.45" span="3">
      <narrative>SQLite bridges the data layer, CLI tooling, and testing communities...</narrative>
      <connects>
        <community name="TypeScript Development Tools" />
        <community name="Data Persistence Layer" />
      </connects>
    </bridge>
    <!-- ... more bridges ... -->
  </bridges>

  <temporal_patterns count="2">
    <pattern type="topic_emergence" confidence="0.8">
      <description>Knowledge graph analysis emerged as a new topic in the last 28 days</description>
      <entities>graphology, Louvain, betweenness</entities>
    </pattern>
    <!-- ... more patterns ... -->
  </temporal_patterns>

  <health>
    <stat name="total_nodes" value="45" />
    <stat name="total_edges" value="78" />
    <stat name="modularity" value="0.72" />
    <stat name="communities" value="4" />
    <stat name="orphan_nodes" value="3" />
    <stat name="average_coherence" value="0.81" />
  </health>

  <observations>
    <observation type="growth_observation" confidence="0.9">
      Your knowledge graph grew by 12 entities this cycle...
    </observation>
  </observations>
</engram_reflection>
```

Each mode filters the output to only the relevant section. `mode: "all"` includes everything.

**CLI addition** (`src/cli/index.ts`):

```typescript
program
  .command("reflect")
  .description("Show knowledge graph reflection and emergent patterns")
  .option("-m, --mode <mode>", "Focus: communities, bridges, temporal, health, all", "all")
  .option("--refresh", "Force fresh analysis (slower)")
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config);
    try {
      if (opts.refresh) {
        const { runReflection } = await import("../graph/reflection.js");
        const result = await runReflection(db, config);
        printReflectResult(result, opts.mode);
      } else {
        const { buildReflectResultFromCache } = await import("../graph/reflection.js");
        const result = buildReflectResultFromCache(db);
        if (!result) {
          console.log("No reflection data. Run 'engram dream --phase reflect' first.");
          return;
        }
        printReflectResult(result, opts.mode);
      }
    } finally {
      db.close();
    }
  });
```

`printReflectResult()` formats the result as human-readable console output (not XML).

**Test file**: `tests/mcp/reflect.test.ts`
- Test tool registration: verify `reflect` appears in `ListToolsRequestSchema` response
- Test handler with cached data: pre-populate DB, call handler with `mode: "all"`, verify XML output structure
- Test each mode filter: `communities`, `bridges`, `temporal`, `health` each produce the correct subset
- Test `refresh: true`: mock `runReflection()`, verify it is called
- Test no data: verify graceful "no data" response
- Test `formatReflectXml()` output correctness: verify XML is well-formed and contains expected tags

**Estimated lines**: ~200 in server.ts additions, ~60 in cli additions, ~250 in tests

---

### Step 8: Enhanced Dream Phases (`src/dream/daemon.ts`)

**Complexity: MEDIUM**

**Purpose**: Replace the simple REFLECT phase with the full reflection pipeline, and add entity cleanup to the PRUNE phase.

**Enhanced `runReflectPhase()`:**

Replace the current implementation (lines 423-471 of `daemon.ts`) which only calls `analyzeGraph()` + `persistAnalysis()`:

```typescript
async function runReflectPhase(
  db: Database.Database,
  config: EngramConfig,
  runId: string,
  logPath: string,
  options: DreamOptions,
  report: DreamReport,
): Promise<PhaseResult> {
  const startMs = Date.now();
  logEntry(logPath, "reflect", "Starting enhanced reflect phase");

  if (options.dryRun) {
    logEntry(logPath, "reflect", "Dry run -- skipping reflection");
    return { phase: "reflect", itemsProcessed: 0, errors: 0, durationMs: Date.now() - startMs };
  }

  try {
    const { runReflection } = await import("../graph/reflection.js");
    const result = await runReflection(db, config);

    // Update report with Phase 6 metrics
    report.communitiesNamed = result.communities.length;
    report.bridgesIdentified = result.bridges.length;
    report.temporalPatternsDetected = result.temporalPatterns.length;
    report.observationsGenerated = result.observations.length;

    recordCheckpoint(db, runId, "reflect", "reflection");

    logEntry(logPath, "reflect", "Reflection complete", {
      communities: result.communities.length,
      bridges: result.bridges.length,
      temporalPatterns: result.temporalPatterns.length,
      observations: result.observations.length,
      modularity: result.health.modularity,
    });

    options.onProgress?.("reflect", 1, 1, 0);

    return {
      phase: "reflect",
      itemsProcessed: 1,
      errors: 0,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logEntry(logPath, "reflect", `Error in reflection: ${errorMsg}`);
    return {
      phase: "reflect",
      itemsProcessed: 0,
      errors: 1,
      durationMs: Date.now() - startMs,
    };
  }
}
```

**Note**: The function signature changes to accept `report: DreamReport` so it can record Phase 6 metrics. This requires updating the call site in `runDream()` (line 175) to pass `report`.

**Enhanced `runPrunePhase()`:**

Add three new cleanup operations after the existing memory pruning:

```typescript
// After existing memory pruning loop (around line 553):

// --- Phase 6 entity cleanup ---

// 1. Merge redundant entities
const { mergeRedundantEntities } = await import("../graph/reflection.js");
const mergeResult = mergeRedundantEntities(db);
report.entitiesMerged = mergeResult.merged;
logEntry(logPath, "prune", `Merged ${mergeResult.merged} redundant entities`);

// 2. Remove orphan entities (no relationships, low mentions, old last_seen)
const { pruneOrphanEntities } = await import("../graph/reflection.js");
const orphanResult = pruneOrphanEntities(db, {
  minMentions: 2,            // keep if mention_count >= 2
  maxAgeDays: 90,            // only prune if last_seen > 90 days ago
});
report.orphansPruned = orphanResult.pruned;
logEntry(logPath, "prune", `Pruned ${orphanResult.pruned} orphan entities`);

// 3. Prune stale topic clusters (keep latest + 2 previous generations)
const { pruneStaleGenerations } = await import("../graph/reflection.js");
const clusterResult = pruneStaleGenerations(db, { keepGenerations: 3 });
report.clustersPruned = clusterResult.pruned;
logEntry(logPath, "prune", `Pruned ${clusterResult.pruned} stale cluster generations`);
```

**New functions in `src/graph/reflection.ts` for PRUNE phase:**

```typescript
/**
 * Merge redundant entities -- entities with the same name (case-insensitive)
 * or matching aliases that were created in different dream runs.
 *
 * Keeps the entity with the highest mention_count as the canonical one.
 * Redirects all relationships from the duplicate to the canonical entity.
 */
export function mergeRedundantEntities(
  db: Database.Database,
): { merged: number; candidates: Array<{ kept: string; removed: string }> }

/**
 * Remove orphan entities that have no relationships, low mention count,
 * and have not been seen recently.
 *
 * Does NOT delete entities referenced by active memories or topic clusters.
 */
export function pruneOrphanEntities(
  db: Database.Database,
  options: { minMentions: number; maxAgeDays: number },
): { pruned: number }

/**
 * Prune old topic_clusters, bridge_scores, temporal_patterns, and
 * reflection_observations from generations older than keepGenerations.
 *
 * Keeps the latest N generations; deletes all older data.
 */
export function pruneStaleGenerations(
  db: Database.Database,
  options: { keepGenerations: number },
): { pruned: number }
```

**Key design decisions:**
- Entity merging is conservative: only merges exact name matches (case-insensitive). Does not attempt fuzzy matching during prune (that is the resolver's job during EXTRACT).
- Orphan pruning checks that the entity is not referenced in any `topic_clusters.entity_ids` or `memories.source_exchanges` before deletion.
- Generation pruning deletes from all four generation-tracked tables: `topic_clusters`, `bridge_scores`, `temporal_patterns`, `reflection_observations`.

**Test additions to `tests/dream/daemon.test.ts`:**
- Update existing reflect phase tests to verify `runReflection()` is called instead of `analyzeGraph()` + `persistAnalysis()`
- Test enhanced prune phase: mock `mergeRedundantEntities()`, `pruneOrphanEntities()`, `pruneStaleGenerations()`; verify they are called
- Test report metrics: verify `communitiesNamed`, `bridgesIdentified`, `temporalPatternsDetected`, `entitiesMerged`, `orphansPruned` are populated

**Dedicated prune function tests in `tests/graph/reflection.test.ts`:**
- Test `mergeRedundantEntities()`: insert two entities with same name, different IDs; verify one is removed and relationships are redirected
- Test `pruneOrphanEntities()`: insert isolated entity with 1 mention and old last_seen; verify it is deleted. Insert connected entity; verify it is NOT deleted.
- Test `pruneStaleGenerations()` with keepGenerations=3: insert data for generations 1-5; verify generations 1-2 are deleted, 3-5 are kept
- Test safety: `mergeRedundantEntities()` with no duplicates does nothing

**Estimated lines**: ~200 in daemon.ts changes, ~150 in reflection.ts prune functions, ~200 in tests

---

## Execution Order

The implementation steps should be executed in this order due to dependencies:

```
Step 1: Schema Additions (foundation)
    |
    +---> Step 2: Community Naming (needs types from Step 1)
    |         |
    +---> Step 3: Bridge Persistence (needs tables from Step 1)
    |         |
    +---> Step 4: Temporal Analysis (needs tables from Step 1)
    |         |
    +---> Step 5: Memory Linkage (needs tables from Step 1)
              |
              v
         Step 6: Reflection Orchestration (depends on Steps 2-5)
              |
              v
         Step 7: reflect MCP Tool (depends on Step 6)
              |
              v
         Step 8: Enhanced Dream Phases (depends on Step 6)
```

Steps 2, 3, 4, and 5 can be **parallelized** after Step 1 completes (no dependencies between them).
Steps 7 and 8 can be parallelized (both depend only on Step 6).

**Recommended commit cadence:**
- Commit after Step 1 (schema + types)
- Commit after Step 2 (naming)
- Commit after Step 3 (bridge persistence)
- Commit after Step 4 (temporal -- this is the largest)
- Commit after Step 5 (memory linkage)
- Commit after Step 6 (reflection orchestration)
- Commit after Step 7 (MCP tool)
- Commit after Step 8 (enhanced daemon)

---

## Testing Strategy

### Unit Tests (per module)

| Module | Test File | Focus |
|--------|-----------|-------|
| Schema | `tests/core/db.test.ts` (extend) | Table creation, constraints, round-trips |
| Naming | `tests/graph/naming.test.ts` | Mock LLM, name quality, fallbacks |
| Bridge | `tests/graph/analyzer.test.ts` (extend) | Persistence, generation tracking, queries |
| Temporal | `tests/graph/temporal.test.ts` | Pattern detection with synthetic data |
| Reflection | `tests/graph/reflection.test.ts` | Pipeline orchestration, edge weights, memory linkage, observations, prune functions |
| MCP Tool | `tests/mcp/reflect.test.ts` | Tool registration, handler, XML output, modes |
| Daemon | `tests/dream/daemon.test.ts` (extend) | Enhanced reflect/prune phases |

### Integration Test

**File**: `tests/graph/reflection-integration.test.ts`

End-to-end test with realistic (mocked LLM) pipeline:
1. Create test DB with synthetic entities (10+), relationships (15+), memories (5+), and staged timestamps
2. Run `runReflection()` with mocked intelligence layer
3. Verify: communities are named (not "Community N"), bridge_scores populated, temporal patterns detected, memory_ids linked, observations generated
4. Verify `buildReflectResultFromCache()` returns equivalent data
5. Run reflection again: verify generation increments, old data coexists

### Daemon Integration Test

**File**: `tests/dream/integration.test.ts` (extend existing)

Add test cases for the enhanced REFLECT and PRUNE phases:
1. Run full `runDream()` with mocked extractors and intelligence layer
2. Verify reflect phase produces named communities and bridge scores
3. Verify prune phase merges redundant entities and prunes orphans
4. Verify report includes Phase 6 metrics

### Mocking Strategy

All LLM calls are mocked via `vi.mock("../dream/intelligence.js")`:
- `generateStructured()` returns predetermined JSON for community naming
- `generate()` returns predetermined text for observations
- `isOllamaAvailable()` returns false (forces API path in tests)
- `buildIntelligenceConfig()` returns test config

The graph analysis functions (`analyzeGraph`, `detectCommunities`, etc.) use real implementations against the test database -- they are fast (sub-ms for small graphs) and deterministic.

---

## File Summary

### New Files (8)

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/graph/naming.ts` | ~200 | LLM-based community naming via intelligence layer |
| `src/graph/temporal.ts` | ~450 | Temporal pattern detection (bursts, emergence, decay, evolution, transitions, bridge formation) |
| `src/graph/reflection.ts` | ~500 | Reflection orchestration, edge weight recomputation, memory linkage, observations, prune helpers |
| `tests/graph/naming.test.ts` | ~250 | Community naming unit tests |
| `tests/graph/temporal.test.ts` | ~500 | Temporal analysis tests with synthetic data |
| `tests/graph/reflection.test.ts` | ~460 | Reflection pipeline, memory linkage, prune function tests |
| `tests/graph/reflection-integration.test.ts` | ~200 | End-to-end reflection pipeline test |
| `tests/mcp/reflect.test.ts` | ~250 | MCP reflect tool tests |

### Modified Files (6)

| File | Change | Lines Changed (est.) |
|------|--------|---------------------|
| `src/core/db.ts` | Add `bridge_scores`, `temporal_patterns`, `reflection_observations` tables + indexes | +50 |
| `src/core/types.ts` | Extend `DreamReport` with Phase 6 metrics | +10 |
| `src/graph/types.ts` | Add `CommunityNaming`, `BridgeScore`, `TemporalPattern`, `ReflectionObservation`, `ReflectResult`, `TemporalPatternType`, `ObservationType` types | +120 |
| `src/graph/analyzer.ts` | Add `persistBridgeScores()`, `getBridgeScores()`, `getLatestBridgeGeneration()` | +80 |
| `src/dream/daemon.ts` | Replace `runReflectPhase()` body, add entity cleanup to `runPrunePhase()` | +100 |
| `src/mcp/server.ts` | Add `reflect` tool definition, handler, and XML formatter | +200 |
| `src/cli/index.ts` | Add `reflect` command | +60 |
| `tests/core/db.test.ts` | Add new table creation/constraint tests | +60 |
| `tests/graph/analyzer.test.ts` | Add bridge persistence tests | +100 |
| `tests/dream/daemon.test.ts` | Update reflect/prune phase tests | +100 |
| `tests/dream/integration.test.ts` | Add Phase 6 integration test cases | +60 |

### Unchanged Files (30+)

All Phase 1-4 source files, all existing semantic/episodic modules, entity extraction, resolver, relationship CRUD, graph search, decay model, scheduler, intelligence layer, embeddings, sync, config, prompts, launchd configuration.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| LLM naming quality (Ollama produces poor topic names) | Medium | Medium | Fallback to entity-name-based labels when LLM output fails validation. Quality threshold: name must be 2-8 words, description must be 1-3 sentences. |
| LLM cost for many communities | Low | Medium | One LLM call per community is bounded by graph size. Typical: 3-10 communities. Skip naming for communities unchanged from previous generation. |
| Temporal analysis false positives | Medium | Low | Conservative thresholds (burstThreshold=3x, jaccardThreshold=0.3). All patterns include confidence scores. The MCP tool shows confidence. |
| Large graph performance in temporal analysis | Low | Medium | All temporal queries use indexed columns (`first_seen`, `last_seen`, `created_at`, `generation`). Worst case: full table scan of entities (~hundreds, not millions). |
| Memory linkage multi-join performance | Low | Low | Community entity lists are small (2-20 entities). The SQL query uses IN clause, not nested subqueries. |
| Breaking existing tests | Low | High | Phase 6 only extends existing functions (no API changes). New code is in new files. Daemon changes are additive (more steps in reflect, more operations in prune). Run full test suite after each step. |
| Entity merge during prune damages graph | Medium | High | Merge is conservative: exact name match only. Verify no active memory references before deletion. Transaction rollback on error. |

---

## Success Criteria

- [ ] `reflect` MCP tool returns meaningful community names (not "Community N"), bridge narratives, and temporal patterns
- [ ] Dream daemon REFLECT phase produces named topic clusters, persisted bridge scores, and temporal patterns
- [ ] Temporal analysis detects at least one pattern in test data with synthetic timestamps
- [ ] `engram reflect --mode communities` shows named topic clusters with entity lists
- [ ] `engram reflect --mode bridges` shows bridge entities with community connections
- [ ] `engram reflect --mode temporal` shows detected patterns
- [ ] `engram reflect --mode health` shows graph statistics
- [ ] Enhanced PRUNE phase merges redundant entities and prunes orphans in test data
- [ ] `buildReflectResultFromCache()` returns data without re-running analysis
- [ ] All 409+ existing tests still pass
- [ ] New test count target: ~80-100 new tests across 7 new test files
- [ ] No new npm dependencies added
