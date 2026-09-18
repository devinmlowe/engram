# Engram User Guide

Engram is a local-first cognitive memory system for Claude Code. It transforms raw conversation history into structured, consolidated knowledge — episodic memories are captured, consolidated into semantic knowledge during "dream state" processing, and emergent connections surface through graph analysis.

For the full vision and technical specification, see [SPEC.md](../SPEC.md).

---

## Prerequisites

- **Node.js 22+** — required (`node --version` to check)
- **Ollama** (optional) — for local LLM inference during dream processing. Without it, Engram uses the Claude API via `ANTHROPIC_API_KEY`.

## Installation

### Via npm

```bash
npx @devinmlowe/engram preflight   # prebuilt native modules for this node/platform/arch/libc? prints the fix if not
npm install -g @devinmlowe/engram
# `engram` is now on your PATH; `engram preflight` repeats the check on the installed copy
```

The preflight reports, per native module (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`),
`prebuilt`, `compiled locally`, `will compile (needs python3 + C++ toolchain)`, `unsupported` or
`unknown`, followed by the exact fix for your OS. See the README's "Supported platform/arch set"
table for what each target gets.

### From Source

```bash
git clone https://github.com/devinmlowe/engram.git
cd engram
node scripts/preflight.cjs   # optional: the same native-module check before anything is installed
npm install                  # runs it again as the postinstall hook
npm run build
```

The built CLI is at `dist/interfaces/cli/index.js`. You can symlink it for convenience:

```bash
npm link
# Now `engram` is available globally
```

### Via npx

```bash
npx -y @devinmlowe/engram mcp
```

---

## First-Time Setup

### 1. Initialize the Database

```bash
engram init
```

This creates the SQLite database at `~/.local/share/engram/engram.db` and downloads the embedding model (`nomic-ai/nomic-embed-text-v1.5`). First run takes a few minutes for the model download.

### 2. Import Existing Data (optional)

If you have an existing episodic-memory plugin (conversation-index) database:

```bash
engram import-legacy --source ~/.config/superpowers/conversation-index/db.sqlite
```

Use `--dry-run` to preview what would be imported. (`engram migrate` now means *install/data migration* — see "Updating" in the README; `engram update` runs it for you.)

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
  node /path/to/engram/dist/interfaces/mcp/server.js
```

Replace `/path/to/engram` with the actual path to your clone.

### Option B: Manual Configuration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/interfaces/mcp/server.js"],
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

You should see 16 tools. The five core ones are `recall`, `remember`, `show`, `explore`, and `reflect`; the rest are the session and file-analysis tools listed in [api-reference.md](./api-reference.md).

---

## Daily Workflow

Once integrated, Engram provides five MCP tools that Claude Code uses automatically:

### recall — Search Memories

The primary tool. Searches across episodic conversations, semantic memories, and the knowledge graph using hybrid vector + keyword search.

```
recall("how did we set up the database?")
```

Results are token-budgeted and formatted as XML for optimal Claude consumption.

**Temporal recall.** Recall accepts natural-language date hints and two date
semantics — "memories IN a period" (when they were recorded) and "memories
ABOUT a period" (when the events happened, via source-exchange timestamps):

```
recall("launchd daemon work", dateHint: "last week")
recall("project decisions", dateHint: "in March 2026", dateBasis: "event")
recall("engram", dateHint: "on this day last year")   // anniversary flashback
```

Exact ISO bounds (`after`/`before` `YYYY-MM-DD`) are also accepted and override
a date hint when both are passed. Applied filters are reported in the response
as `<date_filter …>` metadata. In the CLI: `engram search <query> --date-hint
"last month" --date-basis event` (also `--after`/`--before`).

**Recall reinforces what it returns.** Each semantic memory a recall returns
gets its FSRS access recorded (`access_count`, `last_accessed`) and its
stability grown, so memories you keep using decay more slowly. That is
bookkeeping, not a content change — the recall tools stay `readOnlyHint: true`
so MCP clients do not prompt on every search. Pass `reinforce: false` (CLI:
`engram search … --no-reinforce`) for diagnostic searches that must not touch
the store.

**Per-request scope.** `recall` and `recall_session` accept `scope` (tenant
identity; reads default to `global` + that scope) and `read_scopes` (explicit
list); `remember` and `remember_batch` accept `scope`. The server's
`ENGRAM_SCOPE` / `ENGRAM_READ_SCOPES` remain the defaults — a parameter wins
for that call only. See [integrate-your-agent.md](./integrate-your-agent.md)
for the scoping model.

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

### ingest_turn — Feed Conversations From Other Hosts

Claude Code transcripts are picked up by `engram sync`; every other host records
its turns with `ingest_turn(session_id, turn_index, scope, user_text,
assistant_text)`. It is an idempotent upsert — the same `session_id` +
`turn_index` updates the turn in place — and the conversation's `scope` is
inherited by every memory the dream pipeline later extracts from it. The
Hermes plugin does this per turn automatically (`sync_turns`). Full schema in
[api-reference.md](./api-reference.md#ingest_turn).

### export / import — Move the Semantic Layer

```bash
engram export --out engram.jsonl                 # memories, entities, relationships, commitments
engram export --scope hermes:career --kinds memories
engram import engram.jsonl --dry-run             # validate, report, write nothing
engram import engram.jsonl --scope hermes:work   # re-scope every imported memory
```

JSONL v1: a header line, then one record per row; embeddings are not in the
file. Import is idempotent by id (a row is replaced only when the incoming
record is newer) and re-embeds and re-indexes every memory and entity, so it
runs at embedding speed. Details in [api-reference.md](./api-reference.md#engram-export).

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
engram dream --force            # Re-extract conversations even when unchanged
```

Extract skips conversations whose exchanges have not changed since their last
successful extraction (a content fingerprint on the checkpoint; an edited,
added or removed exchange changes it). The summary reports them as
`Skipped unchanged`, and `Collapsed dupes` counts candidate facts folded into
a near-duplicate sibling before insertion. `--force` ignores the fingerprint.

### Dream Pipeline Phases

| Phase | What It Does |
|-------|-------------|
| **ingest** | Syncs new conversations, parses exchanges, generates embeddings |
| **extract** | Extracts facts, entities, and relationships from new exchanges. The model scores each fact's `importance` and its own `confidence` (0–1; used as the memory's initial confidence). Point-in-time status ("phase 3 is complete", "added 12 tests") is filed as a transient tier: importance capped at 0.3 and FSRS stability 7 days, so it fades quickly unless recalled |
| **consolidate** | Deduplicates memories (against the store and within the batch), resolves conflicts, merges entities |
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
| `ANTHROPIC_API_KEY` | (none) | Enables the Anthropic tier (last in the cascade) |
| `OPENROUTER_API_KEY` | (none) | Enables the OpenRouter tier |
| `ENGRAM_OPENAI_BASE_URL` / `ENGRAM_OPENAI_MODEL` / `ENGRAM_OPENAI_API_KEY_ENV` | `https://api.openai.com/v1` / (none) / `OPENAI_API_KEY` | Generic OpenAI-compatible tier (OpenAI, LiteLLM, self-hosted). Setting the model activates it; the key is read from the env var *named* by `ENGRAM_OPENAI_API_KEY_ENV` |
| `ENGRAM_LLM_PROVIDERS` | `ollama,openai,openrouter,anthropic` | Tier order; tiers left out are never tried |
| `ENGRAM_LOCAL_MODEL` | `qwen2.5:7b` | Ollama model used by the local tier (must be pulled on `OLLAMA_HOST`) |
| `ENGRAM_LOCAL_MODEL_FALLBACKS` | (none) | Comma-separated Ollama models tried in order when `ENGRAM_LOCAL_MODEL` is not pulled; `engram doctor` shows which model the Ollama tier resolved to |
| `ENGRAM_DREAM_MAX_CONVERSATIONS` | (unlimited) | Cap on conversations extracted per run (bounds a manual end-to-end run) |

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

1. Verify the MCP server starts: `node dist/interfaces/mcp/server.js` (should print to stderr and wait)
2. Check Claude Code MCP configuration: `claude mcp list`
3. Ensure the path in your config points to the built `dist/interfaces/mcp/server.js`, not the TypeScript source

### Database is locked

Engram uses SQLite with WAL mode: readers never block, writers serialise with a 5 s `busy_timeout`, and recall reinforcement retries briefly then skips rather than failing the recall. Only one dream run per data dir is allowed (`<data dir>/tmp/dream.lock`; a second `engram dream` reports the owning pid). If you still see lock errors, look for a long-running writer (`engram dream`, a bulk `engram import`) and let it finish.

### High memory usage during sync

Large conversation histories can require significant memory for embedding generation. The embedding model runs in-process via `@xenova/transformers`. If memory is an issue, sync in batches using `--project` to process one project at a time.
