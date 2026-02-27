# Research: Packaging Engram as a Claude Code MCP Server / Plugin

**Date:** 2026-02-26
**Project:** Engram
**Domain:** packaging, distribution, Claude Code integration

---

## Table of Contents

1. [Distribution Strategies Overview](#1-distribution-strategies-overview)
2. [Strategy A: Standalone MCP Server (npm + stdio)](#2-strategy-a-standalone-mcp-server-npm--stdio)
3. [Strategy B: Claude Code Plugin](#3-strategy-b-claude-code-plugin)
4. [Strategy C: Hybrid -- npm Package + Plugin Wrapper](#4-strategy-c-hybrid----npm-package--plugin-wrapper)
5. [MCP Server Configuration in Claude Code](#5-mcp-server-configuration-in-claude-code)
6. [npm Packaging Requirements](#6-npm-packaging-requirements)
7. [Plugin Structure and Manifest](#7-plugin-structure-and-manifest)
8. [Stdio Transport Best Practices](#8-stdio-transport-best-practices)
9. [Installation Methods](#9-installation-methods)
10. [Engram-Specific Configuration Examples](#10-engram-specific-configuration-examples)
11. [Reference: Official MCP Server Packaging Pattern](#11-reference-official-mcp-server-packaging-pattern)
12. [Recommendations for Engram](#12-recommendations-for-engram)
13. [Sources](#13-sources)

---

## 1. Distribution Strategies Overview

There are three viable strategies for making Engram available in Claude Code:

| Strategy | Mechanism | Discovery | Auto-start | Skills/Hooks |
|---|---|---|---|---|
| **A: npm MCP Server** | `claude mcp add` or manual JSON | Manual CLI command | Yes (after config) | No |
| **B: Claude Code Plugin** | Plugin marketplace install | Via `/plugin` UI | Yes (when enabled) | Yes |
| **C: Hybrid** | npm package + thin plugin wrapper | Via marketplace | Yes | Yes |

**Strategy A** is the simplest and most common approach for MCP servers today. **Strategy B** provides richer integration but requires a plugin marketplace. **Strategy C** combines both -- the npm package is the canonical distribution, and a plugin wraps it for marketplace discoverability and optional skills/hooks.

---

## 2. Strategy A: Standalone MCP Server (npm + stdio)

This is how `@modelcontextprotocol/server-filesystem`, `@playwright/mcp`, and other widely-used MCP servers are distributed.

### How it works

1. User runs `claude mcp add engram -- npx -y engram --mcp` (or similar).
2. Claude Code writes the configuration to `~/.claude.json`.
3. On every Claude Code session, the MCP server process is spawned via stdio.
4. Tools (`recall`, `remember`, `show`, `explore`, `reflect`) appear in Claude's toolkit.

### Pros
- Simple, well-understood pattern.
- No plugin infrastructure needed.
- Works with Claude Desktop, other MCP clients, not just Claude Code.
- `npx -y` handles installation automatically.

### Cons
- No slash commands, skills, hooks, or agents.
- User must run `claude mcp add` manually (or paste JSON).
- No marketplace discoverability.

---

## 3. Strategy B: Claude Code Plugin

Plugins are Claude Code's native extension system. A plugin is a directory containing a `.claude-plugin/plugin.json` manifest and optional component directories.

### How it works

1. Plugin is listed in a marketplace (`marketplace.json`).
2. User runs `/plugin install engram@marketplace-name`.
3. Plugin is copied to `~/.claude/plugins/cache/`.
4. The bundled MCP server starts automatically when the plugin is enabled.
5. Optional skills, hooks, and agents are loaded alongside.

### Plugin directory structure for Engram

```
engram-plugin/
  .claude-plugin/
    plugin.json            # Plugin manifest
  .mcp.json                # MCP server definition
  skills/
    recall/
      SKILL.md             # /recall skill
    remember/
      SKILL.md             # /remember skill
    dream/
      SKILL.md             # /dream skill
  scripts/
    start-server.sh        # Server startup wrapper
```

### Pros
- Rich integration: skills, hooks, agents alongside MCP tools.
- Marketplace discoverability.
- Automatic lifecycle management.
- Team distribution via project settings.

### Cons
- Only works in Claude Code (not Claude Desktop or other MCP clients).
- Requires setting up a marketplace or submitting to an existing one.
- Plugin caching means the plugin directory is copied; cannot reference external files.

---

## 4. Strategy C: Hybrid -- npm Package + Plugin Wrapper

The recommended approach: publish the core MCP server as an npm package, then create a thin Claude Code plugin that wraps it.

### How it works

1. `engram` is published to npm with `bin` and MCP server entry points.
2. A separate plugin (or the same repo) contains `.claude-plugin/plugin.json` + `.mcp.json`.
3. The `.mcp.json` launches the npm-installed binary via `npx`.
4. Skills in the plugin provide slash-command shortcuts.
5. Users who do not use Claude Code can still `claude mcp add` or configure directly.

### Plugin `.mcp.json` (wrapping npm package)

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram", "mcp"],
      "env": {}
    }
  }
}
```

Or using a local build:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "env": {}
    }
  }
}
```

---

## 5. MCP Server Configuration in Claude Code

### Configuration file locations

| Scope | File | Purpose |
|---|---|---|
| User (global) | `~/.claude.json` under `mcpServers` | Available across all projects |
| Local (per-project, private) | `~/.claude.json` under project path | One project, one user |
| Project (shared) | `.mcp.json` at project root | Checked into VCS, shared with team |
| Managed | `/Library/Application Support/ClaudeCode/managed-mcp.json` | IT-controlled, read-only |
| Plugin | `.mcp.json` at plugin root or inline in `plugin.json` | Bundled with plugin |

### Configuration format

The `mcpServers` object maps server names to configuration objects:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "string",
      "args": ["array", "of", "strings"],
      "env": {
        "KEY": "value"
      },
      "cwd": "/optional/working/directory"
    }
  }
}
```

For project-scoped `.mcp.json` files, the format wraps in an outer object:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name"],
      "env": {}
    }
  }
}
```

### Adding via CLI

```bash
# stdio transport (default for local servers)
claude mcp add --transport stdio engram -- npx -y engram mcp

# With environment variables
claude mcp add --transport stdio --env ENGRAM_DATA_DIR=/custom/path engram -- npx -y engram mcp

# With scope
claude mcp add --transport stdio --scope user engram -- npx -y engram mcp

# From JSON directly
claude mcp add-json engram '{"type":"stdio","command":"npx","args":["-y","engram","mcp"]}'
```

### Adding via JSON (manual edit of ~/.claude.json)

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram", "mcp"],
      "env": {
        "ENGRAM_DATA_DIR": "/Users/username/.local/share/engram"
      }
    }
  }
}
```

### Managing servers

```bash
claude mcp list              # List all configured servers
claude mcp get engram        # Get details for a specific server
claude mcp remove engram     # Remove a server
```

Within Claude Code interactive mode:
```
/mcp                         # View and manage MCP servers
```

---

## 6. npm Packaging Requirements

### package.json for an MCP server

Based on the official `@modelcontextprotocol/server-filesystem` pattern:

```json
{
  "name": "engram",
  "version": "0.1.0",
  "description": "Cognitive memory system for Claude Code",
  "type": "module",
  "license": "MIT",

  "bin": {
    "engram": "dist/cli/index.js"
  },

  "main": "dist/cli/index.js",

  "files": [
    "dist"
  ],

  "scripts": {
    "build": "tsc && shx chmod +x dist/cli/index.js dist/mcp/server.js",
    "prepare": "npm run build",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest",
    "mcp": "tsx src/mcp/server.ts"
  },

  "engines": {
    "node": ">=22.0.0"
  }
}
```

### Key fields

| Field | Purpose |
|---|---|
| `"type": "module"` | ES module support (already present) |
| `"bin"` | Makes `engram` available as a CLI command after `npm install -g` or via `npx` |
| `"files": ["dist"]` | Only publish compiled output to npm (excludes src, tests, etc.) |
| `"scripts.build"` | Compile TypeScript and make entry points executable |
| `"scripts.prepare"` | Auto-run build before `npm publish` |

### Shebang requirement

Both entry points (`dist/cli/index.js` and `dist/mcp/server.js`) must start with:

```
#!/usr/bin/env node
```

The source files already have this (both `src/cli/index.ts` and `src/mcp/server.ts` start with `#!/usr/bin/env node`).

### Separate MCP entry point

Engram currently has two entry points:
- `src/cli/index.ts` -- full CLI with subcommands (sync, search, dream, etc.)
- `src/mcp/server.ts` -- MCP stdio server

For `npx` usage, there are two options:

**Option 1: CLI subcommand routing** (recommended)
Add an `mcp` subcommand to the CLI:
```bash
npx engram mcp     # Starts MCP server
npx engram sync    # Runs sync
npx engram dream   # Runs dream
```

**Option 2: Separate bin entries**
```json
{
  "bin": {
    "engram": "dist/cli/index.js",
    "engram-mcp": "dist/mcp/server.js"
  }
}
```

Option 1 is cleaner because it keeps a single entry point and lets the CLI router (Commander) handle dispatch.

---

## 7. Plugin Structure and Manifest

### `.claude-plugin/plugin.json` (complete schema)

```json
{
  "name": "engram",
  "version": "0.1.0",
  "description": "Cognitive memory system -- episodic storage, semantic extraction, knowledge graph, and dream-state consolidation for Claude Code",
  "author": {
    "name": "Devin Lowe",
    "url": "https://github.com/dml089"
  },
  "repository": "https://github.com/dml089/engram",
  "license": "MIT",
  "keywords": ["memory", "episodic", "semantic", "knowledge-graph", "mcp", "rag"],
  "mcpServers": "./mcp-config.json"
}
```

### Required fields

Only `name` is strictly required. Everything else is optional metadata.

### Component path fields

| Field | Type | Default location | Purpose |
|---|---|---|---|
| `commands` | string or array | `commands/` | Legacy command markdown files |
| `agents` | string or array | `agents/` | Subagent markdown files |
| `skills` | string or array | `skills/` | Skills with `SKILL.md` |
| `hooks` | string or object | `hooks/hooks.json` | Event handlers |
| `mcpServers` | string or object | `.mcp.json` | MCP server definitions |
| `lspServers` | string or object | `.lsp.json` | LSP server configs |
| `outputStyles` | string or array | (none) | Output formatting |

### `${CLAUDE_PLUGIN_ROOT}` variable

All paths in hooks, MCP configs, and scripts must use `${CLAUDE_PLUGIN_ROOT}` because plugins are copied to `~/.claude/plugins/cache/` at install time. Absolute paths or relative paths without this variable will break.

### Plugin installation scopes

| Scope | Settings file | Use case |
|---|---|---|
| `user` | `~/.claude/settings.json` | Personal, all projects (default) |
| `project` | `.claude/settings.json` | Team, version-controlled |
| `local` | `.claude/settings.local.json` | Personal, one project, gitignored |
| `managed` | Managed settings file | IT-controlled |

---

## 8. Stdio Transport Best Practices

### Critical: No console.log in MCP servers

For stdio-based MCP servers, **never use `console.log()`**. The stdio transport uses stdout for the MCP JSON-RPC protocol. Any stray output to stdout corrupts the protocol stream.

Use instead:
- `console.error()` -- writes to stderr, visible in debug logs
- A logging library that writes to stderr or files

Engram's `src/mcp/server.ts` already follows this correctly:
```typescript
console.error("Engram MCP server running via stdio");
```

### Startup behavior

1. The MCP client (Claude Code) spawns the server process.
2. The server initializes and connects via `StdioServerTransport`.
3. The client sends `initialize` and `tools/list` requests.
4. The server responds with available tools.
5. Tools are called throughout the session.

### Error handling

```typescript
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
```

Engram already has this pattern. Additional best practices:

- **Lazy initialization**: Defer heavy operations (database, embeddings) until first tool call. Engram already does this.
- **Graceful errors**: Return `isError: true` in tool responses rather than crashing. Engram already does this.
- **Timeout**: Claude Code has a configurable startup timeout (default varies, can be set with `MCP_TIMEOUT` environment variable).

### Health checks

Claude Code does not have a formal health-check protocol for MCP servers. The server is considered healthy if:
1. It responds to `initialize` within the timeout.
2. It responds to `tools/list` correctly.
3. Tool calls return results without the process crashing.

### Dynamic tool updates

Claude Code supports `list_changed` notifications. If Engram adds or removes tools at runtime, it can notify the client:

```typescript
server.notification({
  method: "notifications/tools/list_changed"
});
```

---

## 9. Installation Methods

### Method 1: CLI one-liner (simplest for users)

```bash
claude mcp add --transport stdio --scope user engram -- npx -y engram mcp
```

### Method 2: Manual JSON configuration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram", "mcp"],
      "env": {}
    }
  }
}
```

### Method 3: Local development (from source)

```bash
claude mcp add --transport stdio --scope local engram -- node /path/to/engram/dist/mcp/server.js
```

Or via JSON:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/Users/USER/Documents/git/engram/dist/mcp/server.js"],
      "env": {}
    }
  }
}
```

### Method 4: Plugin marketplace install

```
/plugin marketplace add owner/engram-marketplace
/plugin install engram@engram-marketplace
```

### Method 5: Project-scoped `.mcp.json`

Place in project root (checked into git):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram", "mcp"],
      "env": {}
    }
  }
}
```

---

## 10. Engram-Specific Configuration Examples

### Global installation (recommended for personal use)

```bash
# Install globally
npm install -g engram

