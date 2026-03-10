# SRC Migration Analysis: Engram Repository

**Date:** 2026-03-09
**Status:** Research / Actionable Recommendations

---

## Executive Summary

Engram has strong natural module boundaries that align well with SRC's vertical-slice philosophy. The current `src/<module>/` structure maps almost directly to SRC domains and features. The primary work is **documentation scaffolding** (SPEC.md + README.md at each level) and **restructuring the flat `src/` layout** into SRC's hierarchical domain model. Code changes are minimal — this is largely a reorganization and documentation effort.

**Current SRC Maturity (self-assessed against 5 dimensions):**

| Dimension | Status | Notes |
|-----------|--------|-------|
| Document Structure | Not Started | Root SPEC.md exists but doesn't follow SRC format. No per-module SPEC.md/README.md |
| Size Discipline | Not Started | Root SPEC.md is ~65KB (far exceeds 2K token limit) |
| Navigation Integrity | Not Started | No bidirectional linking, no `derives-from` chains |
| Requirement Traceability | Not Started | No REQ-N identifiers, no verification tables |
| Architecture Compliance | Partial | Natural depth is L0→L1→L2 (fits within L3 max) |

---

## Current Structure vs. SRC Target

### Current Layout (Horizontal Layers)

```
engram/
├── SPEC.md              # Monolithic 65KB spec (not SRC-compliant)
├── src/
│   ├── cli/             # CLI entry point
│   ├── core/            # Shared: config, db, types, cache, openrouter
│   ├── episodic/        # Domain: raw conversation storage & search
│   ├── semantic/        # Domain: fact extraction & knowledge management
│   ├── graph/           # Domain: entity relationships & analysis
│   ├── dream/           # Feature: autonomous consolidation pipeline
│   ├── retrieval/       # Feature: context engineering & reranking
│   ├── migration/       # Feature: legacy data migration
│   ├── mcp/             # Interface: MCP protocol server
│   └── web/             # Interface: visualization server
├── tests/               # Mirrors src/ structure
├── docs/                # Flat docs + research + plans
├── prompts/             # LLM prompt templates
├── scripts/             # Shell utilities
└── launchd/             # macOS daemon plists
```

### Proposed SRC Layout

