# ADR-003: _core/ as Shared Infrastructure

**Status**: Accepted
**Date**: 2026-03-09

## Context

The original `core/` directory contained config, db, types, cache, and an OpenRouter client. Several cross-cutting services were misplaced in domain directories: embeddings in `episodic/`, RRF fusion in `episodic/search.ts`, LLM intelligence in `dream/`. SRC requires shared infrastructure in `_shared/` directories.

## Decision

Create `_core/` (instead of SRC's default `_shared/`) as the project-root shared infrastructure directory containing:

- `_core/config/` — System-wide configuration with env var overrides
- `_core/db/` — Database connection, schema, thin data access layer
- `_core/types/` — Cross-domain interface types only
- `_core/embeddings/` — Vector embedding pipeline (extracted from `episodic/`)
- `_core/search/` — Multi-source orchestration, RRF fusion, score normalization (extracted from `episodic/search.ts`)
- `_core/llm/` — Unified LLM client factory (extracted from `dream/intelligence.ts` + `core/openrouter.ts`)
- `_core/cache/` — Generic LRU cache utility

The underscore prefix preserves SRC's sort-to-top convention. The name `_core` better fits engram's vocabulary.

## Consequences

- Breaks circular dependency: episodic/search → semantic/search → episodic/embeddings
- Embeddings, search orchestration, and LLM access become explicit shared services
- Domain directories become pure domain logic — no cross-cutting infrastructure
- Each `_core/` module gets its own SPEC.md per SRC rules
- Dependency direction enforced: domains depend on `_core/`; `_core/` never depends on domains
