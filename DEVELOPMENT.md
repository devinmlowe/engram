# Engram Development Guide

## Prerequisites

- **Node.js >= 22.0.0** (check with `node -v`)
- **npm** (bundled with Node.js)

## Setup

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Verify the build
engram health
```

## Build

```bash
npm run build    # Compile TypeScript (tsc) -> dist/
npm run lint     # Type-check without emitting files
```

> **CRITICAL: The `dist/` directory contains compiled JavaScript. Edits to `.ts` files in `src/` are NOT live. After ANY code change in `src/`, you MUST:**
>
> 1. **Recompile:** `npm run build`
> 2. **Restart** any running engram processes (MCP server, daemon, web server)
>
> If you skip this, your changes will not take effect. The CLI, MCP server, and all runtime code execute from `dist/`, not `src/`.

## Running Tests

```bash
npm run test:run   # Run all tests once (vitest)
npm run test       # Run tests in watch mode
```

There are 63 test files with 887 tests covering all domains (episodic, semantic, graph, dream, core).

## Running the CLI

```bash
# Via the installed wrapper (if /opt/homebrew/bin/engram exists)
engram <command>

# Directly from the project
node dist/interfaces/cli/index.js <command>

# In development (runs TypeScript directly via tsx, no build needed)
npm run dev -- <command>
```

Available CLI commands: `init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `doctor`, `update`, `migrate`, `import-legacy`, `validate`, `backfill-event-ts`, `commitments`, `commitment-done`, `commitments-extract`, `export`, `import`, `mcp` (see `src/interfaces/cli/README.md`).

## Running the MCP Server

```bash
# Production (from compiled output)
node dist/interfaces/mcp/server.js

# Development (via tsx)
npm run mcp
```

### MCP Server Configuration in Claude Code

The MCP server is configured in `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/absolute/path/to/engram/dist/interfaces/mcp/server.js"],
      "env": {}
    }
  }
}
```

There is also a `.mcp.json` in the project root for project-scoped MCP configuration (used when you open this checkout in Claude Code; the published plugin does not use it).

After rebuilding the MCP server code, restart it by running `/mcp` in Claude Code or restarting the Claude Code session.

**Bridge vs inline while developing.** A stdio start (`node dist/interfaces/mcp/server.js`, `engram mcp`, `npm run mcp`) bridges to the HTTP daemon if one answers on `ENGRAM_MCP_PORT` (default 9907) — so with the supervised daemon running, your freshly built stdio server is *not* what handles tool calls; the daemon is. To exercise the in-process build, pass `--standalone` (or set `ENGRAM_MCP_STANDALONE=1` in the `.mcp.json` `env`), or restart the daemon so it picks up `dist/`. The stderr line `Engram MCP: bridging stdio to …` / `running inline (…)` tells you which happened. See `src/interfaces/mcp/bridge.ts` and `tests/interfaces/mcp/bridge.test.ts`.

## Releasing (#58)

`package.json` is the only place the version is edited by hand; `src/_core/version/index.ts` reads it at runtime and `scripts/sync-manifests.cjs` copies it into the distribution manifests (`.claude-plugin/plugin.json` incl. the `npx -y @devinmlowe/engram@<v>` pin, `.claude-plugin/marketplace.json`, `server.json`).

```bash
npm run check-manifests          # what CI runs: versions + shape agree (exit 1 with the list otherwise)
npm version minor                # bumps package.json, runs sync-manifests via the "version" hook, commits, tags v<version>
git push origin main --follow-tags
```

The tag triggers `.github/workflows/release.yml`: verify (tag = version, manifests, preflight, lint, full tests) → `npm publish --provenance` (needs the `NPM_TOKEN` repository secret) → `mcp-publisher login github-oidc` + `mcp-publisher publish` for registry.modelcontextprotocol.io (`io.github.devinmlowe/engram`; no secret — GitHub OIDC proves the repo owner). The marketplace has no publish step: Claude Code reads `.claude-plugin/marketplace.json` from this repo, so users get the new plugin version with `/plugin update engram@engram` once the bump is on `main`. Validate locally before tagging:

```bash
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json --strict
claude plugin validate commands --strict
```

The Hermes plugin is unrelated to this channel and is still deployed by `engram update` / `interfaces/hermes-plugin/deploy.sh`.

## Development Workflow

1. **Edit** source files in `src/`
2. **Build** with `npm run build`
3. **Test** with `npm run test:run`
4. **Restart** any running engram processes (MCP server, daemon)
5. **Verify** changes work end-to-end

For rapid iteration during development, use `npm run dev` or `npm run mcp` which run TypeScript directly via `tsx` (no build step needed). But remember that the production CLI (`engram`) and the MCP server configured in Claude Code both run from `dist/`, so you must rebuild before those reflect your changes.

## Project Structure

```
src/
  _core/       # Shared infrastructure (config, db, types, embeddings, search, llm, cache)
  episodic/    # Conversation archive ingestion, indexing, search
  semantic/    # Knowledge extraction, consolidation, chunking, decay
  graph/       # Entity/relationship graph, topic clusters, file indexing
  dream/       # Autonomous consolidation pipeline
  interfaces/
    cli/       # CLI entry point (index.ts)
    mcp/       # MCP server entry point (server.ts)
    web/       # Web visualization server
  migration/   # Database migration scripts
dist/          # Compiled JavaScript output (mirrors src/ structure)
tests/         # Test files (vitest)
plans/         # Implementation plans
decisions/     # Architecture Decision Records
```

## Other Commands

```bash
npm run dream      # Run dream consolidation pipeline
npm run migrate    # Run database migrations
```