```
engram/
├── SPEC.md                          # L0: System-level (≤2K tokens)
├── README.md                        # L0: Agent routing
├── decisions/                       # ADRs (required by SRC)
│   ├── 001-three-layer-memory.md
│   ├── 002-sqlite-single-db.md
│   ├── 003-tiered-llm-fallback.md
│   ├── 004-rrf-search-fusion.md
│   ├── 005-fsrs-memory-decay.md
│   └── 006-src-migration.md
│
├── _shared/                         # Cross-cutting modules
│   ├── core/                        # L2: config, db, types, cache
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # config.ts, db.ts, types.ts, cache.ts
│   │   └── tests/                   # cache.test.ts, db.test.ts
│   ├── llm/                         # L2: LLM client (openrouter + intelligence)
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # openrouter.ts, intelligence.ts
│   │   └── tests/                   # intelligence.test.ts
│   ├── embeddings/                  # L2: local embedding generation
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # embeddings.ts
│   │   └── tests/                   # embeddings.test.ts
│   └── prompts/                     # L2: LLM prompt templates
│       ├── SPEC.md
│       ├── README.md
│       └── src/                     # *.md prompt files
│
├── episodic/                        # L1: Episodic memory domain
│   ├── SPEC.md
│   ├── README.md
│   ├── ingestion/                   # L2: Parse & sync conversations
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # parser.ts, sync.ts, store.ts
│   │   └── tests/                   # parser.test.ts, sync.test.ts, store.test.ts
│   └── search/                      # L2: Episodic search
│       ├── SPEC.md
│       ├── README.md
│       ├── src/                     # search.ts
│       └── tests/                   # search.test.ts
│
├── semantic/                        # L1: Semantic knowledge domain
│   ├── SPEC.md
│   ├── README.md
│   ├── _shared/
│   │   └── types/                   # L3: Semantic type definitions
│   │       ├── SPEC.md
│   │       ├── README.md
│   │       └── src/                 # types.ts
│   ├── extraction/                  # L2: Fact extraction from exchanges
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # extractor.ts
│   │   └── tests/                   # extractor.test.ts
│   ├── consolidation/               # L2: Dedup, merge, conflict resolution
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # consolidator.ts, nli.ts
│   │   └── tests/                   # consolidator.test.ts, nli.test.ts
│   ├── lifecycle/                   # L2: Decay, pruning, health
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # decay.ts, memory.ts
│   │   └── tests/                   # decay.test.ts, memory.test.ts
│   └── search/                      # L2: Semantic search
│       ├── SPEC.md
│       ├── README.md
│       ├── src/                     # search.ts
│       └── tests/                   # search.test.ts
│
├── graph/                           # L1: Knowledge graph domain
│   ├── SPEC.md
│   ├── README.md
│   ├── _shared/
│   │   └── types/                   # L3: Graph type definitions
│   │       ├── SPEC.md
│   │       ├── README.md
│   │       └── src/                 # types.ts
│   ├── extraction/                  # L2: Entity & relationship extraction
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # extractor.ts, naming.ts
│   │   └── tests/                   # extractor.test.ts, naming.test.ts
│   ├── resolution/                  # L2: Entity resolution & dedup
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # entity.ts, relationship.ts, resolver.ts
│   │   └── tests/                   # entity.test.ts, relationship.test.ts, resolver.test.ts
│   ├── analysis/                    # L2: Graph metrics, communities, temporal
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # analyzer.ts, reflection.ts, temporal.ts
│   │   └── tests/                   # analyzer.test.ts, reflection.test.ts, temporal.test.ts
│   └── search/                      # L2: Graph search & explore
│       ├── SPEC.md
│       ├── README.md
│       ├── src/                     # search.ts
│       └── tests/                   # search.test.ts, search-integration.test.ts
│
├── dream/                           # L1: Dream pipeline domain
│   ├── SPEC.md
│   ├── README.md
│   ├── orchestration/               # L2: Pipeline daemon & scheduling
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # daemon.ts, scheduler.ts
│   │   └── tests/                   # daemon.test.ts, scheduler.test.ts
│   └── deployment/                  # L2: launchd plists & install scripts
│       ├── SPEC.md
│       ├── README.md
│       └── src/                     # *.plist, install-daemon.sh, compact-dream.sh
│
├── retrieval/                       # L1: Query & retrieval domain
│   ├── SPEC.md
│   ├── README.md
│   ├── context/                     # L2: Budget allocation & formatting
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # context.ts
│   │   └── tests/                   # context.test.ts
│   └── reranking/                   # L2: Cross-encoder reranking
│       ├── SPEC.md
│       ├── README.md
│       ├── src/                     # reranker.ts
│       └── tests/                   # reranker.test.ts
│
├── interfaces/                      # L1: External interface domain
│   ├── SPEC.md
│   ├── README.md
│   ├── cli/                         # L2: CLI entry point
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # index.ts
│   │   └── tests/
│   ├── mcp/                         # L2: MCP protocol server
│   │   ├── SPEC.md
│   │   ├── README.md
│   │   ├── src/                     # server.ts
│   │   └── tests/                   # mcp-server.test.ts
│   └── web/                         # L2: Visualization server
│       ├── SPEC.md
│       ├── README.md
│       ├── src/                     # graph-server.ts
│       └── tests/
│
├── migration/                       # L1: Data migration domain
│   ├── SPEC.md
│   ├── README.md
│   ├── src/                         # migrate.ts, validate.ts, types.ts
│   └── tests/                       # migrate.test.ts, validate.test.ts
│
└── docs/                            # Non-SRC: research, plans (reference only)
    ├── architecture.md
    ├── user-guide.md
    └── research/
```

---

## Gap Analysis: What Needs to Change

### 1. Root SPEC.md — Rewrite Required

**Current:** 65KB monolithic specification covering everything from architecture to database schemas.

**Target:** ≤2,000 token L0 SPEC.md with:
- YAML frontmatter (module, level, status, verified-by)
- Purpose (1-3 sentences)
- Requirements (REQ-N "shall" statements for system-level behavior)
- Interface Contract (PRE/POST/INV for the system boundary — MCP tools)
- Verification table
- Decomposes Into (links to L1 domains)
- Dependencies (links to `_shared/`)

**Action:** Extract the current SPEC.md content into domain-level specs and the `decisions/` directory. The root spec becomes a thin routing document.

### 2. Root README.md — Create New

**Current:** Does not exist.

**Target:** ≤500 token agent routing file answering "what is this / should I look here / where next."

