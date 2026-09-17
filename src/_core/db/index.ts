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
  COMMITMENTS_MIGRATION,
  EVENT_TS_SUBQUERY,
} from "./schema.js";

// Connection management
export {
  getDatabase,
  closeDatabase,
  resetDatabaseState,
  withTransaction,
} from "./connection.js";

// CRUD helpers
export {
  getById,
  getAll,
  insertRow,
  updateRow,
  upsertRow,
  deleteRow,
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
  syncFts,
} from "./fts.js";
