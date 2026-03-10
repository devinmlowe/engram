---
module: types
level: L2
derives-from: ../SPEC.md
status: draft
verified-by: ../../../tests/core/types.test.ts
decision-log:
  - ../../../decisions/007-hybrid-type-ownership.md
---

# Types

Cross-domain interface types that multiple domains depend on. Only types that cross domain boundaries live here — domain-internal types are owned by their respective domains.

## Requirements

- **REQ-1**: The module shall define shared search types: `SearchOptions`, `SearchResult`, `LayerSearchResult`, `RecallResponse`, `SearchMode`, `SearchSource`. *(traces to ADR-006, ADR-007)*
- **REQ-2**: The module shall define the system configuration type: `EngramConfig`, `RerankerConfig`. *(traces to ADR-007)*

## Interface Contract

### Invariants

- **INV-1**: Types here shall be interface-only — no implementations, no runtime code.
- **INV-2**: Adding a field to a shared type requires coordination with all consuming domains.
- **INV-3**: Domain-specific types (`Memory`, `Entity`, `Exchange`, etc.) shall not be defined here.
