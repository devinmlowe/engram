# Engram Phase 4: Knowledge Graph -- Implementation Plan

## Context

Phase 1 built Engram's episodic memory foundation: JSONL parser, nomic-embed-text-v1.5 embeddings (256d), hybrid vector+FTS5 search with RRF fusion, MCP server, CLI, and comprehensive tests. Phase 2 added score normalization, embedding fixes (layer_norm for Matryoshka), and the migration pipeline from the legacy superpowers DB. Phase 3 implemented the semantic extraction pipeline: LLM-powered fact extraction with three-tier routing, NLI contradiction detection, FSRS-inspired confidence decay, deduplication/conflict resolution, multi-source search, and the `remember` MCP tool.

Phase 4 is the knowledge graph layer -- it transforms the flat semantic memory store into a connected graph of entities and relationships, enabling structural reasoning about how things relate to each other across conversations.

**What Phase 4 delivers:**
1. **Entity extraction** -- LLM-powered extraction of entities (projects, tools, technologies, concepts, etc.) from conversations via two-step Graphiti-inspired pipeline
2. **Relationship extraction** -- LLM-powered extraction of typed relationships (uses, depends_on, part_of, etc.) between resolved entities
3. **Entity resolution** -- Four-stage cascading pipeline: exact name match, alias lookup, embedding cosine similarity, LLM verification
4. **Entity CRUD** -- Full CRUD operations for entities with FTS5 and vec0 synchronization (mirroring the memory.ts pattern)
5. **Graph analysis** -- Community detection via Louvain (graphology), betweenness centrality for bridge detection, edge weight computation
6. **Graph search** -- Entity-centric graph traversal for multi-source recall
7. **`explore` MCP tool** -- Entity-centric graph navigation with depth-limited traversal and relationship type filtering
8. **CLI commands** -- `entities`, `relationships`, and `explore` commands for testing and inspection

**What Phase 4 does NOT include** (deferred to Phase 5):
- Dream state daemon scheduling (launchd integration)
- Automatic extraction triggers (conversation-complete hooks)
- LLM-generated community summaries (topic cluster naming)
- Cross-encoder reranking
- Memory pruning execution

All research is complete (3 documents in `docs/research/`). The database schema for knowledge graph tables is already defined in `src/core/db.ts` -- entities, relationships, topic_clusters tables plus vec_entities virtual table are all in place. This plan executes the implementation.

---

## New Dependencies

```
graphology                      -- Core in-memory graph data structure (no visualization deps)
graphology-communities-louvain  -- Louvain community detection algorithm
graphology-metrics              -- Betweenness centrality, degree, and other metrics
graphology-traversal            -- BFS/DFS traversal with depth tracking
graphology-shortest-path        -- Dijkstra, A*, bidirectional shortest path
graphology-components           -- Connected/strongly-connected component detection
```

Estimated addition to `node_modules`: ~2-3MB total. Zero visualization or DOM dependencies.

---

## Architecture Overview

```
Semantic Memories (existing)
       |
       v
+--------------------------------------------------------------+
|               ENTITY EXTRACTION PIPELINE                      |
|                                                               |
|  Step 1: Extract Entities                                     |
|    LLM tool_use -> {name, type, description}                  |
|    Three-tier routing: Haiku -> Sonnet (reuse extractor.ts)   |
|                                                               |
|  Step 2: Resolve Entities                                     |
|    Four-stage cascade:                                        |
|      Exact name -> Alias lookup -> Embedding sim -> LLM       |
|    Thresholds: >=0.95 auto-merge, 0.85-0.95 likely,           |
|                0.70-0.85 LLM verify, <0.70 distinct           |
|                                                               |
|  Step 3: Extract Relationships                                |
|    LLM tool_use -> {source, target, type, context}            |
|    Using resolved entity IDs from Step 2                      |
+-------------------------------+-------------------------------+
                                |
                                v
+--------------------------------------------------------------+
|                    GRAPH STORE                                 |
|                                                               |
|  entities table + entities_fts + vec_entities                  |
|  relationships table (with UNIQUE constraint on edge)         |
|  topic_clusters table for community results                   |
|                                                               |
|  Entity CRUD: FTS5/vec0 sync (mirrors memory.ts pattern)      |
|  Relationship CRUD: weight management, dedup                  |
+-------------------------------+-------------------------------+
                                |
                                v
+--------------------------------------------------------------+
|                 GRAPH ANALYSIS (graphology)                    |
|                                                               |
|  Load SQLite -> graphology Graph (<100ms for 10K nodes)       |
|  Louvain community detection -> topic_clusters                |
|  Betweenness centrality -> bridge entity detection            |
|  Edge weight: freq(35%) + recency(25%) + conf(20%) + imp(20%) |
|  BFS/DFS traversal for explore queries                        |
+-------------------------------+-------------------------------+
                                |
                                v
+--------------------------------------------------------------+
|                 RETRIEVAL & INTEGRATION                        |
|                                                               |
|  Entity search: hybrid vec+FTS on entity names/descriptions   |
|  Graph traversal: N-hop neighborhood, path finding             |
|  Multi-source search: episodic + semantic + graph              |
|  explore MCP tool: zero LLM calls at query time               |
+--------------------------------------------------------------+
```

---

## File Plan

### New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/graph/types.ts` | Phase 4-specific types (ExtractedEntity, EntityResolution, GraphAnalysis, etc.) | ~120 |
| `src/graph/entity.ts` | Entity CRUD: insert, update, merge, search with FTS5/vec0 sync | ~300 |
| `src/graph/relationship.ts` | Relationship CRUD: insert, update, weight management, edge dedup | ~200 |
| `src/graph/extractor.ts` | LLM-based entity + relationship extraction (two-step pipeline) | ~350 |
| `src/graph/resolver.ts` | Four-stage entity resolution pipeline | ~280 |
| `src/graph/analyzer.ts` | graphology: load graph, Louvain, centrality, bridge detection, weights | ~300 |
| `src/graph/search.ts` | Graph-based search: entity lookup, neighborhood traversal, path finding | ~200 |
| `prompts/extract-entities.md` | Entity extraction prompt template | ~80 |
| `prompts/extract-relationships.md` | Relationship extraction prompt template | ~80 |
| `tests/graph/entity.test.ts` | Entity CRUD operations, FTS/vec sync, merge | ~250 |
| `tests/graph/relationship.test.ts` | Relationship CRUD, weight management, edge dedup | ~200 |
| `tests/graph/extractor.test.ts` | Entity + relationship extraction with mocked LLM | ~250 |
| `tests/graph/resolver.test.ts` | Four-stage entity resolution tests | ~250 |
| `tests/graph/analyzer.test.ts` | graphology loading, Louvain, centrality, weights | ~250 |
| `tests/graph/search.test.ts` | Graph search, traversal, neighborhood queries | ~200 |
| `tests/graph/integration.test.ts` | End-to-end: extraction -> resolution -> analysis -> search | ~350 |