# Initialize database and download embedding model
engram init

# Add to Claude Code
claude mcp add --transport stdio --scope user engram -- engram mcp
```

### npx-based installation (zero install)

```bash
claude mcp add --transport stdio --scope user engram -- npx -y engram mcp
```

### With custom data directory

```bash
claude mcp add --transport stdio --scope user \
  --env ENGRAM_DATA_DIR=/custom/path \
  engram -- npx -y engram mcp
```

### JSON configuration for Claude Code settings

For `~/.claude.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram", "mcp"],
      "env": {
        "ENGRAM_DATA_DIR": "/Users/USER/.local/share/engram"
      }
    }
  }
}
```

### Plugin `.mcp.json` for bundled distribution

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "env": {}
    }
  }
}
```

Or wrapping via npx:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram", "mcp"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

---

## 11. Reference: Official MCP Server Packaging Pattern

### `@modelcontextprotocol/server-filesystem` package.json

```json
{
  "name": "@modelcontextprotocol/server-filesystem",
  "version": "0.6.3",
  "description": "MCP server for filesystem access",
  "license": "MIT",
  "type": "module",
  "bin": {
    "mcp-server-filesystem": "dist/index.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc && shx chmod +x dist/*.js",
    "prepare": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "zod-to-json-schema": "^3.23.5"
  }
}
```

