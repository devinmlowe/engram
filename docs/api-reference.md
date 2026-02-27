# Engram API Reference

Complete reference for MCP tools, CLI commands, and configuration.

---

## MCP Tools

Engram exposes 5 tools via the Model Context Protocol. These are used automatically by Claude Code when Engram is registered as an MCP server.

### recall

Retrieve relevant memories from past conversations and extracted knowledge. Uses hybrid semantic + keyword search with token-budgeted output.

**Input Schema:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query (min 2 characters) |
| `budget` | number | no | `1500` | Max tokens in response (100-5000) |
| `after` | string | no | — | Only results after date (`YYYY-MM-DD`) |
| `before` | string | no | — | Only results before date (`YYYY-MM-DD`) |
| `depth` | string | no | `"shallow"` | `"shallow"` or `"deep"` |
| `sources` | string[] | no | `["episodic", "semantic"]` | Memory stores to search: `"episodic"`, `"semantic"`, `"graph"` |

**Output:** XML-formatted results within the token budget.

```xml
<engram_recall query="database setup" results="3" tokens="842">
  <memory type="decision" confidence="0.85" importance="0.7">
    The project uses better-sqlite3 with sqlite-vec for the database layer, with no ORM.
  </memory>
  <exchange project="engram" date="2026-02-15" score="0.72">
    User: Let's use SQLite with WAL mode...
  </exchange>
</engram_recall>
```

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

## CLI Commands

All commands are invoked as `engram <command> [options]`.

### engram init

Initialize the database and download the embedding model.

```bash
engram init
```

Creates `~/.local/share/engram/engram.db` and downloads `nomic-ai/nomic-embed-text-v1.5`.

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
| `--after <date>` | Only results after date (`YYYY-MM-DD`) |
| `--before <date>` | Only results before date (`YYYY-MM-DD`) |
| `--budget <tokens>` | Token budget for results (default: `1500`) |

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

Near-duplicate detection: if an existing memory has >= 0.95 cosine similarity, the existing memory is updated instead.

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
| `--verbose` | Show detailed progress |

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
```

---

### engram migrate

Migrate data from the superpowers conversation-index database.

```bash
engram migrate [options]
```

| Flag | Description |
|------|-------------|
| `-s, --source <path>` | Source database path (default: `~/.config/superpowers/conversation-index/db.sqlite`) |
| `-n, --dry-run` | Show what would be migrated without changes |
| `--batch-size <n>` | Embedding batch size (default: `32`) |
| `--force` | Force re-migration (ignore checkpoints) |

---

### engram validate

Validate migration integrity by comparing source and target databases.

```bash
engram validate [options]
```

| Flag | Description |
|------|-------------|
| `-s, --source <path>` | Source database path (default: `~/.config/superpowers/conversation-index/db.sqlite`) |

---

### engram mcp

Start the MCP server on stdio transport. Used by Claude Code to communicate with Engram.

```bash
engram mcp
```

This is typically not invoked directly — Claude Code launches it via the MCP configuration.

---

### engram health

Check system health — database, embedding model, Ollama, MCP server, and tool availability.

```bash
engram health
```

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
    localModel?: string;        // MLX model path (optional)
    apiModel: string;           // "claude-haiku-4-5-20251001"
    apiFallbackModel: string;   // "claude-sonnet-4-6"
    concurrency: number;        // 1
    scheduleHour: number;       // 2 (2 AM)
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
}
```