### 3. decisions/ Directory — Create with Retroactive ADRs

**Current:** Architectural decisions are embedded in SPEC.md prose and docs/research/.

**Target:** Extract key decisions into Nygard-format ADRs:

| ADR | Source | Decision |
|-----|--------|----------|
| 001-three-layer-memory | SPEC.md | Episodic/Semantic/Graph separation |
| 002-sqlite-single-db | SPEC.md, research/knowledge-graph-sqlite-implementation.md | Single SQLite DB with FTS5+vec0 |
| 003-tiered-llm-fallback | research/dream-cycle-model-selection.md | Ollama→OpenRouter→Anthropic cascade |
| 004-rrf-search-fusion | research/search-quality-evaluation.md | Reciprocal Rank Fusion for multi-source |
| 005-fsrs-memory-decay | SPEC.md | FSRS-inspired spaced repetition decay |
| 006-prompt-template-separation | Current practice | Prompt files in prompts/ directory |

### 4. Per-Module SPEC.md + README.md — 40+ Files to Create

Every L1-L3 module needs two documents. Estimated count:

| Level | Count | Documents |
|-------|-------|-----------|
| L0 (root) | 1 | 2 (SPEC + README) |
| L1 (domains) | 7 | 14 |
| L2 (features) | ~18 | 36 |
| L3 (components) | ~3 | 6 |
| **Total** | | **~58 documents** |

### 5. Import Path Updates — TypeScript Configuration

Moving files from `src/<module>/file.ts` to `<domain>/<feature>/src/file.ts` requires:
- tsconfig.json `paths` aliases or `baseUrl` adjustment
- Update all import statements across 38 source files
- Update test imports across 37 test files
- Update `package.json` main/bin paths
- Update build output in `dist/`

**This is the highest-risk change.** Consider path aliases to minimize import churn.

### 6. Existing SPEC.md Content Redistribution

The current 65KB SPEC.md contains valuable content that maps to SRC locations:

| Current Section | Target Location |
|----------------|-----------------|
| Vision, Architecture Overview | Root SPEC.md Purpose section |
| Phase descriptions | decisions/ ADRs or domain SPEC.md sections |
| Database Schema | `_shared/core/SPEC.md` Interface Contract |
| Episodic Layer details | `episodic/SPEC.md` |
| Semantic Layer details | `semantic/SPEC.md` |
| Knowledge Graph details | `graph/SPEC.md` |
| Dream State details | `dream/SPEC.md` |
| MCP Server tools | `interfaces/mcp/SPEC.md` |
| Search/Retrieval details | `retrieval/SPEC.md` |
| Score normalization | `retrieval/reranking/SPEC.md` |

---

## Migration Strategy

### Approach: Incremental, Documentation-First

SRC migration does NOT require a big-bang restructure. The spec explicitly supports incremental adoption via its maturity model. Recommended phased approach:

### Phase 1: Documentation Layer (No Code Changes)

**Effort:** Medium | **Risk:** None | **Value:** High

1. Create `decisions/` directory with retroactive ADRs
2. Rewrite root `SPEC.md` to SRC L0 format (≤2K tokens)
3. Preserve current SPEC.md as `docs/architecture.md` (or rename existing)
4. Create root `README.md` as agent routing file
5. Create SPEC.md + README.md for each `src/<module>/` directory *in place*
   - These documents describe the current flat structure
   - No file moves required yet

**Outcome:** SRC Document Structure dimension moves to "Partial." Agent navigation improves immediately.

### Phase 2: Requirement Traceability (No Code Changes)

**Effort:** Medium | **Risk:** None | **Value:** Medium

1. Add REQ-N identifiers to all SPEC.md files
2. Add `derives-from` frontmatter linking child→parent
3. Add `Decomposes Into` sections linking parent→child
4. Add verification tables mapping REQ→test file
5. Validate bidirectional link integrity

**Outcome:** Navigation Integrity and Requirement Traceability dimensions move to "Complete."

### Phase 3: Physical Restructure (Code Changes)

**Effort:** High | **Risk:** Medium | **Value:** Medium

This phase physically moves source files into the SRC hierarchy. **Only do this if the documentation-only approach proves insufficient for agent navigation.**

1. Set up TypeScript path aliases in tsconfig.json
2. Move source files into domain/feature/src/ structure
3. Move test files into domain/feature/tests/ structure
4. Update all imports
5. Verify build + all tests pass
6. Update package.json entry points

