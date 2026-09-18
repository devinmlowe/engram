/**
 * The bodies of `engram init` and `engram sync`, as functions, so
 * `engram setup` (#61) runs the very same steps instead of re-implementing
 * them. `index.ts` keeps the flag parsing and calls these.
 */
import { existsSync } from "node:fs";
import type { EngramConfig } from "../../_core/types/index.js";
import { getDatabase, closeDatabase } from "../../_core/db/index.js";
import type { SyncResult } from "../../episodic/sync.js";

export interface InitSummary {
  dbPath: string;
  /** False when `engram.db` already existed before this run. */
  created: boolean;
  modelCacheDir: string;
  model: string;
}

/**
 * Create the database (schema migrations run on open), point transformers.js
 * at the durable model cache (adopting a pre-0.4.0 node_modules cache, #53)
 * and download the embedding model. Idempotent: an existing database and a
 * populated cache make it a fast no-op.
 */
export async function runInit(config: EngramConfig, log: (line: string) => void = console.log): Promise<InitSummary> {
  const { initEmbeddings, getActiveModel } = await import("../../_core/embeddings/index.js");
  const existed = existsSync(config.dbPath);

  log("Initializing database...");
  getDatabase(config);
  closeDatabase();
  log(`  Database: ${config.dbPath}${existed ? " (already present)" : ""}`);

  const { env: transformersEnv } = await import("@xenova/transformers");
  const { applyModelCacheDir } = await import("../../_core/embeddings/model-cache.js");
  const cacheDir = applyModelCacheDir(transformersEnv, config.modelCacheDir, { log: (l) => log(`  ${l}`) });
  log(`  Model cache: ${cacheDir}`);

  log("Downloading embedding model...");
  await initEmbeddings(config);
  const model = getActiveModel();
  log(`  Model: ${model}`);

  log("Done. Engram is ready.");
  return { dbPath: config.dbPath, created: !existed, modelCacheDir: cacheDir, model };
}

export interface SyncOptions {
  project?: string;
  force?: boolean;
  dryRun?: boolean;
}

/** Index conversations from `~/.claude/projects` (the `engram sync` body). */
export async function runSync(config: EngramConfig, opts: SyncOptions = {}, log: (line: string) => void = console.log): Promise<SyncResult> {
  const { syncConversations } = await import("../../episodic/sync.js");
  const db = getDatabase(config);
  try {
    log("Syncing conversations...");
    const result = await syncConversations(db, config, opts);
    log("");
    log("Sync complete:");
    log(`  Discovered: ${result.discovered}`);
    log(`  Copied:     ${result.copied}`);
    log(`  Indexed:    ${result.indexed}`);
    log(`  Skipped:    ${result.skipped}`);
    if (result.errors.length > 0) {
      log(`  Errors:     ${result.errors.length}`);
      for (const err of result.errors) console.error(`    ${err.file}: ${err.error}`);
    }
    return result;
  } finally {
    closeDatabase();
  }
}
