/**
 * Row counts that must survive an upgrade unchanged. `engram stats --json`
 * prints them, and `engram update` compares the post-update snapshot to the
 * pre-update one (#44): if any count dropped, the update failed loudly and
 * the backup is what to restore.
 */
import type Database from "better-sqlite3";

export interface CountSnapshot {
  exchanges: number;
  conversations: number;
  tool_calls: number;
  memories_active: number;
  memories_inactive: number;
  entities: number;
  relationships: number;
  topic_clusters: number;
  commitments: number;
}

export const SNAPSHOT_KEYS = [
  "exchanges", "conversations", "tool_calls", "memories_active", "memories_inactive",
  "entities", "relationships", "topic_clusters", "commitments",
] as const satisfies ReadonlyArray<keyof CountSnapshot>;

function count(db: Database.Database, sql: string): number {
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } catch {
    return 0; // table absent on an older schema: counts as empty, never throws
  }
}

export function snapshotCounts(db: Database.Database): CountSnapshot {
  return {
    exchanges: count(db, "SELECT COUNT(*) AS c FROM exchanges"),
    conversations: count(db, "SELECT COUNT(*) AS c FROM conversations"),
    tool_calls: count(db, "SELECT COUNT(*) AS c FROM tool_calls"),
    memories_active: count(db, "SELECT COUNT(*) AS c FROM memories WHERE is_active = 1"),
    memories_inactive: count(db, "SELECT COUNT(*) AS c FROM memories WHERE is_active = 0"),
    entities: count(db, "SELECT COUNT(*) AS c FROM entities"),
    relationships: count(db, "SELECT COUNT(*) AS c FROM relationships"),
    topic_clusters: count(db, "SELECT COUNT(*) AS c FROM topic_clusters"),
    commitments: count(db, "SELECT COUNT(*) AS c FROM commitments"),
  };
}

/** Keys whose count went DOWN between `before` and `after` (growth is fine: a dream run may add rows). */
export function snapshotRegressions(before: CountSnapshot, after: CountSnapshot): string[] {
  return SNAPSHOT_KEYS.filter((k) => after[k] < before[k]).map(
    (k) => `${k}: ${before[k]} -> ${after[k]}`,
  );
}

export function formatSnapshot(s: CountSnapshot): string {
  return SNAPSHOT_KEYS.map((k) => `${k}=${s[k]}`).join(" ");
}
