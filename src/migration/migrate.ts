/**
 * Core migration pipeline: superpowers conversation-index → Engram.
 *
 * Migrates ~3,605 exchanges with embeddings, tool calls, and conversations.
 * Supports checkpointing for resumable runs, batch processing for performance,
 * and dry-run mode for pre-flight validation.
 */

import Database from "better-sqlite3";
import { basename, dirname } from "node:path";
import type { Exchange, ToolCall, Conversation } from "../episodic/types.js";
import { initDatabase, rebuildFts } from "../_core/db/index.js";
import { loadConfig } from "../_core/config/index.js";
import { extractProjectName } from "../episodic/sync.js";
import { initEmbeddings, embedDocumentBatch } from "../_core/embeddings/index.js";
import { upsertConversation } from "../episodic/store.js";
import type {
  MigrationBatchConfig,
  MigrationProgress,
  MigrationCheckpoint,
  MigrationReport,
  ValidationResult,
  SourceExchange,
} from "./types.js";
import { DEFAULT_BATCH_CONFIG, EXCLUDED_PROJECT } from "./types.js";

// ─── Schema Mapping ─────────────────────────────────────────────

/**
 * Derive the conversation ID from an archive path.
 * Archive paths look like: /path/to/project/<uuid>.jsonl
 */
export function deriveConversationId(archivePath: string): string {
  return basename(archivePath, ".jsonl");
}

/**
 * Derive the project name from an archive path directory.
 * Uses the same extraction logic as the sync module.
 */
export function deriveProject(archivePath: string): string {
  const dirName = basename(dirname(archivePath));
  return extractProjectName(dirName);
}

/**
 * Compute sequential exchange indexes per conversation.
 * Exchanges are ordered by archive_path, line_start within each conversation.
 */
export function computeExchangeIndexes(
  sourceDb: Database.Database,
): Map<string, number> {
  const rows = sourceDb
    .prepare(
      `SELECT id, archive_path, line_start
       FROM exchanges
       WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'
       ORDER BY archive_path, line_start`,
    )
    .all() as { id: string; archive_path: string; line_start: number }[];

  const indexes = new Map<string, number>();
  let currentArchive = "";
  let currentIndex = 0;

  for (const row of rows) {
    if (row.archive_path !== currentArchive) {
      currentArchive = row.archive_path;
      currentIndex = 0;
    }
    indexes.set(row.id, currentIndex);
    currentIndex++;
  }

  return indexes;
}

/**
 * Rough token estimation: (userMsg + assistantMsg) / 4.
 */
export function estimateTokens(
  userMsg: string,
  assistantMsg: string,
): number {
  return Math.ceil((userMsg.length + assistantMsg.length) / 4);
}

/**
 * Map a source exchange to the Engram Exchange type.
 */
export function mapSourceToTarget(
  source: SourceExchange,
  exchangeIndex: number,
): Exchange {
  return {
    id: source.id,
    conversationId: deriveConversationId(source.archive_path),
    project: deriveProject(source.archive_path),
    timestamp: source.timestamp,
    userMessage: source.user_message,
    assistantMessage: source.assistant_message,
    sessionId: source.session_id ?? undefined,
    cwd: source.cwd ?? undefined,
    gitBranch: source.git_branch ?? undefined,
    modelVersion: source.claude_version ?? undefined,
    exchangeIndex,
    tokenEstimate: estimateTokens(
      source.user_message || "",
      source.assistant_message || "",
    ),
    createdAt: Math.floor(new Date(source.timestamp).getTime() / 1000),
  };
}

/**
 * Map a source tool call to the Engram ToolCall type.
 * Truncates tool_input to 1000 chars, tool_result to 500 chars.
 */
export function mapToolCall(source: {
  id: string;
  exchange_id: string;
  tool_name: string;
  tool_input?: string | null;
  tool_result?: string | null;
  is_error?: number | null;
  timestamp?: string | null;
}): ToolCall {
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
    timestamp: source.timestamp ?? undefined,
  };
}

// ─── Conversation Aggregation ───────────────────────────────────

/**
 * Build conversation records by aggregating source exchanges grouped by archive_path.
 * Applies the EXCLUDED_PROJECT filter.
 */
