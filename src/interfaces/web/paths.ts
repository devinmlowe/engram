/**
 * Filesystem paths used by the web visualizer.
 *
 * Every path is resolved through loadConfig() so the visualizer, the dream
 * daemon, and the CLI always agree on where engram data lives
 * (ENGRAM_DATA_DIR, ENGRAM_DB_PATH, ENGRAM_LOGS_DIR, platform defaults).
 * Resolved lazily on each call so the contract tests can vary the
 * environment after import.
 */

import { loadConfig } from "../../_core/config/index.js";

/** SQLite database the visualizer opens read-only. */
export function resolveWebDbPath(): string {
  return loadConfig().dbPath;
}
