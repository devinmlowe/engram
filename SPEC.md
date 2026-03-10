---
module: engram
level: L0
status: draft
verified-by: ./tests/
decision-log:
  - ./decisions/001-target-architecture.md
  - ./decisions/002-llm-agnostic.md
  - ./decisions/003-core-shared-infrastructure.md
  - ./decisions/004-thin-data-access-layer.md
  - ./decisions/005-unified-llm-factory.md
  - ./decisions/006-shared-search-contract.md
  - ./decisions/007-hybrid-type-ownership.md
---

# Engram

Engram is a local-first cognitive memory system that ingests LLM agent conversation history and consolidates it into structured knowledge graphs via autonomous "dream state" processing, mimicking human synthesis of skills and knowledge. Retrieved and synthesized information is available via a hybrid search engine optimized for LLM context budgets.

## Requirements

- **REQ-1**: The system shall ingest conversation archives and index exchanges with vector embeddings.
- **REQ-2**: The system shall extract structured knowledge (facts, decisions, patterns, entities, relationships) from conversations via LLM processing.
- **REQ-3**: The system shall maintain a knowledge graph of entities and their typed relationships.
- **REQ-4**: The system shall serve hybrid search (vector + full-text + graph traversal) across all memory layers within a caller-specified token budget.
- **REQ-5**: The system shall run autonomous consolidation ("dream") pipelines that ingest, extract, consolidate, reflect, and prune.
- **REQ-6**: The system shall expose memory operations via MCP server, optimized for LLM consumption.
- **REQ-7**: The system shall expose memory operations via CLI for direct user interaction.
- **REQ-8**: The system shall enforce token budgets on all search responses.
- **REQ-9**: The system shall decay and prune low-value memories based on configurable type-specific rates.
- **REQ-10**: The system shall detect and track conflicts between contradictory memories.

## Interface Contract

### Preconditions

- **PRE-1**: SQLite database shall be initialized with the engram schema.
- **PRE-2**: At least one embedding model shall be available (local nomic-embed-text or fallback MiniLM).
- **PRE-3**: Conversation archives shall exist at the configured path.
- **PRE-4**: At least one LLM provider shall be reachable for extraction operations (Ollama, OpenRouter, or Anthropic API).

### Postconditions

- **POST-1**: All writes shall be transactional (atomic commit or full rollback).
- **POST-2**: Search responses shall not exceed the caller-specified token budget.
- **POST-3**: Dream pipeline runs shall produce a DreamReport with per-phase metrics.

### Invariants

- **INV-1**: The system shall not modify source conversation archives.
- **INV-2**: All persistent state shall reside in a single SQLite database file.
- **INV-3**: The system shall operate without cloud dependencies when a local LLM is available.
- **INV-4**: The system shall be agent/model agnostic — not coupled to any specific LLM provider or coding agent.

## Decomposes Into

- [Episodic](./src/episodic/SPEC.md) — Conversation archive ingestion, indexing, and episodic search
- [Semantic](./src/semantic/SPEC.md) — Knowledge extraction, consolidation, and semantic search
- [Graph](./src/graph/SPEC.md) — Entity/relationship graph, topic clusters, and graph search
- [Dream](./src/dream/SPEC.md) — Autonomous consolidation pipeline: scheduling, orchestration, decay
- [Interfaces](./src/interfaces/SPEC.md) — CLI, MCP server, and web interface

## Dependencies

- [_core/config](`./src/_core/config/SPEC.md`) — System-wide configuration with env var overrides
- [_core/db](`./src/_core/db/SPEC.md`) — Database connection, schema, thin data access layer
- [_core/types](`./src/_core/types/SPEC.md`) — Cross-domain interface types (SearchResult, SearchOptions, EngramConfig)
- [_core/embeddings](`./src/_core/embeddings/SPEC.md`) — Vector embedding pipeline (model init, encode, cache)
- [_core/search](`./src/_core/search/SPEC.md`) — Multi-source search orchestration, RRF fusion, score normalization
- [_core/llm](`./src/_core/llm/SPEC.md`) — Unified LLM client factory with tiered provider cascade
- [_core/cache](`./src/_core/cache/SPEC.md`) — Generic LRU cache utility

## Verification

| ID | Method | Location |
|----|--------|----------|
| REQ-1 | Integration test | `./tests/episodic/` |
| REQ-2 | Integration test | `./tests/semantic/` |
| REQ-3 | Integration test | `./tests/graph/` |
| REQ-4 | Integration test | `./tests/search/` |
| REQ-5 | Integration test | `./tests/dream/` |
| REQ-6 | Integration test | `./tests/mcp/` |
| REQ-7 | Integration test | `./tests/cli/` |
| REQ-8 | Unit test | `./tests/search/budget.test.ts` |
| REQ-9 | Unit test | `./tests/dream/decay.test.ts` |
| REQ-10 | Unit test | `./tests/semantic/conflict.test.ts` |
| PRE-1 | Integration test | `./tests/core/db.test.ts` |
| POST-1 | Integration test | `./tests/core/db.test.ts` |
| POST-2 | Unit test | `./tests/search/budget.test.ts` |
| INV-2 | Architecture test | `./tests/invariants.test.ts` |
