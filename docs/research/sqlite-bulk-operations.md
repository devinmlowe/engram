# SQLite Bulk Operations: sqlite-vec, FTS5, and better-sqlite3

Research notes for Phase 2 migration — re-embedding ~3,605 exchanges (after double-shot-latte exclusion) with 256-dimension vectors (down from 384) and rebuilding FTS5 indexes.
**Referenced from**: [spec.md (Phase 2)](../../spec.md)

**Date:** 2026-02-26
**Context:** Engram cognitive memory system, TypeScript/Node.js, better-sqlite3, sqlite-vec, FTS5

---

## Table of Contents

1. [sqlite-vec Bulk Loading](#1-sqlite-vec-bulk-loading)
2. [sqlite-vec Dimension Change](#2-sqlite-vec-dimension-change)
3. [FTS5 External Content Tables](#3-fts5-external-content-tables)
4. [SQLite WAL Mode Bulk Operations](#4-sqlite-wal-mode-bulk-operations)
5. [better-sqlite3 Specific Patterns](#5-better-sqlite3-specific-patterns)
6. [Recommended Migration Strategy](#6-recommended-migration-strategy)

---

## 1. sqlite-vec Bulk Loading

### How vec0 Storage Works

sqlite-vec stores vectors in a chunked internal format. Each chunk holds a fixed number of
vectors (default: 64 vectors per chunk). When you insert a vector, it is placed into an
available chunk. When you delete a vector, a bitmap marks the slot as invalid but the space
is **not** reclaimed — similar to how B-tree pages work but without automatic compaction.

This has direct implications for bulk operations:

- **Individual DELETE+INSERT cycles** leave fragmented chunks with dead slots
- **DROP TABLE + recreate** produces a clean, compact table with no fragmentation
- There is no built-in `rebuild` command for vec0 (unlike FTS5) — the maintainer has
  acknowledged this gap and plans to add one ([GitHub issue #205](https://github.com/asg017/sqlite-vec/issues/205))

### Bulk Insert Performance Characteristics

Benchmarks from the sqlite-vec ecosystem on Apple M1 Pro (100k vectors, 384 dimensions, float32):

| Operation | sqlite-vec | Notes |
|-----------|-----------|-------|
| Insert 100k vectors | ~563ms | Standard INSERT statements in transaction |
| Query (brute-force KNN) | Baseline | Good for <500k vectors |

For our scale (~7,660 vectors at 256 dimensions), bulk insert should complete in **under 100ms**
in a single transaction. This is well within sqlite-vec's sweet spot (brute-force search,
thousands to low hundreds of thousands of vectors).

### INSERT vs DELETE+INSERT vs DROP+CREATE

For a full re-embedding migration (every row gets a new vector), the recommended approach is:

1. **DROP TABLE + CREATE TABLE** — cleanest option for full migration
2. **Single-transaction INSERT** into the fresh table
3. **VACUUM** after migration to reclaim space from the dropped virtual table's shadow tables

The maintainer (asg017) explicitly recommends this approach:
> "Try `DROP TABLE vectors`, then a `VACUUM`, then re-create the table."
> — [GitHub issue #205](https://github.com/asg017/sqlite-vec/issues/205)

Avoid: deleting all rows one-by-one then re-inserting. This fragments every chunk and the
dead space is never reclaimed without DROP+recreate.

### Transaction Batching for vec0

For 7,660 vectors, a single transaction is fine. The general guidelines:

- **< 10,000 vectors:** Single transaction, no batching needed
- **10,000 - 100,000 vectors:** Single transaction still works; monitor memory
- **> 100,000 vectors:** Consider batching in chunks of 10,000-50,000 per transaction

### Known Issues (v0.1.7-alpha)

- **v0.1.7-alpha.2:** Fixed a segfault on invalid inputs to `vec_each()` — not relevant
  to bulk INSERT
- **v0.1.7-alpha.3:** CI/CD build fixes only
- **No known bulk loading issues** in the alpha series. The vec0 INSERT path is well-tested
- The `optimize` command (from [PR #210](https://github.com/asg017/sqlite-vec/pull/210))
  reclaims space from fragmented chunks but is only needed after heavy DELETE workloads,
  not for fresh bulk inserts

### TypeScript Example: Bulk vec0 Insert

```typescript
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

function bulkInsertVectors(
  db: Database.Database,
  vectors: Array<{ id: string; embedding: number[] }>,
  tableName: string,
  dimensions: number,
): void {
  // 1. Drop old table (safe for full migration)
  db.exec(`DROP TABLE IF EXISTS ${tableName}`);

  // 2. Create fresh table with target dimensions
  db.exec(
    `CREATE VIRTUAL TABLE ${tableName} USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dimensions}]
    )`
  );

  // 3. Bulk insert in a single transaction
  const insertStmt = db.prepare(
    `INSERT INTO ${tableName}(id, embedding) VALUES (?, ?)`
  );

  const insertAll = db.transaction((items: typeof vectors) => {
    for (const item of items) {
      insertStmt.run(
        item.id,
        Buffer.from(new Float32Array(item.embedding).buffer)
      );
    }
  });

  insertAll(vectors);
}
```

---

## 2. sqlite-vec Dimension Change

### Changing Dimensions: float[384] to float[256]

vec0 tables declare their dimension at creation time:

```sql
CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[256]    -- was float[384]
);
```

**There is no ALTER TABLE for vec0.** To change dimensions, you must DROP and CREATE a
new table. This is perfectly fine for a migration — it is the standard approach.

### Gotchas

1. **Dimension mismatch is a hard error.** If you try to INSERT a 384-dim vector into a
   float[256] table, sqlite-vec will reject it. The vector byte length must exactly match
   `dimensions * 4` bytes (float32).

2. **Float32Array buffer conversion.** The existing engram codebase already handles this
   correctly:

   ```typescript
   // Current pattern in store.ts — correct
   Buffer.from(new Float32Array(embedding).buffer)
   ```

   This creates a Node.js Buffer that wraps the raw IEEE 754 float32 bytes. better-sqlite3
   binds this as a BLOB, which is exactly what vec0 expects.

3. **Byte length validation.** For 256 dimensions:
   - Expected BLOB size: `256 * 4 = 1024 bytes`
   - A Float32Array of length 256 produces exactly 1024 bytes
   - If your embedding array has != 256 elements, the INSERT will fail

4. **Endianness.** Float32Array uses the platform's native byte order (little-endian on
   x86/ARM). sqlite-vec expects little-endian floats. This is correct on all modern
   platforms (x86_64, Apple Silicon ARM64).

5. **No `.buffer` needed with better-sqlite3.** Per the sqlite-vec JS documentation,
   `better-sqlite3` can directly bind a `Float32Array` as a BLOB:

   ```typescript
   // Also works — simpler
   insertStmt.run(id, new Float32Array(embedding));
   ```

   However, the `Buffer.from(new Float32Array(embedding).buffer)` pattern is also correct
   and is what the existing codebase uses. Both work.

### Validation Helper

```typescript
function validateEmbedding(embedding: number[], expectedDims: number): void {
  if (embedding.length !== expectedDims) {
    throw new Error(
      `Embedding dimension mismatch: got ${embedding.length}, expected ${expectedDims}`
    );
  }
  // Check for NaN/Infinity
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new Error(`Non-finite value at index ${i}: ${embedding[i]}`);
    }
  }
}
```

---

## 3. FTS5 External Content Tables

### How External Content Mode Works

Engram's FTS5 tables use external content mode:

```sql
CREATE VIRTUAL TABLE exchanges_fts USING fts5(
  user_message,
  assistant_message,
  content='exchanges',          -- references the exchanges table
  content_rowid='rowid',        -- uses SQLite's implicit rowid
  tokenize='porter unicode61'
);
```

Key behaviors:

1. **FTS5 does NOT store column values.** It only stores the inverted index (token
   positions, document frequencies). When you query, FTS5 fetches the actual text from
   the content table via: `SELECT rowid, user_message, assistant_message FROM exchanges WHERE rowid = ?`

2. **FTS5 does NOT auto-sync.** When you modify the `exchanges` table, the FTS index
   is **not** automatically updated. You must either:
   - Use triggers to keep them in sync
   - Manually issue delete/insert commands to the FTS table
   - Periodically run `rebuild`

3. **content_rowid must reference an INTEGER.** The `exchanges` table has `id TEXT PRIMARY KEY`,
   but SQLite still maintains an implicit `rowid` (since the PK is TEXT, not INTEGER).
   The FTS5 table correctly uses `content_rowid='rowid'` to reference this implicit rowid.

### The Rebuild Command

```sql
INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild');
```

What rebuild does:
1. Deletes the entire FTS5 inverted index
2. Re-reads every row from the content table (`exchanges`)
3. Re-tokenizes and re-indexes all content

**Performance for 7,660 rows:** Rebuild will be fast — FTS5 rebuild on ~8k rows with
modest text content (a few KB per row average) should complete in **under 1 second**.
FTS5 is heavily optimized for this scale.

**When to use rebuild:**
- After bulk modifications to the content table (our migration case)
- When the FTS index has accumulated inconsistencies
- Much simpler than manual sync for bulk operations

**When NOT to use rebuild:**
- For incremental single-row updates during normal operation (use triggers or manual
  delete+insert instead — this is what `insertExchange` in `store.ts` already does)

### Manual Sync Pattern (for incremental updates)

The existing `store.ts` code correctly implements manual FTS sync:

```typescript
// 1. Delete old FTS entry (must supply EXACT old values)
db.prepare(
  `INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
   VALUES('delete', ?, ?, ?)`
).run(existing.rowid, existing.user_message, existing.assistant_message);

// 2. Insert new FTS entry
db.prepare(
  `INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
   VALUES (?, ?, ?)`
).run(row.rowid, exchange.userMessage, exchange.assistantMessage);
```

Critical requirement: The delete command **must supply the exact column values** that were
originally indexed. If the values don't match, the FTS index becomes corrupted (phantom
entries that match queries but point to non-existent content).

### Trigger-Based Sync (alternative approach)

```sql
-- Auto-sync FTS after INSERT on exchanges
CREATE TRIGGER IF NOT EXISTS exchanges_ai AFTER INSERT ON exchanges BEGIN
  INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
  VALUES (new.rowid, new.user_message, new.assistant_message);
END;

-- Auto-sync FTS after DELETE on exchanges
CREATE TRIGGER IF NOT EXISTS exchanges_ad AFTER DELETE ON exchanges BEGIN
  INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
  VALUES('delete', old.rowid, old.user_message, old.assistant_message);
END;

-- Auto-sync FTS after UPDATE on exchanges
CREATE TRIGGER IF NOT EXISTS exchanges_au AFTER UPDATE ON exchanges BEGIN
  INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
  VALUES('delete', old.rowid, old.user_message, old.assistant_message);
  INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
  VALUES (new.rowid, new.user_message, new.assistant_message);
END;
```

Note: Triggers only affect changes made **after** trigger creation. Pre-existing data
inconsistencies require a `rebuild`.

### Rebuild vs Triggers for Migration

For the Phase 2 migration, use **rebuild** after all content table modifications are complete:

```typescript
function migrateWithRebuild(db: Database.Database): void {
  // ... perform all exchanges table modifications ...

  // Single rebuild at the end — much faster than per-row sync
  db.exec(`INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
}
```

---

## 4. SQLite WAL Mode Bulk Operations

### Recommended PRAGMA Settings for Bulk Insert

The database already sets `journal_mode = WAL` and `synchronous = NORMAL`. For the bulk
migration, temporarily add more aggressive settings:

```typescript
function configureBulkPragmas(db: Database.Database): void {
  // Already set by initDatabase:
  // db.pragma("journal_mode = WAL");
  // db.pragma("synchronous = NORMAL");

  // Additional settings for bulk operations:

  // Increase page cache — 64MB (negative = KB)
  // Default is ~2MB; 64MB helps with large transactions
  db.pragma("cache_size = -65536");

  // Memory-mapped I/O — 256MB
  // Reduces disk I/O by mapping database file into virtual memory
  // Safe on 64-bit systems; OS manages actual physical memory usage
  db.pragma("mmap_size = 268435456");

  // Store temp tables/indexes in memory
  db.pragma("temp_store = MEMORY");
}

function restoreNormalPragmas(db: Database.Database): void {
  // Restore conservative settings for normal operation
  db.pragma("cache_size = -2000");  // ~2MB default
  db.pragma("mmap_size = 0");       // disable mmap for normal use
}
```

### PRAGMA Setting Details

| PRAGMA | Bulk Value | Normal Value | Purpose |
|--------|-----------|--------------|---------|
| `journal_mode` | WAL | WAL | Already set; keep WAL for the migration |
| `synchronous` | NORMAL | NORMAL | In WAL mode, NORMAL is safe — only checkpoints need fsync |
| `cache_size` | -65536 (64MB) | -2000 (2MB) | More pages in memory = fewer disk reads |
| `mmap_size` | 268435456 (256MB) | 0 | Memory-map the DB file for fast random access |
| `temp_store` | MEMORY | default | Temp indexes in RAM during bulk inserts |
| `page_size` | 4096 (default) | 4096 | Don't change; would require VACUUM |

### WAL Size and Checkpoint Management

During a bulk insert transaction, the WAL file grows to hold all changes. For 7,660
exchanges with embeddings, estimated WAL size:

- Exchange rows: ~7,660 * ~2KB avg = ~15MB
- Vec0 shadow tables: ~7,660 * 1024 bytes = ~8MB
- FTS5 rebuild index: ~5-10MB
- **Total WAL estimate: ~30-40MB** — well within safe limits

After the bulk operation, run a checkpoint to merge WAL back into the main database:

```typescript
function checkpointAfterBulk(db: Database.Database): void {
  // TRUNCATE mode: merges WAL into DB and resets WAL to zero bytes
  // Blocks other writers but that's fine for a migration
  db.pragma("wal_checkpoint(TRUNCATE)");
}
```

### Avoiding WAL Bloat

For our scale (~8k rows), WAL bloat is not a concern. General guidance for larger operations:

- **< 50,000 rows:** Single transaction is fine; WAL stays reasonable
- **50,000 - 500,000 rows:** Batch into 10,000-row transactions with checkpoints between
- **> 500,000 rows:** Batch into 50,000-row transactions; checkpoint after each batch

The default `wal_autocheckpoint` interval (1000 pages) may trigger during large transactions,
which adds overhead. For bulk operations, you can temporarily disable it:

```typescript
// Disable auto-checkpoint during bulk operation
db.pragma("wal_autocheckpoint = 0");

// ... bulk operations ...

// Re-enable and run manual checkpoint
db.pragma("wal_autocheckpoint = 1000");
db.pragma("wal_checkpoint(TRUNCATE)");
```

---

## 5. better-sqlite3 Specific Patterns

### Prepared Statement Reuse

better-sqlite3's prepared statements are cached and reused. The key pattern for bulk
operations is: **prepare once, run many times inside a transaction.**

```typescript
// GOOD: Prepare once, reuse in transaction
const stmt = db.prepare("INSERT INTO exchanges (...) VALUES (?, ?, ...)");
const bulkInsert = db.transaction((items: Exchange[]) => {
  for (const item of items) {
    stmt.run(item.id, item.conversationId, /* ... */);
  }
});
bulkInsert(allExchanges);

// BAD: Preparing inside the loop
const bulkInsertBad = db.transaction((items: Exchange[]) => {
  for (const item of items) {
    db.prepare("INSERT INTO exchanges (...) VALUES (?, ?, ...)").run(/* ... */);
    // ^ Re-parses SQL on every iteration (though better-sqlite3 does cache)
  }
});
```

### Transaction Performance

better-sqlite3's `db.transaction()` wrapper:

- Uses `BEGIN DEFERRED` by default (acquires write lock on first write)
- For bulk inserts, consider `.immediate()` to acquire the write lock upfront:

```typescript
const bulkInsert = db.transaction((items: Exchange[]) => {
  for (const item of items) {
    insertStmt.run(/* ... */);
  }
});

// Use .immediate() for bulk writes to avoid SQLITE_BUSY on lock upgrade
bulkInsert.immediate(allExchanges);
```

- **Performance:** better-sqlite3 achieves ~4,141 ops/sec for 100-row transaction batches
  (vs 265 for node-sqlite3). For our 7,660-row migration in a single transaction, expect
  **< 2 seconds** total.

- **Critical:** `db.transaction()` does NOT work with async functions. The transaction
  commits after the function returns synchronously. Any `await` inside the transaction
  function will cause the transaction to commit before the async work completes.

### Memory Usage with BLOB Operations

Each 256-dim float32 vector = 1024 bytes. For 7,660 vectors:

- **Total vector data in memory:** ~7.5MB
- **Float32Array allocation:** Creates a typed array view — GC-friendly
- **Buffer.from():** Creates a copy of the underlying ArrayBuffer

To minimize memory during bulk operations, process in streaming fashion:

```typescript
// Memory-efficient: generate and insert one at a time
const insertVec = db.prepare(
  "INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)"
);

const bulkInsertVecs = db.transaction(
  (items: Array<{ id: string; embedding: number[] }>) => {
    for (const item of items) {
      // Float32Array is created and GC'd each iteration
      const buf = Buffer.from(new Float32Array(item.embedding).buffer);
      insertVec.run(item.id, buf);
    }
  }
);
```

For 7,660 vectors at 256 dims, peak memory usage will be dominated by the embedding
generation (model inference), not the SQLite insertions. The SQLite layer adds minimal
overhead.

### Binding Types Reference

| JS Type | SQLite Type | Notes |
|---------|-------------|-------|
| `number` | INTEGER or REAL | Integers up to 2^53, then REAL |
| `bigint` | INTEGER | For rowids > 2^53 |
| `string` | TEXT | UTF-8 |
| `Buffer` | BLOB | For vec0 embeddings |
| `Float32Array` | BLOB | Directly bindable in better-sqlite3 |
| `null` | NULL | |

---

## 6. Recommended Migration Strategy

### Complete Migration Function

Putting it all together for the Phase 2 re-embedding migration:

```typescript
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

interface MigrationProgress {
  phase: string;
  current: number;
  total: number;
}

type ProgressCallback = (progress: MigrationProgress) => void;

/**
 * Full re-embedding migration:
 * 1. Configure PRAGMAs for bulk operation
 * 2. Read all exchanges from the content table
 * 3. Generate new 256-dim embeddings
 * 4. DROP and recreate vec0 table with new dimensions
 * 5. Bulk insert all vectors
 * 6. Rebuild FTS5 indexes
 * 7. Restore normal PRAGMAs and checkpoint
 */
async function migrateEmbeddings(
  db: Database.Database,
  embedFn: (text: string) => Promise<number[]>,
  dimensions: number,
  onProgress?: ProgressCallback,
): Promise<{ migrated: number; durationMs: number }> {
  const start = Date.now();

  // ── Phase 1: Configure for bulk operations ──
  db.pragma("cache_size = -65536");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
  db.pragma("wal_autocheckpoint = 0");

  try {
    // ── Phase 2: Read all exchange IDs and text ──
    const exchanges = db
      .prepare(
        `SELECT id, user_message, assistant_message, project, timestamp, git_branch
         FROM exchanges ORDER BY timestamp ASC`
      )
      .all() as Array<{
        id: string;
        user_message: string;
        assistant_message: string;
        project: string;
        timestamp: string;
        git_branch: string | null;
      }>;

    const total = exchanges.length;
    onProgress?.({ phase: "read", current: total, total });

    // ── Phase 3: Generate new embeddings ──
    const vectors: Array<{ id: string; embedding: number[] }> = [];

    for (let i = 0; i < exchanges.length; i++) {
      const ex = exchanges[i];
      const text = buildEmbeddingText(ex);
      const embedding = await embedFn(text);

      if (embedding.length !== dimensions) {
        throw new Error(
          `Dimension mismatch for ${ex.id}: got ${embedding.length}, expected ${dimensions}`
        );
      }

      vectors.push({ id: ex.id, embedding });

      if ((i + 1) % 100 === 0 || i === exchanges.length - 1) {
        onProgress?.({ phase: "embed", current: i + 1, total });
      }
    }

    // ── Phase 4: DROP and recreate vec0 table ──
    onProgress?.({ phase: "vec0-rebuild", current: 0, total });

    db.exec("DROP TABLE IF EXISTS vec_exchanges");
    db.exec(
      `CREATE VIRTUAL TABLE vec_exchanges USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      )`
    );

    // ── Phase 5: Bulk insert vectors in single transaction ──
    const insertVec = db.prepare(
      "INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)"
    );

    const bulkInsertVecs = db.transaction(
      (items: Array<{ id: string; embedding: number[] }>) => {
        for (const item of items) {
          insertVec.run(
            item.id,
            Buffer.from(new Float32Array(item.embedding).buffer)
          );
        }
      }
    );

    bulkInsertVecs.immediate(vectors);
    onProgress?.({ phase: "vec0-rebuild", current: total, total });

    // ── Phase 6: Rebuild FTS5 indexes ──
    onProgress?.({ phase: "fts5-rebuild", current: 0, total: 2 });
    db.exec(`INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`);
    onProgress?.({ phase: "fts5-rebuild", current: 1, total: 2 });
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
    onProgress?.({ phase: "fts5-rebuild", current: 2, total: 2 });

    return {
      migrated: total,
      durationMs: Date.now() - start,
    };
  } finally {
    // ── Phase 7: Restore normal settings ──
    db.pragma("cache_size = -2000");
    db.pragma("mmap_size = 0");
    db.pragma("wal_autocheckpoint = 1000");
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
}

function buildEmbeddingText(ex: {
  user_message: string;
  assistant_message: string;
  project: string;
  timestamp: string;
  git_branch: string | null;
}): string {
  const parts: string[] = [];
  const contextParts: string[] = [];

  if (ex.project) contextParts.push(`Project: ${ex.project}`);
  if (ex.timestamp) contextParts.push(`Date: ${ex.timestamp.split("T")[0]}`);
  if (ex.git_branch) contextParts.push(`Branch: ${ex.git_branch}`);

  if (contextParts.length > 0) {
    parts.push(`[${contextParts.join(" | ")}]`);
  }

  parts.push(`User: ${ex.user_message || ""}`);
  parts.push(`Assistant: ${(ex.assistant_message || "").substring(0, 500)}`);

  return parts.join("\n");
}
```

### Migration Order and Safety

```
1. BACKUP database file (cp engram.db engram.db.bak)
2. Open database, configure bulk PRAGMAs
3. Read all exchange rows (SELECT from content table — no mutation yet)
4. Generate embeddings (async, potentially slow: ~7,660 * model inference)
5. DROP + CREATE vec0 tables (fast, schema change only)
6. Bulk INSERT vectors (single transaction, <2s for 7,660 rows)
7. Rebuild FTS5 indexes (< 1s)
8. Restore PRAGMAs, checkpoint WAL
9. VACUUM (optional — reclaims space from dropped shadow tables)
```

### Batched Embedding Generation (for large datasets)

If embedding generation is the bottleneck (it will be — model inference is slow), consider
batching with periodic progress saves:

```typescript
const EMBED_BATCH_SIZE = 100;

async function generateEmbeddingsInBatches(
  exchanges: Array<{ id: string; text: string }>,
  embedFn: (text: string) => Promise<number[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, number[]>> {
  const results = new Map<string, number[]>();

  for (let i = 0; i < exchanges.length; i += EMBED_BATCH_SIZE) {
    const batch = exchanges.slice(i, i + EMBED_BATCH_SIZE);

    // Process batch sequentially (model is single-threaded)
    for (const ex of batch) {
      results.set(ex.id, await embedFn(ex.text));
    }

    onProgress?.(Math.min(i + EMBED_BATCH_SIZE, exchanges.length), exchanges.length);
  }

  return results;
}
```

### Performance Estimates for 7,660 Exchanges

| Phase | Estimated Time | Bottleneck |
|-------|---------------|------------|
| Read exchanges | < 100ms | Disk I/O |
| Generate 256-dim embeddings | 5-15 min | Model inference (nomic-embed-text-v1.5) |
| DROP + CREATE vec0 | < 10ms | Instantaneous |
| Bulk INSERT vectors | < 500ms | SQLite writes |
| FTS5 rebuild (2 tables) | < 1s | Tokenization + index build |
| WAL checkpoint | < 100ms | fsync |
| VACUUM (optional) | 1-5s | Page reorganization |
| **Total (excluding embeddings)** | **< 7s** | |
| **Total (with embeddings)** | **5-15 min** | Model inference dominates |

---

## Sources

- [sqlite-vec GitHub repository](https://github.com/asg017/sqlite-vec)
- [sqlite-vec documentation](https://alexgarcia.xyz/sqlite-vec/)
- [sqlite-vec JS/Node.js setup](https://alexgarcia.xyz/sqlite-vec/js.html)
- [Vector search in 7 languages (Alex Garcia)](https://alexgarcia.xyz/blog/2024/sql-vector-search-languages/index.html)
- [sqlite-vec v0.1.0 release blog](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)
- [GitHub issue #205 — How to rebuild vec0 indexes](https://github.com/asg017/sqlite-vec/issues/205)
- [GitHub issue #186 — Performance tuning for vec search](https://github.com/asg017/sqlite-vec/issues/186)
- [GitHub PR #210 — Add custom optimize command](https://github.com/asg017/sqlite-vec/pull/210)
- [SQLite FTS5 official documentation](https://sqlite.org/fts5.html)
- [FTS5 bulk insert with external content table (mailing list)](https://sqlite-users.sqlite.narkive.com/FsHtboS0/sqlite-properly-bulk-inserting-into-fts5-index-with-external-content-table)
- [better-sqlite3 API documentation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)
- [SQLite performance tuning (phiresky)](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [SQLite optimizations for ultra high-performance (PowerSync)](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)
- [SQLite PRAGMA reference](https://sqlite.org/pragma.html)
- [SQLite WAL mode documentation](https://sqlite.org/wal.html)
- [How sqlite-vec works (Stephen Collins)](https://medium.com/@stephenc211/how-sqlite-vec-works-for-storing-and-querying-vector-embeddings-165adeeeceea)
