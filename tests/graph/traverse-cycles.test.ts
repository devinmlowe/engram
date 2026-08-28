/**
 * traverseNeighborhood must scale with edges, not with the number of walks:
 * the old recursive CTE enumerated d^depth walks for a degree-d hub.
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

describe("traverseNeighborhood (BFS)", () => {
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
    expect(result.find((r) => r.entityId === "c")!.relationship.direction).toBe("incoming");
  });

  it("keeps traversing through non-matching edge types (type filter applies to reporting)", () => {
    for (const id of ["a", "b", "c"]) {
      insertEntity(t.db, createTestEntity({ id, name: id.toUpperCase() }), emb(id.charCodeAt(0)));
    }
    insertRelationship(t.db, createTestRelationship({ id: "ab", sourceEntityId: "a", targetEntityId: "b", type: "uses" }));
    insertRelationship(t.db, createTestRelationship({ id: "bc", sourceEntityId: "b", targetEntityId: "c", type: "related_to" }));

    const result = traverseNeighborhood(t.db, "a", 2, ["related_to"]);
    expect(result.map((r) => [r.entityId, r.depth])).toEqual([["c", 2]]);
  });

  it("handles a dense hub at depth 3 in edge-linear time", () => {
    const N = 120; // complete graph: the old CTE materialized ~N^3 walks
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

    const result = traverseNeighborhood(t.db, "n0", 3);
    expect(result).toHaveLength(N - 1);
    expect(result.every((r) => r.depth === 1)).toBe(true);
  });
});
