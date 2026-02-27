# Engram User Guide

Engram is a local-first cognitive memory system for Claude Code. It transforms raw conversation history into structured, consolidated knowledge — episodic memories are captured, consolidated into semantic knowledge during "dream state" processing, and emergent connections surface through graph analysis.

For the full vision and technical specification, see [SPEC.md](../SPEC.md).

---

## Prerequisites

- **Node.js 22+** — required (`node --version` to check)
- **Ollama** (optional) — for local LLM inference during dream processing. Without it, Engram uses the Claude API via `ANTHROPIC_API_KEY`.

## Installation

### From Source

```bash
git clone git@github.com:dml089/engram.git
cd engram
npm install
npm run build
```

The built CLI is at `dist/cli/index.js`. You can symlink it for convenience:

```bash
npm link
# Now `engram` is available globally
```

### Via npm (future)

```bash
npm install -g engram
```

### Via npx

```bash
npx -y engram mcp
```

---

## First-Time Setup

### 1. Initialize the Database

```bash
engram init
```

This creates the SQLite database at `~/.local/share/engram/engram.db` and downloads the embedding model (`nomic-ai/nomic-embed-text-v1.5`). First run takes a few minutes for the model download.

### 2. Migrate Existing Data (optional)

If you have an existing episodic-memory plugin database:

```bash
engram migrate
```

This imports conversations from `~/.config/superpowers/conversation-index/db.sqlite` into Engram's schema. Use `--dry-run` to preview what would be migrated.

### 3. Sync Conversations

```bash
engram sync
```

Scans `~/.claude/projects/` for conversation files, parses exchanges, generates embeddings, and indexes everything for search. Run this whenever you want to ingest new conversations.

### 4. Verify

```bash
engram health
```

Checks database status, embedding model availability, Ollama (optional), and MCP server readiness.

---

## Claude Code Integration

Register Engram as an MCP server so Claude Code can use its memory tools automatically.

### Option A: CLI Registration

```bash
claude mcp add --transport stdio --scope user engram -- \
  node /path/to/engram/dist/mcp/server.js
```

Replace `/path/to/engram` with the actual path to your clone.

### Option B: Manual Configuration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/mcp/server.js"],
      "env": {}
    }
  }
}
```

### Verify

Start a new Claude Code session and check that the tools appear:

```
/mcp
```

You should see 5 tools: `recall`, `remember`, `show`, `explore`, `reflect`.

---

## Daily Workflow

Once integrated, Engram provides five MCP tools that Claude Code uses automatically:

### recall — Search Memories

The primary tool. Searches across episodic conversations, semantic memories, and the knowledge graph using hybrid vector + keyword search.

```
recall("how did we set up the database?")
```

Results are token-budgeted and formatted as XML for optimal Claude consumption.

### remember — Store Knowledge

Explicitly store a fact, preference, decision, or other knowledge that should persist across conversations. Automatically deduplicates against existing memories.

```
remember("The project uses ESM modules with .js import extensions")
```

### show — Read Conversations

Read the full content of a conversation file found via `recall`. Supports pagination with `startLine`/`endLine` for large files.

### explore — Navigate Knowledge Graph

Explore entity connections in the knowledge graph. Shows what a concept, tool, project, or technology is connected to.

```
explore("SQLite")
```

### reflect — View Emergent Patterns

Shows topic communities, bridge entities connecting different domains, temporal patterns, and graph health metrics. Use after working on a topic to understand how it connects to other knowledge domains.

---

## Dream State Setup

The dream state daemon runs memory consolidation during off-hours — syncing new conversations, extracting facts and entities, building the knowledge graph, detecting patterns, and pruning low-confidence memories.

### Install the Daemon

```bash
./scripts/install-daemon.sh install
```

This:
1. Builds the project
2. Installs a launchd plist at `~/Library/LaunchAgents/com.engram.dreamstate.plist`
3. Schedules daily execution at 2:00 AM

If `ANTHROPIC_API_KEY` is set in your environment, it's automatically added to the plist.

### Check Status

```bash
./scripts/install-daemon.sh status
```

### Trigger Manually

```bash
engram dream
```

Or via the daemon:

```bash
./scripts/install-daemon.sh run-now
```

### Run a Specific Phase

```bash
engram dream --phase extract    # Only run fact/entity extraction
engram dream --phase reflect    # Only run reflection analysis
engram dream --verbose          # Show detailed progress
engram dream --dry-run          # Preview without making changes
```

### Dream Pipeline Phases

| Phase | What It Does |
|-------|-------------|
| **ingest** | Syncs new conversations, parses exchanges, generates embeddings |
| **extract** | Extracts facts, entities, and relationships from new exchanges |
| **consolidate** | Deduplicates memories, resolves conflicts, merges entities |
| **reflect** | Runs community detection, finds bridge entities, generates observations |
| **prune** | Applies confidence decay, archives low-confidence memories, cleans orphans |

### Uninstall

```bash
./scripts/install-daemon.sh uninstall
```

### Logs

- stdout: `~/.local/share/engram/logs/dream.log`
- stderr: `~/.local/share/engram/logs/dream-error.log`

---

## Configuration

Engram is configured through environment variables. All settings have sensible defaults.

### Data Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_DATA_DIR` | `~/.local/share/engram` | Root data directory |
| `ENGRAM_DB_PATH` | `{dataDir}/engram.db` | Database file path |
| `ENGRAM_ARCHIVE_DIR` | `{dataDir}/archive` | Archived conversation storage |
| `ENGRAM_LOGS_DIR` | `{dataDir}/logs` | Log file directory |
| `ENGRAM_CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code projects directory |

### Embedding

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_EMBEDDING_DIMS` | `256` | Embedding dimensions (MRL truncation) |

### Search

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_RERANK_ENABLED` | `true` | Enable cross-encoder reranking |

### Dream State

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (none) | Required for Claude API extraction |
| `ENGRAM_LOCAL_MODEL` | (none) | Local MLX model path (optional Ollama alternative) |

---

## Troubleshooting

### `engram init` fails with model download error

The embedding model (`nomic-ai/nomic-embed-text-v1.5`) is downloaded from Hugging Face on first run. Ensure you have internet connectivity. The model is cached in the `@xenova/transformers` cache directory.

### `engram search` returns no results

1. Run `engram sync` to ensure conversations are indexed
2. Run `engram stats` to verify exchange and embedding counts
3. Check that `engram health` passes all checks

### Dream state fails with "ANTHROPIC_API_KEY not set"

The extract and reflect phases use the Claude API for LLM inference. Set `ANTHROPIC_API_KEY` in your environment or in the launchd plist via the install script.

### MCP tools not appearing in Claude Code

1. Verify the MCP server starts: `node dist/mcp/server.js` (should print to stderr and wait)
2. Check Claude Code MCP configuration: `claude mcp list`
3. Ensure the path in your config points to the built `dist/mcp/server.js`, not the TypeScript source

### Database is locked

Engram uses SQLite with WAL mode for concurrent reads. If you see lock errors, ensure only one write process (dream daemon or CLI command) is running at a time.

### High memory usage during sync

Large conversation histories can require significant memory for embedding generation. The embedding model runs in-process via `@xenova/transformers`. If memory is an issue, sync in batches using `--project` to process one project at a time.
