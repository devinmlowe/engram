/**
 * Memory index integrity (#55): vec_memories and memories_fts must hold rows
 * for live memories only. A forgotten memory (deleted_at set) or a missing
 * memories row must have no vector and no FTS entry — forget removes them in
 * the same transaction, so a leftover means something bypassed it (a crash
 * between statements on an old build, a hand edit, an import of a forgotten
 * row). `engram validate` reports these as failures; `--fix` repairs them.
 *
 * FTS5 external-content tables cannot be queried by rowid for index
 * membership (a rowid lookup reads the content table), so the index is
 * enumerated through a temporary fts5vocab 'instance' table.
 */

import type Database from "better-sqlite3";
import { deleteVector, rebuildFts } from "../_core/db/index.js";
import { unindexMemory } from "./forget.js";

export interface IndexAudit {
  /** vec_memories ids whose memories row is forgotten. */
  orphanVectorsForgotten: string[];
  /** vec_memories ids with no memories row at all. */
  orphanVectorsMissing: string[];
  /** memories_fts rowids whose memories row is forgotten. */
  orphanFtsForgotten: number[];
  /** memories_fts rowids with no memories row at all. */
  orphanFtsMissing: number[];
  /** Live memories (active, not forgotten) with no vector — informational. */
  liveWithoutVector: number;
}

export interface IndexRepair {
  vectorsDeleted: number;
  /** True when the FTS index was rebuilt from the content table and forgotten rows re-removed. */
  ftsRebuilt: boolean;
  ftsRowsRemoved: number;
}

/**
 * Rowids currently present in memories_fts, read from its docsize shadow
 * table. #112: an fts5vocab 'instance' table has one row per term occurrence,
 * so a document that tokenizes to nothing (punctuation or emoji only) has no
 * rows there and was never audited; docsize holds one row per indexed
 * document regardless of its terms.
 */
export function ftsIndexedRowids(db: Database.Database): number[] {
  return (db.prepare("SELECT id FROM memories_fts_docsize").all() as Array<{ id: number }>).map((r) => r.id);
}

export function auditMemoryIndex(db: Database.Database): IndexAudit {
  const orphanVectorsForgotten = (
    db
      .prepare(
        `SELECT v.id FROM vec_memories v JOIN memories m ON m.id = v.id WHERE m.deleted_at IS NOT NULL`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
  const orphanVectorsMissing = (
    db
      .prepare(`SELECT v.id FROM vec_memories v WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = v.id)`)
      .all() as Array<{ id: string }>
  ).map((r) => r.id);

  const indexed = ftsIndexedRowids(db);
  const orphanFtsForgotten: number[] = [];
  const orphanFtsMissing: number[] = [];
  if (indexed.length > 0) {
    const lookup = db.prepare("SELECT deleted_at FROM memories WHERE rowid = ?");
    for (const rowid of indexed) {
      const row = lookup.get(rowid) as { deleted_at: string | null } | undefined;
      if (!row) orphanFtsMissing.push(rowid);
      else if (row.deleted_at !== null) orphanFtsForgotten.push(rowid);
    }
  }

  const liveWithoutVector = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories m
         WHERE m.is_active = 1 AND m.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM vec_memories v WHERE v.id = m.id)`,
      )
      .get() as { n: number }
  ).n;

  return { orphanVectorsForgotten, orphanVectorsMissing, orphanFtsForgotten, orphanFtsMissing, liveWithoutVector };
}

/**
 * Remove orphaned index rows. Vectors are deleted by id. FTS orphans for
 * missing rows cannot be deleted individually (the 'delete' command needs the
 * original text), so when any FTS orphan exists the index is rebuilt from the
 * content table and every forgotten memory is unindexed again.
 */
export function repairMemoryIndex(db: Database.Database, audit: IndexAudit = auditMemoryIndex(db)): IndexRepair {
  const run = db.transaction((): IndexRepair => {
    let vectorsDeleted = 0;
    for (const id of [...audit.orphanVectorsForgotten, ...audit.orphanVectorsMissing]) {
      deleteVector(db, "vec_memories", id);
      vectorsDeleted++;
    }

    let ftsRebuilt = false;
    let ftsRowsRemoved = 0;
    if (audit.orphanFtsForgotten.length > 0 || audit.orphanFtsMissing.length > 0) {
      rebuildFts(db, "memories_fts");
      ftsRebuilt = true;
      const forgotten = db
        .prepare("SELECT rowid, id, content, context FROM memories WHERE deleted_at IS NOT NULL")
        .all() as Array<{ rowid: number; id: string; content: string; context: string | null }>;
      for (const row of forgotten) {
        // unindexMemory also drops the (already absent) vector — harmless.
        unindexMemory(db, row);
        ftsRowsRemoved++;
      }
    }
    return { vectorsDeleted, ftsRebuilt, ftsRowsRemoved };
  });
  return run.immediate();
}
