# Checkpoint and Resume Patterns for Data Processing Pipelines

## Research Document for Engram Phase 5: Dream State Daemon

**Date**: 2026-02-26
**Domain**: Pipeline orchestration, fault tolerance, checkpointing, idempotent processing
**Scope**: Patterns for crash-safe, resumable batch processing in a TypeScript/Node.js daemon using SQLite

---

## Table of Contents

1. [Checkpointing Fundamentals](#1-checkpointing-fundamentals)
2. [Write-Ahead Logging (WAL) for Pipeline State](#2-write-ahead-logging-wal-for-pipeline-state)
3. [Cursor-Based Resumption](#3-cursor-based-resumption)
4. [Transaction-Safe Checkpointing in SQLite](#4-transaction-safe-checkpointing-in-sqlite)
5. [Idempotent Processing Patterns](#5-idempotent-processing-patterns)
6. [Progress Tracking and Reporting](#6-progress-tracking-and-reporting)
7. [Batch Processing with Configurable Concurrency](#7-batch-processing-with-configurable-concurrency)
8. [Error Handling Strategies](#8-error-handling-strategies)
9. [Pipeline Orchestration in Node.js/TypeScript](#9-pipeline-orchestration-in-nodejstypescript)
10. [Lessons from Production Systems](#10-lessons-from-production-systems)
11. [Key Takeaways for Engram](#11-key-takeaways-for-engram)

---

## 1. Checkpointing Fundamentals

### 1.1 What is Checkpointing?

Checkpointing is the practice of periodically saving the state of a computation so that it can be resumed from that saved state rather than restarted from scratch. In data processing pipelines, this means recording which items have been processed and what intermediate results have been produced.

There are two primary categories:

| Type | Description | Trade-offs |
|------|-------------|------------|
| **Application-level** | Application explicitly serializes essential state | Efficient, portable, requires development effort |
| **System-level** | OS/framework captures entire process state | Transparent, environment-dependent, large snapshots |

For Engram's daemon, **application-level checkpointing** is the right choice: we know exactly what state matters (which conversations have been processed, which pipeline stages are complete) and can serialize it compactly to SQLite.

(Source: [Checkpoint/Restore Systems: Evolution, Techniques, and Applications in AI Agents](https://eunomia.dev/blog/2025/05/11/checkpointrestore-systems-evolution-techniques-and-applications-in-ai-agents/))

### 1.2 Checkpoint Granularity

The granularity of checkpointing affects both safety and performance:

| Granularity | Example | Recovery Time | Storage Overhead |
|-------------|---------|---------------|-----------------|
| **Per-item** | After each conversation | Minimal (lose at most 1 item) | Higher I/O |
| **Per-batch** | After every 10 conversations | Lose up to batch size | Moderate I/O |
| **Per-phase** | After all items complete a phase | Must redo entire phase | Low I/O |
| **Per-run** | At the end of the daemon run | Must redo entire run | Minimal I/O |

**Recommendation for Engram:** Per-item checkpointing. Each conversation is an independent unit of work, and processing takes seconds per item. The overhead of writing a checkpoint row to SQLite after each conversation is negligible compared to the LLM processing time.

### 1.3 Stateless vs Stateful Recovery

Modern AI agent frameworks distinguish between:

**Stateless recovery** (recommended for Engram):
- Save only high-level persistent data (which conversations are processed, extracted facts/entities)
- Restart fresh process instances reading from durable checkpoint data
- Enables code upgrades between runs without migration
- Requires recomputation of transient state (acceptable for a daemon that runs periodically)

**Stateful recovery** (overkill for Engram):
- Preserve exact execution context including in-memory state
- Enables millisecond-level resumption
- Tightly coupled to environment; fragile across upgrades

(Source: [Checkpoint/Restore Systems](https://eunomia.dev/blog/2025/05/11/checkpointrestore-systems-evolution-techniques-and-applications-in-ai-agents/))

---

## 2. Write-Ahead Logging (WAL) for Pipeline State

### 2.1 SQLite WAL Mode Fundamentals

SQLite's Write-Ahead Logging (WAL) mode is critical for Engram's daemon:

- **Readers never block writers, writers never block readers.** The daemon can read conversation data while writing extracted facts/entities.
- **Crash safety:** Committed transactions survive crashes. The WAL must be synced to persistent storage before the transaction is considered committed.
- **Better concurrency:** Multiple readers can operate simultaneously against the same snapshot.

```typescript
// Enable WAL mode (do this once on database creation)
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // Good balance of safety and speed
db.pragma('busy_timeout = 5000');  // Wait up to 5 seconds for locks
```

(Source: [SQLite Write-Ahead Logging](https://sqlite.org/wal.html))

### 2.2 WAL as Pipeline State Log

The concept of a write-ahead log can be applied to pipeline state tracking. Rather than using a separate WAL file, we use SQLite's own transactional guarantees:

```sql
-- Pipeline state table (acts as our "WAL" for processing state)
CREATE TABLE dream_pipeline_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    phase TEXT NOT NULL,          -- 'ingest' | 'extract_facts' | 'extract_entities' | 'extract_relationships' | 'consolidate'
    status TEXT NOT NULL,         -- 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
    started_at INTEGER,
    completed_at INTEGER,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(conversation_id, phase)
);

CREATE INDEX idx_pipeline_pending ON dream_pipeline_state(phase, status)
    WHERE status = 'pending';
```

**How it works:**
1. Before processing a conversation through a phase, insert/update a row with `status = 'processing'`
2. On success, update to `status = 'completed'`
3. On failure, update to `status = 'failed'` with error message
4. On daemon restart, query for `status = 'processing'` (was interrupted) and reset to `pending`

### 2.3 Checkpoint Operations with WAL

SQLite WAL checkpointing (transferring WAL data to the main database file) should be triggered explicitly:

```typescript
// At the end of each batch, checkpoint the WAL
db.pragma('wal_checkpoint(PASSIVE)');

// On graceful shutdown, do a full checkpoint
db.pragma('wal_checkpoint(TRUNCATE)');
```

Checkpoint modes:
- **PASSIVE**: Checkpoint as much as possible without blocking readers. Best for mid-run checkpoints.
- **FULL**: Wait for readers to finish, then checkpoint everything. Blocks briefly.
- **TRUNCATE**: Like FULL but also truncates the WAL file. Best for shutdown.

**Important:** Prevent checkpoint starvation by ensuring long-running read transactions release periodically. With `better-sqlite3`, this is rarely an issue since transactions are synchronous.

(Sources: [SQLite WAL Checkpoint](https://sqlite.org/c3ref/wal_checkpoint_v2.html), [How SQLite Scales Read Concurrency](https://fly.io/blog/sqlite-internals-wal/))

---

## 3. Cursor-Based Resumption

### 3.1 The Cursor Pattern

A cursor tracks "where we left off" in a sequence of work items. For Engram, the cursor is the last successfully processed conversation.

```sql
-- Track the high-water mark for each pipeline phase
CREATE TABLE dream_cursors (
    phase TEXT PRIMARY KEY,
    last_processed_id TEXT,           -- Last conversation ID fully processed
    last_processed_at INTEGER,        -- When it was processed
    items_processed INTEGER DEFAULT 0, -- Running count
    updated_at INTEGER DEFAULT (unixepoch())
);
```

### 3.2 Cursor Query Pattern

```typescript
// Get next batch of unprocessed conversations for a phase
function getNextBatch(phase: string, batchSize: number): Conversation[] {
  const cursor = db.prepare(`
    SELECT last_processed_id FROM dream_cursors WHERE phase = ?
  `).get(phase);

  // Use rowid ordering for deterministic processing order
  return db.prepare(`
    SELECT c.* FROM conversations c
    WHERE c.rowid > COALESCE(
      (SELECT rowid FROM conversations WHERE id = ?),
      0
    )
    AND c.id NOT IN (
      SELECT conversation_id FROM dream_pipeline_state
      WHERE phase = ? AND status = 'completed'
    )
    ORDER BY c.rowid ASC
    LIMIT ?
  `).all(cursor?.last_processed_id ?? null, phase, batchSize);
}

// Advance the cursor after successful processing
function advanceCursor(phase: string, conversationId: string): void {
  db.prepare(`
    INSERT INTO dream_cursors (phase, last_processed_id, last_processed_at, items_processed)
    VALUES (?, ?, unixepoch(), 1)
    ON CONFLICT(phase) DO UPDATE SET
      last_processed_id = excluded.last_processed_id,
      last_processed_at = excluded.last_processed_at,
      items_processed = items_processed + 1,
      updated_at = unixepoch()
  `).run(phase, conversationId);
}
```

### 3.3 Handling Out-of-Order Processing

If conversations can be added while the daemon is running (e.g., ingested during a Claude Code session), the cursor must handle items inserted before the cursor position:

**Strategy 1: Dual tracking** (recommended)
- Cursor tracks the rowid high-water mark
- Pipeline state table tracks individual item status
- On resume, query both: items after cursor AND items before cursor that are not completed

**Strategy 2: Epoch-based**
- Each daemon run gets an epoch number
- Conversations are assigned to epochs when discovered
- Only process conversations in the current or earlier epochs

For Engram, Strategy 1 is simpler and handles the common case where conversations are ingested asynchronously.

(Source: [Dagster Checkpointing](https://dagster.io/glossary/checkpointing))

---

## 4. Transaction-Safe Checkpointing in SQLite

### 4.1 Atomic State Transitions

The key safety requirement: **a conversation's processing results and its checkpoint status must be committed atomically.** If the daemon crashes between writing results and updating the checkpoint, either both should be visible or neither.

```typescript
// Atomic: extract facts AND update pipeline state in one transaction
const processConversation = db.transaction((conversationId: string, facts: ExtractedFact[]) => {
  // Insert extracted facts
  const insertFact = db.prepare(`
    INSERT INTO memories (id, content, memory_type, importance, source_conversation_id, created_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `);

  for (const fact of facts) {
    insertFact.run(fact.id, fact.content, fact.type, fact.importance, conversationId);
  }

  // Update pipeline state
  db.prepare(`
    INSERT INTO dream_pipeline_state (conversation_id, phase, status, completed_at)
    VALUES (?, 'extract_facts', 'completed', unixepoch())
    ON CONFLICT(conversation_id, phase) DO UPDATE SET
      status = 'completed',
      completed_at = unixepoch()
  `).run(conversationId);

  // Advance cursor
  advanceCursor('extract_facts', conversationId);
});

// Usage: all-or-nothing
processConversation(conv.id, extractedFacts);
```

With `better-sqlite3`, the `db.transaction()` wrapper ensures:
- All statements execute within a single SQLite transaction
- If any statement throws, the entire transaction is rolled back
- If the process crashes mid-transaction, SQLite's WAL ensures the uncommitted changes are discarded on recovery

### 4.2 Crash Recovery

On daemon startup, detect and recover from interrupted processing:

```typescript
function recoverFromCrash(): number {
  // Find conversations that were mid-processing when the daemon crashed
  const interrupted = db.prepare(`
    SELECT conversation_id, phase FROM dream_pipeline_state
    WHERE status = 'processing'
  `).all();

  if (interrupted.length === 0) return 0;

  // Reset interrupted items to pending for reprocessing
  const reset = db.prepare(`
    UPDATE dream_pipeline_state
    SET status = 'pending', retry_count = retry_count + 1
    WHERE status = 'processing'
  `);

  const result = reset.run();
  console.log(`[dream] Recovered ${result.changes} interrupted items from crash`);
  return result.changes;
}
```

### 4.3 Transaction Isolation for Concurrent Access

If the MCP server and the daemon both access the same SQLite database:

```typescript
// Use WAL mode for concurrent read/write
db.pragma('journal_mode = WAL');

// Set busy timeout for lock contention
db.pragma('busy_timeout = 5000');

// The daemon should batch writes within explicit transactions
// to minimize lock contention with the MCP server's reads
const batchInsert = db.transaction((items: ProcessedItem[]) => {
  for (const item of items) {
    insertStmt.run(item);
  }
});
```

WAL mode allows the MCP server to read while the daemon writes. The only contention is on write locks (only one writer at a time), mitigated by `busy_timeout`.

(Sources: [better-sqlite3 Performance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md), [Improving Concurrency](https://wchargin.com/better-sqlite3/performance.html))

---

## 5. Idempotent Processing Patterns

### 5.1 What Makes Processing Idempotent?

> "An idempotent pipeline produces the same result when rerunning the same data through it."

For Engram, idempotency means: running the daemon twice on the same unprocessed conversations produces identical results. This requires:

1. **Deterministic extraction**: Same conversation always produces the same facts/entities (temperature=0)
2. **Upsert semantics**: Re-inserting existing data updates rather than duplicates
3. **Status tracking**: Already-processed items are skipped on re-run
4. **Content-addressed IDs**: Facts/entities identified by content hash, not random UUID

(Source: [Understanding Idempotency: Key to Reliable Data Pipelines](https://airbyte.com/data-engineering-resources/idempotency-in-data-pipelines))

### 5.2 Content-Addressed Identification

Generate deterministic IDs from content rather than random UUIDs:

```typescript
import { createHash } from 'node:crypto';

function contentHash(content: string, conversationId: string, phase: string): string {
  return createHash('sha256')
    .update(`${conversationId}:${phase}:${content}`)
    .digest('hex')
    .slice(0, 16);
}

// For extracted facts
function factId(conversationId: string, factContent: string): string {
  return `fact_${contentHash(factContent, conversationId, 'fact')}`;
}

// For extracted entities
function entityId(entityName: string, entityType: string): string {
  return `ent_${contentHash(`${entityType}:${entityName.toLowerCase()}`, '', 'entity')}`;
}
```

With content-addressed IDs, re-extracting the same fact from the same conversation produces the same ID, and the upsert naturally deduplicates.

### 5.3 Upsert Pattern

```sql
-- Idempotent fact insertion (INSERT OR REPLACE)
INSERT INTO memories (id, content, memory_type, importance, source_conversation_id, created_at)
VALUES (?, ?, ?, ?, ?, unixepoch())
ON CONFLICT(id) DO UPDATE SET
    content = excluded.content,
    importance = MAX(memories.importance, excluded.importance),
    updated_at = unixepoch();
```

### 5.4 Delete-and-Reload Pattern

For phases that produce multiple outputs per conversation (e.g., entity extraction produces N entities), the safest idempotent pattern is delete-and-reload:

```typescript
const reprocessEntities = db.transaction((conversationId: string, entities: ExtractedEntity[]) => {
  // Delete previous extraction results for this conversation
  db.prepare(`
    DELETE FROM conversation_entities
    WHERE conversation_id = ? AND source = 'dream_extraction'
  `).run(conversationId);

  // Insert fresh results
  for (const entity of entities) {
    db.prepare(`
      INSERT INTO conversation_entities (conversation_id, entity_id, source)
      VALUES (?, ?, 'dream_extraction')
    `).run(conversationId, entity.id);
  }
});
```

This ensures that if extraction produces different results on re-run (e.g., after a model upgrade), stale results are cleaned up.

(Sources: [Building Idempotent Data Pipelines](https://medium.com/towards-data-engineering/building-idempotent-data-pipelines-a-practical-guide-to-reliability-at-scale-2afc1dcb7251), [How to Make Data Pipelines Idempotent](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/))

---

## 6. Progress Tracking and Reporting

### 6.1 Run-Level Tracking

```sql
-- Track each daemon run
CREATE TABLE dream_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed' | 'interrupted'
    conversations_total INTEGER DEFAULT 0,
    conversations_processed INTEGER DEFAULT 0,
    conversations_failed INTEGER DEFAULT 0,
    facts_extracted INTEGER DEFAULT 0,
    entities_extracted INTEGER DEFAULT 0,
    relationships_extracted INTEGER DEFAULT 0,
    error_message TEXT,
    duration_seconds REAL
);
```

### 6.2 Phase-Level Progress

```typescript
interface PhaseProgress {
  phase: string;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  startedAt: number;
  estimatedSecondsRemaining: number | null;
}

function getPhaseProgress(phase: string): PhaseProgress {
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      MIN(started_at) as started_at
    FROM dream_pipeline_state
    WHERE phase = ?
  `).get(phase);

  const elapsed = (Date.now() / 1000) - counts.started_at;
  const rate = counts.completed / elapsed;
  const remaining = counts.total - counts.completed - counts.failed - counts.skipped;

  return {
    phase,
    total: counts.total,
    completed: counts.completed,
    failed: counts.failed,
    skipped: counts.skipped,
    startedAt: counts.started_at,
    estimatedSecondsRemaining: rate > 0 ? remaining / rate : null,
  };
}
```

### 6.3 CLI Progress Display

```typescript
function displayProgress(progress: PhaseProgress): void {
  const pct = Math.round((progress.completed / progress.total) * 100);
  const bar = '='.repeat(Math.floor(pct / 2)).padEnd(50);
  const eta = progress.estimatedSecondsRemaining
    ? `ETA: ${Math.round(progress.estimatedSecondsRemaining / 60)}m`
    : 'calculating...';

  process.stdout.write(
    `\r[${bar}] ${pct}% (${progress.completed}/${progress.total}) ${progress.phase} | ${eta}`
  );
}
```

### 6.4 Health File for External Monitoring

Write a health JSON file that the CLI or launchd can monitor:

```typescript
// Write after each completed item
function updateHealthFile(runId: number, progress: PhaseProgress): void {
  const health = {
    runId,
    lastUpdate: new Date().toISOString(),
    phase: progress.phase,
    progress: `${progress.completed}/${progress.total}`,
    failed: progress.failed,
    eta: progress.estimatedSecondsRemaining,
  };
  writeFileSync(HEALTH_FILE_PATH, JSON.stringify(health, null, 2));
}
```

---

## 7. Batch Processing with Configurable Concurrency

### 7.1 Sequential Processing (Recommended Default)

For Engram's daemon, sequential processing is the simplest and most predictable approach:

```typescript
async function processPhase(
  phase: string,
  conversations: Conversation[],
  processor: (conv: Conversation) => Promise<void>,
): Promise<PhaseResult> {
  let processed = 0;
  let failed = 0;

  for (const conv of conversations) {
    try {
      markProcessing(conv.id, phase);
      await processor(conv);
      markCompleted(conv.id, phase);
      processed++;
    } catch (err) {
      markFailed(conv.id, phase, String(err));
      failed++;
    }
  }

  return { processed, failed };
}
```

**Why sequential?** The LLM server (Ollama/MLX) is the bottleneck. It processes one request at a time for single-user deployments. Concurrent requests just queue up in the server.

### 7.2 Controlled Concurrency (For Multi-Phase Pipelines)

If independent phases can overlap (e.g., entity extraction for conversation B while fact extraction for conversation A is being processed):

```typescript
async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<void>,
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  const queue = [...items];
  const active = new Set<Promise<void>>();

  while (queue.length > 0 || active.size > 0) {
    // Fill up to concurrency limit
    while (queue.length > 0 && active.size < concurrency) {
      const item = queue.shift()!;
      const promise = processor(item)
        .then(() => { succeeded++; })
        .catch(() => { failed++; })
        .finally(() => { active.delete(promise); });
      active.add(promise);
    }

    // Wait for at least one to complete
    if (active.size > 0) {
      await Promise.race(active);
    }
  }

  return { succeeded, failed };
}
```

### 7.3 Batch Size Configuration

```typescript
interface DreamConfig {
  batchSize: number;       // Conversations per batch (default: 50)
  concurrency: number;     // Max concurrent operations (default: 1)
  maxRunDuration: number;  // Max seconds per daemon run (default: 3600)
  retryLimit: number;      // Max retries per conversation (default: 3)
}

const DEFAULT_CONFIG: DreamConfig = {
  batchSize: 50,
  concurrency: 1,
  maxRunDuration: 3600,  // 1 hour
  retryLimit: 3,
};
```

The batch size controls how many conversations are processed per daemon run. For a daily daemon:
- `batchSize: 50` is good for 50 conversations/day
- `batchSize: 0` means "process all pending" -- useful but should be bounded by `maxRunDuration`

---

## 8. Error Handling Strategies

### 8.1 Skip-and-Continue (Recommended for Extraction)

For LLM extraction, individual conversations may fail (malformed input, model timeout, unexpected output). The daemon should log the failure and continue:

```typescript
async function extractWithSkipOnError(
  conversations: Conversation[],
  llm: LLMProvider,
): Promise<ExtractionResult> {
  const results: ExtractedFact[] = [];
  const failures: FailedItem[] = [];

  for (const conv of conversations) {
    try {
      const facts = await extractFacts(llm, conv);
      results.push(...facts);
      markCompleted(conv.id, 'extract_facts');
    } catch (err) {
      const retries = getRetryCount(conv.id, 'extract_facts');
      if (retries < MAX_RETRIES) {
        markPending(conv.id, 'extract_facts'); // Will retry next run
        failures.push({ id: conv.id, error: String(err), willRetry: true });
      } else {
        markSkipped(conv.id, 'extract_facts', String(err)); // Give up
        failures.push({ id: conv.id, error: String(err), willRetry: false });
      }
    }
  }

  return { results, failures };
}
```

### 8.2 Fail-Fast (For Critical Phases)

Some operations should abort the entire run on failure (e.g., database corruption, LLM server crash):

```typescript
// If the LLM server is unresponsive, abort the run
async function ensureLLMAvailable(llm: LLMProvider): Promise<void> {
  try {
    await llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1 });
  } catch (err) {
    throw new FatalError(`LLM provider unavailable: ${err}`);
  }
}
```

### 8.3 Retry Strategies

| Strategy | When to Use | Implementation |
|----------|-------------|----------------|
| **Immediate retry** | Transient network errors | Retry once within the same request |
| **Deferred retry** | LLM timeout, rate limiting | Mark pending, retry next batch |
| **Exponential backoff** | Server overload | Increasing delay between retries |
| **Skip after N retries** | Persistent failure | Mark as skipped after retryLimit |

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}
```

### 8.4 Dead Letter Queue

Conversations that repeatedly fail should be quarantined:

```sql
-- Conversations that failed all retries
CREATE VIEW dream_dead_letters AS
SELECT ps.conversation_id, ps.phase, ps.error_message, ps.retry_count
FROM dream_pipeline_state ps
WHERE ps.status = 'skipped'
  AND ps.retry_count >= 3;
```

The CLI can expose these for manual inspection:

```bash
engram dream --failed
# Output:
# conv_abc123 | extract_facts | Retry 3/3 | JSON parse error: unexpected token
# conv_def456 | extract_entities | Retry 3/3 | LLM timeout after 60s
```

(Sources: [The Importance of Idempotent Data Pipelines](https://www.prefect.io/blog/the-importance-of-idempotent-data-pipelines-for-resilience), [Idempotent Processing Implementation](https://dev3lop.com/idempotent-processing-implementation-for-pipeline-reliability/))

---

## 9. Pipeline Orchestration in Node.js/TypeScript

### 9.1 Simple Sequential Pipeline (Recommended)

For Engram, a lightweight sequential pipeline pattern without external dependencies:

```typescript
// src/daemon/pipeline.ts

interface PipelinePhase {
  name: string;
  execute: (context: PipelineContext) => Promise<PhaseResult>;
  canSkip?: (context: PipelineContext) => boolean;
}

interface PipelineContext {
  db: Database;
  llm: LLMProvider;
  config: DreamConfig;
  runId: number;
  signal: AbortSignal;
}

interface PhaseResult {
  processed: number;
  failed: number;
  skipped: number;
}

export class DreamPipeline {
  private phases: PipelinePhase[];
  private context: PipelineContext;

  constructor(context: PipelineContext) {
    this.context = context;
    this.phases = [
      { name: 'ingest', execute: ingestPhase },
      { name: 'extract_facts', execute: extractFactsPhase },
      { name: 'extract_entities', execute: extractEntitiesPhase },
      { name: 'extract_relationships', execute: extractRelationshipsPhase },
      { name: 'consolidate', execute: consolidatePhase },
    ];
  }

  async run(): Promise<PipelineRunResult> {
    const results: Map<string, PhaseResult> = new Map();

    for (const phase of this.phases) {
      // Check for shutdown signal
      if (this.context.signal.aborted) {
        console.log(`[dream] Shutdown requested, stopping before ${phase.name}`);
        break;
      }

      // Check time budget
      if (this.isOverTimeBudget()) {
        console.log(`[dream] Time budget exceeded, stopping before ${phase.name}`);
        break;
      }

      // Check if phase can be skipped
      if (phase.canSkip?.(this.context)) {
        console.log(`[dream] Skipping ${phase.name} (nothing to do)`);
        results.set(phase.name, { processed: 0, failed: 0, skipped: 0 });
        continue;
      }

      console.log(`[dream] Starting phase: ${phase.name}`);
      const startTime = Date.now();

      try {
        const result = await phase.execute(this.context);
        results.set(phase.name, result);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[dream] Phase ${phase.name} complete: ${result.processed} processed, ${result.failed} failed (${elapsed}s)`);
      } catch (err) {
        console.error(`[dream] Phase ${phase.name} failed fatally:`, err);
        results.set(phase.name, { processed: 0, failed: 0, skipped: 0 });
        break; // Fatal error stops the pipeline
      }
    }

    return { phases: results };
  }

  private isOverTimeBudget(): boolean {
    // Implemented based on context.config.maxRunDuration
    return false; // Placeholder
  }
}
```

### 9.2 State Machine Pattern

For more complex pipelines with conditional branching:

```typescript
type PipelineState =
  | 'idle'
  | 'ingesting'
  | 'extracting_facts'
  | 'extracting_entities'
  | 'extracting_relationships'
  | 'consolidating'
  | 'completed'
  | 'failed';

const TRANSITIONS: Record<PipelineState, PipelineState[]> = {
  idle: ['ingesting'],
  ingesting: ['extracting_facts', 'completed'],
  extracting_facts: ['extracting_entities', 'completed'],
  extracting_entities: ['extracting_relationships', 'completed'],
  extracting_relationships: ['consolidating', 'completed'],
  consolidating: ['completed'],
  completed: ['idle'],
  failed: ['idle'],
};

function canTransition(from: PipelineState, to: PipelineState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
```

This approach is cleaner than ad-hoc conditionals and makes the pipeline's valid states explicit.

(Sources: [XState - JavaScript State Machines](https://xstate.js.org/), [The Pipeline Pattern](https://dev.to/wallacefreitas/the-pipeline-pattern-streamlining-data-processing-in-software-architecture-44hn), [Orbits](https://orbits.do/blog/workflows-orchestrate-microservices/))

### 9.3 AbortController for Graceful Cancellation

Node.js's built-in `AbortController` integrates cleanly with async pipelines:

```typescript
// src/daemon/index.ts
const controller = new AbortController();

process.on('SIGTERM', () => {
  console.log('[dream] SIGTERM received, requesting pipeline shutdown...');
  controller.abort();
});

const pipeline = new DreamPipeline({
  ...context,
  signal: controller.signal,
});

await pipeline.run();
```

Each phase checks `signal.aborted` before starting the next conversation. The pipeline stops at a clean checkpoint boundary rather than mid-conversation.

### 9.4 Why Not Use a Job Queue Library?

Libraries like BullMQ, Trigger.dev, and Temporal are designed for distributed systems with multiple workers. For Engram:

| Feature | Need? | Solution |
|---------|-------|----------|
| Distributed execution | No (single machine) | Sequential pipeline |
| Job persistence | Yes | SQLite pipeline_state table |
| Retry with backoff | Yes | Application-level retry |
| Priority queues | No (process all pending) | ORDER BY in SQL query |
| Monitoring dashboard | No | CLI status command |
| Redis dependency | No | SQLite only |

The overhead of adding Redis + BullMQ for a single-machine batch processor is not justified. SQLite provides all the persistence and atomicity needed.

(Sources: [BullMQ](https://bullmq.io/), [Trigger.dev](https://trigger.dev/), [Lightweight Alternative to Temporal](https://dev.to/louis_dussarps_e656bc7b01/a-lightweight-alternative-to-temporal-for-nodejs-applications-9e4))

---

## 10. Lessons from Production Systems

### 10.1 Apache Flink's Checkpointing

Flink periodically takes consistent snapshots of the entire distributed dataflow:
- **Barrier-based**: Injects checkpoint barriers into the data stream. When an operator receives a barrier, it snapshots its state.
- **Asynchronous**: State is snapshotted asynchronously to avoid blocking data processing.
- **Exactly-once semantics**: Guarantees each record is processed exactly once through barrier alignment.

**Lesson for Engram:** While we do not need distributed snapshots, the principle of snapshotting at well-defined boundaries (between conversations, not mid-conversation) is directly applicable.

(Source: [Apache Flink Checkpointing](https://nightlies.apache.org/flink/flink-docs-master/docs/dev/datastream/fault-tolerance/checkpointing/))

### 10.2 LangGraph's Agent Checkpointing

LangGraph (LangChain's agent orchestration) demonstrates modern agent checkpointing:

> "LangGraph allows an AI workflow to pause at a node, save the entire execution state, and later resume from that checkpoint."

Key features:
- **Thread-based**: Each execution thread has its own checkpoint history
- **State branching**: Checkpoints can be forked for exploring alternatives
- **Human-in-the-loop**: Checkpoint state can be modified before resuming

**Lesson for Engram:** The "thread_id as cursor" pattern maps to our conversation_id as cursor. Each conversation is an independent thread of processing.

(Source: [LangGraph Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts))

### 10.3 Trigger.dev's Checkpoint-Resume

Trigger.dev implements automatic checkpointing for long-running serverless tasks:

> "Trigger.dev automatically suspends (checkpoints) tasks during waits, so you don't pay for idle time. When a wait exceeds ~5 seconds, the task worker is suspended and resumed when the wait completes."

Key pattern: **Fan-out orchestration** -- an orchestrator spawns N child tasks, waits for all to complete, then aggregates results. This maps to processing N conversations in a phase.

**Lesson for Engram:** The fan-out pattern is useful for future optimization where entity resolution could be parallelized across conversations.

(Source: [Trigger.dev Deep Dive](https://vadim.blog/trigger-dev-deep-dive))

### 10.4 Dagster's Asset-Based Checkpointing

Dagster treats pipeline outputs as **software-defined assets** with built-in materialization tracking:
- Each asset knows when it was last materialized
- Re-materialization is incremental (only processes new inputs)
- Partition-aware: assets can be materialized per time partition

**Lesson for Engram:** Treat extracted facts, entities, and relationships as "assets" that are materialized from "source assets" (conversations). Each has a clear lineage.

(Source: [Data Pipeline Architecture: 5 Design Patterns](https://dagster.io/guides/data-pipeline-architecture-5-design-patterns-with-examples))

---

## 11. Key Takeaways for Engram

### Schema Design

```sql
-- Pipeline state tracking (per-conversation, per-phase)
CREATE TABLE dream_pipeline_state (
    conversation_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at INTEGER,
    completed_at INTEGER,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    run_id INTEGER REFERENCES dream_runs(id),
    PRIMARY KEY (conversation_id, phase)
);

-- Cursor tracking (high-water marks)
CREATE TABLE dream_cursors (
    phase TEXT PRIMARY KEY,
    last_processed_id TEXT,
    last_processed_at INTEGER,
    items_processed INTEGER DEFAULT 0
);

-- Run tracking
CREATE TABLE dream_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    phase_results TEXT,  -- JSON summary
    error_message TEXT
);
```

### Pipeline Architecture

```
Daemon Start
  |
  v
Crash Recovery (reset interrupted items)
  |
  v
Phase 1: Ingest (discover new conversations)
  |
  v
Phase 2: Extract Facts (LLM-powered, per conversation)
  |  checkpoint after each conversation
  v
Phase 3: Extract Entities (LLM-powered, per conversation)
  |  checkpoint after each conversation
  v
Phase 4: Extract Relationships (LLM-powered, per conversation)
  |  checkpoint after each conversation
  v
Phase 5: Consolidate (merge entities, update communities, decay scores)
  |
  v
Daemon Exit (WAL checkpoint, write health file, release PID lock)
```

### Design Principles

1. **Per-conversation checkpointing**: Each conversation is the unit of work. Checkpoint after processing each one.
2. **Atomic transactions**: Results and status updates committed together in SQLite transactions.
3. **Idempotent by design**: Content-addressed IDs + upsert semantics = safe to re-run.
4. **Skip-and-continue for extraction**: Individual failures do not block the pipeline.
5. **Fail-fast for infrastructure**: LLM server down = abort the run.
6. **Time-bounded runs**: `maxRunDuration` prevents runaway processing.
7. **No external dependencies**: SQLite provides all persistence. No Redis, no job queues.
8. **AbortController for cancellation**: Graceful shutdown at checkpoint boundaries.
9. **Retry with limit**: Failed conversations get 3 retries across runs, then are quarantined.
10. **Observable**: Health file, run table, CLI status command.

---

## Sources

### Checkpointing Theory
- [Checkpoint/Restore Systems: Evolution, Techniques, and Applications in AI Agents](https://eunomia.dev/blog/2025/05/11/checkpointrestore-systems-evolution-techniques-and-applications-in-ai-agents/)
- [What Does Checkpointing Mean (Dagster)](https://dagster.io/glossary/checkpointing)

### Idempotent Processing
- [Understanding Idempotency: Key to Reliable Data Pipelines (Airbyte)](https://airbyte.com/data-engineering-resources/idempotency-in-data-pipelines)
- [Building Idempotent Data Pipelines (Medium)](https://medium.com/towards-data-engineering/building-idempotent-data-pipelines-a-practical-guide-to-reliability-at-scale-2afc1dcb7251)
- [How to Make Data Pipelines Idempotent](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/)
- [The Importance of Idempotent Data Pipelines (Prefect)](https://www.prefect.io/blog/the-importance-of-idempotent-data-pipelines-for-resilience)
- [Idempotent Processing Implementation (Dev3lop)](https://dev3lop.com/idempotent-processing-implementation-for-pipeline-reliability/)
- [Data Pipeline Fundamentals (ML4Devs)](https://www.ml4devs.com/what-is/data-pipeline/)

### SQLite and WAL
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html)
- [SQLite Checkpoint API](https://sqlite.org/c3ref/wal_checkpoint_v2.html)
- [How SQLite Scales Read Concurrency (Fly.io)](https://fly.io/blog/sqlite-internals-wal/)
- [better-sqlite3 Performance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [Improving Concurrency (better-sqlite3)](https://wchargin.com/better-sqlite3/performance.html)
- [Journal Modes in SQLite](https://blog.sqlite.ai/journal-modes-in-sqlite)

### Pipeline Orchestration
- [Data Pipeline Architecture: 5 Design Patterns (Dagster)](https://dagster.io/guides/data-pipeline-architecture-5-design-patterns-with-examples)
- [Data Pipeline Architecture: 9 Patterns (Alation)](https://www.alation.com/blog/data-pipeline-architecture-patterns/)
- [The Pipeline Pattern (Dev.to)](https://dev.to/wallacefreitas/the-pipeline-pattern-streamlining-data-processing-in-software-architecture-44hn)
- [Building a Type-Safe Data Processing Pipeline in TypeScript](https://dev.to/sakobume/building-a-type-safe-data-processing-pipeline-in-typescript-1nfe)

### Production Systems
- [Apache Flink Checkpointing](https://nightlies.apache.org/flink/flink-docs-master/docs/dev/datastream/fault-tolerance/checkpointing/)
- [Apache Spark vs Flink (ChaosGenius)](https://www.chaosgenius.io/blog/apache-spark-vs-flink/)
- [LangGraph Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Trigger.dev Deep Dive](https://vadim.blog/trigger-dev-deep-dive)
- [Trigger.dev How It Works](https://trigger.dev/docs/how-it-works)

### Job Queue Alternatives
- [BullMQ](https://bullmq.io/)
- [A Lightweight Alternative to Temporal for Node.js](https://dev.to/louis_dussarps_e656bc7b01/a-lightweight-alternative-to-temporal-for-nodejs-applications-9e4)
- [XState State Machines](https://xstate.js.org/)
- [Orbits Workflow Orchestration](https://orbits.do/blog/workflows-orchestrate-microservices/)
- [pipeline-js (npm)](https://github.com/kamranahmedse/pipeline-js)