### Modified Files

| File | Changes |
|------|---------|
| `src/core/db.ts` | Add `entities_fts` FTS5 table, UNIQUE constraint on relationships, composite indexes |
| `src/core/types.ts` | Add `EntityType` expansions (configuration, error, command), expand `RelationshipType` |
| `src/episodic/search.ts` | Update `searchMultiSource()` to include graph source, add `formatGraphXml()` |
| `src/mcp/server.ts` | Add `explore` tool, update `recall` to include graph source |
| `src/cli/index.ts` | Add `entities`, `relationships`, `explore` commands, update `stats` |
| `package.json` | Add graphology dependencies |
| `tests/helpers.ts` | Add `createTestEntity()`, `createTestRelationship()` helpers |

---

## Team Execution Strategy: 4 Parallel Streams

```
Stream A: Entity CRUD + Graph Types     (graph/types.ts, graph/entity.ts,
                                         graph/relationship.ts, tests)

Stream B: Entity Extraction Pipeline    (graph/extractor.ts, prompts/*, tests)

Stream C: graphology Analysis           (graph/analyzer.ts, tests)

    -- all three start simultaneously, no cross-dependencies --

         | A complete   | B complete   | C complete
         v              v              v
Stream D: Integration
    (graph/resolver.ts, graph/search.ts,
     episodic/search.ts, mcp/server.ts, cli/index.ts,
     core/db.ts, core/types.ts, tests)
```

**Zero merge conflicts in Streams A/B/C**: Each creates new files only.
Stream D modifies shared files but runs after A/B/C complete.

| File | A | B | C | D |
|------|---|---|---|---|
| `src/graph/types.ts` | CREATES | - | - | imports |
| `src/graph/entity.ts` | CREATES | - | - | imports |
| `src/graph/relationship.ts` | CREATES | - | - | imports |
| `src/graph/extractor.ts` | - | CREATES | - | imports |
| `prompts/extract-entities.md` | - | CREATES | - | - |
| `prompts/extract-relationships.md` | - | CREATES | - | - |
| `src/graph/analyzer.ts` | - | - | CREATES | imports |
| `src/graph/resolver.ts` | - | - | - | CREATES |
| `src/graph/search.ts` | - | - | - | CREATES |
| `src/episodic/search.ts` | - | - | - | MODIFIES |
| `src/mcp/server.ts` | - | - | - | MODIFIES |
| `src/cli/index.ts` | - | - | - | APPENDS |
| `src/core/db.ts` | - | - | - | MODIFIES |
| `src/core/types.ts` | - | - | - | MODIFIES |
| `package.json` | - | - | MODIFIES | - |
| `tests/helpers.ts` | MODIFIES | - | - | - |

---

## Stream A: Entity CRUD + Graph Types

### A1: Create graph types (`src/graph/types.ts`)

**Purpose**: Phase 4-specific types not already in `core/types.ts`. Follows the same pattern as `src/semantic/types.ts`.

```typescript
import type { EntityType, RelationshipType } from "../core/types.js";

// ─── Extraction ──────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description?: string;
}

export interface ExtractedRelationship {
  sourceEntityIndex: number;   // index into the extracted entities array
  targetEntityIndex: number;
  type: RelationshipType;
  context?: string;            // natural language description of the relationship
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  model: string;
  tier: "haiku" | "sonnet";
  durationMs: number;
}

export interface RelationshipExtractionResult {
  relationships: ExtractedRelationship[];
  model: string;
  tier: "haiku" | "sonnet";
  durationMs: number;
}

// ─── Entity Resolution ──────────────────────────────────────────

export type ResolutionStage =
  | "exact_name"
  | "alias"
  | "embedding"
  | "llm"
  | "created";

export interface EntityResolution {
  action: "merge" | "create";
  entityId: string;
  stage: ResolutionStage;
  similarity?: number;
  mergedAliases?: string[];
}

// ─── Graph Analysis ─────────────────────────────────────────────

export interface CommunityResult {
  communityId: number;
  entityIds: string[];
  coherenceScore: number;
}

export interface GraphAnalysisResult {
  communities: CommunityResult[];
  modularity: number;
  bridgeEntities: Array<{
    entityId: string;
    betweenness: number;
    communitySpan: number;
    bridgeScore: number;
  }>;
  totalNodes: number;
  totalEdges: number;
  durationMs: number;
}

// ─── Edge Weight ────────────────────────────────────────────────

export interface EdgeWeightFactors {
  mentionCount: number;
  lastSeen: number;
  confidence: number;
  sourceImportance: number;
  targetImportance: number;
}

// ─── Explore Query ──────────────────────────────────────────────

export interface ExploreOptions {
  entity: string;           // starting entity name or ID
  depth?: number;           // hops (default 1, max 3)
  relationshipTypes?: RelationshipType[];
  includeMemories?: boolean;
}

export interface ExploreResult {
  centerEntity: {
    id: string;
    name: string;
    type: EntityType;
    description?: string;
    mentionCount: number;
  };
  neighbors: Array<{
    entity: {
      id: string;
      name: string;
      type: EntityType;
      description?: string;
    };
    relationship: {
      type: RelationshipType;
      weight: number;
      context?: string;
      direction: "outgoing" | "incoming";
    };
    depth: number;
  }>;
  community?: {
    name: string;
    description?: string;
    entityCount: number;
  };
}
```

**Commit**: `feat(graph): add Phase 4 knowledge graph type definitions`

### A2: Add test helpers (`tests/helpers.ts` modifications)

**Append** to existing helpers:

```typescript
import type { Entity, Relationship } from "../src/core/types.js";

export function createTestEntity(overrides: Partial<Entity> = {}): Entity {
  const id = overrides.id ?? `ent-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name: "TypeScript",
    type: "technology",
    description: "A typed superset of JavaScript",
    aliases: [],
    firstSeen: Math.floor(Date.now() / 1000),
    lastSeen: Math.floor(Date.now() / 1000),
    mentionCount: 1,
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

