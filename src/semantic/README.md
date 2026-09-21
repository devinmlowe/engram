# Semantic

Extracts, consolidates, and retrieves structured knowledge from conversations — transforming raw exchanges into typed memories with deduplication, conflict detection, and decay.

## In Scope

- LLM-powered fact extraction with prompt templates
- Memory deduplication and conflict detection (NLI-based)
- Confidence scoring and FSRS-inspired decay
- Hybrid semantic search over memories
- Batch memory ingestion with entity linking
- Memory lifecycle: forget (soft delete + retention purge), edit, restore, purge-by-conversation, change log, extraction suppression, index integrity (#55)

## Out of Scope

- Raw conversation storage (see [episodic/](../episodic/))
- Entity/relationship graph management (see [graph/](../graph/))
- Search orchestration across layers (see [_core/search/](../_core/search/))

## Contains

- `extractor` — LLM-powered fact extraction with prompt templates
- `commitments` — Commitments ledger: extraction prompt/schema, due-date resolution, dedupe (lexical overlap or embedding cosine ≥ 0.85), store, lifecycle and XML for the `commitments` tools
- `consolidator` — Deduplication, merge, and conflict detection; applies model confidence and the transient policy at insert
- `collapse` — Intra-batch / intra-run near-duplicate collapse (normalised content, embedding cosine) before insert (W9a)
- `transient` — Regex classifier for transient status facts; short stability tier + importance cap (W9b)
- `memory` — Memory CRUD, similarity search, access tracking (reinforcement skips inactive/forgotten rows)
- `forget` — `forgetMemory` / `editMemory` / `restoreMemory` / `purgeConversation` / `purgeForgottenMemories` (#55): one-transaction soft delete that removes the vec0 + FTS5 rows at once, logs to `memory_changes`, records a `memory_suppressions` content hash (`contentHash` = sha256 of `normalizeContent`), and detaches the memory from relationship evidence (decrement `mention_count`, stamp `stale_since`, never delete — #57); `filterSuppressedFacts` / `clearSuppression` back dream extract and explicit remember; scope gate per #25
- `inspect` — Read-only listing (`listMemories`), full provenance (`getMemoryProvenance`: source exchanges + conversations, graph evidence, FSRS health, change log), `listMemoryChanges`, `resolveMemoryId` (unique 6+ char prefix)
- `index-integrity` — `auditMemoryIndex` / `repairMemoryIndex`: no vec/FTS rows for forgotten or missing memories (FTS enumerated through fts5vocab); behind `engram validate [--fix]`
- `search` — Hybrid vector + FTS5 search with RRF fusion; honors after/before on both candidate paths under a `filed` (created_at) or `event` (event_ts → earliest source exchange) basis
- `nli` — NLI contradiction detection via DeBERTa
- `decay` — FSRS-inspired retrievability decay and pruning
- `types` — Semantic-specific type definitions

## Key Interfaces

- `extractFacts(conversation) → ExtractionResult` — Extract structured knowledge from exchanges
- `searchSemantic(db, options) → LayerSearchResult[]` — Hybrid search over memories
- `forgetMemory(db, { memoryId, actor, hard?, readScopes?, scope? }) → ForgetResult` — Soft (or hard) delete with graph detachment and audit row
- `Memory` — Core type: a typed knowledge item with confidence, importance, and decay tracking

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [prompts/](../../prompts/) — LLM prompt templates used by extractor
- [tests/semantic/](../../tests/semantic/) — Test suite
