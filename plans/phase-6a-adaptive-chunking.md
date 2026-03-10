# Phase 6A: Adaptive Dream Extraction — Detailed Implementation Plan

**Branch:** `phase-6-rlm` (worktree: `~/Documents/git/engram-phase-6-rlm`)
**Status:** READY
**Depends on:** Nothing (independent)

---

## Objective

Replace engram's fixed 25-exchange chunking with an adaptive strategy that creates variable-sized chunks based on information density, improving fact extraction from dense conversation segments.

## Current State

- `src/_core/search/text.ts:19-48` — `chunkConversation()` does fixed 25-exchange windows with 5-exchange overlap
- `src/semantic/extractor.ts:41-47` — Config: `chunkSize: 25, chunkOverlap: 5, maxTurns: 100`
- `src/semantic/extractor.ts:472-539` — `extractFromConversation()` uses fixed chunker

## Implementation Steps

### Step 1: Create AdaptiveChunker module

**File:** `src/semantic/adaptive-chunker.ts` (NEW)

```typescript
interface DensityScore {
  index: number;
  score: number;         // 0-1 normalized density
  charCount: number;
  toolCallCount: number;
  codeBlockCount: number;
}

interface ChunkBoundary {
  start: number;
  end: number;
  avgDensity: number;
}

// Score each exchange by information density
export function scoreExchangeDensity(exchanges: Exchange[]): DensityScore[]

// Create variable-sized chunks: smaller for dense regions, larger for sparse
export function adaptiveChunk(
  exchanges: Exchange[],
  options?: {
    minChunkSize?: number;    // default: 10
    maxChunkSize?: number;    // default: 40
    densityThreshold?: number; // default: 0.6 — above = dense
    overlap?: number;          // default: 3
  }
): Exchange[][]
```

**Density scoring heuristic:**
- `charCount` weight: 0.3 (longer exchanges = more information)
- `toolCallCount` weight: 0.4 (tool usage = substantive work)
- `codeBlockCount` weight: 0.2 (code = technical content)
- `hasDecision` weight: 0.1 (contains decision-language markers)
- Normalize to [0, 1] within the conversation

**Chunk sizing logic:**
- Dense regions (score > threshold): use `minChunkSize` (10)
- Sparse regions (score < threshold): use `maxChunkSize` (40)
- Transition zones: interpolate between min and max
- Always maintain `overlap` exchanges between adjacent chunks

### Step 2: Add configuration option

**File:** `src/semantic/extractor.ts`

Add `chunkingStrategy` to extractor config:
```typescript
interface ExtractorConfig {
  // existing fields...
  chunkingStrategy: 'fixed' | 'adaptive';  // default: 'fixed'
}
```

### Step 3: Integrate into extraction pipeline

**File:** `src/semantic/extractor.ts`

In `extractFromConversation()`, branch on strategy:
```typescript
const chunks = config.chunkingStrategy === 'adaptive'
  ? adaptiveChunk(exchanges, { overlap: config.chunkOverlap })
  : chunkConversation(exchanges, config.chunkSize, config.chunkOverlap);
```

### Step 4: Add to main config

**File:** `src/_core/types/index.ts`

Add `chunkingStrategy` to the dream/extraction config section.

**File:** `src/_core/config/index.ts`

Default: `'fixed'` (backward compatible). Override via `ENGRAM_CHUNKING_STRATEGY=adaptive`.

## Tests (Write FIRST — TDD)

**File:** `tests/semantic/adaptive-chunker.test.ts` (NEW)

```
describe('scoreExchangeDensity')
  ✓ returns empty array for empty input
  ✓ scores single exchange correctly
  ✓ assigns higher scores to exchanges with tool calls
  ✓ assigns higher scores to exchanges with code blocks
  ✓ assigns higher scores to longer exchanges
  ✓ normalizes scores to [0, 1] range
  ✓ handles exchanges with no content gracefully

describe('adaptiveChunk')
  ✓ returns single chunk for short conversations (< minChunkSize)
  ✓ creates smaller chunks for dense regions
  ✓ creates larger chunks for sparse regions
  ✓ maintains overlap between adjacent chunks
  ✓ all exchanges are covered (no gaps)
  ✓ respects minChunkSize boundary
  ✓ respects maxChunkSize boundary
  ✓ handles uniformly dense conversations (all small chunks)
  ✓ handles uniformly sparse conversations (all large chunks)
  ✓ handles alternating dense/sparse regions
  ✓ matches fixed chunking behavior when all scores are equal

describe('integration with extractor')
  ✓ fixed strategy uses chunkConversation
  ✓ adaptive strategy uses adaptiveChunk
  ✓ default strategy is fixed (backward compatible)
  ✓ adaptive produces >= as many chunks for mixed-density conversations
```

## Contract Tests

**File:** `tests/contracts/chunking-contract.test.ts` (NEW)

```
describe('chunkConversation backward compatibility')
  ✓ chunkConversation signature unchanged
  ✓ chunkConversation(100 exchanges) produces same output as before
  ✓ chunkConversation(50 exchanges, 25, 5) produces same output as before
```

## Validation

1. All existing tests pass
2. New tests pass
3. `npm run build` succeeds
4. Run dream extract on a test conversation with both strategies, compare fact counts

## Files Changed

| File | Action |
|------|--------|
| `src/semantic/adaptive-chunker.ts` | CREATE |
| `src/semantic/extractor.ts` | MODIFY (add strategy branching) |
| `src/_core/types/index.ts` | MODIFY (add config field) |
| `src/_core/config/index.ts` | MODIFY (add default) |
| `tests/semantic/adaptive-chunker.test.ts` | CREATE |
| `tests/contracts/chunking-contract.test.ts` | CREATE |
