# Types

Cross-domain interface types shared across all modules. Core types live here; domain-specific types stay in their respective modules.

## In Scope

- Search interfaces (`SearchOptions`, `LayerSearchResult`, `RecallResponse`)
- Configuration types (`EngramConfig`)
- Common result types used across module boundaries

## Out of Scope

- Domain-specific types (each domain owns its internal types)
- Runtime validation (types are compile-time only)

## Contains

- `index.ts` — All shared type definitions and interfaces

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/007-hybrid-type-ownership.md](../../../decisions/007-hybrid-type-ownership.md) — Type ownership strategy
- [_core/](../) — Parent shared infrastructure