export function buildConversations(
  sourceDb: Database.Database,
): Conversation[] {
  const rows = sourceDb
    .prepare(
      `SELECT
         archive_path,
         MIN(timestamp) as started_at,
         MAX(timestamp) as ended_at,
         COUNT(*) as exchange_count
       FROM exchanges
       WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'
       GROUP BY archive_path`,
    )
    .all() as {
    archive_path: string;
    started_at: string;
    ended_at: string;
    exchange_count: number;
  }[];

  return rows.map((row) => ({
    id: deriveConversationId(row.archive_path),
    project: deriveProject(row.archive_path),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exchangeCount: row.exchange_count,
    archivePath: row.archive_path,
    lastIndexed: Math.floor(Date.now() / 1000),
  }));
}

// ─── Checkpoint Management ──────────────────────────────────────

/**
 * Create the migration_checkpoints table if it doesn't exist.
 */
export function ensureCheckpointTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_checkpoints (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_exchange_id TEXT NOT NULL,
      processed_count INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      phase TEXT NOT NULL
    )
  `);
}

/**
 * Get the current migration checkpoint, or null if none exists.
 */
export function getCheckpoint(
  db: Database.Database,
): MigrationCheckpoint | null {
  const row = db
    .prepare("SELECT * FROM migration_checkpoints WHERE id = 1")
    .get() as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    lastExchangeId: row.last_exchange_id as string,
    processedCount: row.processed_count as number,
    timestamp: row.timestamp as number,
    phase: row.phase as string,
  };
}

/**
 * Save a migration checkpoint (upsert).
 */
export function saveCheckpoint(
  db: Database.Database,
  checkpoint: MigrationCheckpoint,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO migration_checkpoints
       (id, last_exchange_id, processed_count, timestamp, phase)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(
    checkpoint.lastExchangeId,
    checkpoint.processedCount,
    checkpoint.timestamp,
    checkpoint.phase,
  );
}

// ─── Batch Operations ───────────────────────────────────────────

/**
 * Migrate exchanges from source to target DB with batch embedding.
 * Skips exchanges already processed (based on checkpoint) unless force=true.
 */
export async function migrateExchanges(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  config: MigrationBatchConfig = DEFAULT_BATCH_CONFIG,
  onProgress?: (progress: MigrationProgress) => void,
): Promise<{ migrated: number; embedded: number; errors: string[] }> {
  const errors: string[] = [];

  // Get checkpoint to determine resume point
  const checkpoint = getCheckpoint(targetDb);

  // Query all source exchanges (excluding EXCLUDED_PROJECT)
  const allExchanges = sourceDb
    .prepare(
      `SELECT * FROM exchanges
       WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'
       ORDER BY archive_path, line_start`,
    )
    .all() as SourceExchange[];

  const total = allExchanges.length;

  // Skip already processed exchanges if resuming
  let startIdx = 0;
  if (checkpoint) {
    const lastIdx = allExchanges.findIndex(
      (e) => e.id === checkpoint.lastExchangeId,
    );
    if (lastIdx >= 0) {
      startIdx = lastIdx + 1;
    }
  }

  const exchangesToProcess = allExchanges.slice(startIdx);
  const exchangeIndexes = computeExchangeIndexes(sourceDb);

  // Prepare insert statements
  const insertExchangeStmt = targetDb.prepare(`
    INSERT OR REPLACE INTO exchanges
      (id, conversation_id, project, timestamp, user_message, assistant_message,
       session_id, cwd, git_branch, model_version, exchange_index, token_estimate,
       created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteVecStmt = targetDb.prepare(
    "DELETE FROM vec_exchanges WHERE id = ?",
  );

  const insertVecStmt = targetDb.prepare(
    "INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)",
  );

  let migrated = 0;
  let embedded = 0;
  const startTime = Date.now();

  // Process in embedding batches
  for (
    let i = 0;
    i < exchangesToProcess.length;
    i += config.embeddingBatchSize
  ) {
    const batch = exchangesToProcess.slice(
      i,
      i + config.embeddingBatchSize,
    );

    // Build embedding input texts
    const texts = batch.map((ex) => {
      const parts: string[] = [];
      const project = deriveProject(ex.archive_path);
      const date = ex.timestamp.split("T")[0];
      parts.push(`[Project: ${project} | Date: ${date}]`);
      parts.push(`User: ${ex.user_message}`);
      parts.push(
        `Assistant: ${(ex.assistant_message || "").substring(0, 500)}`,
      );
      return parts.join("\n");
    });

    // Batch embed
    let embeddings: number[][];
    try {
      embeddings = await embedDocumentBatch(texts);
      embedded += embeddings.length;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      errors.push(`Embedding batch error at offset ${i}: ${msg}`);
      continue;
    }

    // Insert in DB transaction batches
    const insertBatch = targetDb.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const source = batch[j];
        const exchangeIndex = exchangeIndexes.get(source.id) ?? 0;
        const mapped = mapSourceToTarget(source, exchangeIndex);

        insertExchangeStmt.run(
          mapped.id,
          mapped.conversationId,
          mapped.project,
          mapped.timestamp,
          mapped.userMessage,
          mapped.assistantMessage,
          mapped.sessionId ?? null,
          mapped.cwd ?? null,
          mapped.gitBranch ?? null,
          mapped.modelVersion ?? null,
          mapped.exchangeIndex,
          mapped.tokenEstimate,
          mapped.createdAt,
          mapped.lastAccessed ?? null,
        );

        // Insert vector embedding
        if (j < embeddings.length) {
          deleteVecStmt.run(mapped.id);
          insertVecStmt.run(
            mapped.id,
            Buffer.from(new Float32Array(embeddings[j]).buffer),
          );
        }

        migrated++;
      }
    });

    insertBatch();

    // Save checkpoint periodically
    if (migrated % config.checkpointInterval === 0 || i + batch.length >= exchangesToProcess.length) {
      const lastExchange = batch[batch.length - 1];
      saveCheckpoint(targetDb, {
        lastExchangeId: lastExchange.id,
        processedCount: startIdx + migrated,
        timestamp: Math.floor(Date.now() / 1000),
        phase: "embedding",
      });
    }

    // Report progress
    if (onProgress) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = migrated / elapsed;
      const remaining = exchangesToProcess.length - (i + batch.length);
      onProgress({
        phase: "embedding",
        total,
        processed: startIdx + migrated,
        errors: errors.length,
        estimatedSecondsRemaining:
          rate > 0 ? Math.ceil(remaining / rate) : undefined,
      });
    }
  }

  return { migrated, embedded, errors };
}

