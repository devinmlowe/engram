# Phase 6C: Recursive Graph Exploration — Detailed Implementation Plan

**Branch:** `phase-6-rlm` (worktree: `~/Documents/git/engram-phase-6-rlm`)
**Status:** READY
**Depends on:** Nothing (independent)

---

## Objective

Add selective, criteria-driven graph exploration that lets the model specify relevance criteria, expanding only relevant branches — converting fixed-depth BFS to model-directed recursive traversal.

## Current State

- `src/graph/search.ts:158-237` — `exploreEntity()`: fixed-depth BFS
- `src/graph/search.ts:247-310` — `traverseNeighborhood()`: recursive CTE, depth 1-3
- `src/interfaces/mcp/server.ts:433-491` — `explore` MCP tool
- Entity types: project, tool, technology, person, concept, file, repo
- Relationship types: uses, depends_on, related_to, part_of, configured_by, solved_by

## Implementation Steps

### Step 1: Selective traversal function

**File:** `src/graph/search.ts` — Add new function:

```typescript
interface SelectiveExploreOptions {
  entityName: string;
  criteria: string;              // Natural language or keyword criteria
  maxDepth?: number;             // default: 3
  maxNodes?: number;             // default: 50 (safety cap)
  relationshipTypes?: string[];  // optional filter
}

interface SelectiveExploreResult {
  center: EntityDetail;
  nodes: Array<{
    entity: EntityDetail;
    depth: number;
    relevanceScore: number;       // 0-1 how well it matches criteria
    path: string[];               // entity names from center to this node
  }>;
  edges: Array<{
    source: string;
    target: string;
    relationship: string;
    weight: number;
  }>;
  pruned: number;                 // count of nodes pruned by criteria
}

export async function exploreSelective(
  db: Database,
  embeddings: EmbeddingService,
  options: SelectiveExploreOptions
): Promise<SelectiveExploreResult>
```

**Algorithm:**
1. Find center entity (existing `findEntityByNameOrAlias`)
2. Get depth-1 neighbors (existing CTE)
3. Score each neighbor against criteria:
   - Embed the criteria string
   - Compute cosine similarity between criteria embedding and entity description embedding
   - Score = cosine similarity (0-1)
4. Keep neighbors with score > 0.3 (configurable threshold)
5. For kept neighbors, recursively explore depth+1 (up to maxDepth)
6. Stop when maxNodes reached or no more relevant neighbors
7. Collect edges between all kept nodes

### Step 2: MCP tool

**File:** `src/interfaces/mcp/server.ts` — Add new tool:

**`explore_selective`**
```
Parameters:
  - entity: string (required) — Starting entity name
  - criteria: string (required) — What makes a neighbor relevant
  - max_depth?: number — Default 3
  - max_nodes?: number — Default 50
  - relationship_types?: string[] — Optional filter
Returns:
  - center: entity details
  - nodes: relevant entities with depth, relevance score, path
  - edges: relationships between relevant entities
  - pruned_count: how many nodes were filtered out
```

### Step 3: Shared interface layer

**File:** `src/interfaces/shared/explore.ts` — Add:
- `exploreSelectiveEntity(options)` — Wraps graph function with defaults

## Tests (Write FIRST — TDD)

**File:** `tests/graph/selective-explore.test.ts` (NEW)

```
describe('exploreSelective')
  ✓ finds center entity by name
  ✓ returns center entity when no neighbors match criteria
  ✓ filters neighbors by criteria relevance
  ✓ expands relevant neighbors to depth 2
  ✓ respects maxDepth limit
  ✓ respects maxNodes safety cap
  ✓ filters by relationship types when specified
  ✓ returns correct paths from center to each node
  ✓ includes edges between all kept nodes
  ✓ reports pruned count accurately
  ✓ handles entity not found gracefully
  ✓ handles entity with no relationships
  ✓ criteria "all" returns full BFS (no pruning)
  ✓ empty criteria returns full BFS (no pruning)

describe('MCP explore_selective tool')
  ✓ returns valid response for existing entity
  ✓ returns error for non-existent entity
  ✓ respects max_depth parameter
  ✓ respects max_nodes parameter
```

**Contract tests:** Add to existing `tests/e2e/mcp-server.test.ts`:

```
describe('existing explore tool unchanged')
  ✓ explore tool schema unchanged
  ✓ explore returns same format as before
```

## Validation

1. All existing tests pass
2. New tests pass
3. `npm run build` succeeds
4. Interactive test: explore a well-connected entity with specific criteria

## Files Changed

| File | Action |
|------|--------|
| `src/graph/search.ts` | MODIFY (add exploreSelective) |
| `src/interfaces/mcp/server.ts` | MODIFY (add explore_selective tool) |
| `src/interfaces/shared/explore.ts` | MODIFY (add wrapper) |
| `tests/graph/selective-explore.test.ts` | CREATE |
