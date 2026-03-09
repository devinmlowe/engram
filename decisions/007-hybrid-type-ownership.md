# ADR-007: Hybrid Type Ownership

**Status**: Accepted
**Date**: 2026-03-09

## Context

`core/types.ts` contains 21 types spanning all domains. `semantic/types.ts` adds 4 and `graph/types.ts` adds 8. The monolithic type file creates coupling — every domain imports from core even for domain-internal types.

## Decision

Adopt **hybrid type ownership**:

- `_core/types/` owns only cross-domain interface types: `SearchResult`, `SearchOptions`, `RecallResponse`, `EngramConfig`, `SearchMode`, `SearchSource`, `RerankerConfig`
- Each domain owns its internal types:
  - **episodic**: `Exchange`, `Conversation`, `ToolCall`
  - **semantic**: `Memory`, `MemoryType`, `Conflict`
  - **graph**: `Entity`, `EntityType`, `Relationship`, `RelationshipType`, `TopicCluster`
  - **dream**: `DreamPhase`, `DreamProgress`, `DreamReport`
- Domains export their types for consumers but own the definitions

## Consequences

- `core/types.ts` is split — domain types move to their domains, cross-cutting types to `_core/types/`
- Domains can evolve their internal types without touching shared code
- Import paths become semantically meaningful (import `Memory` from semantic, not core)
- Cross-domain interfaces are the only types that require coordination to change
