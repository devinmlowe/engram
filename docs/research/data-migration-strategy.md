# Data Migration Strategy: Superpowers DB to Engram DB

**Phase 2 Research** | 2026-02-26
**Referenced from**: [spec.md (Phase 2)](../../spec.md) | [score-normalization.md](../score-normalization.md)

## Overview

Migrate 7,660 exchanges and 145,386 tool calls from the existing `superpowers/conversation-index` SQLite database to the new Engram schema. This requires re-embedding all exchanges at 256 dimensions (nomic-embed-text-v1.5 via Matryoshka truncation), building FTS5 full-text indexes, deriving new fields not present in the source, and validating correctness.

### Source Database

- **Path**: `~/.config/superpowers/conversation-index/db.sqlite`
- **Exchanges**: 7,660 rows across 1,502 conversations and 36 projects
- **Tool calls**: 145,386 rows
- **Embeddings**: 384 dimensions (all-MiniLM-L6-v2), stored in `vec_exchanges` (sqlite-vec)
- **No FTS5 tables** -- text search was LIKE-based
- **Average exchange text size**: ~3,480 characters (user + assistant combined)
- **Max exchange text size**: ~725,794 characters

### Target Database

- **Path**: `~/.local/share/engram/engram.db`
- **Embeddings**: 256 dimensions (nomic-embed-text-v1.5, Matryoshka-truncated)
- **FTS5**: `exchanges_fts` virtual table with Porter stemming
- **New tables**: `conversations`, dream state tracking
- **New fields**: `conversation_id`, `exchange_index`, `token_estimate`, `model_version`

---

## 1. Batch Embedding Strategy

### The @xenova/transformers Pipeline API

The project uses `@xenova/transformers` v2.17.x (the v2 package maintained under the Xenova namespace, still the most common for Node.js ESM projects). The `pipeline` API for feature extraction accepts both single strings and arrays of strings for batch processing.

**Key insight**: The pipeline call `await extractor(texts, { pooling: 'mean', normalize: true })` accepts an array of strings, returning a `Tensor` of shape `[batchSize, dimensions]`. However, for nomic-embed-text-v1.5 with Matryoshka truncation, we must apply `layer_norm` + slice + renormalize _after_ the pipeline call, which means we need the raw 768-dim output first.

### Matryoshka Truncation in @xenova/transformers

The correct procedure for producing 256-dim embeddings from nomic-embed-text-v1.5:

```typescript
import { pipeline, layer_norm, type FeatureExtractionPipeline } from "@xenova/transformers";

const extractor = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5");

const MATRYOSHKA_DIM = 256;

async function embedBatch(texts: string[]): Promise<number[][]> {
  // 1. Get raw 768-dim embeddings with mean pooling (no normalize yet)
  const raw = await extractor(texts, { pooling: "mean", normalize: false });

  // 2. Apply layer_norm (required by nomic before MRL truncation)
  const normed = layer_norm(raw, [raw.dims[1]]);

  // 3. Slice to Matryoshka dimension
  const sliced = normed.slice(null, [0, MATRYOSHKA_DIM]);

  // 4. L2-normalize the truncated vectors
  const final = sliced.normalize(2, -1);

  // 5. Convert to array of arrays
  return final.tolist() as number[][];
}
```

**Important**: The existing `embeddings.ts` in the Engram codebase uses `normalize: true` in the pipeline call and then does a manual slice + L2-normalize. This skips the `layer_norm` step. The Nomic model card [explicitly states](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) that `layer_norm` must be applied before truncation. The migration script should use the correct procedure, and `embeddings.ts` should be updated in Phase 2 to match.

### Batch Processing Design

The pipeline processes inputs sequentially through the ONNX runtime. Passing multiple texts at once allows the runtime to batch internally, but the dominant cost for 7,660 exchanges is the inference itself, not the overhead.

```typescript
interface MigrationBatchConfig {
  /** Number of exchanges to embed in one pipeline call */
  embeddingBatchSize: number;

  /** Number of exchanges to INSERT in one SQLite transaction */
  dbBatchSize: number;

  /** How often to write a checkpoint (in exchanges) */
  checkpointInterval: number;
}

const DEFAULT_CONFIG: MigrationBatchConfig = {
  embeddingBatchSize: 32,
  dbBatchSize: 500,
  checkpointInterval: 500,
};
```

### Optimal Batch Sizes for M4 MacMini (16GB Unified Memory)

The M4 MacMini has 16GB unified memory shared between CPU and GPU. The ONNX runtime in Node.js uses the CPU backend (WASM or native). Key memory considerations:

- **Model weight memory**: nomic-embed-text-v1.5 ONNX model is ~130MB in memory
- **Per-text working memory**: Each input text tokenizes to up to 8,192 tokens. At ~4 bytes per token with attention matrices, a single long input can consume ~200MB transiently.
- **Batch memory scaling**: Memory scales roughly linearly with batch size for the attention computation.

