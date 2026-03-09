# ADR-008: Parameter Naming Convention

**Status:** Accepted
**Date:** 2026-03-09
**Context:** Phase 3 unify-interfaces refactor

## Context

The engram codebase has two user-facing interfaces — CLI (Commander) and MCP server — that accept parameters with different naming conventions:

- **CLI**: Uses camelCase (TypeScript/JavaScript convention), e.g., `--dry-run` maps to `opts.dryRun`
- **MCP**: Uses snake_case (MCP protocol convention), e.g., `relationship_types`, `source_exchanges`

During Phase 3, shared operations were extracted to `src/interfaces/shared/` to eliminate duplicated business logic between CLI and MCP. This required deciding on a canonical parameter naming convention for the shared layer.

## Decision

1. **Internal code uses camelCase** — all TypeScript interfaces, function parameters, and shared operation types follow standard TypeScript naming conventions (e.g., `RememberParams.content`, `UnifiedSearchParams.query`).

2. **MCP tool parameters use snake_case** — MCP input schemas and tool definitions use snake_case per MCP protocol convention (e.g., `relationship_types` in the explore tool's input schema).

3. **The shared operations layer uses camelCase internally** — `rememberFact()`, `unifiedSearch()`, `explore()`, and `reflect()` all accept camelCase parameter objects.

4. **The MCP adapter layer translates snake_case to camelCase at the boundary** — conversion happens in the MCP server's tool handlers when mapping parsed MCP input to shared operation calls. For example, `params.relationship_types` from MCP input becomes `relationshipTypes` when passed to the shared explore function.

## Consequences

- Shared operations are idiomatic TypeScript with no protocol-specific naming leaks
- MCP server handles all snake_case/camelCase translation in its handler layer
- CLI passes Commander options directly to shared operations (both use camelCase)
- New shared operations only need camelCase interfaces; MCP adapter handles translation
- No runtime transformation library needed — translation is explicit in MCP handlers