export function createTestRelationship(
  overrides: Partial<Relationship> = {},
): Relationship {
  return {
    id: `rel-${Math.random().toString(36).slice(2, 10)}`,
    sourceEntityId: "ent-source",
    targetEntityId: "ent-target",
    type: "uses",
    weight: 1.0,
    sourceMemories: [],
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}
```

**Commit**: `test(graph): add entity and relationship test helpers`

### A3: Create entity CRUD (`src/graph/entity.ts`)

**Purpose**: All database operations for the `entities` table, including FTS5 and vec0 synchronization. Mirrors the established pattern from `src/semantic/memory.ts`.

```typescript
// Key exports
export function insertEntity(db: Database, entity: Entity, embedding: number[]): void;
export function updateEntity(db: Database, id: string, updates: Partial<Entity>): void;
export function updateEntityEmbedding(db: Database, id: string, embedding: number[]): void;
export function getEntity(db: Database, id: string): Entity | null;
export function getEntityByName(db: Database, name: string): Entity | null;
export function getEntityByAlias(db: Database, alias: string): Entity | null;
export function getAllEntities(db: Database, type?: EntityType): Entity[];
export function recordEntityMention(db: Database, id: string): void;
export function mergeEntities(db: Database, keepId: string, mergeId: string): void;
export function findNearestEntities(
  db: Database, embedding: number[], limit: number
): Array<{ id: string; distance: number }>;
export function ftsSearchEntities(
  db: Database, query: string, limit: number
): Array<{ id: string; rank: number }>;
```

**Implementation details**:
- `insertEntity()`: Transactional -- inserts into `entities`, `entities_fts` (new), and `vec_entities` atomically. `aliases` stored as JSON array string.
- `updateEntity()`: FTS5 delete-then-insert sync pattern (same as memory.ts)
- `getEntityByName()`: Case-insensitive `lower(name) = lower(?)` query
- `getEntityByAlias()`: Scans `aliases` JSON array with `aliases LIKE '%"' || lower(?) || '"%'`
- `recordEntityMention()`: Increments `mention_count`, updates `last_seen`
- `mergeEntities()`: Transactional merge -- moves aliases, repoints relationships, updates mention counts, soft-deletes merged entity. Handles duplicate relationship dedup after repointing.
- `findNearestEntities()`: vec0 MATCH query on `vec_entities`
- `ftsSearchEntities()`: FTS5 MATCH on `entities_fts` with porter unicode61 tokenization
- All writes use `db.transaction()` for atomicity

**Commit**: `feat(graph): implement entity CRUD with FTS5/vec0 sync`

### A4: Create relationship CRUD (`src/graph/relationship.ts`)

**Purpose**: Database operations for the `relationships` table, including weight management and edge deduplication.

```typescript
// Key exports
export function insertRelationship(db: Database, rel: Relationship): void;
export function updateRelationship(
  db: Database, id: string, updates: Partial<Relationship>
): void;
export function getRelationship(db: Database, id: string): Relationship | null;
export function getRelationshipsForEntity(
  db: Database, entityId: string
): Relationship[];
export function getRelationshipsBetween(
  db: Database, entityA: string, entityB: string
): Relationship[];
export function findOrCreateRelationship(
  db: Database, sourceId: string, targetId: string, type: RelationshipType,
  context?: string, memoryId?: string
): { relationship: Relationship; created: boolean };
export function updateRelationshipWeight(
  db: Database, id: string, weight: number
): void;
export function computeEdgeWeight(factors: EdgeWeightFactors, now?: number): number;
```

**Implementation details**:
- `insertRelationship()`: Respects UNIQUE constraint on `(source_entity_id, target_entity_id, type)`. Uses INSERT OR IGNORE to avoid duplicate edges.
- `findOrCreateRelationship()`: Checks if edge exists; if so, appends memoryId to `source_memories` JSON array and updates `updated_at`; if not, creates new. This is the primary write entry point.
- `getRelationshipsForEntity()`: Queries both source and target columns (bidirectional)
- `computeEdgeWeight()`: Multi-factor formula from research:
  ```
  freq(35%):   log2(1 + mentionCount) / log2(11)   -- normalized to ~1.0 at 10 mentions
  recency(25%): 0.9 ^ (daysSinceLastSeen / 90)     -- aligned with FSRS decay
  conf(20%):   confidence                           -- direct passthrough
  imp(20%):    (sourceImportance + targetImportance) / 2
  weight = 0.35*freq + 0.25*recency + 0.20*conf + 0.20*imp
  Floor at 0.01 to prevent zero-weight edges
  ```
- `source_memories` stored as JSON array string

**Commit**: `feat(graph): implement relationship CRUD with weight management`

### A5: Entity CRUD tests (`tests/graph/entity.test.ts`)

- Test: `insertEntity()` writes to all three tables (entities, FTS, vec)
- Test: `getEntity()` returns correct entity by ID
- Test: `getEntityByName()` finds entity case-insensitively
- Test: `getEntityByAlias()` finds entity by alias
- Test: `updateEntity()` updates description and syncs FTS
- Test: `recordEntityMention()` increments `mention_count` and updates `last_seen`
- Test: `mergeEntities()` transfers aliases, repoints relationships, deduplicates edges
- Test: `findNearestEntities()` returns neighbors sorted by distance
- Test: `ftsSearchEntities()` finds entities by keyword
- Test: FTS search finds inserted entity by name keyword

**Commit**: `test(graph): add entity CRUD and merge tests`

### A6: Relationship CRUD tests (`tests/graph/relationship.test.ts`)

- Test: `insertRelationship()` writes to relationships table
- Test: `getRelationshipsForEntity()` returns both incoming and outgoing edges
- Test: `getRelationshipsBetween()` returns edges between two specific entities
- Test: `findOrCreateRelationship()` creates new edge when none exists
- Test: `findOrCreateRelationship()` appends memory to existing edge's source_memories
- Test: duplicate insert with same (source, target, type) does not create duplicate
- Test: `computeEdgeWeight()` produces expected values for known inputs
- Test: `computeEdgeWeight()` recency decays over time
- Test: `computeEdgeWeight()` floors at 0.01

**Commit**: `test(graph): add relationship CRUD and weight computation tests`

---

## Stream B: Entity Extraction Pipeline

### B1: Create entity extraction prompt template (`prompts/extract-entities.md`)

**Purpose**: Structured prompt for LLM-based entity extraction from conversations. Read at runtime by the extractor, keeping it as markdown for easy iteration.

```markdown
# Entity Extraction from Developer Conversation

You are an entity extraction specialist analyzing a conversation between
a developer and Claude Code (an AI coding assistant).

## Entity Types

Extract entities into exactly one of these types:

- **project**: Software project, application, or product name
- **technology**: Programming language, framework, library, or protocol
- **tool**: Development tool, CLI utility, editor, or service
- **file**: Specific file path, directory, or configuration file
- **repo**: Git repository (org/name format preferred)
- **person**: The user, or any referenced individual
- **concept**: Technical concept, design pattern, algorithm, or architecture approach

## Rules

1. Extract entities explicitly or implicitly mentioned in the conversation.
2. Replace ALL pronouns with the actual entity names.
3. Use the most complete, formal name available:
   - "TypeScript" not "TS"
   - "better-sqlite3" not "the sqlite library"
   - "src/semantic/extractor.ts" not "the extractor"
4. For file paths, preserve the full relative path when available.
5. Do NOT extract:
   - Temporal information (dates, times) -- these go on relationships
   - Generic actions or verbs
   - Conversational filler
6. If an entity could be multiple types, choose the most specific type.
7. Score importance on 0.0-1.0 scale (passing mention = 0.2, core discussion topic = 0.9)

## Few-Shot Examples

### Example 1
User: "I set up the project to use SQLite with WAL mode"
Assistant: "WAL mode provides good concurrent read performance"

Entities:
- name: "SQLite", type: "technology", description: "Database engine used by the project"
- name: "WAL mode", type: "concept", description: "Write-Ahead Logging journal mode for SQLite"

### Example 2
User: "Can you read src/semantic/extractor.ts and fix the chunking bug?"
Assistant: "I see the issue in the chunkConversation function..."

Entities:
- name: "src/semantic/extractor.ts", type: "file", description: "Semantic extraction pipeline source file"
- name: "chunkConversation", type: "concept", description: "Function for splitting conversations into processable chunks"
```

**Commit**: `feat(graph): add entity extraction prompt template`

### B2: Create relationship extraction prompt template (`prompts/extract-relationships.md`)

**Purpose**: Prompt template for LLM-based relationship extraction between resolved entities.

```markdown
# Relationship Extraction from Developer Conversation

You are a relationship extraction specialist. Given a developer conversation
and a list of resolved entities, extract factual relationships between them.

## Relationship Types

- **uses**: Active use of a tool, technology, or library
- **depends_on**: Runtime, build, or logical dependency
- **related_to**: General association (use sparingly -- prefer specific types)
- **part_of**: Containment (file in project, module in system)
- **configured_by**: Configuration relationship
- **solved_by**: Problem resolved by a solution, tool, or approach

## Rules

1. Each relationship must connect two DISTINCT entities from the provided list.
2. Use the entity indexes provided, not new entity names.
3. The context field should be a concise natural language description of the relationship.
4. Paraphrase -- do not copy text verbatim from the conversation.
5. Do NOT extract:
   - Self-referential relationships (source = target)
   - Relationships not supported by the conversation text
   - Speculative or hypothetical relationships

## Entities

{entity_list}

## Conversation

{conversation_text}
```

**Commit**: `feat(graph): add relationship extraction prompt template`

### B3: Implement entity + relationship extractor (`src/graph/extractor.ts`)

**Purpose**: Two-step LLM extraction pipeline: first entities, then relationships between resolved entities. Follows the Graphiti-inspired separation of concerns.

```typescript
// Key exports
export async function initGraphExtractor(anthropicApiKey?: string): Promise<void>;
export function resetGraphExtractor(): void;
export function setGraphExtractorClient(customClient: Anthropic): void;

export async function extractEntities(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
): Promise<EntityExtractionResult>;

export async function extractRelationships(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
  resolvedEntities: Array<{ index: number; id: string; name: string; type: EntityType }>,
): Promise<RelationshipExtractionResult>;

export function buildEntityExtractionPrompt(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
): string;

export function buildRelationshipExtractionPrompt(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
  entities: Array<{ index: number; name: string; type: EntityType }>,
): string;

export function parseEntityExtractionResponse(toolUseResult: unknown): ExtractedEntity[];
export function parseRelationshipExtractionResponse(toolUseResult: unknown): ExtractedRelationship[];
```

**Implementation details**:

1. **Tool schemas**: Two separate Anthropic tool definitions:

   `extract_entities` tool:
   ```typescript
   {
     name: "extract_entities",
     input_schema: {
       type: "object",
       properties: {
         entities: {
           type: "array",
           items: {
             type: "object",
             properties: {
               name: { type: "string" },
               type: { type: "string", enum: [...EntityType values] },
               description: { type: "string" }
             },
             required: ["name", "type"]
           }
         }
       },
       required: ["entities"]
     }
   }
   ```

   `extract_relationships` tool:
   ```typescript
   {
     name: "extract_relationships",
     input_schema: {
       type: "object",
       properties: {
         relationships: {
           type: "array",
           items: {
             type: "object",
             properties: {
               source_entity_index: { type: "integer" },
               target_entity_index: { type: "integer" },
               type: { type: "string", enum: [...RelationshipType values] },
               context: { type: "string" }
             },
             required: ["source_entity_index", "target_entity_index", "type"]
           }
         }
       },
       required: ["relationships"]
     }
   }
   ```

2. **Three-tier routing**: Reuses the same Haiku -> Sonnet fallback pattern from `semantic/extractor.ts`. Uses `claude-haiku-4-5-20251001` (primary) and `claude-sonnet-4-6` (fallback).

3. **Response parsing**:
   - `parseEntityExtractionResponse()`: Validates entity types against the EntityType enum, filters empty names, deduplicates by lowercase name
   - `parseRelationshipExtractionResponse()`: Validates entity indexes are within bounds, validates relationship types, filters self-referential edges

4. **Chunking**: Reuses `chunkConversation()` from `semantic/extractor.ts` for long conversations. Entity extraction runs per chunk, then results are merged and deduplicated before relationship extraction runs on the full set.

**Commit**: `feat(graph): implement two-step entity and relationship extraction pipeline`

### B4: Extraction tests (`tests/graph/extractor.test.ts`)

- Test: `buildEntityExtractionPrompt()` includes metadata and exchange content
- Test: `buildEntityExtractionPrompt()` loads prompt template from disk
- Test: `buildRelationshipExtractionPrompt()` includes entity list and conversation
- Test: `parseEntityExtractionResponse()` handles valid tool_use response
- Test: `parseEntityExtractionResponse()` rejects invalid entity types
- Test: `parseEntityExtractionResponse()` deduplicates by lowercase name
- Test: `parseEntityExtractionResponse()` filters empty names
- Test: `parseEntityExtractionResponse()` returns empty array for empty response
- Test: `parseRelationshipExtractionResponse()` handles valid response
- Test: `parseRelationshipExtractionResponse()` rejects out-of-bounds entity indexes
- Test: `parseRelationshipExtractionResponse()` rejects self-referential edges
- Test: extraction with mock API client returns correct structure

**Commit**: `test(graph): add entity and relationship extraction tests`

---

## Stream C: graphology Analysis

### C1: Add graphology dependencies

```bash
npm install graphology graphology-communities-louvain graphology-metrics \
  graphology-traversal graphology-shortest-path graphology-components
```

**Commit**: `chore: add graphology dependencies for graph analysis`

### C2: Implement graph analyzer (`src/graph/analyzer.ts`)

**Purpose**: Load the knowledge graph from SQLite into graphology, run community detection, compute centrality, and detect bridge entities.

```typescript
import Graph from "graphology";

// ─── Graph Loading ──────────────────────────────────────────────

export function loadGraph(db: Database): Graph;

// ─── Community Detection ────────────────────────────────────────

export function detectCommunities(
  graph: Graph,
  resolution?: number,
): {
  communities: Map<string, number>;  // nodeId -> communityId
  count: number;
  modularity: number;
};

export function groupByCommunity(
  communities: Map<string, number>,
): Map<number, string[]>;  // communityId -> entityIds[]

export function computeCoherence(
  graph: Graph,
  communityNodes: string[],
): number;

// ─── Centrality & Bridge Detection ──────────────────────────────

export function computeBetweenness(
  graph: Graph,
): Map<string, number>;  // nodeId -> betweenness score

export function detectBridgeEntities(
  graph: Graph,
  communities: Map<string, number>,
): Array<{
  entityId: string;
  betweenness: number;
  communitySpan: number;
  bridgeScore: number;
}>;

// ─── Full Analysis ──────────────────────────────────────────────

export function analyzeGraph(
  db: Database,
  resolution?: number,
): GraphAnalysisResult;

export function persistAnalysis(
  db: Database,
  analysis: GraphAnalysisResult,
): void;
```

**Implementation details**:

1. **loadGraph()**: Queries all entities and relationships from SQLite, builds a graphology `Graph({ type: 'undirected', multi: false })`. For 10K entities + 50K relationships, this completes in <100ms and uses <50MB RAM.

2. **detectCommunities()**: Uses `graphology-communities-louvain` with `louvain.detailed(graph, { resolution, getEdgeWeight: 'weight' })`. Returns the community partition, count, and modularity score.

3. **computeCoherence()**: For each community, calculates `internalEdges / (internalEdges + externalEdges)`. Higher score means the community is more self-contained.

4. **detectBridgeEntities()**: Multi-metric approach:
   - Run betweenness centrality via `graphology-metrics/centrality/betweenness`
   - For each node, count distinct communities in its 1-hop neighborhood
   - `bridgeScore = betweenness * communitySpan`
   - Sort by bridgeScore descending, return top entities

5. **analyzeGraph()**: Full analysis pipeline:
   - Load graph from SQLite
   - Run Louvain community detection
   - Compute coherence per community
   - Compute betweenness centrality
   - Detect bridge entities
   - Return unified `GraphAnalysisResult`

6. **persistAnalysis()**: Writes community results to `topic_clusters` table. Each community becomes a TopicCluster with entityIds and coherenceScore. Clears previous generation's clusters before writing new ones (using `generation` field for versioning).

**Commit**: `feat(graph): implement graphology-based community detection and centrality analysis`

### C3: Analyzer tests (`tests/graph/analyzer.test.ts`)

- Test: `loadGraph()` creates correct node and edge count from DB
- Test: `loadGraph()` preserves node attributes (name, type)
- Test: `loadGraph()` preserves edge attributes (type, weight)
- Test: `detectCommunities()` finds at least 1 community
- Test: `detectCommunities()` assigns every node to a community
- Test: `detectCommunities()` returns modularity in [-0.5, 1.0]
- Test: `computeCoherence()` returns 1.0 for fully connected clique
- Test: `computeCoherence()` returns 0.0 for community with only external edges
- Test: `computeBetweenness()` returns non-negative scores
- Test: `computeBetweenness()` gives highest score to central node in star graph
- Test: `detectBridgeEntities()` identifies node connecting two cliques
- Test: `analyzeGraph()` returns complete `GraphAnalysisResult` structure
- Test: `persistAnalysis()` writes topic clusters to DB
- Test: `persistAnalysis()` increments generation counter

**Commit**: `test(graph): add graph analysis and community detection tests`

---

## Stream D: Integration

**Depends on**: Streams A, B, C all complete.

### D1: Update database schema (`src/core/db.ts`)

**Modifications**:

1. Add `entities_fts` FTS5 virtual table for entity text search:
   ```sql
   CREATE VIRTUAL TABLE entities_fts USING fts5(
     name,
     description,
     content='entities',
     content_rowid='rowid',
     tokenize='porter unicode61'
   )
   ```

2. Add UNIQUE constraint on relationships to prevent duplicate edges:
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique_edge
     ON relationships(source_entity_id, target_entity_id, type);
   ```

3. Add composite indexes for bidirectional edge traversal:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_rel_source_target
     ON relationships(source_entity_id, target_entity_id);
   CREATE INDEX IF NOT EXISTS idx_rel_target_source
     ON relationships(target_entity_id, source_entity_id);
   ```

4. Add case-insensitive name index:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_entities_name_lower
     ON entities(lower(name));
   ```

**Commit**: `feat(core): add entities_fts, unique edge constraint, and composite indexes`

### D2: Implement entity resolver (`src/graph/resolver.ts`)

**Purpose**: Four-stage cascading pipeline for entity resolution: exact name, alias, embedding, LLM verification.

```typescript
// Key exports
export async function resolveEntity(
  db: Database,
  extracted: ExtractedEntity,
): Promise<EntityResolution>;

export async function resolveEntities(
  db: Database,
  extractedEntities: ExtractedEntity[],
): Promise<Array<{ extracted: ExtractedEntity; resolution: EntityResolution }>>;
```

**Four-stage algorithm**:

```
For each extracted entity:

Stage 1: Exact Name Match (Free)
  SELECT id FROM entities WHERE lower(name) = lower(?)
  If found -> return { action: 'merge', entityId, stage: 'exact_name' }

Stage 2: Alias Lookup (Free)
  Scan aliases JSON arrays for case-insensitive match
  If found -> return { action: 'merge', entityId, stage: 'alias' }

Stage 3: Embedding Similarity (Cheap)
  Embed the entity name with embedDocument()
  Query vec_entities for top-5 nearest neighbors
  Convert L2 distance to cosine similarity:
    >=0.95: auto-merge -> return { action: 'merge', stage: 'embedding' }
    0.85-0.95: merge with high confidence (same type check)
    0.70-0.85: proceed to Stage 4 (LLM verify)
    <0.70: skip this candidate

Stage 4: LLM Verification (Expensive, optional)
  For candidates in the 0.70-0.85 range:
    Call Haiku with a deduplicate-entity prompt
    If LLM confirms match -> return { action: 'merge', stage: 'llm' }

No match found:
  Generate new entity ID
  Insert into entities table with embedding
  Add name as first alias
  return { action: 'create', stage: 'created' }
```

**Implementation details**:
- On merge: calls `recordEntityMention()` to bump mention_count, updates `last_seen`, adds new aliases
- On create: calls `insertEntity()` with the embedded name
- Processes entities sequentially (order matters -- earlier resolutions affect later lookups)
- When LLM verification is not available (no API key), the 0.70-0.85 range is treated as distinct entities (conservative default)

**Commit**: `feat(graph): implement four-stage entity resolution pipeline`

### D3: Entity resolver tests (`tests/graph/resolver.test.ts`)

- Test: exact name match returns merge with `stage: 'exact_name'`
- Test: case-insensitive name match ("typescript" matches "TypeScript")
- Test: alias match returns merge with `stage: 'alias'`
- Test: high embedding similarity (>=0.95) returns auto-merge with `stage: 'embedding'`
- Test: medium similarity (0.85-0.95) with same type returns merge
- Test: medium similarity with different type does not auto-merge
- Test: low similarity (<0.70) returns create
- Test: novel entity (no existing entities) returns create with `stage: 'created'`
- Test: merge updates mention_count and adds alias
- Test: sequential resolution handles within-batch dedup (entity A created, then similar entity B merges with A)
- Test: LLM verification (mocked) confirms ambiguous match

**Commit**: `test(graph): add four-stage entity resolution tests`

### D4: Implement graph search (`src/graph/search.ts`)

**Purpose**: Graph-based search for multi-source recall and the explore MCP tool.

```typescript
// Key exports
export async function searchGraph(
  db: Database,
  options: SearchOptions,
): Promise<SearchResult[]>;

export function exploreEntity(
  db: Database,
  options: ExploreOptions,
): ExploreResult;

export function traverseNeighborhood(
  db: Database,
  entityId: string,
  maxDepth: number,
  relationshipTypes?: RelationshipType[],
): Array<{
  entityId: string;
  depth: number;
  relationship: { type: RelationshipType; weight: number; context?: string };
}>;

export function findEntityByNameOrAlias(
  db: Database,
  nameOrAlias: string,
): Entity | null;
```

**Implementation details**:

1. **searchGraph()**: Entity-centric search for multi-source recall:
   - Embed query with `embedQuery()`
   - Vector search on `vec_entities` (top-10)
   - FTS search on `entities_fts` (top-10)
   - RRF fusion (reuse `rrfFuse()` from `episodic/search.ts`)
   - For each matched entity, include its description and connected relationships as content
   - Format as `SearchResult[]` with `source: "graph"`
   - Zero LLM calls at query time

2. **exploreEntity()**: For the MCP `explore` tool:
   - Find entity by name or alias (case-insensitive)
   - Use SQLite recursive CTE for 1-2 hop traversal (fast for small depth)
   - For depth >= 3, load into graphology and use `bfsFromNode()`
   - Filter by relationship types if specified
   - Return structured `ExploreResult` with center entity, neighbors, and optional community info

3. **traverseNeighborhood()**: Bidirectional traversal using SQLite recursive CTE:
   ```sql
   WITH RECURSIVE neighbors(entity_id, depth) AS (
     SELECT ?, 0
     UNION
     SELECT
       CASE WHEN r.source_entity_id = n.entity_id
            THEN r.target_entity_id
            ELSE r.source_entity_id END,
       n.depth + 1
     FROM neighbors n
     JOIN relationships r
       ON r.source_entity_id = n.entity_id
       OR r.target_entity_id = n.entity_id
     WHERE n.depth < ?
   )
   SELECT DISTINCT e.* FROM entities e
   JOIN neighbors n ON e.id = n.entity_id;
   ```

4. **findEntityByNameOrAlias()**: First tries exact name match (case-insensitive), then searches aliases.

**Commit**: `feat(graph): implement graph search and entity traversal`

### D5: Graph search tests (`tests/graph/search.test.ts`)

- Test: `searchGraph()` finds entities matching query
- Test: `searchGraph()` returns results with `source: "graph"`
- Test: `searchGraph()` includes relationship context in results
- Test: `searchGraph()` returns empty for no matches
- Test: `exploreEntity()` finds entity by name (case-insensitive)
- Test: `exploreEntity()` finds entity by alias
- Test: `exploreEntity()` returns correct neighbors at depth 1
- Test: `exploreEntity()` respects maxDepth limit
- Test: `exploreEntity()` filters by relationship type
- Test: `traverseNeighborhood()` returns bidirectional results
- Test: `traverseNeighborhood()` handles isolated entity (no neighbors)

**Commit**: `test(graph): add graph search and traversal tests`

### D6: Extend episodic search for graph source (`src/episodic/search.ts`)

**Modifications**:

1. Add graph source to `searchMultiSource()`:
   ```typescript
   const includeGraph = sources.includes("graph");
   // ...
   const [episodicResponse, semanticResults, graphResults] = await Promise.all([
     includeEpisodic ? searchEpisodic(db, options) : ...,
     includeSemantic ? searchSemantic(db, options) : ...,
     includeGraph ? searchGraph(db, options) : Promise.resolve([]),
   ]);
   ```

2. Add `formatGraphXml()` for graph results within the XML output:
   ```xml
   <graph entity="TypeScript" type="technology" relevance="85%">
     TypeScript is a typed superset of JavaScript.
     Relationships: uses better-sqlite3, part_of engram project
   </graph>
   ```

3. Update `formatRecallXml()` to handle graph results alongside episodic and semantic.

4. Update token budget prioritization: semantic first, then graph (entity descriptions are compact), then episodic.

**Commit**: `feat(search): add graph source to multi-source search`

### D7: Multi-source search tests (graph addition)

Add to `tests/episodic/search.test.ts`:

- Test: `searchMultiSource()` with `sources: ["graph"]` returns graph results only
- Test: `searchMultiSource()` with all three sources returns mixed results
- Test: `formatRecallXml()` outputs `<graph>` tags for graph results
- Test: graph results included in cross-source RRF fusion

**Commit**: `test(search): add graph source integration tests`

### D8: Add `explore` tool to MCP server (`src/mcp/server.ts`)

**Modifications**:

1. Add `explore` tool definition:
   ```typescript
   {
     name: "explore",
     description:
       "Explore connections in the knowledge graph starting from an entity. " +
       "Shows what a concept, tool, project, or technology is connected to. " +
       "Use after recall to understand how things relate to each other.",
     inputSchema: {
       type: "object",
       properties: {
         entity: {
           type: "string",
           minLength: 1,
           description: "Entity name to explore (e.g., 'TypeScript', 'engram', 'SQLite')"
         },
         depth: {
           type: "number",
           minimum: 1,
           maximum: 3,
           default: 1,
           description: "Number of hops to traverse (1-3)"
         },
         relationship_types: {
           type: "array",
           items: {
             type: "string",
             enum: ["uses", "depends_on", "related_to", "part_of", "configured_by", "solved_by"]
           },
           description: "Filter by relationship types"
         }
       },
       required: ["entity"],
       additionalProperties: false
     },
     annotations: {
       title: "Explore Knowledge Graph",
       readOnlyHint: true,
       destructiveHint: false,
       idempotentHint: true,
       openWorldHint: false,
     }
   }
   ```

2. **Handler behavior**:
   - Calls `exploreEntity()` from `graph/search.ts`
   - Formats result as XML consistent with recall output
   - Zero LLM calls (pure graph traversal)
   - Returns structured XML:
     ```xml
     <engram_graph entity="TypeScript" type="technology">
       <description>A typed superset of JavaScript</description>
       <relationship direction="outgoing" type="uses" target="better-sqlite3" weight="0.85">
         Used as the database driver for the engram project
       </relationship>
       <relationship direction="incoming" type="part_of" source="src/core/types.ts" weight="0.72">
         Core type definitions file in the TypeScript project
       </relationship>
     </engram_graph>
     ```

3. Update `RecallInputSchema` sources to include `"graph"`:
   ```typescript
   sources: z.array(z.enum(["episodic", "semantic", "graph"])).optional(),
   ```

4. Update `VALID_SOURCES`:
   ```typescript
   const VALID_SOURCES: readonly SearchSource[] = ["episodic", "semantic", "graph"];
   ```

**Commit**: `feat(mcp): add explore tool and graph source in recall`

### D9: Add CLI commands (`src/cli/index.ts`)

**Append** three new commands:

1. `engram entities`:
   ```
   Options:
     -t, --type <type>    Filter by entity type
     -l, --limit <n>      Max results (default 20)
     --search <query>     Search entities by name
   ```
   Lists entities from the graph, optionally filtered by type or searched by name.

2. `engram relationships <entity>`:
   ```
   Options:
     -t, --type <type>    Filter by relationship type
     --depth <n>          Traversal depth (default 1)
   ```
   Shows relationships for a specific entity.

3. `engram explore <entity>`:
   ```
   Options:
     -d, --depth <n>      Traversal depth (1-3, default 1)
     -t, --type <type>    Filter by relationship type
   ```
   Interactive graph exploration starting from an entity. Calls `exploreEntity()` and formats output.

4. Update `engram stats` to include graph statistics:
   ```
   Graph:
     Entities:        42 (12 projects, 15 tools, 8 technologies, 7 concepts)
     Relationships:   87
     Topic Clusters:  5
   ```

**Commit**: `feat(cli): add entities, relationships, and explore commands`

### D10: Update core types (`src/core/types.ts`)

**Modifications**:
- The existing `EntityType` and `RelationshipType` are already sufficient for Phase 4. No changes needed unless we expand the type sets, which the research suggests deferring.
- Verify `SearchSource` includes `"graph"` (it already does -- line 145: `export type SearchSource = "episodic" | "semantic" | "graph";`)

**Commit**: (no separate commit needed -- types already include graph source)

---

## Integration Testing

### D11: End-to-end integration test (`tests/graph/integration.test.ts`)

Full pipeline test with mocked LLM and embeddings:

1. **Setup**: Insert synthetic exchanges into episodic store (reuse `seedExchange()` pattern from Phase 3 integration tests)

2. **Entity extraction**: Mock LLM returns structured entities (TypeScript, SQLite, engram, Fish shell)

3. **Entity resolution**: Test the full four-stage pipeline:
   - First entity (TypeScript) creates new entity
   - Duplicate entity ("TS") merges with TypeScript via alias/embedding match
   - Novel entity (Fish shell) creates new entity

4. **Relationship extraction**: Mock LLM returns relationships (engram USES TypeScript, engram DEPENDS_ON SQLite)

5. **Graph analysis**: Run Louvain on the resulting graph, verify communities detected

6. **Multi-source search**: `searchMultiSource()` with `sources: ["episodic", "semantic", "graph"]` returns results from all three stores

7. **Explore**: `exploreEntity()` for "TypeScript" returns its relationships

8. **Bridge detection**: Verify bridge entities connect separate communities

~350 lines estimated.

**Commit**: `test(graph): add end-to-end knowledge graph integration tests`

### D12: Full test suite verification

```bash
npm run test:run  # all tests pass
npm run build     # TypeScript compiles cleanly
```

**Commit** (if fixes needed): `fix: resolve Phase 4 integration test failures`

---

## Execution Timeline

### Phase 1: Parallel Foundation (Streams A + B + C)

| Agent | Steps | New Files | Independent? |
|-------|-------|-----------|-------------|
| Stream A | A1-A6 | graph/types.ts, graph/entity.ts, graph/relationship.ts, tests | Yes |
| Stream B | B1-B4 | graph/extractor.ts, prompts/*, tests | Yes |
| Stream C | C1-C3 | graph/analyzer.ts, tests, package.json | Yes |

All three start simultaneously. No dependencies between them.

### Phase 2: Integration (Stream D, after A+B+C complete)

| Agent | Steps | Files Modified/Created |
|-------|-------|----------------------|
| Stream D | D1-D12 | graph/resolver.ts, graph/search.ts, core/db.ts, episodic/search.ts, mcp/server.ts, cli/index.ts, tests |

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

1. **Tests pass**: `npm run test:run` (all existing + ~1,750 new test lines)
2. **Build compiles**: `npm run build` (strict TypeScript)
3. **Entity CRUD works**: Insert, update, merge, search all round-trip correctly
4. **FTS/vec sync works**: Entity insertions are searchable via both FTS and vector
5. **Relationship CRUD works**: Insert, find-or-create, edge dedup, weight computation
6. **Entity extraction works**: Mock conversations produce typed entities with descriptions
7. **Relationship extraction works**: Mock conversations produce typed relationships between resolved entities
8. **Entity resolution works**: Four-stage cascade correctly merges duplicates and creates novel entities
9. **Graph analysis works**: Louvain produces communities, betweenness identifies bridges
10. **Graph search works**: `searchMultiSource()` with graph source returns entity results
11. **Explore works**: `engram explore "TypeScript"` shows connected entities and relationships
12. **MCP explore works**: `explore` tool returns structured XML graph traversal

For live testing (optional, requires ANTHROPIC_API_KEY):
```bash
# Extract entities from a conversation
npm run dev -- extract <conversation-id> --dry-run

# List entities
npm run dev -- entities --search "TypeScript"

# Explore entity connections
npm run dev -- explore "SQLite" --depth 2

# Search across all three stores
npm run dev -- search "database setup"

# Check stats
npm run dev -- stats
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| graphology Louvain produces disconnected communities | Post-processing step in `analyzeGraph()` checks component connectivity within each community and splits disconnected ones |
| Entity resolution over-merges distinct entities | Conservative thresholds: auto-merge only at >= 0.95 similarity; 0.70-0.85 range requires LLM confirmation or treated as distinct |
| Entity resolution under-merges (too many duplicates) | Alias lookup stage catches common abbreviations (TS/TypeScript, JS/JavaScript); periodic dream-cycle re-evaluation |
| Relationship extraction hallucinations | Validation: reject self-referential edges, reject out-of-bounds entity indexes, require context field |
| vec_entities empty on first run | `findNearestEntities()` returns empty array, all entities are created as novel |
| FTS5 sync corruption on entity merge | Same delete-then-insert pattern proven in Phase 1/3; merge operation wrapped in single transaction |
| graphology import issues with ESM | graphology ships ESM natively; verify `"type": "module"` in package.json (already set) |
| Token cost from entity + relationship extraction | Entity extraction uses Haiku by default; relationship extraction uses entity list (compact) not full conversation; both are single-tool-call patterns |
| Graph analysis slow for large graphs | Louvain < 100ms for 10K nodes (benchmarked); betweenness < 500ms; budget is generous for dream-cycle batch processing |
| Circular dependency between graph/entity.ts and graph/resolver.ts | Resolver imports from entity.ts (one-directional); entity.ts has no import from resolver |

---

## Commit Sequence Summary

### Stream A (Entity CRUD + Types)
1. `feat(graph): add Phase 4 knowledge graph type definitions`
2. `test(graph): add entity and relationship test helpers`
3. `feat(graph): implement entity CRUD with FTS5/vec0 sync`
4. `feat(graph): implement relationship CRUD with weight management`
5. `test(graph): add entity CRUD and merge tests`
6. `test(graph): add relationship CRUD and weight computation tests`

### Stream B (Extraction)
1. `feat(graph): add entity extraction prompt template`
2. `feat(graph): add relationship extraction prompt template`
3. `feat(graph): implement two-step entity and relationship extraction pipeline`
4. `test(graph): add entity and relationship extraction tests`

### Stream C (Analysis)
1. `chore: add graphology dependencies for graph analysis`
2. `feat(graph): implement graphology-based community detection and centrality analysis`
3. `test(graph): add graph analysis and community detection tests`

### Stream D (Integration)
1. `feat(core): add entities_fts, unique edge constraint, and composite indexes`
2. `feat(graph): implement four-stage entity resolution pipeline`
3. `test(graph): add four-stage entity resolution tests`
4. `feat(graph): implement graph search and entity traversal`
5. `test(graph): add graph search and traversal tests`
6. `feat(search): add graph source to multi-source search`
7. `test(search): add graph source integration tests`
8. `feat(mcp): add explore tool and graph source in recall`
9. `feat(cli): add entities, relationships, and explore commands`
10. `test(graph): add end-to-end knowledge graph integration tests`
11. `fix: resolve Phase 4 integration test failures` (if needed)

---

### Critical Files for Implementation
- `/Users/USER/Documents/git/engram/.claude/worktrees/phase-4/src/semantic/memory.ts` - Pattern to follow: transactional FTS5/vec0 sync, row-to-domain type conversions, CRUD structure
- `/Users/USER/Documents/git/engram/.claude/worktrees/phase-4/src/semantic/extractor.ts` - Pattern to follow: LLM tool_use structured output, three-tier routing, prompt template loading, response parsing
- `/Users/USER/Documents/git/engram/.claude/worktrees/phase-4/src/core/db.ts` - Schema to modify: add entities_fts, unique constraint, composite indexes
- `/Users/USER/Documents/git/engram/.claude/worktrees/phase-4/src/episodic/search.ts` - Integration point: extend searchMultiSource() with graph source, add formatGraphXml()
- `/Users/USER/Documents/git/engram/.claude/worktrees/phase-4/src/mcp/server.ts` - Integration point: add explore tool, update recall sources to include graph