**Recommended embedding batch sizes** (conservative for 16GB):

| Avg text length | Recommended batch size | Peak memory estimate |
|-----------------|----------------------|---------------------|
| < 1,000 chars   | 64                   | ~500MB              |
| 1,000-4,000 chars | 32                 | ~800MB              |
| 4,000-8,000 chars | 16                 | ~1.2GB              |
| > 8,000 chars   | 8                    | ~1.5GB              |

Given the average exchange is ~3,480 chars, **a batch size of 32 is recommended as the default**. The migration script should adaptively reduce batch size if it encounters very long exchanges.

### Expected Throughput

Based on published benchmarks and the characteristics of the M4:

- **nomic-embed-text-v1.5 on Apple Silicon (CPU/WASM)**: ~20-40ms per text for average-length inputs
- **With batch size 32**: ~400-800ms per batch, or ~40-80 texts/second
- **For 7,660 exchanges**: Estimated 96-192 seconds (1.6-3.2 minutes) for embedding only
- **With DB writes and overhead**: Estimated 3-5 minutes total

The first run will be slower due to model download and ONNX session initialization (~30-60 seconds). Subsequent runs (if using checkpoint/resume) skip the download.

### Checkpoint and Resume

For a 3-5 minute migration, checkpoint/resume is a reliability measure rather than a necessity. However, it protects against crashes and allows incremental re-runs.

```typescript
interface MigrationCheckpoint {
  /** Last successfully processed exchange ID */
  lastExchangeId: string;
  /** Total exchanges processed so far */
  processedCount: number;
  /** Timestamp of last checkpoint */
  timestamp: number;
  /** Phase: 'embedding' | 'fts' | 'validation' */
  phase: string;
}

const CHECKPOINT_TABLE = `
  CREATE TABLE IF NOT EXISTS migration_checkpoints (
    id TEXT PRIMARY KEY DEFAULT 'current',
    last_exchange_id TEXT NOT NULL,
    processed_count INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    phase TEXT NOT NULL
  )
`;
```

The migration reads all source exchange IDs, then queries the checkpoint table to find where to resume:

```typescript
async function migrateExchanges(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  config: MigrationBatchConfig,
  onProgress?: (progress: MigrationProgress) => void,
): Promise<void> {
  // Get all source exchange IDs, ordered for deterministic processing
  const allIds: string[] = sourceDb
    .prepare("SELECT id FROM exchanges ORDER BY timestamp ASC, id ASC")
    .all()
    .map((row: any) => row.id);

  // Check for existing checkpoint
  const checkpoint = getCheckpoint(targetDb);
  let startIndex = 0;

  if (checkpoint && checkpoint.phase === "embedding") {
    const lastIdx = allIds.indexOf(checkpoint.lastExchangeId);
    if (lastIdx >= 0) {
      startIndex = lastIdx + 1;
      console.log(
        `Resuming from checkpoint: ${checkpoint.processedCount} exchanges already processed`,
      );
    }
  }

  const totalToProcess = allIds.length - startIndex;
  let processed = checkpoint?.processedCount ?? 0;
  let errors = 0;

  // Process in batches
  for (let i = startIndex; i < allIds.length; i += config.embeddingBatchSize) {
    const batchIds = allIds.slice(i, i + config.embeddingBatchSize);

    // Read source exchanges
    const sourceExchanges = readSourceBatch(sourceDb, batchIds);

    // Build embedding input texts with contextual prefix
    const texts = sourceExchanges.map((ex) => buildEmbeddingText(ex));

    // Batch embed
    const embeddings = await embedBatch(texts);

    // Write to target DB in a transaction
    const targetTransaction = targetDb.transaction(() => {
      for (let j = 0; j < sourceExchanges.length; j++) {
        const source = sourceExchanges[j];
        const embedding = embeddings[j];
        const targetExchange = mapSourceToTarget(source);
        insertExchange(targetDb, targetExchange, embedding, []);
      }
    });
    targetTransaction();

    processed += batchIds.length;

    // Checkpoint
    if (processed % config.checkpointInterval === 0) {
      saveCheckpoint(targetDb, {
        lastExchangeId: batchIds[batchIds.length - 1],
        processedCount: processed,
        timestamp: Date.now(),
        phase: "embedding",
      });
    }

    // Progress callback
    onProgress?.({
      phase: "embedding",
      total: allIds.length,
      processed,
      errors,
      estimatedSecondsRemaining: estimateRemaining(processed, allIds.length, startTime),
    });
  }
}
```

### Progress Tracking

```typescript
interface MigrationProgress {
  phase: "embedding" | "tool_calls" | "fts" | "validation";
  total: number;
  processed: number;
  errors: number;
  estimatedSecondsRemaining?: number;
}

function formatProgress(p: MigrationProgress): string {
  const pct = ((p.processed / p.total) * 100).toFixed(1);
  const eta = p.estimatedSecondsRemaining
    ? ` | ETA: ${Math.ceil(p.estimatedSecondsRemaining)}s`
    : "";
  return `[${p.phase}] ${p.processed}/${p.total} (${pct}%)${eta} | errors: ${p.errors}`;
}
```

