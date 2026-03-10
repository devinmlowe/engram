# Decisions

Architecture Decision Records (ADRs) — documents that capture significant design choices, their context, and rationale.

## In Scope

- Structural and architectural decisions that affect multiple modules
- Technology selection choices with evaluated alternatives
- Cross-cutting conventions (naming, typing, data access patterns)

## Out of Scope

- Implementation details within a single module (those belong in domain SPECs)
- Phase-specific planning (see [plans/](../plans/))
- Research findings without a decision outcome (see [docs/research/](../docs/research/))

## Contains

| ADR | Decision |
|-----|----------|
| [001](./001-target-architecture.md) | Target architecture — domain-separated, SRC-compliant |
| [002](./002-llm-agnostic.md) | LLM-agnostic design — no coupling to specific providers |
| [003](./003-core-shared-infrastructure.md) | Shared `_core/` infrastructure pattern |
| [004](./004-thin-data-access-layer.md) | Thin data access layer — direct SQLite, no ORM |
| [005](./005-unified-llm-factory.md) | Unified LLM factory with tiered provider cascade |
| [006](./006-shared-search-contract.md) | Shared search contract across all memory layers |
| [007](./007-hybrid-type-ownership.md) | Hybrid type ownership — core types vs domain-specific |
| [008](./008-parameter-naming.md) | Parameter naming conventions (snake_case MCP, camelCase internal) |

## See Also

- [SPEC.md](../SPEC.md) — references decisions in frontmatter `decision-log`
- Domain SPECs — each links to relevant ADRs in their frontmatter
