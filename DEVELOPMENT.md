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

Available CLI commands: `init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `migrate`, `validate`.

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

There is also a `.mcp.json` in the project root for project-scoped MCP configuration.

After rebuilding the MCP server code, restart it by running `/mcp` in Claude Code or restarting the Claude Code session.

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
