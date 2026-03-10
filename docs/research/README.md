# Research

Research surveys, technology evaluations, and analysis documents that informed design decisions and implementation approaches. These are reference material — decisions derived from this research are captured in [decisions/](../../decisions/).

## In Scope

- Technology surveys and comparisons (models, libraries, algorithms)
- Production system analysis (Mem0, Zep/Graphiti, LangMem, etc.)
- Codebase readiness assessments for upcoming phases
- Benchmark results and evaluation metrics

## Out of Scope

- Final decisions (see [decisions/](../../decisions/))
- Implementation steps (see [docs/plans/](../plans/))
- User-facing documentation (see [docs/](../))

## Contains

### Core Architecture
- [memory-architectures-schemas.md](./memory-architectures-schemas.md) — Memory system comparisons and schema design
- [sqlite-bulk-operations.md](./sqlite-bulk-operations.md) — SQLite performance patterns
- [score-normalization-strategies.md](./score-normalization-strategies.md) — RRF score normalization approaches
- [src-migration-analysis.md](./src-migration-analysis.md) — SRC compliance migration analysis

### Semantic Layer
- [semantic-extraction-techniques.md](./semantic-extraction-techniques.md) — Fact extraction patterns from production systems
- [deduplication-conflict-detection.md](./deduplication-conflict-detection.md) — Dedup thresholds, NLI, conflict resolution
- [local-inference-nli-models.md](./local-inference-nli-models.md) — Local NLI model options and hybrid routing
- [data-migration-strategy.md](./data-migration-strategy.md) — Superpowers DB migration analysis
- [search-quality-evaluation.md](./search-quality-evaluation.md) — NDCG metrics and search quality

### Knowledge Graph
- [entity-extraction-knowledge-graphs.md](./entity-extraction-knowledge-graphs.md) — Entity/relationship extraction patterns
- [knowledge-graph-sqlite-implementation.md](./knowledge-graph-sqlite-implementation.md) — Graph storage in SQLite
- [graph-analysis-research.md](./graph-analysis-research.md) — Community detection, centrality, graphology

### Dream Pipeline
- [memory-consolidation-pipelines.md](./memory-consolidation-pipelines.md) — Consolidation pipeline patterns
- [checkpoint-resume-patterns.md](./checkpoint-resume-patterns.md) — Pipeline checkpointing approaches
- [daemon-launchd-patterns.md](./daemon-launchd-patterns.md) — macOS launchd daemon patterns
- [mlx-local-llm-integration.md](./mlx-local-llm-integration.md) — Local LLM options (MLX, Ollama)
- [dream-cycle-model-selection.md](./dream-cycle-model-selection.md) — Model selection for dream processing
- [dream-cycle-openrouter-results.md](./dream-cycle-openrouter-results.md) — OpenRouter evaluation results

### Phase Readiness
- [phase-5-codebase-readiness.md](./phase-5-codebase-readiness.md) — Dream daemon readiness
- [phase-6-codebase-readiness.md](./phase-6-codebase-readiness.md) — RLM integration readiness
- [phase-6-emergence-patterns.md](./phase-6-emergence-patterns.md) — Emergence pattern research
- [phase-6-temporal-and-tooling.md](./phase-6-temporal-and-tooling.md) — Temporal analysis and tooling
- [phase-7-optimization-patterns.md](./phase-7-optimization-patterns.md) — Reranking, caching, budgets

### Plugin & Distribution
- [claude-code-plugin-packaging.md](./claude-code-plugin-packaging.md) — Plugin packaging and MCP distribution

## See Also

- [decisions/](../../decisions/) — Decisions derived from this research
- [SPEC-legacy.md](../../SPEC-legacy.md) — Original vision document with inline research references
