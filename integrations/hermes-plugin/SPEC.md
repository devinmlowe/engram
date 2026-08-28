# SPEC — Hermes Memory Provider Plugin

## Purpose

Expose engram's knowledge graph to Hermes agents as an external `MemoryProvider`
(ADR-010, `decisions/hermes-memory-provider-integration.md`), giving every
profile automatic recall over the shared corpus plus curated, profile-scoped
writes.

## Requirements

- **R1** Subclass Hermes's real `MemoryProvider` ABC (`agent/memory_provider.py`);
  implement `name`, `is_available`, `initialize`, `get_tool_schemas`.
- **R2** Transport: engram's MCP server as a persistent stdio child (newline-
  delimited JSON-RPC), spawned lazily on first use, stdlib-only client.
- **R3** Context gating: spawn only when `agent_context == "primary"`; cron,
  subagent, and flush contexts must never pay the Node/embedding RSS cost.
- **R4** Scoping: child env carries `ENGRAM_SCOPE=hermes:<profile>` and
  `ENGRAM_READ_SCOPES=global,hermes:<profile>` (config-overridable). No tool
  argument can widen the write scope.
- **R5** `prefetch()` calls `recall` with a token budget (default 1200) under a
  6s timeout (below Hermes's 8s ceiling); failures return "" — never raise.
- **R6** Explicit tools are namespaced `engram_*` to avoid core-tool collisions.
- **R7** Writes are curated only: `engram_remember` tool calls and
  `on_memory_write` mirrors of built-in MEMORY.md saves, drained on a
  background thread (non-blocking contract). Raw turns are not ingested.
- **R8** Idle child is reaped after `idle_kill_s` (default 600s).
- **R9** `backup_paths()` returns `[]` deliberately — the engram DB is shared
  infrastructure with its own backup lifecycle.
- **R10** Config lives at `$HERMES_HOME/engram.json`, written atomically 0600.

## Interface

See `provider.py` (`EngramMemoryProvider`) and `mcp_client.py`
(`McpStdioClient`). Entry point: `register(ctx)` in `__init__.py`.

## Verification

`pytest` in this directory: client transport tests (fake stdio server),
provider contract tests against the live Hermes ABC, packaging tests for the
discovery heuristic and `register()` entry point.
