/**
 * eval/src/fixtures/mini-store.ts — hermetic seeded mini-DB builder (SPEC-007).
 *
 * Builds a real Engram store via the repo's own initDatabase + insertMemory
 * (with repo-generated embeddings), so acceptance/unit tests exercise the
 * genuine schema and recall path — never the live 483MB store.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { EngramConfig } from "../../../src/_core/types/index.js";
import { loadConfig } from "../../../src/_core/config/index.js";
import { initDatabase } from "../../../src/_core/db/schema.js";
import { insertMemory, insertConflict } from "../../../src/semantic/memory.js";
import { contentHash } from "../../../src/semantic/forget.js";
import { initEmbeddings, embedDocument } from "../../../src/_core/embeddings/index.js";
import type { Memory } from "../../../src/semantic/types.js";

export interface ConflictPairSeed {
  conflict: { id: string; resolution?: string; description: string };
  surviving: { id: string; type?: string; content: string; is_active?: boolean; created_at?: number };
  stale: { id: string; type?: string; content: string; is_active?: boolean; superseded_by?: string; created_at?: number };
}

export interface ChangeSeed {
  id: string;
  memoryId: string;
  op: "forget" | "edit" | "purge" | "restore";
  before: string | null;
  after: string | null;
  at: string;
}

export interface SuppressionSeed {
  memoryId: string;
  scope: string;
  content: string;
  keepActive?: boolean;
}

export interface MiniStoreSeed {
  conflictPairs: ConflictPairSeed[];
  changes: ChangeSeed[];
  suppressions: SuppressionSeed[];
}

export interface MiniStore {
  dbPath: string;
  db: Database.Database;
}

function toMemory(
  seed: ConflictPairSeed["surviving"] | ConflictPairSeed["stale"],
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id: seed.id,
    type: (seed.type ?? "fact") as Memory["type"],
    content: seed.content,
    confidence: 0.9,
    importance: 0.5,
    accessCount: 0,
    createdAt: seed.created_at ?? Math.floor(Date.now() / 1000),
    sourceExchanges: [],
    isActive: seed.is_active ?? true,
    scope: "global",
    ...overrides,
  };
}

/**
 * Build a hermetic mini Engram store at `<dir>/engram.db` from the seed.
 * Uses the repo's real initDatabase / insertMemory / insertConflict and the
 * repo's local embedding pipeline (model cached under the Engram data dir —
 * hermetic means no live store, local compute only).
 */
export async function buildMiniStore(
  dir: string,
  seed: MiniStoreSeed,
): Promise<MiniStore> {
  const base = loadConfig({ dataDir: dir });
  const config: EngramConfig = {
    ...base,
    // Pin the DB inside `dir` regardless of ENGRAM_DATA_DIR / ENGRAM_DB_PATH.
    dbPath: join(dir, "engram.db"),
  };

  await initEmbeddings(config);

  const db = initDatabase(config);
  try {
    const allContent: string[] = [];
    for (const pair of seed.conflictPairs) {
      allContent.push(pair.surviving.content, pair.stale.content);
    }
    for (const sup of seed.suppressions) allContent.push(sup.content);
    const embeddings = await Promise.all(allContent.map(embedDocument));
    const byContent = new Map(allContent.map((c, i) => [c, embeddings[i]]));

    for (const pair of seed.conflictPairs) {
      insertMemory(db, toMemory(pair.surviving), byContent.get(pair.surviving.content)!);
      insertMemory(
        db,
        toMemory(pair.stale, {
          isActive: pair.stale.is_active ?? false,
          supersededBy: pair.stale.superseded_by ?? pair.surviving.id,
        }),
        byContent.get(pair.stale.content)!,
      );
      insertConflict(db, {
        id: pair.conflict.id,
        memoryId: pair.surviving.id,
        conflictingMemoryId: pair.stale.id,
        description: pair.conflict.description,
        resolution: pair.conflict.resolution ?? "update",
        createdAt: Math.floor(Date.now() / 1000),
      });
    }

    for (const sup of seed.suppressions) {
      insertMemory(
        db,
        {
          id: sup.memoryId,
          type: "fact",
          content: sup.content,
          confidence: 0.9,
          importance: 0.5,
          accessCount: 0,
          createdAt: Math.floor(Date.now() / 1000),
          sourceExchanges: [],
          isActive: sup.keepActive ?? false,
          scope: sup.scope,
        },
        byContent.get(sup.content)!,
      );
      db.prepare(
        `INSERT OR REPLACE INTO memory_suppressions
           (content_hash, memory_id, scope, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(contentHash(sup.content), sup.memoryId, sup.scope, new Date().toISOString());
    }

    for (const change of seed.changes) {
      db.prepare(
        `INSERT INTO memory_changes (id, memory_id, op, before, after, actor, at)
         VALUES (?, ?, ?, ?, ?, 'eval-seed', ?)`,
      ).run(change.id, change.memoryId, change.op, change.before, change.after, change.at);
    }
  } catch (err) {
    db.close();
    throw err;
  }

  return { dbPath: config.dbPath, db };
}

/** Remove a mini store produced by buildMiniStore (call after closing). */
export function cleanupMiniStore(dbPath: string): void {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  } catch {
    // best effort
  }
}