### Key patterns to replicate

1. **`"type": "module"`** -- ES modules.
2. **`"bin"` field** -- enables `npx` usage and global install.
3. **`"files": ["dist"]`** -- only ship compiled output.
4. **`"prepare"` script** -- auto-build before publish.
5. **`shx chmod +x`** -- make entry points executable (cross-platform).
6. **Shebang line** -- `#!/usr/bin/env node` at top of entry points.

---

## 12. Recommendations for Engram

### Immediate (ship as MCP server via npm)

1. **Add `mcp` subcommand to CLI** (`src/cli/index.ts`):
   ```typescript
   program
     .command("mcp")
     .description("Start MCP server (stdio transport)")
     .action(async () => {
       await import("../mcp/server.js");
     });
   ```

2. **Update `package.json`**:
   - Add `"files": ["dist"]`.
   - Update build script: `"build": "tsc && chmod +x dist/cli/index.js dist/mcp/server.js"`.
   - Add `"prepare": "npm run build"`.
   - Consider adding `shx` for cross-platform chmod.

3. **Publish to npm**: `npm publish`.

4. **Document the install one-liner**:
   ```bash
   claude mcp add --transport stdio --scope user engram -- npx -y engram mcp
   ```

### Near-term (add Claude Code plugin)

5. **Create plugin structure** in the repo:
   ```
   .claude-plugin/
     plugin.json
   .mcp.json
   skills/
     recall/SKILL.md
     remember/SKILL.md
     dream/SKILL.md
   ```