**Risk mitigation:**
- Do this on a feature branch with a full test run before and after
- Use a codemod script to automate import rewrites
- Keep `src/` as a re-export barrel during transition

### Phase 4: Enforcement (Tooling)

**Effort:** Low | **Risk:** None | **Value:** Low-Medium

1. Add SRC lint script to package.json
2. Run 8 enforcement checks in CI
3. Add token budget checking for SPEC.md/README.md files

---

## Key Design Decisions for Migration

### Decision 1: Where Do Interfaces Live?

**Option A:** `interfaces/` domain containing cli/, mcp/, web/ (proposed above)
**Option B:** Keep cli/, mcp/, web/ as top-level domains

**Recommendation:** Option A. These are presentation layers that compose the core domains. Grouping them signals "these are entry points, not core logic."

### Decision 2: Where Does `dream/intelligence.ts` Live?

Currently in `dream/`, but it's a general-purpose LLM provider selection layer used by the dream pipeline.

**Recommendation:** Move to `_shared/llm/` alongside `openrouter.ts`. Both are LLM client abstractions.

### Decision 3: Where Do Prompts Live?

**Option A:** `_shared/prompts/` (proposed above)
**Option B:** Colocate with consuming modules (e.g., `semantic/extraction/src/extract-facts.md`)

**Recommendation:** Option A for now (mirrors current layout). Option B is more SRC-idiomatic but increases file moves.

### Decision 4: Physical Restructure vs. Documentation-Only?

The SRC spec is designed to work as a documentation overlay on existing code. The SPEC.md `verified-by` field can point to `../../tests/<module>/` regardless of physical layout.

**Recommendation:** Start with Phase 1-2 (documentation-only). Evaluate whether physical restructure adds enough value to justify the import churn. For a single-developer project with 38 source files, the flat `src/` layout may be navigable enough with good SPEC.md routing.

### Decision 5: What Happens to docs/?

SRC doesn't have a `docs/` convention — documentation lives in SPEC.md files distributed through the tree. However, research artifacts and implementation plans don't fit the SPEC.md format.

**Recommendation:** Keep `docs/` for non-specification content (research, plans, guides). Add a note in root README.md routing to it.

---

## Estimated Effort

| Phase | Files Created | Files Modified | Estimated Work |
|-------|--------------|----------------|----------------|
| Phase 1: Documentation | ~30 new SPEC/README | 1 (root SPEC.md) | 1 focused session |
| Phase 2: Traceability | 0 new | ~30 (add frontmatter + links) | 1 focused session |
| Phase 3: Restructure | 0 new | ~75 (imports) | 2-3 sessions |
| Phase 4: Enforcement | 1-2 scripts | 1 (package.json) | 1 quick session |

**Recommended starting point:** Phase 1 only. It delivers immediate value with zero risk.

---

## Appendix: Module Dependency Map

```
Dependency direction: features → _shared (never reverse)

_shared/core ← ALL modules (config, db, types)
_shared/llm ← semantic/extraction, graph/extraction, dream/orchestration
_shared/embeddings ← episodic/ingestion, semantic/lifecycle, graph/search

episodic → _shared/core, _shared/embeddings
semantic → _shared/core, _shared/embeddings, _shared/llm
graph → _shared/core, _shared/embeddings, _shared/llm
dream → episodic, semantic, graph, _shared/llm
retrieval → episodic, semantic, graph (read-only search composition)
interfaces → ALL domains (thin wrappers)
migration → _shared/core (DB schema only)
```

This dependency graph is **SRC-compliant**: features depend on `_shared/`, never the reverse. Cross-domain dependencies (dream → episodic/semantic/graph) are acceptable as dream is an orchestration domain.

---

## Appendix: Current SPEC.md Content Worth Preserving

The existing 65KB SPEC.md contains specification-grade content that should be redistributed, not discarded:

- **Database schema DDL** → `_shared/core/SPEC.md` Interface Contract
- **MCP tool definitions** → `interfaces/mcp/SPEC.md` Interface Contract
- **Dream phase descriptions** → `dream/orchestration/SPEC.md` Requirements
- **Score normalization math** → `retrieval/reranking/SPEC.md` or a decision ADR
- **Embedding model selection** → `decisions/NNN-embedding-model.md`
- **Phase implementation notes** → `docs/plans/` (already there)
