# Engram Phase 7 Readiness Assessment

**Date:** 2026-02-26
**Assessor:** Automated codebase analysis + manual review
**Status:** Ready to begin Phase 7

---

## Executive Summary

Phases 0-6 are **substantially complete**. The system has:
- Episodic memory with hybrid search (vector + BM25 + RRF fusion)
- Semantic extraction with three-tier intelligence routing
- Knowledge graph with community detection, bridges, temporal patterns
- Dream state daemon with 5-phase pipeline and launchd integration
- Reflection & emergence with named communities, bridge scoring, and temporal analysis
- MCP server with 5 tools: recall, remember, show, explore, reflect
- 11 CLI commands covering the full lifecycle

Phase 7 (Optimization & Polish) has **4 critical gaps** and several minor ones.

---

## Phase Completion Status

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 0 | Project Setup | COMPLETE | DB schema, CLI scaffold, config |
| 1 | Episodic Foundation | COMPLETE | Sync, parse, embed, hybrid search |
| 2 | Data Migration | COMPLETE | Superpowers import, checkpointing |
| 3 | Semantic Extraction | COMPLETE | 3-tier LLM, NLI dedup, decay model |
| 4 | Knowledge Graph | COMPLETE | Entities, resolution, graphology analysis |
| 5 | Dream State Daemon | COMPLETE | 5-phase pipeline, Ollama, launchd |
| 6 | Reflection & Emergence | COMPLETE | Communities, bridges, temporal, reflect tool |
| 7 | Optimization & Polish | **NOT STARTED** | See gap analysis below |

---

## Phase 7 Gap Analysis

### Critical Gaps

#### 1. TypeScript Compilation Errors (22 errors)

- **4 module resolution failures**: `@anthropic-ai/sdk` and `graphology` packages missing type declarations
- **18 implicit `any` parameter errors**: Mostly in `analyzer.ts`, `intelligence.ts`, `extractor.ts`
- **Impact**: Blocks `npm run build`, which blocks distribution
- **Fix effort**: ~1 hour

#### 2. Cross-Encoder Reranking — NOT IMPLEMENTED

- Config flag `search.rerankEnabled: false` exists but no implementation
- Spec calls for `src/retrieval/reranker.ts` — directory doesn't exist
- Research recommends: `Xenova/bge-reranker-base` (278M params), ~50-150ms on Apple Silicon
- See: [docs/research/phase-7-optimization-patterns.md §1](docs/research/phase-7-optimization-patterns.md)
- **Fix effort**: ~4-6 hours

#### 3. Plugin Packaging — NOT IMPLEMENTED

- No `plugin.json`, no `.mcp.json`, no `mcp` CLI subcommand
- npm packaging incomplete (missing `files` field, `prepare` script)
- Research identified 3 strategies: npm MCP server, Claude Code plugin, hybrid
- See: [docs/research/claude-code-plugin-packaging.md](docs/research/claude-code-plugin-packaging.md)
- **Fix effort**: ~3-4 hours

#### 4. Documentation — MINIMAL

- No user guide, API reference, architecture guide, or troubleshooting
- Missing prompt templates: `summarize.md`, `reflect.md`
- No interface/endpoint documentation
- **Fix effort**: ~4-6 hours

### Minor Gaps

| Gap | Status | Effort |
|-----|--------|--------|
| Context budget tuning | Basic greedy exists, needs reranker integration | 2h |
| Performance caching | No query result caching, no embedding memoization | 2h |
| Missing `mcp` CLI subcommand | Required for `npx engram mcp` | 30min |
| Missing `health-check` command | Operational visibility | 30min |
| Missing prompt templates | `summarize.md`, `reflect.md` | 1h |
| Missing `src/retrieval/` module | Spec references dedicated retrieval layer | 4h |
| Dead code audit | Not yet performed | 1h |
| End-to-end test coverage | Integration tests exist but no full E2E | 3h |

---

## Current Test Status

- **471 tests passing** across 37 test suites
- **15 test files failing** — all due to worker timeout in `dream/intelligence.test.ts` (model loading)
- Test coverage spans: core, episodic (5), semantic (7), graph (12), dream (4), migration (2)
- No end-to-end test covering the full MCP → search → format pipeline

---

## Source File Inventory

### Implemented (34 files)
```
src/core/       config.ts, db.ts, types.ts
src/episodic/   embeddings.ts, parser.ts, search.ts, store.ts, sync.ts
src/semantic/   consolidator.ts, decay.ts, extractor.ts, memory.ts, nli.ts, search.ts, types.ts
src/graph/      analyzer.ts, entity.ts, extractor.ts, naming.ts, reflection.ts,
                relationship.ts, resolver.ts, search.ts, temporal.ts, types.ts
src/dream/      daemon.ts, intelligence.ts, scheduler.ts
src/mcp/        server.ts
src/cli/        index.ts
src/migration/  migrate.ts, types.ts, validate.ts
```

### Missing per Spec
```
src/retrieval/  recall.ts, reranker.ts, context.ts, placement.ts
```

### Prompt Templates
```
prompts/        extract-facts.md ✓, extract-entities.md ✓,
                extract-relationships.md ✓, resolve-conflict.md ✓
                summarize.md ✗, reflect.md ✗
```

---

## Dependency Status

All runtime dependencies installed. Type declaration issues:
- `@anthropic-ai/sdk` — needs `@types/` or SDK-bundled types
- `graphology` ecosystem — needs type stubs or `skipLibCheck`

---

## Research Artifacts

| Document | Path | Relevance |
|----------|------|-----------|
| Optimization patterns | [docs/research/phase-7-optimization-patterns.md](docs/research/phase-7-optimization-patterns.md) | Cross-encoder, context budgets, FSRS, evaluation |
| Plugin packaging | [docs/research/claude-code-plugin-packaging.md](docs/research/claude-code-plugin-packaging.md) | MCP config, npm packaging, plugin structure |
| Score normalization | [docs/research/score-normalization-strategies.md](docs/research/score-normalization-strategies.md) | RRF fusion scoring |
| Search quality eval | [docs/research/search-quality-evaluation.md](docs/research/search-quality-evaluation.md) | NDCG benchmarking |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| TS compilation blocks build/distribution | HIGH | Fix type annotations first |
| Reranker model download size (~500MB) | MEDIUM | Document first-run behavior, lazy load |
| Native deps (better-sqlite3, sqlite-vec) | MEDIUM | Document prebuild requirements |
| Test timeouts in CI | LOW | Increase vitest timeout for model-loading tests |