6. **Create or submit to a marketplace** for discoverability.

### Plugin skills to consider

| Skill | Description |
|---|---|
| `/recall` | Quick shortcut to search memories |
| `/remember` | Store a new memory |
| `/dream` | Trigger dream-state consolidation |
| `/engram-stats` | Show memory statistics |
| `/engram-sync` | Sync conversations |

### Native dependencies consideration

Engram depends on `better-sqlite3` and `sqlite-vec`, which are native Node.js addons. This means:
- `npx -y` will trigger a native compilation step (or prebuild download).
- The first run may be slower as prebuilds are fetched.
- Cross-platform compatibility depends on prebuild availability.
- Consider documenting Node.js version requirements clearly (`engines.node >= 22`).

### Environment variable configuration

Engram already supports configuration via environment variables. Document these for MCP users:

| Variable | Default | Purpose |
|---|---|---|
| `ENGRAM_DATA_DIR` | `~/.local/share/engram` | Base data directory |
| `ENGRAM_DB_PATH` | `$ENGRAM_DATA_DIR/engram.db` | Database path |
| `ENGRAM_ARCHIVE_DIR` | `$ENGRAM_DATA_DIR/archive` | Archive directory |
| `ENGRAM_CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude projects dir |
| `ENGRAM_EMBEDDING_DIMS` | `256` | Embedding dimensions |
| `ENGRAM_LOCAL_MODEL` | (none) | Local model override |

---

## 13. Sources

- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- Official MCP configuration guide
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) -- Plugin manifest schema, component specs, CLI commands
- [Claude Code Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) -- Creating and distributing plugin marketplaces
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- Official SDK for building MCP servers
- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- SDK package
- [@modelcontextprotocol/server-filesystem on GitHub](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) -- Reference MCP server implementation
- [MCP Server Development Guide](https://modelcontextprotocol.io/docs/develop/build-server) -- Official server development docs
- [Configuring MCP Tools in Claude Code](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code) -- Third-party configuration guide
- [Claude Code Plugin Template](https://github.com/ivan-magda/claude-code-plugin-template) -- Community plugin scaffold
- [Official Anthropic Claude Plugins](https://github.com/anthropics/claude-plugins-official) -- Official plugin directory
- [How to Build Claude Code Plugins](https://www.datacamp.com/tutorial/how-to-build-claude-code-plugins) -- DataCamp tutorial
