/**
 * Types for the superpowers → Engram migration pipeline.
 *
 * Handles batch processing, checkpointing, progress tracking,
 * validation, and source DB schema mapping.
 */

// ─── Batch Configuration ────────────────────────────────────────

export interface MigrationBatchConfig {
  /** Number of exchanges to embed in one pipeline call */
  embeddingBatchSize: number;
  /** Number of exchanges to INSERT in one SQLite transaction */
  dbBatchSize: number;
  /** How often to write a checkpoint (in exchanges) */
  checkpointInterval: number;
}

export const DEFAULT_BATCH_CONFIG: MigrationBatchConfig = {
  embeddingBatchSize: 32,
  dbBatchSize: 500,
  checkpointInterval: 500,
};

export const EXCLUDED_PROJECT = "double-shot-latte";

// ─── Progress & Checkpointing ───────────────────────────────────

export interface MigrationProgress {
  phase: "embedding" | "tool_calls" | "fts" | "validation";
  total: number;
  processed: number;
  errors: number;
  estimatedSecondsRemaining?: number;
}

export interface MigrationCheckpoint {
  lastExchangeId: string;
  processedCount: number;
  timestamp: number;
  phase: string;
}

// ─── Reporting ──────────────────────────────────────────────────

export interface MigrationReport {
  startedAt: number;
  completedAt?: number;
  exchangesMigrated: number;
  toolCallsMigrated: number;
  conversationsCreated: number;
  embeddingsGenerated: number;
  errors: string[];
  validationResults: ValidationResult[];
}

export interface ValidationResult {
  check: string;
  passed: boolean;
  expected: number | string;
  actual: number | string;
  details?: string;
}

// ─── Source DB Schema ───────────────────────────────────────────

export interface SourceExchange {
  id: string;
  project: string;
  timestamp: string;
  user_message: string;
  assistant_message: string;
  archive_path: string;
  line_start: number;
  line_end: number;
  session_id: string | null;
  cwd: string | null;
  git_branch: string | null;
  claude_version: string | null;
  is_sidechain: number;
}
