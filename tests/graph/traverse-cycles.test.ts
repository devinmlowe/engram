/**
 * traverseNeighborhood must not enumerate walks that revisit nodes: on a
 * dense graph the un-guarded recursive CTE materializes d^depth rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { traverseNeighborhood } from "../../src/graph/search.js";
import { createTestDb, createTestEntity, createTestRelationship } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import { insertEntity } from "../../src/graph/entity.js";
import { insertRelationship } from "../../src/graph/relationship.js";

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

function emb(seed: number): number[] {
  const v = new Array(256).fill(0);
  v[seed % 256] = 1;
  return v;
}

describe("traverseNeighborhood cycle guard", () => {
  it("returns each reachable entity once at its shallowest depth on a cyclic graph", () => {
    for (const id of ["a", "b", "c", "d"]) {
      insertEntity(t.db, createTestEntity({ id, name: id.toUpperCase() }), emb(id.charCodeAt(0)));
    }
    // a-b, b-c, c-a (triangle), c-d
    insertRelationship(t.db, createTestRelationship({ id: "ab", sourceEntityId: "a", targetEntityId: "b" }));
    insertRelationship(t.db, createTestRelationship({ id: "bc", sourceEntityId: "b", targetEntityId: "c" }));
    insertRelationship(t.db, createTestRelationship({ id: "ca", sourceEntityId: "c", targetEntityId: "a" }));
    insertRelationship(t.db, createTestRelationship({ id: "cd", sourceEntityId: "c", targetEntityId: "d" }));

    const result = traverseNeighborhood(t.db, "a", 3);
    const byId = new Map(result.map((r) => [r.entityId, r.depth]));
    expect([...byId.keys()].sort()).toEqual(["b", "c", "d"]);
    expect(byId.get("b")).toBe(1);
    expect(byId.get("c")).toBe(1);
    expect(byId.get("d")).toBe(2);
  });

  it("stays fast on a dense hub at depth 3", () => {
    const N = 120; // complete graph: un-guarded walks ≈ N^3 ≈ 1.7M rows
    const tx = t.db.transaction(() => {
      for (let i = 0; i < N; i++) {
        insertEntity(t.db, createTestEntity({ id: `n${i}`, name: `Node ${i}` }), emb(i));
      }
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          insertRelationship(
            t.db,
            createTestRelationship({ id: `e${i}-${j}`, sourceEntityId: `n${i}`, targetEntityId: `n${j}` }),
          );
        }
      }
    });
    tx();

    const t0 = performance.now();
    const result = traverseNeighborhood(t.db, "n0", 3);
    const ms = performance.now() - t0;
    expect(result).toHaveLength(N - 1);
    expect(result.every((r) => r.depth === 1)).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });
});