---

## 2. Schema Mapping

### Field-by-Field Comparison

| Source Field | Target Field | Mapping Strategy |
|-------------|-------------|-----------------|
| `id` | `id` | **Direct copy** -- MD5 hash of `archive_path:line_start-line_end` |
| `project` | `project` | **Transform** -- apply `extractProjectName()` to clean encoded paths |
| `timestamp` | `timestamp` | **Direct copy** -- ISO 8601 |
| `user_message` | `user_message` | **Direct copy** |
| `assistant_message` | `assistant_message` | **Direct copy** |
| `archive_path` | _(dropped)_ | Used to derive `conversation_id`; stored in `conversations.archive_path` |
| `line_start` | _(dropped)_ | Not needed in new schema |
| `line_end` | _(dropped)_ | Not needed in new schema |
| `parent_uuid` | _(dropped)_ | Sidechain tracking not in new schema |
| `is_sidechain` | _(dropped)_ | 7,660 rows; 0 sidechains. Could be used as filter during migration if needed. |
| `session_id` | `session_id` | **Direct copy** |
| `cwd` | `cwd` | **Direct copy** |
| `git_branch` | `git_branch` | **Direct copy** |
| `claude_version` | `model_version` | **Rename** -- map `claude_version` (e.g., "2.0.76") to `model_version` |
| `thinking_level` | _(dropped)_ | Not in target schema; could be stored as metadata later |
| `thinking_disabled` | _(dropped)_ | Not in target schema |
| `thinking_triggers` | _(dropped)_ | Not in target schema |
| `embedding` | _(re-embedded)_ | Discarded; new embedding computed with nomic-embed-text-v1.5 @ 256 dims |
| _(new)_ | `conversation_id` | **Derived** from `archive_path` (see below) |
| _(new)_ | `exchange_index` | **Computed** -- sequential position within conversation |
| _(new)_ | `token_estimate` | **Computed** -- heuristic from text length |

### Deriving `conversation_id` from Source Data

The source has no `conversations` table. Each exchange has an `archive_path` like:

```
/Users/USER/.config/superpowers/conversation-archive/-Users-devinmlowe-Documents-git-engram/78ff1399-2d22-4859-bbf2-e4273dfc2b9d.jsonl
```

The conversation ID is the filename without the `.jsonl` extension. There are 1,502 unique conversation IDs across 7,660 exchanges.

```typescript
import { basename } from "node:path";

function deriveConversationId(archivePath: string): string {
  // "78ff1399-2d22-4859-bbf2-e4273dfc2b9d.jsonl" -> "78ff1399-2d22-4859-bbf2-e4273dfc2b9d"
  // "agent-a4ac4fa.jsonl" -> "agent-a4ac4fa"
  return basename(archivePath, ".jsonl");
}

function deriveProject(archivePath: string): string {
  // Extract the project directory segment from the archive path
  // ".../conversation-archive/-Users-devinmlowe-Documents-git-engram/file.jsonl"
  // -> "-Users-devinmlowe-Documents-git-engram"
  // -> "engram" (via extractProjectName)
  const dir = basename(dirname(archivePath));
  return extractProjectName(dir);
}
```

### Computing `exchange_index`

The source stores `line_start` which gives ordering within a conversation. Use this to assign sequential indexes:

```typescript
function computeExchangeIndexes(
  sourceDb: Database.Database,
): Map<string, number> {
  const rows = sourceDb
    .prepare(
      `SELECT id, archive_path, line_start
       FROM exchanges
       ORDER BY archive_path, line_start ASC`,
    )
    .all() as { id: string; archive_path: string; line_start: number }[];

  const indexMap = new Map<string, number>();
  let currentConv = "";
  let idx = 0;

  for (const row of rows) {
    const convId = deriveConversationId(row.archive_path);
    if (convId !== currentConv) {
      currentConv = convId;
      idx = 0;
    }
    indexMap.set(row.id, idx);
    idx++;
  }

  return indexMap;
}
```

### Estimating Token Counts

The existing Engram parser already uses the `characters / 4` heuristic, which is the standard approximation for English text with ~10% accuracy:

```typescript
function estimateTokens(userMessage: string, assistantMessage: string): number {
  // Standard heuristic: 1 token ~= 4 characters for English text
  // Anthropic suggests 1 token ~= 3.5 chars; 4 is slightly conservative
  return Math.ceil((userMessage.length + assistantMessage.length) / 4);
}
```

This matches the parser's existing logic and is sufficient for budget estimation purposes. For more accurate counts, [tokenx](https://github.com/johannschopplich/tokenx) provides ~96% accuracy in a 2kB bundle, but the extra dependency is not justified for estimates.

