# ADR-006: Shared Search Contract

**Status**: Accepted
**Date**: 2026-03-09

## Context

Three domains (episodic, semantic, graph) implement search with the same algorithm (vector + FTS5 → RRF fusion) but return different result shapes. `searchMultiSource()` in `episodic/search.ts` orchestrates across all three but lives in the wrong domain and imports from 4 modules.

## Decision

Establish a **shared search contract** in `_core/search/`:

- `LayerSearchResult` — uniform result type all domains implement (id, source, score, content, tokenEstimate, metadata)
- Each domain exports a `search(query, options) → LayerSearchResult[]` function conforming to this contract
- `searchMultiSource()` moves to `_core/search/` as the orchestrator
- RRF fusion and score normalization live alongside the orchestrator as shared utilities

Domain-specific rich types (full `Memory`, full `Entity`) are accessed via domain-specific `getById` calls, not through search results.

## Consequences

- Consistent search result shape across all layers (resolves issue #11)
- Multi-source orchestration no longer violates episodic domain boundary (resolves issue #1)
- New search sources can be added by implementing `LayerSearchResult` contract
- `metadata: Record<string, unknown>` provides extensibility without coupling
- Token budget enforcement happens once in the orchestrator, not per-domain
