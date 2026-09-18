# Engram API Reference

Complete reference for MCP tools, CLI commands, and configuration.

---

## MCP Tools

Engram exposes 16 tools via the Model Context Protocol (the canonical list is `src/interfaces/mcp/tool-names.ts`; `tools/list` on a running server is authoritative). The five core tools are documented below, as are `forget` and the commitments ledger tools (`commitments`, `commitments_update`). The Phase 6 session tools (`recall_session`, `recall_drill`, `explore_selective`, `remember_batch`) and Phase 7 file tools (`index_file_structure`, `fetch_snippets`, `scan_file`) are summarized in [CLAUDE.md](../CLAUDE.md) and [integrate-your-agent.md](./integrate-your-agent.md). The rest are summarized in [CLAUDE.md](../CLAUDE.md) and [integrate-your-agent.md](./integrate-your-agent.md).

### recall

Retrieve relevant memories from past conversations and extracted knowledge. Uses hybrid semantic + keyword search with token-budgeted output.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query (min 2 characters) |
| `budget` | number | no | `1500` | Max tokens in response (100-5000) |
| `after` | string | no | — | Only results on/after this date (`YYYY-MM-DD`, UTC) |
| `before` | string | no | — | Only results before this date (`YYYY-MM-DD`, UTC; that day is excluded) |
| `dateHint` | string | no | — | Natural-language window: `today`, `yesterday`, `this week`, `last month`, `3 days ago`, `this day last year`, `in March`, `March 2026`, `since last week`, `before March`, `on this day`, ISO `2026-03` / `2026-03-01`. Explicit `after`/`before` win over the hint. Unrecognized hints apply no filter and are reported in `<date_filter note>` |
| `dateBasis` | string | no | `"filed"` | What dates refer to. `"filed"` = when the memory was recorded (memories **in** March). `"event"` = when the described events happened, via the earliest source-exchange timestamp with `created_at` as fallback (memories **about** March). Episodic results are identical under both |
| `depth` | string | no | `"shallow"` | `"shallow"` or `"deep"` |
| `sources` | string[] | no | `["episodic", "semantic"]` | Memory stores to search: `"episodic"`, `"semantic"`, `"graph"` |
| `scope` | string | no | `ENGRAM_SCOPE` | Tenant identity for this call (e.g. `"hermes:career"`); reads default to `global` + this scope. Overrides the server's `ENGRAM_SCOPE` for this call only |
| `read_scopes` | string[] | no | `ENGRAM_READ_SCOPES` | Explicit scopes to read from (e.g. `["global", "hermes:career"]`). Overrides `ENGRAM_READ_SCOPES` for this call only. Applies to every layer since #25: semantic memories, episodic exchanges (denormalised from the conversation), graph entities/relationships, and the commitments ledger. The same `scope` / `read_scopes` params exist on `explore`, `explore_selective` and `commitments` |
| `reinforce` | boolean | no | `true` | Reinforce the semantic memories this call returns — FSRS bookkeeping: `access_count`, `last_accessed` and stability growth. Set `false` for read-only/diagnostic callers |

**Reinforcement and `readOnlyHint`.** Retrieval strengthens the returned memories' FSRS stability (they decay more slowly) and records the access; it never creates, edits or deletes a memory or changes its content, so `recall`, `recall_session` and `recall_drill` keep `readOnlyHint: true` (a write hint would make MCP clients confirm every recall). Pass `reinforce: false` to opt out. The same three params (`scope`, `read_scopes`, `reinforce`) exist on `recall_session`; `recall_drill` takes `reinforce` only (it drills an already-scoped session result).

**Output:** XML-formatted results within the token budget. When any date filter was requested the first child is a `<date_filter>` element describing exactly what was applied (`basis`, `after`, `before`, `anniversary="MM-DD"`, `hint`, `overridden`, `note`). Semantic results carry a `date` attribute: the basis date they were filtered on.

