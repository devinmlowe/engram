/**
 * Database module — re-exports all DAL helpers.
 *
 * Consumers should import from '_core/db/index.js' (or '_core/db/')
 * rather than importing sub-modules directly.
 */

// Schema & initialization
export {
  initDatabase,
  pruneZeroEntityVectors,
  backfillEventTs,
  migrateCommitments,
  migrateForget,
  migrateSuppressionsScope,
  COMMITMENTS_MIGRATION,
  FORGET_MIGRATION,
  SUPPRESSIONS_SCOPE_MIGRATION,
  MEMORY_HISTORY_MIGRATION,
  MEMORY_CHANGE_OPS,
  EVENT_TS_SUBQUERY,
  SCHEMA_MIGRATIONS,
  SCHEMA_VERSION,
  BREAKING_MIGRATIONS,
  schemaVersion,
  type SchemaVersion,
} from "./schema.js";

// History trail (memory_history audit support + read API)
export {
  registerHistoryFunctions,
  withHistoryActor,
  listMemoryHistory,
  UNKNOWN_ACTOR,
  type MemoryHistoryRow,
} from "./history.js";

// Connection management
export {
  getDatabase,
  closeDatabase,
  withTransaction,
} from "./connection.js";

// CRUD helpers
export {
  getById,
  insertRow,
  count,
} from "./helpers.js";

// Vector helpers
export {
  insertVector,
  searchVector,
  deleteVector,
  getVector,
} from "./vector.js";

// FTS helpers
export {
  rebuildFts,
  insertFtsRow,
  deleteFtsRow,
} from "./fts.js";
