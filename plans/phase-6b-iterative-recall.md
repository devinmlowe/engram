# Phase 6B: Iterative Recall — Detailed Implementation Plan

**Branch:** `phase-6-rlm` (worktree: `~/Documents/git/engram-phase-6-rlm`)
**Status:** READY
**Depends on:** Nothing (independent)

---

## Objective

Add stateful search sessions to engram's MCP interface, enabling iterative, multi-step recall that follows leads across episodic, semantic, and graph layers — the core RLM pattern applied to memory exploration.

## Current State

- `src/interfaces/mcp/server.ts:362-380` — `recall` tool: single-shot search
- `src/interfaces/shared/search.ts:42-61` — `unifiedSearch()` wraps orchestrator
- `src/_core/search/orchestrator.ts:62-200` — Multi-source parallel search with RRF
- Existing `recall` returns XML-formatted results with token budget

## Design Decisions (from RLM research)

- **DSPy pattern:** Metadata-first — send variable metadata (type, length, preview) instead of full content
- **Official RLM pattern:** Budget propagation — each sub-query gets remaining budget
- **Safety:** Bounded iterations, LRU session cache with TTL

## Implementation Steps

### Step 1: Session Store

**File:** `src/_core/search/session.ts` (NEW)

```typescript
interface RecallSession {
  id: string;                    // UUID
  createdAt: Date;
  lastAccessedAt: Date;
  query: string;                 // Original query
  refinements: string[];         // Subsequent refinements
  results: SearchResult[];       // Accumulated results
  expandedIds: Set<string>;      // Results that have been drilled into
  totalBudgetUsed: number;       // Token budget consumed
  maxBudget: number;             // Token budget cap
}

interface SessionStore {
  create(query: string, options?: { maxBudget?: number }): RecallSession;
  get(sessionId: string): RecallSession | null;
  refine(sessionId: string, refinedQuery: string): SearchResult[];
  drill(sessionId: string, resultId: string): DrillResult;
  close(sessionId: string): void;
}
```

- LRU cache: max 10 sessions
- TTL: 30 minutes from last access
- Thread-safe (single-process, but safe for concurrent MCP calls)

### Step 2: Drill capability

**File:** `src/_core/search/drill.ts` (NEW)

```typescript
interface DrillResult {
  // The expanded result with full context
  content: string;
  // Surrounding context (e.g., adjacent exchanges)
  before: string[];
  after: string[];
  // Related entities (if result links to graph)
  relatedEntities: EntitySummary[];
  // Suggested follow-up queries
  suggestions: string[];
}

export async function drillIntoResult(
  result: SearchResult,
  db: Database
): Promise<DrillResult>
```

**Drill behavior by result type:**
- **Episodic:** Return surrounding 10 exchanges (5 before, 5 after) from same conversation
- **Semantic:** Return the source conversation segment that generated this memory
- **Graph:** Return entity with full relationship neighborhood (depth 1)

### Step 3: MCP Tools

**File:** `src/interfaces/mcp/server.ts` — Add two new tools:

**`recall_session`** — Create or continue a search session
```
Parameters:
  - query: string (required) — Search query
  - session_id?: string — Existing session to refine (omit to create new)
  - budget?: number — Max token budget (default: 3000)
  - sources?: string[] — episodic, semantic, graph (default: all)
Returns:
  - session_id: string
  - results: SearchResult[] (new results from this step)
  - budget_remaining: number
  - result_count: number
```

**`recall_drill`** — Drill into a specific result
```
Parameters:
  - session_id: string (required)
  - result_index: number (required) — 0-based index into session results
Returns:
  - content: string — Full expanded content
  - context: { before: string[], after: string[] }
  - related_entities: EntitySummary[]
  - suggestions: string[] — Follow-up query suggestions
```

### Step 4: Shared interface layer

**File:** `src/interfaces/shared/search.ts` — Add functions:
- `createRecallSession(query, options)` — Wraps SessionStore.create + initial search
- `refineRecallSession(sessionId, query)` — Wraps SessionStore.refine
- `drillRecallResult(sessionId, resultIndex)` — Wraps drill.drillIntoResult

## Tests (Write FIRST — TDD)

**File:** `tests/core/session.test.ts` (NEW)

```
describe('SessionStore')
  ✓ creates session with unique ID
  ✓ retrieves session by ID
  ✓ returns null for non-existent session
  ✓ tracks refinements
  ✓ accumulates results across refinements
  ✓ tracks budget usage
  ✓ prevents exceeding max budget
  ✓ evicts oldest session when at capacity (10)
  ✓ expires sessions after TTL (30 min)
  ✓ updates lastAccessedAt on access
  ✓ close removes session

describe('drillIntoResult')
  ✓ episodic: returns surrounding exchanges
  ✓ semantic: returns source conversation segment
  ✓ graph: returns entity with relationships
  ✓ generates follow-up suggestions
  ✓ handles missing source gracefully

describe('MCP recall_session tool')
  ✓ creates new session when no session_id provided
  ✓ refines existing session when session_id provided
  ✓ returns error for invalid session_id
  ✓ respects budget parameter
  ✓ filters by sources parameter

describe('MCP recall_drill tool')
  ✓ returns expanded result for valid index
  ✓ returns error for invalid session_id
  ✓ returns error for out-of-range index
  ✓ includes context and related entities
```

**Contract tests:** `tests/contracts/recall-contract.test.ts` (NEW)

```
describe('existing recall tool unchanged')
  ✓ recall tool schema unchanged
  ✓ recall returns same format as before
  ✓ recall does not require session_id
```

## Validation

1. All existing tests pass (especially `tests/e2e/mcp-server.test.ts`)
2. New tests pass
3. `npm run build` succeeds
4. Interactive test: start MCP server, call recall_session, refine, drill

## Files Changed

| File | Action |
|------|--------|
| `src/_core/search/session.ts` | CREATE |
| `src/_core/search/drill.ts` | CREATE |
| `src/interfaces/mcp/server.ts` | MODIFY (add 2 tools) |
| `src/interfaces/shared/search.ts` | MODIFY (add session functions) |
| `tests/core/session.test.ts` | CREATE |
| `tests/contracts/recall-contract.test.ts` | CREATE |