/**
 * Migrate tool calls from source to target DB in large transactions.
 */
export async function migrateToolCalls(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  _config: MigrationBatchConfig = DEFAULT_BATCH_CONFIG,
): Promise<{ migrated: number; errors: string[] }> {
  const errors: string[] = [];
  const batchSize = 2000;

  // Get all tool calls for non-excluded exchanges
  const toolCalls = sourceDb
    .prepare(
      `SELECT tc.*
       FROM tool_calls tc
       JOIN exchanges e ON tc.exchange_id = e.id
       WHERE e.archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'`,
    )
    .all() as {
    id: string;
    exchange_id: string;
    tool_name: string;
    tool_input: string | null;
    tool_result: string | null;
    is_error: number | null;
    timestamp: string | null;
  }[];

  const insertStmt = targetDb.prepare(`
    INSERT OR REPLACE INTO tool_calls
      (id, exchange_id, tool_name, tool_input, tool_result_summary, is_error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let migrated = 0;

  // Process in transaction batches
  for (let i = 0; i < toolCalls.length; i += batchSize) {
    const batch = toolCalls.slice(i, i + batchSize);

    const insertBatch = targetDb.transaction(() => {
      for (const tc of batch) {
        try {
          const mapped = mapToolCall(tc);
          insertStmt.run(
            mapped.id,
            mapped.exchangeId,
            mapped.toolName,
            mapped.toolInput ?? null,
            mapped.toolResultSummary ?? null,
            mapped.isError ? 1 : 0,
            mapped.timestamp ?? null,
          );
          migrated++;
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : String(err);
          errors.push(`Tool call ${tc.id}: ${msg}`);
        }
      }
    });

    insertBatch();
  }

  return { migrated, errors };
}

// ─── Finalization ───────────────────────────────────────────────

/**
 * Post-migration finalization: FTS rebuild, WAL checkpoint, ANALYZE.
 */
export function finalizeMigration(db: Database.Database): void {
  // Rebuild FTS5 index from exchange content
  rebuildFts(db, "exchanges_fts");

  // Force WAL checkpoint to merge WAL into main database
  db.pragma("wal_checkpoint(TRUNCATE)");

  // Update query planner statistics
  db.exec("ANALYZE");
}

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Run the full migration pipeline.
 */
export async function runMigration(options: {
  sourcePath: string;
  dryRun?: boolean;
  batchSize?: number;
  force?: boolean;
  onProgress?: (progress: MigrationProgress) => void;
}): Promise<MigrationReport> {
  const report: MigrationReport = {
    startedAt: Date.now(),
    exchangesMigrated: 0,
    toolCallsMigrated: 0,
    conversationsCreated: 0,
    embeddingsGenerated: 0,
    errors: [],
    validationResults: [],
  };

  // Open source DB read-only
  const sourceDb = new Database(options.sourcePath, { readonly: true });

  // Initialize target DB
  const config = loadConfig();
  const targetDb = initDatabase(config);

  try {
    // Set up checkpoint table
    ensureCheckpointTable(targetDb);

    // Clear checkpoints if forcing
    if (options.force) {
      targetDb.exec(
        "DELETE FROM migration_checkpoints",
      );
    }

    // Count source data for dry run
    const sourceCount = (
      sourceDb
        .prepare(
          `SELECT COUNT(*) as count FROM exchanges
           WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'`,
        )
        .get() as { count: number }
    ).count;

    const toolCallCount = (
      sourceDb
        .prepare(
          `SELECT COUNT(*) as count FROM tool_calls tc
           JOIN exchanges e ON tc.exchange_id = e.id
           WHERE e.archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'`,
        )
        .get() as { count: number }
    ).count;

    if (options.dryRun) {
      console.log(`Dry run — would migrate:`);
      console.log(`  Exchanges:  ${sourceCount}`);
      console.log(`  Tool calls: ${toolCallCount}`);
      report.completedAt = Date.now();
      return report;
    }

    // Initialize embeddings
    await initEmbeddings(config);

    const batchConfig: MigrationBatchConfig = {
      ...DEFAULT_BATCH_CONFIG,
      embeddingBatchSize: options.batchSize ?? DEFAULT_BATCH_CONFIG.embeddingBatchSize,
    };

    // Phase 1: Migrate exchanges with embeddings
    const exchangeResult = await migrateExchanges(
      sourceDb,
      targetDb,
      batchConfig,
      options.onProgress,
    );
    report.exchangesMigrated = exchangeResult.migrated;
    report.embeddingsGenerated = exchangeResult.embedded;
    report.errors.push(...exchangeResult.errors);

    // Phase 2: Migrate tool calls
    if (options.onProgress) {
      options.onProgress({
        phase: "tool_calls",
        total: toolCallCount,
        processed: 0,
        errors: report.errors.length,
      });
    }

    const toolCallResult = await migrateToolCalls(
      sourceDb,
      targetDb,
      batchConfig,
    );
    report.toolCallsMigrated = toolCallResult.migrated;
    report.errors.push(...toolCallResult.errors);

    // Phase 3: Build and insert conversations
    const conversations = buildConversations(sourceDb);
    for (const conv of conversations) {
      upsertConversation(targetDb, conv);
    }
    report.conversationsCreated = conversations.length;

    // Phase 4: Finalize (FTS, WAL, ANALYZE)
    if (options.onProgress) {
      options.onProgress({
        phase: "fts",
        total: 1,
        processed: 0,
        errors: report.errors.length,
      });
    }

    finalizeMigration(targetDb);

    report.completedAt = Date.now();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Fatal: ${msg}`);
    report.completedAt = Date.now();
  } finally {
    sourceDb.close();
    targetDb.close();
  }

  return report;
}

// ─── UX ─────────────────────────────────────────────────────────

/**
 * Format migration progress for terminal display.
 */
export function formatProgress(p: MigrationProgress): string {
  const pct =
    p.total > 0 ? Math.round((p.processed / p.total) * 100) : 0;
  const bar = "=".repeat(Math.floor(pct / 2)).padEnd(50, " ");

  let line = `[${bar}] ${pct}% (${p.processed}/${p.total})`;
  line += ` | Phase: ${p.phase}`;

  if (p.errors > 0) {
    line += ` | Errors: ${p.errors}`;
  }

  if (p.estimatedSecondsRemaining !== undefined) {
    const mins = Math.floor(p.estimatedSecondsRemaining / 60);
    const secs = p.estimatedSecondsRemaining % 60;
    line += ` | ETA: ${mins}m${secs}s`;
  }

  return line;
}