Temporal semantics: all boundaries are UTC; `after` is inclusive of the day's start, `before` is a start-of-day bound (the named day is excluded), so `dateHint: "in March"` resolves to `after=2026-03-01 before=2026-04-01`. `"on this day"` is not a range — it matches the same month/day across every year (`anniversary`).

```json
{ "query": "project decisions", "dateHint": "this day last year" }
{ "query": "launchd daemon work", "dateHint": "last week", "dateBasis": "event" }
```

```xml
<engram_memory query="database setup" tokens_used="842" total_results="3">
  <semantic id="3f9c1c2e-…" type="decision" confidence="85%" importance="high" relevance="100%" date="2026-02-15">
    The project uses better-sqlite3 with sqlite-vec for the database layer, with no ORM.
  </semantic>
  <episodic date="2026-02-15" project="engram" relevance="72%">
    User: Let's use SQLite with WAL mode...
  </episodic>
</engram_memory>
```

Every `<semantic>` element carries the memory's `id` — pass it to `forget` (or `engram memories show <id>`) when the user says a recalled memory is wrong.

**Example:**

```json
{
  "query": "how did we configure the embedding model?",
  "budget": 2000,
  "sources": ["semantic", "episodic"]
}
```

---

### remember

Store a fact, preference, decision, or other knowledge as a semantic memory. Automatically deduplicates: if an existing memory has >= 0.95 cosine similarity, the existing memory's access count is bumped instead of creating a duplicate.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | yes | — | The knowledge to remember |
| `type` | string | no | `"fact"` | One of: `"preference"`, `"decision"`, `"pattern"`, `"fact"`, `"solution"`, `"convention"` |
| `importance` | number | no | `0.7` | Importance score (0-1) |
| `source` | string | no | `"user"` | Provenance: `"user"`, `"dream"`, `"rlm"`, `"import"`, `"hermes-mirror"` (the Hermes plugin's built-in memory mirror). `remember_batch` accepts the same per-memory `source` |
| `context` | string | no | — | Provenance note (≤ 500 chars, trimmed) stored in `memories.context` and FTS-indexed; `remember_batch` accepts it per memory |
| `scope` | string | no | `ENGRAM_SCOPE` | Tenant scope stamped on the memory; overrides the server's `ENGRAM_SCOPE` for this call only. `remember_batch` accepts the same `scope` |

**Output:** Confirmation text.

**Example:**

```json
{
  "content": "The user's default shell is Fish and they require Fish-compatible syntax.",
  "type": "preference",
  "importance": 0.7
}
```

---

### show

Read full conversations to extract detailed context after finding relevant results with `recall`. Returns JSONL conversation lines formatted as readable markdown.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | yes | — | Absolute path to conversation file |
| `startLine` | number | no | `1` | First line to read |
| `endLine` | number | no | (end of file) | Last line to read |

**Output:** Markdown-formatted conversation with role headers and timestamps.

---

### explore

Explore connections in the knowledge graph starting from an entity. Shows what a concept, tool, project, or technology is connected to.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `entity` | string | yes | — | Entity name to explore (e.g., `"TypeScript"`, `"SQLite"`) |
| `depth` | number | no | `1` | Traversal hops (1-3) |
| `relationship_types` | string[] | no | (all) | Filter: `"uses"`, `"depends_on"`, `"related_to"`, `"part_of"`, `"configured_by"`, `"solved_by"` |

**Output:** XML-formatted graph traversal result.

```xml
<engram_graph entity="SQLite" type="technology">
  <description>Database engine used by the project</description>
  <relationship direction="outgoing" type="uses" target="WAL mode" weight="0.90">
    Write-Ahead Logging for concurrent reads
  </relationship>
  <relationship direction="incoming" type="depends_on" source="engram" weight="0.95">
    Core persistence layer
  </relationship>
  <community name="Database & Storage" entities="8" />
</engram_graph>
```

---

### reflect

View emergent patterns and structure in the knowledge graph. Shows topic communities, bridge entities, temporal patterns, and graph health.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mode` | string | no | `"all"` | Focus: `"communities"`, `"bridges"`, `"temporal"`, `"health"`, `"all"` |
| `refresh` | boolean | no | `false` | Force fresh analysis (runs community detection, slower) |

**Output:** XML-formatted reflection data.

```xml
<engram_reflection mode="all" generation="3" timestamp="2026-02-26T02:00:00.000Z">
  <communities count="4" modularity="0.65">
    <community name="Memory System Architecture" coherence="0.82" entities="12" memories="28">
      <description>Core memory pipeline components</description>
    </community>
  </communities>
  <bridges count="2">
    <bridge entity="SQLite" type="technology" score="0.78" span="3">
      <narrative>Connects database, search, and graph domains</narrative>
    </bridge>
  </bridges>
  <health>
    <stat name="total_nodes" value="45" />
    <stat name="total_edges" value="78" />
    <stat name="modularity" value="0.65" />
  </health>
</engram_reflection>
```

---

### commitments

List tracked commitments — first-person promises ("I'll send Alan the timeline"), self-directed intentions ("we need to revisit this next week") and follow-ups owed to the user by others ("Alan will confirm the return date"), extracted by the dream pipeline's commitments pass. "Mention once, never dropped."

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | no | `"pending"` | `pending`, `done`, `dropped`, `superseded`, or `all` |
| `include_due_within_days` | number | no | — | Only items with a due date within N days; overdue items are always included |
| `limit` | number | no | `20` | Max items (1-500) |
| `budget` | number | no | `1500` | Token budget for the XML |

**Output:** `<engram_commitments status count total as_of [truncated] tokens_used>` wrapping `<commitment id status subject origin age [due overdue] [resolved] [superseded_by] sources>content</commitment>` elements. Order: overdue first, then dated items by due date, then undated items newest first. `subject` is `devin` when the user owes the action, otherwise the other party; `origin` is `stated` for the user's own words, `inferred` for implied obligations and follow-ups owed by others; `sources` are the exchange ids the item was extracted from.

### commitments_update

Resolve a commitment once the user confirms it is handled.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Commitment id, or a unique prefix of at least 6 characters |
| `status` | string | yes | `done`, `dropped`, or `superseded` |
| `superseded_by` | string | with `superseded` | Id of the replacing commitment |

**Output:** `Commitment <id> marked <status>: <content>`. Resolved items leave the default pending list; `resolved_at` is recorded.

### ingest_turn

Record one user/assistant turn of an external agent conversation (e.g. a Hermes profile) in the episodic layer so it becomes searchable and feeds the nightly dream extraction. This is how hosts other than Claude Code get conversations into engram (the Hermes plugin's `sync_turns` calls it per turn).

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session_id` | string | yes | — | Caller's conversation/session identifier, stable across turns |
| `turn_index` | integer | yes | — | 0-based position of the turn within the session |
| `scope` | string | yes | — | Tenant scope of the conversation (e.g. `"hermes:career"`) |
| `user_text` | string | yes | — | The user's message |
| `assistant_text` | string | yes | — | The assistant's reply |
| `tool_calls` | object[] | no | — | `{name, input?, output?}` per tool invoked during the turn (input/output truncated to 1000 chars) |
| `timestamp` | string | no | now | ISO-8601 time of the turn |
| `source` | string | no | `"hermes"` | Platform label; part of the conversation key |
| `author` | object | no | — | `{id?, name?, is_bot?}` — who authored the user side of the turn; stored verbatim as JSON on the exchange (`exchanges.author_json`), absent → NULL |

**Idempotency:** the conversation id is `<source>:<session_id>` and the exchange id `<source>:<session_id>:<turn_index>`; re-sending the same key updates the turn in place, so a restarted client re-sending indexes 0… of a resumed session never duplicates rows. Gaps in `turn_index` are tolerated.

**Scope inheritance:** the conversation row carries `scope`, and every memory the dream pipeline later extracts from it inherits that scope (`conversations.scope` → extracted memories), so per-tenant recall sees them and other tenants do not.

**Output:** JSON `{ "conversationId", "exchangeId", "created": true|false }` (`created` is false on an update).

### forget

Remove a memory the user says is wrong or stale (#55). Annotated `readOnlyHint: false`, `destructiveHint: true`.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory_id` | string | one of | — | The `id` attribute of a recalled `<semantic>` (or a unique prefix of 6+ characters). Acts in one call. |
| `query` | string | one of | — | Search for candidates instead of naming one. Returns `<forget_candidates>` with ids; deletes nothing unless `confirm` is true **and** exactly one memory matches — a single result, or a single result whose normalised content equals the normalised query. |
| `confirm` | boolean | no | `false` | Query mode only: act on an unambiguous single match. |
| `hard` | boolean | no | `false` | Delete the row outright instead of the soft delete + retention window. |
| `scope` | string | no | `ENGRAM_SCOPE` | Tenant identity for this call; `"global"` acts on a memory in any scope. |
| `read_scopes` | string[] | no | `ENGRAM_READ_SCOPES` | Scopes this call may act on; a memory outside them is refused (#25). |

**What happens (decisions #56, #57):** in one transaction the memory is soft-deleted (`is_active = 0`, `deleted_at`, `deleted_by`), its sqlite-vec and FTS5 rows are removed so no recall path can return it, a `memory_changes` row is written (`op = forget`, `before` = content, `actor` = the MCP client's `clientInfo.name`, or `cli`), its content hash is added to `memory_suppressions` so the next dream extract does not re-extract it from the same exchanges, and every relationship listing it as evidence loses it — endpoint entities' `mention_count` is decremented and rows that reach zero evidence are stamped `stale_since`. `forget` never deletes graph rows; the dream prune phase removes flagged rows with no remaining evidence on its next run, and hard-deletes soft-deleted memories older than `ENGRAM_FORGET_RETENTION_DAYS` (default 30; `0` = next run). `engram memories restore <id>` undoes a soft delete inside that window.

**Output:** `<forgotten id scope hard deleted_at actor><content/><graph entities_touched stale_entities relationships_touched stale_relationships/><note/></forgotten>`, or in query mode `<forget_candidates query count forgotten="none" reason><candidate id type relevance [exact]>…</candidate><hint/></forget_candidates>`. Forgetting an already-forgotten memory is an error (use `hard: true` to purge it early).

## CLI Commands

All commands are invoked as `engram <command> [options]`.

### engram init

Initialize the database and download the embedding model.

```bash
engram init
```

Creates `~/.local/share/engram/engram.db` and downloads `nomic-ai/nomic-embed-text-v1.5` into
the model cache (`~/.local/share/engram/models` by default; `ENGRAM_MODEL_CACHE_DIR` or
`$HF_HOME/hub` when set), moving a pre-0.4.0 `node_modules` cache there first if one exists.

---

### engram sync

Sync and index conversations from Claude Code projects.

```bash
engram sync [options]
```

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Only sync a specific project |
| `-f, --force` | Force re-index all conversations |
| `-n, --dry-run` | Show what would be synced without indexing |

---

### engram search \<query\>

Search indexed conversations and memories.

```bash
engram search "database setup" [options]
```

| Flag | Description |
|------|-------------|
| `-l, --limit <n>` | Max results (default: `10`) |
| `-m, --mode <mode>` | Search mode: `hybrid`, `vector`, `text` (default: `hybrid`) |
| `--after <date>` | Only results on/after date (`YYYY-MM-DD`, UTC) |
| `--before <date>` | Only results before date (`YYYY-MM-DD`, UTC; that day excluded) |
| `--date-hint <phrase>` | Natural-language window (`"last week"`, `"in March"`, `"this day last year"`, `"on this day"`); explicit `--after`/`--before` win |
| `--date-basis <basis>` | `filed` (when recorded, default) or `event` (when the described events happened) |
| `--budget <tokens>` | Token budget for results (default: `1500`) |
| `--json` | Print the raw `RecallResponse` as JSON (ids, metadata, `dateFilter`) |
| `--no-reinforce` | Do not reinforce returned memories (skip the FSRS `access_count` / stability growth that a normal search records) |

---

### engram remember \<content\>

Store a fact, preference, or knowledge as a semantic memory.

```bash
engram remember "The project uses ESM modules" [options]
```

| Flag | Description |
|------|-------------|
| `-t, --type <type>` | Memory type: `preference`, `decision`, `pattern`, `fact`, `solution`, `convention` (default: `fact`) |
| `-i, --importance <n>` | Importance score 0-1 (default: `0.7`) |

Near-duplicate detection: if an existing memory has >= 0.95 cosine similarity, the existing memory is updated instead. Remembering a statement that was forgotten earlier lifts its extraction suppression.

---

### engram memories

Inspect and curate the semantic store (#55). Every write records `cli` as the actor in the change log.

```bash
engram memories list [--type t] [--scope a,b] [--since 2026-09-01] [--query text] [--deleted] [--inactive] [--limit n] [--json]
engram memories show <id>                       # full provenance; <id> may be a unique 6+ char prefix
engram memories edit <id> --content "<text>"    # re-embedded and re-indexed; before/after logged
engram memories delete <id> [--hard]            # alias: forget. Soft delete + retention; --hard purges
engram memories restore <id>                    # undo a forget inside the retention window
engram memories purge --conversation <id> [--hard]
engram memories log [--memory <id>] [--op forget|edit|purge|restore] [--limit n] [--json]
```

`show` prints the content, type, scope, `source` (extractor tier: `user`, `dream`, `rlm`, `import`, `hermes-mirror`), `extraction_basis`, status (active / forgotten by whom / superseded), FSRS stats (stored and composite confidence, importance, stability, retrievability, access count, whether an embedding is indexed), the source conversation(s) — id, title (summary), project, archive path usable as the `show` MCP tool's `path`, and each source exchange — the graph entities the memory evidences (with `stale_since` when flagged), and the memory's change log.

---

### engram extract \<conversation-id\>

Extract semantic facts from a specific conversation.

```bash
engram extract abc-123-def [options]
```

| Flag | Description |
|------|-------------|
| `--tier <tier>` | Extraction tier: `auto`, `haiku`, `sonnet` (default: `auto`) |
| `--reflexion` | Enable reflexion pass for completeness checking |
| `--dry-run` | Show extracted facts without consolidating |

---

### engram entities

List entities in the knowledge graph.

```bash
engram entities [options]
```

| Flag | Description |
|------|-------------|
| `-t, --type <type>` | Filter by entity type (`project`, `tool`, `technology`, `person`, `concept`, `file`, `repo`) |
| `-l, --limit <n>` | Max results (default: `20`) |
| `--search <query>` | Search entities by name (FTS) |

---

### engram relationships \<entity\>

Show relationships for a named entity.

```bash
engram relationships "SQLite" [options]
```

| Flag | Description |
|------|-------------|
| `-t, --type <type>` | Filter by relationship type (`uses`, `depends_on`, `related_to`, `part_of`, `configured_by`, `solved_by`) |

---

### engram explore \<entity\>

Explore entity connections in the knowledge graph (same as MCP `explore` tool).

```bash
engram explore "TypeScript" [options]
```

| Flag | Description |
|------|-------------|
| `-d, --depth <n>` | Traversal depth 1-3 (default: `1`) |
| `-t, --type <type>` | Filter by relationship type |

---

### engram dream

Run the dream state processing pipeline.

```bash
engram dream [options]
```

| Flag | Description |
|------|-------------|
| `--phase <phase>` | Run only a specific phase: `ingest`, `extract`, `consolidate`, `reflect`, `prune` |
| `--conversation <id>` | Process a specific conversation |
| `--dry-run` | Show what would be processed without changes |
| `--force` | Re-extract conversations even when unchanged since their last extraction (ignores the extract fingerprint) |
| `--verbose` | Show detailed progress |

**Extract fingerprint.** Each successful extract checkpoint stores a sha256 over the conversation's exchanges (id, index, timestamp and message text). On later runs a conversation whose fingerprint is unchanged is skipped — an added, removed, re-timestamped or edited exchange (including a same-length in-place edit from `ingest_turn`) changes it. `--force` ignores the fingerprint.

**Report.** The summary printed at the end (and the `DreamReport` returned by `runDream`) carries per-phase items/errors/duration plus `New memories`, `Updated memories`, `New entities`, `New relationships`, `Conflicts`, `Pruned`, `Skipped unchanged` (`skippedUnchanged`: conversations skipped by fingerprint), `Collapsed dupes` (`collapsedCandidates`: candidate facts folded into a near-duplicate sibling before insertion, across the run and within each batch) and `Commitments`.

**Failure classification.** Every LLM call walks the tier cascade (Ollama → OpenRouter → Anthropic). When all tiers fail the error names each tier and its reason (a config skip such as a missing key or un-pulled model, or a runtime failure such as an OpenRouter 401), and that text is what an extract/consolidate error checkpoint's `error_message` records — one checkpoint row per conversation per run, `attempt_count` incremented on retry.

---

### engram reflect

Show knowledge graph reflection and emergent patterns (same as MCP `reflect` tool).

```bash
engram reflect [options]
```

| Flag | Description |
|------|-------------|
| `-m, --mode <mode>` | Focus: `communities`, `bridges`, `temporal`, `health`, `all` (default: `all`) |
| `--refresh` | Force fresh analysis (slower) |

---

### engram stats

Show database statistics — exchange counts, memory counts, graph size, and last sync time.

```bash
engram stats
engram stats --json   # {"db", "size", "counts": {exchanges, conversations, tool_calls, memories_active, ...}}
```

`--json` prints the row counts `engram update` snapshots before an upgrade and compares after it.

---

### engram backfill-event-ts

Recover `memories.event_ts` (the `event` date basis) for legacy dream-extracted memories, whose `source_exchanges` hold model exchange indexes rather than ids. Uses the dream pipeline's `<dataDir>/tmp/pending-facts-*.json` files to map fact content → conversation → exchange timestamp (earliest evidence). Writes only `event_ts`, only where NULL; idempotent.

```bash
engram backfill-event-ts [--dry-run] [--tmp-dir <path>]
```

---

### engram update

Controlled self-update, modelled on `hermes update`: backup, stop services, pull or `npm install -g`, migrate, restart services (MCP before the Hermes plugin redeploy), verify.

```bash
engram update --check          # current vs available (git tag or npm dist-tag)
engram update --plan           # read-only plan; --dry-run is an alias
engram update [--yes] [--no-backup] [--to <version>]
```

| Flag | Description |
|------|-------------|
| `--check` | Print the installed version, the install kind, and the latest available version, then exit |
| `--plan`, `--dry-run` | Print install kind, every directory holding an `engram.db`, model cache, every service + restart command, plugin deploy targets, backup path, blockers, and the ordered steps. Changes nothing |
| `-y, --yes` | Skip the confirmation prompt (required when stdin is not a terminal) |
| `--no-backup` | Skip the pre-update copy of `engram.db` + WAL + `archive/` to `<data dir>.backup-<timestamp>` |
| `--to <version>` | Target version for npm installs (default: `dist-tags.latest`) |

Blockers (exit 1, nothing changed): a dirty git checkout, two directories both holding a database, a daemon answering on its port with no supervisor. On any failure after the code swap the command prints the rollback steps. Post-swap steps (`migrate schema`, `doctor --json`, `stats --json`) run the new build in a child process.

---

### engram migrate

Install/data migration (since 0.4.0). Idempotent and safe to re-run.

```bash
engram migrate [all|data-dir|model-cache|schema] [--dry-run]
```

| Topic | What it does |
|-------|--------------|
| `data-dir` | Lists every candidate data directory (effective, pre-0.2.0 `~/.local/share/engram`, platform default `%LOCALAPPDATA%\engram` / `$XDG_DATA_HOME/engram`) and whether it holds a database. Moves `engram.db` (+ `-wal`/`-shm`), `archive/`, `logs/`, `tmp/` into the effective dir when only a legacy dir is populated; refuses when two dirs both hold a database; leaves `ENGRAM_DB_PATH` installs alone. Refuses to move while the MCP daemon answers on its port |
| `model-cache` | Moves a pre-0.4.0 cache out of `node_modules/@xenova/transformers/.cache` into the resolved cache dir (`ENGRAM_MODEL_CACHE_DIR` → `$HF_HOME/hub` → `<data dir>/models`); a no-op with a message once the default applies and nothing legacy is left. An explicit `ENGRAM_MODEL_CACHE_DIR` inside `node_modules` is relocated to `<data dir>/models`, with the env line appended to `~/.config/engram/env` when that file exists |
| `schema` | Opens the database once so schema migrations run, then lists the `schema_migrations` checkpoints |

`--dry-run` lists every action without changing anything. `engram migrate --source <path>` is the deprecated spelling of `engram import-legacy` and forwards with a notice.

---

### engram import-legacy

Import a legacy conversation-index SQLite database (was `engram migrate --source` before 0.4.0).

```bash
engram import-legacy --source <path> [options]
```

| Flag | Description |
|------|-------------|
| `-s, --source <path>` | Source database path (required; no default) |
| `-n, --dry-run` | Show what would be imported without changes |
| `--batch-size <n>` | Embedding batch size (default: `32`) |
| `--force` | Force re-import (ignore checkpoints) |

---

### engram validate

Validate store integrity: embedding dimensions/norms, FTS5 integrity, reference-query search quality, and (#55) that no `vec_memories` / `memories_fts` rows exist for forgotten or missing memories. With `--source`, the row-count and content checks against a legacy conversation-index database run as well.

```bash
engram validate [options]
```

| Flag | Description |
|------|-------------|
| `-s, --source <path>` | Legacy source database to compare against (optional) |
| `--fix` | Repair orphaned memory index rows: vectors are deleted by id; the FTS index is rebuilt and every forgotten memory re-unindexed. The report then shows the repaired state |

Exit status 1 when any check fails.

---

### engram mcp

Start the MCP server on stdio transport. Used by Claude Code to communicate with Engram.

```bash
engram mcp
```

This is typically not invoked directly — Claude Code launches it via the MCP configuration.

---

### engram export

Export memories, entities, relationships and commitments as JSONL v1 (embeddings are not exported).

```bash
engram export [options] > engram.jsonl
```

| Flag | Description |
|------|-------------|
| `-o, --out <file>` | Write to a file instead of stdout |
| `-s, --scope <scope...>` | Only memories in these scopes (default: all scopes) |
| `--include-inactive` | Include superseded/inactive memories (default: active only) |
| `--kinds <list>` | Comma-separated record kinds: `memories,entities,relationships,commitments` (default: all four) |

**Format:** one JSON object per line. Line 1 is a header — `{"kind":"header","v":1,"exported_at","schema_version","counts","scopes","include_inactive","embeddings":"not exported; regenerated on import from content"}` — then one `{"kind":"memory"|"entity"|"relationship"|"commitment","v":1,"data":{…every column, JSON columns decoded, booleans as true/false}}` per row. Embeddings are deliberately omitted: they are model-specific and large, and the importing database regenerates them.

---

### engram import \<file\>

Import a JSONL v1 file produced by `engram export`.

```bash
engram import engram.jsonl [options]
```

| Flag | Description |
|------|-------------|
| `-s, --scope <scope>` | Override the scope on every imported memory |
| `-n, --dry-run` | Validate and report what would change without writing |

**Source values:** a memory record's `source` is one of `user`, `dream`, `rlm`, `import`, `hermes-mirror` and is preserved as exported; a record without one is imported as `import`.

**Idempotency:** records are matched by `id`. An existing row is updated in place only when the incoming record is newer — `updated_at` for memories and relationships, `last_seen` for entities, `resolved_at` for commitments (each falling back to `created_at`) — otherwise it is skipped, so re-importing the same file is a no-op. The whole file is parsed and validated before the first write; a malformed line aborts with nothing changed.

**Cost:** every imported memory and entity is re-embedded from its content and re-indexed into the FTS5 and vector tables, so importing is bounded by embedding throughput (roughly the speed of `engram sync`), not by file size.

---

### engram health

Check system health — database, embedding model, Ollama, MCP server, and tool availability.

```bash
engram health
```

---

### engram preflight

Native-dependency check for this Node ABI + platform + arch + libc, before or after install. Needs no database or models, so it also runs as `npx @devinmlowe/engram preflight` before `npm install -g`.

```bash
engram preflight                       # one line per native module + fix per OS
engram preflight --json                # structured result: target, deps[], loads[], failed, ok
engram preflight --strict              # exit 1 on any [FAIL]
engram preflight --expect prebuilt     # exit 1 unless every dependency is prebuilt (CI)
engram preflight --expect better-sqlite3=prebuilt,sqlite-vec=unsupported
```

Per dependency (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`) the verdict is `prebuilt`, `compiled locally` (a node-gyp build sits in `node_modules`), `will compile (needs python3 + C++ toolchain)` (predicted from the static table before install), `unsupported` (the dependency publishes no build for this target) or `unknown (<reason>)` (the probe could not tell; it never throws). Warn/fail lines are followed by `fix: …` (`xcode-select --install`, `sudo apt install build-essential python3`, `sudo dnf install gcc-c++ make python3`, `apk add build-base python3`, Visual Studio Build Tools + C++ workload) and `or: nvm use <major>` when a Node major without prebuilds is the cause. `npm_config_platform` / `npm_config_arch` / `npm_config_target_arch` / `npm_config_libc` override the target. The same script (`scripts/preflight.cjs`) runs as the npm `postinstall` hook; `ENGRAM_SKIP_PREFLIGHT=1` silences only the hook.

---

## Configuration Reference

All `EngramConfig` fields with their defaults:

```typescript
interface EngramConfig {
  // Data paths
  dataDir: string;              // ~/.local/share/engram
  dbPath: string;               // {dataDir}/engram.db
  archiveDir: string;           // {dataDir}/archive
  logsDir: string;              // {dataDir}/logs
  claudeProjectsDir: string;    // ~/.claude/projects

  // Embedding model
  embedding: {
    model: string;              // "nomic-ai/nomic-embed-text-v1.5"
    dimensions: number;         // 256 (Matryoshka truncation)
    maxTokens: number;          // 8192
  };

  // Search pipeline
  search: {
    defaultLimit: number;       // 10
    defaultBudget: number;      // 1500 tokens
    rrfK: number;               // 60 (RRF fusion constant)
    rerankEnabled: boolean;     // true
    reranker: {
      enabled: boolean;         // true
      model: string;            // "Xenova/bge-reranker-base"
      topK: number;             // 5
      blendWeight: number;      // 0.7
    };
  };

  // Dream state processing
  dream: {
    localModel?: string;        // Ollama model tag (ENGRAM_LOCAL_MODEL; default qwen2.5:7b at call time)
    localModelFallbacks?: string[]; // Ollama tags tried in order when localModel is not pulled (ENGRAM_LOCAL_MODEL_FALLBACKS)
    openrouterModel?: string;   // OpenRouter model id (ENGRAM_OPENROUTER_MODEL)
    apiModel: string;           // "claude-haiku-4-5-20251001"
    apiFallbackModel: string;   // "claude-sonnet-4-6"
    concurrency: number;        // 1
    scheduleHour: number;       // 2 (2 AM)
    chunkingStrategy: "fixed" | "adaptive"; // ENGRAM_CHUNKING_STRATEGY, default "fixed"
  };

  // Confidence decay rates per memory type
  decay: {
    preference: number;         // 0.01
    decision: number;           // 0.02
    fact: number;               // 0.05
    pattern: number;            // 0.005
    solution: number;           // 0.03
    convention: number;         // 0.015
  };

  // Forget tool (#55 / #56)
  forget: {
    retentionDays: number;      // ENGRAM_FORGET_RETENTION_DAYS, default 30; 0 = purge on the next prune
  };
}
```
