# Phase 6D: Batch Remember + Source Tracking — Detailed Implementation Plan

**Branch:** `phase-6-rlm` (worktree: `~/Documents/git/engram-phase-6-rlm`)
**Status:** READY
**Depends on:** Nothing (independent)

---

## Objective

Add batch memory ingestion and source tracking so RLM agents can store multiple findings in one call, with provenance tracking to distinguish user-created, dream-extracted, and RLM-generated memories.

## Current State

- `src/interfaces/mcp/server.ts:382-431` — `remember` tool: single memory at a time
- `src/interfaces/shared/remember.ts` — `storeMemory()` with dedup
- `src/semantic/memory.ts` — Memory CRUD operations
- Schema: `memories` table has no `source` column

## Implementation Steps

### Step 1: Schema migration — add `source` column

**File:** `src/_core/db/schema.ts` — Add to memories table:

```sql
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
```

Valid values: `'user'` | `'dream'` | `'rlm'` | `'import'`

**Migration approach:**
- Use engram's existing migration pattern
- Additive-only (ALTER TABLE ADD COLUMN)
- Default `'user'` preserves existing data semantics
- No existing data modified

### Step 2: Update memory types

**File:** `src/_core/types/index.ts`

```typescript
export type MemorySource = 'user' | 'dream' | 'rlm' | 'import';

// Update Memory interface
interface Memory {
  // existing fields...
  source: MemorySource;
}
```

### Step 3: Update memory operations

**File:** `src/semantic/memory.ts`

- `insertMemory()` — Accept optional `source` parameter (default: `'user'`)
- `getMemory()` / `searchMemories()` — Include `source` in returned data
- Add `source` filter to search queries (optional)

### Step 4: Update dream extractor

**File:** `src/semantic/extractor.ts`

- When dream pipeline extracts memories, set `source: 'dream'`
- No behavior change, just provenance tracking

### Step 5: Batch remember function

**File:** `src/interfaces/shared/remember.ts` — Add:

```typescript
interface BatchMemoryInput {
  content: string;
  type: MemoryType;
  importance?: number;
  source?: MemorySource;
}

interface BatchRememberResult {
  total: number;
  created: number;
  deduplicated: number;
  errors: number;
  details: Array<{
    index: number;
    status: 'created' | 'deduplicated' | 'error';
    id?: string;
    error?: string;
  }>;
}

export async function storeMemoryBatch(
  memories: BatchMemoryInput[],
  db: Database,
  embeddings: EmbeddingService
): Promise<BatchRememberResult>
```

**Behavior:**
- Process each memory through existing dedup pipeline
- Aggregate results
- Transaction wrapping (all-or-nothing per batch)
- Max batch size: 50 (safety cap)

### Step 6: MCP tool

**File:** `src/interfaces/mcp/server.ts` — Add new tool:

**`remember_batch`**
```
Parameters:
  - memories: Array<{ content: string, type: MemoryType, importance?: number, source?: MemorySource }>
    (required, max 50 items)
Returns:
  - total: number
  - created: number
  - deduplicated: number
  - errors: number
  - details: per-item status
```

### Step 7: Update existing `remember` tool

**File:** `src/interfaces/mcp/server.ts`

Add optional `source` parameter to existing `remember` tool. Default: `'user'`.

## Tests (Write FIRST — TDD)

**File:** `tests/semantic/batch-remember.test.ts` (NEW)

```
describe('storeMemoryBatch')
  ✓ stores multiple memories in one call
  ✓ deduplicates within the batch
  ✓ deduplicates against existing memories
  ✓ returns correct created/deduplicated counts
  ✓ handles mixed success/dedup results
  ✓ sets source field correctly
  ✓ defaults source to 'user' when not specified
  ✓ rejects batch larger than 50
  ✓ handles empty batch gracefully
  ✓ rolls back on transaction failure

describe('source tracking')
  ✓ insertMemory stores source field
  ✓ getMemory returns source field
  ✓ existing memories have source 'user' after migration
  ✓ dream extractor sets source 'dream'
  ✓ search can filter by source

describe('MCP remember_batch tool')
  ✓ accepts array of memories
  ✓ returns aggregate results
  ✓ validates memory types
  ✓ validates source values

describe('MCP remember tool (updated)')
  ✓ accepts optional source parameter
  ✓ defaults to 'user' when source not provided
  ✓ existing behavior unchanged without source param
```

**Contract tests:** `tests/contracts/remember-contract.test.ts` (NEW)

```
describe('existing remember tool backward compatible')
  ✓ remember tool accepts same parameters as before
  ✓ remember without source works identically to before
  ✓ stored memories retrievable via existing recall
```

## Validation

1. All existing tests pass
2. Schema migration applies cleanly
3. New tests pass
4. `npm run build` succeeds
5. Interactive test: batch remember 5 memories, verify in recall

## Files Changed

| File | Action |
|------|--------|
| `src/_core/db/schema.ts` | MODIFY (add migration) |
| `src/_core/types/index.ts` | MODIFY (add MemorySource type) |
| `src/semantic/memory.ts` | MODIFY (add source to operations) |
| `src/semantic/extractor.ts` | MODIFY (set source: 'dream') |
| `src/interfaces/shared/remember.ts` | MODIFY (add batch function) |
| `src/interfaces/mcp/server.ts` | MODIFY (add remember_batch, update remember) |
| `tests/semantic/batch-remember.test.ts` | CREATE |
| `tests/contracts/remember-contract.test.ts` | CREATE |
