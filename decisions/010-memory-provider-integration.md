# ADR-010: External Memory-Provider Integration

- **Status:** Superseded (original removed from the public tree 2026-09-13 for privacy)
- **Date:** 2026-08-28

Internal integration design with a private agent fleet. Summary: engram exposes its agent-facing API via MCP (stdio + HTTP); external memory systems should integrate through that interface rather than the library layer. Tenant scoping (`scope` column, `hermes:<profile>` prefixes) and the HTTP transport (see README "Transports") are the public remnants of this decision.