### Building the Conversations Table

The source has no conversations table, so it must be built from exchange aggregations:

```typescript
function buildConversations(
  sourceDb: Database.Database,
): Map<string, Conversation> {
  const rows = sourceDb
    .prepare(
      `SELECT
         archive_path,
         project,
         MIN(timestamp) as started_at,
         MAX(timestamp) as ended_at,
         COUNT(*) as exchange_count
       FROM exchanges
       GROUP BY archive_path`,
    )
    .all() as {
    archive_path: string;
    project: string;
    started_at: string;
    ended_at: string;
    exchange_count: number;
  }[];

  const conversations = new Map<string, Conversation>();
  for (const row of rows) {
    const id = deriveConversationId(row.archive_path);
    conversations.set(id, {
      id,
      project: deriveProject(row.archive_path),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exchangeCount: row.exchange_count,
      archivePath: row.archive_path,
      lastIndexed: Math.floor(Date.now() / 1000),
    });
  }
  return conversations;
}
```

### Tool Calls Migration

The tool calls schema is nearly identical between source and target. The main difference is that the source has `tool_result` (full result text) while the target has `tool_result_summary` (truncated). Truncate on migration:

```typescript
function mapToolCall(source: any): ToolCall {
  return {
    id: source.id,
    exchangeId: source.exchange_id,
    toolName: source.tool_name,
    toolInput: source.tool_input
      ? source.tool_input.substring(0, 1000)
      : undefined,
    toolResultSummary: source.tool_result
      ? source.tool_result.substring(0, 500)
      : undefined,
    isError: Boolean(source.is_error),
    timestamp: source.timestamp,
  };
}
```

---

## 3. FTS5 Bulk Indexing

### Strategy: Insert First, Rebuild After

FTS5 offers two approaches for populating an external-content table after bulk insert:

1. **Incremental**: Insert FTS entries alongside each exchange insert (current approach in `store.ts`)
2. **Rebuild**: Insert all exchange rows first, then run `INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`

For migration, **rebuild is strongly recommended** because:

- The `rebuild` command reads all rows from the content table and rebuilds the entire FTS index in a single pass
- It is 3-10x faster than incremental inserts for bulk operations because it can optimize segment merging
- It avoids the overhead of maintaining the FTS index during each individual insert
- It produces a more compact, optimized index structure (fewer segments to merge later)

### Implementation

```typescript
function migrateFTS(targetDb: Database.Database): void {
  // Step 1: Ensure all exchange rows are committed
  // (should already be done in the embedding phase)

  // Step 2: Rebuild FTS5 index from content table
  console.log("Rebuilding FTS5 index from exchange content...");
  const start = Date.now();

  targetDb.exec(
    `INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`,
  );

  const elapsed = Date.now() - start;
  console.log(`FTS5 rebuild completed in ${elapsed}ms`);

  // Step 3: Optimize the FTS index (merge all segments into one)
  targetDb.exec(
    `INSERT INTO exchanges_fts(exchanges_fts) VALUES('optimize')`,
  );
}
```

### FTS5 Performance Notes

