import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../../helpers.js";
import { computeOptimalThreshold, resetThresholdCache } from "../../../src/interfaces/web/data/graph-queries.js";

// Regression for GitHub issue #4: the visualizer cached an "empty graph" threshold
// computed before the first sync/dream and kept serving it for the life of the
// process, even after the WAL watcher saw thousands of new entities.

function seedGraph(db: TestDb["db"], entityCount: number): void {
  const insEntity = db.prepare(
    "INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, 'concept', ?)",
  );
  const insRel = db.prepare(
    "INSERT INTO relationships (id, source_entity_id, target_entity_id, type) VALUES (?, ?, ?, 'related_to')",
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < entityCount; i++) insEntity.run(`e${i}`, `entity ${i}`, 1 + (i % 5));
    for (let i = 1; i < entityCount; i++) insRel.run(`r${i}`, `e${i - 1}`, `e${i}`);
  });
  tx();
}

describe("optimal threshold cache invalidation", () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
    resetThresholdCache(); // module-level cache: isolate from other tests in the same worker
  });
  afterEach(() => {
    resetThresholdCache();
    t.cleanup();
  });

  it("caches the empty-database result until explicitly reset", () => {
    const empty = computeOptimalThreshold(t.db);
    expect(empty).toEqual({ value: 1, nodes: 0, edges: 0, edgePct: 100 });

    seedGraph(t.db, 50);

    // Without invalidation the stale empty result is still served: this is the bug.
    expect(computeOptimalThreshold(t.db).nodes).toBe(0);
  });

  it("reports current nonzero counts after data arrives and the cache is reset", () => {
    computeOptimalThreshold(t.db); // prime the cache while the DB is empty
    seedGraph(t.db, 50);

    resetThresholdCache(); // what the WAL watcher now does on every debounced change

    const fresh = computeOptimalThreshold(t.db);
    expect(fresh.nodes).toBe(50);
    expect(fresh.edges).toBe(49);
    expect(fresh.value).toBeGreaterThanOrEqual(1);
    expect(fresh.edgePct).toBeGreaterThan(0);
  });

  it("stays consistent with live graph counts across repeated external updates", () => {
    seedGraph(t.db, 10);
    resetThresholdCache();
    expect(computeOptimalThreshold(t.db).nodes).toBe(10);

    // A second external write (e.g. another `engram sync`) followed by a reset
    seedGraph(t.db, 0); // no-op: proves reset alone doesn't fabricate data
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES ('extra', 'extra', 'tool', 3)").run();
    resetThresholdCache();
    const live = (t.db.prepare("SELECT COUNT(*) AS c FROM entities").get() as { c: number }).c;
    expect(computeOptimalThreshold(t.db).nodes).toBe(live);
    expect(live).toBe(11);
  });
});