- The `rebuild` command for 7,660 rows should complete in under 2 seconds on M4
- The `optimize` command merges all index segments into a single segment, which improves query performance. It should be run after the initial bulk load.
- FTS5 uses `porter unicode61` tokenizer which handles stemming (e.g., "running" matches "run") and Unicode normalization
- The `content='exchanges'` clause makes this an [external-content table](https://sqlite.org/fts5.html#external_content_tables) -- the FTS index does not store the original text, only the index structures. This saves significant disk space since the text already lives in the `exchanges` table.

### Keeping FTS in Sync After Migration

After the initial rebuild, ongoing inserts must keep FTS in sync. The existing `insertExchange()` in `store.ts` already handles this correctly using the manual FTS5 delete+insert pattern for external-content tables. No changes needed for ongoing operations.

---

## 4. Data Validation

### 4.1 Row Count Verification

The simplest and most critical check. Every source row should appear in the target.

```typescript
interface ValidationResult {
  check: string;
  passed: boolean;
  expected: number | string;
  actual: number | string;
  details?: string;
}

function validateRowCounts(
  sourceDb: Database.Database,
  targetDb: Database.Database,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Exchange count
  const srcExchanges = sourceDb
    .prepare("SELECT COUNT(*) as cnt FROM exchanges")
    .get() as { cnt: number };
  const tgtExchanges = targetDb
    .prepare("SELECT COUNT(*) as cnt FROM exchanges")
    .get() as { cnt: number };

  results.push({
    check: "Exchange count",
    passed: srcExchanges.cnt === tgtExchanges.cnt,
    expected: srcExchanges.cnt,
    actual: tgtExchanges.cnt,
  });

  // Tool call count
  const srcTools = sourceDb
    .prepare("SELECT COUNT(*) as cnt FROM tool_calls")
    .get() as { cnt: number };
  const tgtTools = targetDb
    .prepare("SELECT COUNT(*) as cnt FROM tool_calls")
    .get() as { cnt: number };

  results.push({
    check: "Tool call count",
    passed: srcTools.cnt === tgtTools.cnt,
    expected: srcTools.cnt,
    actual: tgtTools.cnt,
  });

  // Conversation count (derived from source archive_path)
  const srcConvs = sourceDb
    .prepare("SELECT COUNT(DISTINCT archive_path) as cnt FROM exchanges")
    .get() as { cnt: number };
  const tgtConvs = targetDb
    .prepare("SELECT COUNT(*) as cnt FROM conversations")
    .get() as { cnt: number };

  results.push({
    check: "Conversation count",
    passed: srcConvs.cnt === tgtConvs.cnt,
    expected: srcConvs.cnt,
    actual: tgtConvs.cnt,
  });

  // Vector embedding count
  const tgtVecs = targetDb
    .prepare("SELECT COUNT(*) as cnt FROM vec_exchanges")
    .get() as { cnt: number };

  results.push({
    check: "Vector embedding count",
    passed: tgtVecs.cnt === tgtExchanges.cnt,
    expected: tgtExchanges.cnt,
    actual: tgtVecs.cnt,
  });

  return results;
}
```

### 4.2 Embedding Dimension Verification

Verify that all stored embeddings have the correct dimensionality and are properly normalized:

```typescript
function validateEmbeddings(
  targetDb: Database.Database,
  sampleSize: number = 100,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Sample random embeddings and check dimensions
  const samples = targetDb
    .prepare(
      `SELECT id, embedding FROM vec_exchanges ORDER BY RANDOM() LIMIT ?`,
    )
    .all(sampleSize) as { id: string; embedding: Buffer }[];

  let dimensionErrors = 0;
  let normErrors = 0;

  for (const sample of samples) {
    const vec = new Float32Array(
      sample.embedding.buffer,
      sample.embedding.byteOffset,
      sample.embedding.byteLength / 4,
    );

    // Check dimension
    if (vec.length !== 256) {
      dimensionErrors++;
    }

    // Check L2 norm (should be ~1.0 for normalized vectors)
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (Math.abs(norm - 1.0) > 0.01) {
      normErrors++;
    }
  }

  results.push({
    check: `Embedding dimensions (sample of ${sampleSize})`,
    passed: dimensionErrors === 0,
    expected: "256 dims for all",
    actual: dimensionErrors === 0 ? "All correct" : `${dimensionErrors} incorrect`,
  });

  results.push({
    check: `Embedding L2 normalization (sample of ${sampleSize})`,
    passed: normErrors === 0,
    expected: "L2 norm ~1.0 for all",
    actual: normErrors === 0 ? "All correct" : `${normErrors} unnormalized`,
  });

  return results;
}
```

### 4.3 Content Integrity

Verify that text content was transferred without corruption:

```typescript
function validateContent(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  sampleSize: number = 200,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Sample exchanges and compare content
  const sourceRows = sourceDb
    .prepare(
      `SELECT id, user_message, assistant_message
       FROM exchanges ORDER BY RANDOM() LIMIT ?`,
    )
    .all(sampleSize) as {
    id: string;
    user_message: string;
    assistant_message: string;
  }[];

  let mismatches = 0;
  let missing = 0;

  for (const src of sourceRows) {
    const tgt = targetDb
      .prepare("SELECT user_message, assistant_message FROM exchanges WHERE id = ?")
      .get(src.id) as { user_message: string; assistant_message: string } | undefined;

    if (!tgt) {
      missing++;
      continue;
    }

    if (tgt.user_message !== src.user_message || tgt.assistant_message !== src.assistant_message) {
      mismatches++;
    }
  }

  results.push({
    check: `Content integrity (sample of ${sampleSize})`,
    passed: mismatches === 0 && missing === 0,
    expected: "All content matches",
    actual:
      mismatches === 0 && missing === 0
        ? "All correct"
        : `${missing} missing, ${mismatches} mismatched`,
  });

  return results;
}
```

### 4.4 FTS5 Index Integrity

Verify that the FTS index returns results for known content:

```typescript
function validateFTS(
  targetDb: Database.Database,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Pick a few exchanges and verify they appear in FTS results
  const samples = targetDb
    .prepare(
      `SELECT id, user_message FROM exchanges
       WHERE LENGTH(user_message) > 50
       ORDER BY RANDOM() LIMIT 20`,
    )
    .all() as { id: string; user_message: string }[];

  let ftsHits = 0;

  for (const sample of samples) {
    // Extract a distinctive phrase (first 3 non-trivial words)
    const words = sample.user_message
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);

    if (words.length === 0) continue;

    const query = words.join(" ");
    const ftsResult = targetDb
      .prepare(
        `SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH ? LIMIT 5`,
      )
      .all(query) as { rowid: number }[];

    if (ftsResult.length > 0) ftsHits++;
  }

  results.push({
    check: "FTS5 index returns results for known content",
    passed: ftsHits >= samples.length * 0.8, // Allow some misses due to tokenization
    expected: `>= ${Math.floor(samples.length * 0.8)} hits out of ${samples.length}`,
    actual: `${ftsHits} hits`,
  });

  // Verify FTS index integrity command
  const integrity = targetDb
    .prepare(
      `INSERT INTO exchanges_fts(exchanges_fts, rank) VALUES('integrity-check', 1)`,
    );
  let integrityPassed = true;
  try {
    integrity.run();
  } catch {
    integrityPassed = false;
  }

  results.push({
    check: "FTS5 integrity check",
    passed: integrityPassed,
    expected: "No errors",
    actual: integrityPassed ? "Passed" : "Failed",
  });

  return results;
}
```

### 4.5 Search Quality Comparison

Compare retrieval rankings between old and new systems for a set of reference queries:

```typescript
const REFERENCE_QUERIES = [
  "SQLite WAL mode performance",
  "Fish shell configuration",
  "embedding model nomic",
  "daemon process launchd",
  "git worktree workflow",
  "tmux pane management",
  "TypeScript type inference",
  "MCP server tools",
];

async function validateSearchQuality(
  sourceDb: Database.Database,
  targetDb: Database.Database,
): Promise<void> {
  console.log("\n=== Search Quality Comparison ===\n");

  for (const query of REFERENCE_QUERIES) {
    // Query source (vector only, since source has no FTS)
    const sourceResults = querySourceVec(sourceDb, query, 5);

    // Query target (hybrid vector + FTS)
    const targetResults = queryTargetHybrid(targetDb, query, 5);

    // Compare overlap in top-5 results
    const sourceIds = new Set(sourceResults.map((r) => r.id));
    const targetIds = new Set(targetResults.map((r) => r.id));
    const overlap = [...sourceIds].filter((id) => targetIds.has(id)).length;

    console.log(`Query: "${query}"`);
    console.log(`  Source top-5 IDs: ${[...sourceIds].join(", ")}`);
    console.log(`  Target top-5 IDs: ${[...targetIds].join(", ")}`);
    console.log(`  Overlap: ${overlap}/5 (${(overlap / 5) * 100}%)`);
    console.log();
  }
}
```

**Expected outcome**: The new embeddings (nomic @ 256 dims) should produce _different but better_ rankings compared to the old embeddings (MiniLM @ 384 dims), because:
- nomic-embed-text-v1.5 has higher BEIR accuracy (86.2% vs 78.1%)
- Contextual prefixes (project, date, branch) improve retrieval by ~49% (per Anthropic's contextual retrieval paper)
- FTS5 adds keyword matching that catches cases where vector search misses exact terms

Overlap of 40-60% between old and new top-5 results is a healthy sign -- it means the new model is finding relevant results while also surfacing ones the old model missed.

---

## 5. Transaction Management

### SQLite WAL Mode Configuration

The Engram database already uses WAL mode with optimal settings:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

Key properties of WAL mode for bulk operations:
- **Readers do not block writers** and vice versa -- safe to query during migration
- **`synchronous = NORMAL`** avoids fsync on most commits, yielding ~2-20x speedup over DELETE journal mode
- **WAL checkpoint** happens automatically but can cause pauses. For bulk inserts, manual checkpointing after completion is preferred.

### Optimal Transaction Sizes

For SQLite bulk inserts with WAL mode, the literature and benchmarks converge on these guidelines:

| Batch size | Throughput | Notes |
|-----------|-----------|-------|
| 1 (autocommit) | ~50-100 inserts/sec | Terrible -- each insert is a transaction |
| 100 | ~10,000 inserts/sec | Good for interactive use |
| 1,000 | ~20,000-40,000 inserts/sec | Optimal for most workloads |
| 10,000 | ~30,000-50,000 inserts/sec | Marginal improvement over 1,000 |
| 100,000 | ~30,000-50,000 inserts/sec | WAL file grows large; risk of long rollback |

**Recommendation**: Use **500 rows per transaction** for exchange inserts (each exchange insert involves the exchanges table, vec_exchanges, and exchanges_fts). This keeps transactions small enough for fast rollback on error while amortizing the commit overhead effectively.

For tool calls (145,386 rows with simpler inserts), use **2,000-5,000 rows per transaction**.

### Transaction Strategy for Migration

```typescript
function bulkInsertExchanges(
  db: Database.Database,
  exchanges: TargetExchange[],
  embeddings: number[][],
  batchSize: number = 500,
): void {
  // Prepare statements once (outside the loop)
  const insertExchange = db.prepare(`
    INSERT OR REPLACE INTO exchanges
      (id, conversation_id, project, timestamp, user_message, assistant_message,
       session_id, cwd, git_branch, model_version, exchange_index, token_estimate,
       created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteVec = db.prepare("DELETE FROM vec_exchanges WHERE id = ?");
  const insertVec = db.prepare(
    "INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)",
  );

  // Process in batches
  for (let i = 0; i < exchanges.length; i += batchSize) {
    const batch = exchanges.slice(i, i + batchSize);
    const batchEmbeddings = embeddings.slice(i, i + batchSize);

    const transaction = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const ex = batch[j];
        const emb = batchEmbeddings[j];

        insertExchange.run(
          ex.id, ex.conversationId, ex.project, ex.timestamp,
          ex.userMessage, ex.assistantMessage, ex.sessionId ?? null,
          ex.cwd ?? null, ex.gitBranch ?? null, ex.modelVersion ?? null,
          ex.exchangeIndex, ex.tokenEstimate, ex.createdAt, ex.lastAccessed ?? null,
        );

        deleteVec.run(ex.id);
        insertVec.run(ex.id, Buffer.from(new Float32Array(emb).buffer));
      }
    });

    transaction();
  }
}

function bulkInsertToolCalls(
  db: Database.Database,
  toolCalls: ToolCall[],
  batchSize: number = 2000,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tool_calls
      (id, exchange_id, tool_name, tool_input, tool_result_summary, is_error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < toolCalls.length; i += batchSize) {
    const batch = toolCalls.slice(i, i + batchSize);

    const transaction = db.transaction(() => {
      for (const tc of batch) {
        stmt.run(
          tc.id, tc.exchangeId, tc.toolName,
          tc.toolInput ?? null, tc.toolResultSummary ?? null,
          tc.isError ? 1 : 0, tc.timestamp ?? null,
        );
      }
    });

    transaction();
  }
}
```

### WAL Checkpoint After Migration

After all inserts are complete, force a WAL checkpoint to merge the WAL file into the main database:

```typescript
function finalizeMigration(db: Database.Database): void {
  // Force WAL checkpoint (merge WAL into main DB file)
  db.pragma("wal_checkpoint(TRUNCATE)");

  // Analyze tables for query planner optimization
  db.exec("ANALYZE");

  // Verify database integrity
  const result = db.pragma("integrity_check") as { integrity_check: string }[];
  if (result[0]?.integrity_check !== "ok") {
    throw new Error(`Database integrity check failed: ${JSON.stringify(result)}`);
  }
}
```

---

## 6. Complete Migration Pipeline

### Orchestration

```typescript
export async function runMigration(options: {
  sourcePath: string;
  targetPath: string;
  config: MigrationBatchConfig;
  dryRun?: boolean;
  onProgress?: (progress: MigrationProgress) => void;
}): Promise<MigrationReport> {
  const report: MigrationReport = {
    startedAt: Date.now(),
    phases: [],
    exchangesMigrated: 0,
    toolCallsMigrated: 0,
    conversationsCreated: 0,
    embeddingsGenerated: 0,
    validationResults: [],
  };

  // 1. Open databases
  const sourceDb = new Database(options.sourcePath, { readonly: true });
  const targetDb = initDatabase({ dbPath: options.targetPath, /* ... */ });

  try {
    // 2. Initialize embedding model (downloads on first run)
    console.log("Initializing embedding model...");
    await initEmbeddings();

    // 3. Build conversation records
    console.log("Building conversation records...");
    const conversations = buildConversations(sourceDb);
    for (const conv of conversations.values()) {
      upsertConversation(targetDb, conv);
    }
    report.conversationsCreated = conversations.size;

    // 4. Compute exchange indexes
    const exchangeIndexes = computeExchangeIndexes(sourceDb);

    // 5. Migrate exchanges with embeddings
    console.log("Migrating exchanges (embedding + insert)...");
    await migrateExchanges(sourceDb, targetDb, exchangeIndexes, options.config, options.onProgress);

    // 6. Migrate tool calls
    console.log("Migrating tool calls...");
    migrateToolCalls(sourceDb, targetDb, options.config);

    // 7. Rebuild FTS5 index
    console.log("Building FTS5 full-text index...");
    migrateFTS(targetDb);

    // 8. Finalize (WAL checkpoint + ANALYZE)
    console.log("Finalizing database...");
    finalizeMigration(targetDb);

    // 9. Validate
    console.log("Running validation...");
    report.validationResults = [
      ...validateRowCounts(sourceDb, targetDb),
      ...validateEmbeddings(targetDb),
      ...validateContent(sourceDb, targetDb),
      ...validateFTS(targetDb),
    ];

    report.completedAt = Date.now();

    // Print report
    printMigrationReport(report);

    return report;
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}
```

### Expected Timeline

| Phase | Estimated Duration | Notes |
|-------|-------------------|-------|
| Model init (first run) | 30-60s | ONNX model download (~130MB) |
| Model init (cached) | 2-5s | Load from disk |
| Build conversations | < 1s | SQL aggregation |
| Exchange embedding + insert | 2-4 min | 7,660 exchanges @ ~40/sec |
| Tool call migration | 5-15s | 145,386 rows, SQL only |
| FTS5 rebuild | 1-2s | Single-pass index build |
| WAL checkpoint + ANALYZE | 1-2s | |
| Validation | 5-10s | Sampling + integrity checks |
| **Total (first run)** | **~4-6 min** | |
| **Total (cached model)** | **~3-5 min** | |

---

## 7. Fix for `embeddings.ts`

The current `embeddings.ts` skips the required `layer_norm` step for nomic Matryoshka truncation. This should be corrected as part of Phase 2:

```typescript
// CURRENT (incorrect for nomic MRL):
const output = await embeddingPipeline!(input, {
  pooling: "mean",
  normalize: true,  // L2-normalizes the full 768-dim vector
});
return truncateAndNormalize(Array.from(output.data as Float32Array));
// truncateAndNormalize just slices + re-normalizes, missing layer_norm

// CORRECT:
import { layer_norm } from "@xenova/transformers";

const output = await embeddingPipeline!(input, {
  pooling: "mean",
  normalize: false,  // Do NOT normalize yet
});

// Apply layer_norm -> slice -> L2 normalize (Matryoshka procedure)
const normed = layer_norm(output, [output.dims[1]]);
const sliced = normed.slice(null, [0, TARGET_DIMS]);
const final = sliced.normalize(2, -1);
return Array.from(final.data as Float32Array);
```

This change means that **all existing embeddings in any Engram DB created during Phase 1 testing will be incompatible** with the corrected procedure. The migration script uses the correct procedure, so the target DB will have properly-computed embeddings.

---

## 8. Risk Mitigation

### Memory Pressure During Embedding

- Monitor Node.js heap with `process.memoryUsage()` at each batch boundary
- If RSS exceeds 4GB, reduce batch size for remaining exchanges
- The adaptive approach:

```typescript
function getAdaptiveBatchSize(
  exchanges: { textLength: number }[],
  baseSize: number,
): number {
  const avgLen = exchanges.reduce((sum, e) => sum + e.textLength, 0) / exchanges.length;
  if (avgLen > 8000) return Math.max(4, Math.floor(baseSize / 4));
  if (avgLen > 4000) return Math.max(8, Math.floor(baseSize / 2));
  return baseSize;
}
```

### Handling Source DB Corruption

- Open source DB as `readonly: true` to prevent accidental writes
- If any source rows fail to read, log the error and continue
- Require a minimum success rate (e.g., 99%) or abort

### Idempotent Re-runs

- Use `INSERT OR REPLACE` so re-running the migration does not create duplicates
- The checkpoint system allows resuming from the last successful batch
- The FTS rebuild command is inherently idempotent (always rebuilds from scratch)

---

## References

- [nomic-ai/nomic-embed-text-v1.5 Model Card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) -- MRL dimensions, task prefixes, layer_norm requirement
- [Matryoshka Representation Learning (Hugging Face Blog)](https://huggingface.co/blog/matryoshka) -- Theory and implementation of Matryoshka embeddings
- [Matryoshka Embeddings with sqlite-vec](https://alexgarcia.xyz/sqlite-vec/guides/matryoshka.html) -- `vec_slice` and `vec_normalize` SQL functions
- [Transformers.js v3](https://huggingface.co/blog/transformersjs-v3) -- WebGPU support, batch processing, Node.js backend
- [Transformers.js v4 Preview](https://huggingface.co/blog/transformersjs-v4) -- Latest NPM preview and improvements
- [SQLite FTS5 Extension](https://sqlite.org/fts5.html) -- rebuild, optimize, external content tables
- [SQLite Optimizations for Ultra High-Performance (PowerSync)](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance) -- WAL mode, PRAGMA tuning, bulk JSON patterns
- [Optimizing FTS5 External Content Tables](https://sqlite.work/optimizing-fts5-external-content-tables-and-vacuum-interactions/) -- FTS5 + VACUUM interactions
- [SQLite Bulk Insert Benchmarking](https://zerowidthjoiner.net/2021/02/21/sqlite-bulk-insert-benchmarking-and-optimization) -- Transaction size vs throughput data
- [SQLite Performance Tuning (phiresky)](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/) -- WAL, synchronous, concurrency
- [tokenx](https://github.com/johannschopplich/tokenx) -- Fast token estimation at 96% accuracy
- [Counting Claude Tokens Without a Tokenizer](https://blog.gopenai.com/counting-claude-tokens-without-a-tokenizer-e767f2b6e632) -- Characters/4 heuristic analysis
- [Transformers.js WebGPU Embedding Benchmark](https://huggingface.co/posts/Xenova/906785325455792) -- Performance data for embedding models
