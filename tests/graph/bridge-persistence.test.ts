import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import {
  loadGraph,
  detectCommunities,
  detectBridgeEntities,
  persistBridgeScores,
  getBridgeScores,
  getLatestBridgeGeneration,
} from "../../src/graph/analyzer.js";

// ─── Helpers ─────────────────────────────────────────────────────

function insertTestEntity(
  db: Database.Database,
  id: string,
  name: string,
  type: string,
) {
  db.prepare(
    "INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at) VALUES (?, ?, ?, '[]', unixepoch(), unixepoch(), 1, unixepoch())",
  ).run(id, name, type);
}

function insertTestRelationship(
  db: Database.Database,
  id: string,
  sourceId: string,
  targetId: string,
  type: string,
  weight: number,
) {
  db.prepare(
    "INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories, created_at) VALUES (?, ?, ?, ?, ?, '[]', unixepoch())",
  ).run(id, sourceId, targetId, type, weight);
}

/**
 * Build two cliques connected by a bridge node.
 *
 * Clique A: a1-a2-a3 (fully connected)
 * Clique B: b1-b2-b3-b4 (fully connected)
 * Bridge:   a1 -- bridge -- b1
 */
function buildTwoCliquesWithBridge(db: Database.Database) {
  // Clique A nodes
  insertTestEntity(db, "a1", "Alpha 1", "technology");
  insertTestEntity(db, "a2", "Alpha 2", "technology");
  insertTestEntity(db, "a3", "Alpha 3", "technology");

  // Clique A edges (fully connected)
  insertTestRelationship(db, "rel-a1-a2", "a1", "a2", "related_to", 2.0);
  insertTestRelationship(db, "rel-a1-a3", "a1", "a3", "related_to", 2.0);
  insertTestRelationship(db, "rel-a2-a3", "a2", "a3", "related_to", 2.0);

  // Bridge node
  insertTestEntity(db, "bridge", "Bridge Node", "concept");

  // Clique B nodes
  insertTestEntity(db, "b1", "Beta 1", "tool");
  insertTestEntity(db, "b2", "Beta 2", "tool");
  insertTestEntity(db, "b3", "Beta 3", "tool");
  insertTestEntity(db, "b4", "Beta 4", "tool");

  // Clique B edges (fully connected)
  insertTestRelationship(db, "rel-b1-b2", "b1", "b2", "related_to", 2.0);
  insertTestRelationship(db, "rel-b1-b3", "b1", "b3", "related_to", 2.0);
  insertTestRelationship(db, "rel-b1-b4", "b1", "b4", "related_to", 2.0);
  insertTestRelationship(db, "rel-b2-b3", "b2", "b3", "related_to", 2.0);
  insertTestRelationship(db, "rel-b2-b4", "b2", "b4", "related_to", 2.0);
  insertTestRelationship(db, "rel-b3-b4", "b3", "b4", "related_to", 2.0);

  // Bridge connections (low weight to encourage community separation)
  insertTestRelationship(db, "rel-a1-bridge", "a1", "bridge", "related_to", 0.5);
  insertTestRelationship(db, "rel-bridge-b1", "bridge", "b1", "related_to", 0.5);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Bridge Persistence", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── getLatestBridgeGeneration ────────────────────────────────

  describe("getLatestBridgeGeneration", () => {
    it("returns 0 when no scores exist", () => {
      const gen = getLatestBridgeGeneration(t.db);
      expect(gen).toBe(0);
    });

    it("returns correct generation after persist", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges);

      expect(getLatestBridgeGeneration(t.db)).toBe(1);
    });
  });

  // ─── persistBridgeScores ──────────────────────────────────────

  describe("persistBridgeScores", () => {
    it("writes correct data to bridge_scores table", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges);

      const rows = t.db
        .prepare("SELECT * FROM bridge_scores ORDER BY bridge_score DESC")
        .all() as Array<{
        entity_id: string;
        betweenness: number;
        community_span: number;
        bridge_score: number;
        generation: number;
      }>;

      expect(rows.length).toBe(bridges.length);

      for (let i = 0; i < bridges.length; i++) {
        expect(rows[i].entity_id).toBe(bridges[i].entityId);
        expect(rows[i].betweenness).toBeCloseTo(bridges[i].betweenness, 10);
        expect(rows[i].community_span).toBe(bridges[i].communitySpan);
        expect(rows[i].bridge_score).toBeCloseTo(bridges[i].bridgeScore, 10);
        expect(rows[i].generation).toBe(1);
      }
    });

    it("auto-increments generation counter", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      // First persist -> generation 1
      persistBridgeScores(t.db, bridges);
      expect(getLatestBridgeGeneration(t.db)).toBe(1);

      // Second persist -> generation 2
      persistBridgeScores(t.db, bridges);
      expect(getLatestBridgeGeneration(t.db)).toBe(2);

      // Third persist -> generation 3
      persistBridgeScores(t.db, bridges);
      expect(getLatestBridgeGeneration(t.db)).toBe(3);

      // Verify all generations exist
      const allRows = t.db
        .prepare("SELECT DISTINCT generation FROM bridge_scores ORDER BY generation")
        .all() as Array<{ generation: number }>;

      expect(allRows.map((r) => r.generation)).toEqual([1, 2, 3]);
    });

    it("respects explicit generation parameter", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges, 42);

      const rows = t.db
        .prepare("SELECT DISTINCT generation FROM bridge_scores")
        .all() as Array<{ generation: number }>;

      expect(rows.length).toBe(1);
      expect(rows[0].generation).toBe(42);
    });

    it("handles empty bridges array", () => {
      persistBridgeScores(t.db, []);

      const rows = t.db
        .prepare("SELECT * FROM bridge_scores")
        .all();

      expect(rows.length).toBe(0);
    });

    it("uses transaction atomicity — partial failures leave no data", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      // Add a bridge with an invalid entity_id (violates FK constraint)
      const badBridges = [
        ...bridges,
        {
          entityId: "nonexistent-entity-id",
          betweenness: 0.5,
          communitySpan: 3,
          bridgeScore: 1.5,
        },
      ];

      // The transaction should fail due to the FK constraint
      expect(() => persistBridgeScores(t.db, badBridges)).toThrow();

      // No rows should have been inserted (transaction rolled back)
      const rows = t.db
        .prepare("SELECT * FROM bridge_scores")
        .all();

      expect(rows.length).toBe(0);
    });
  });

  // ─── getBridgeScores ──────────────────────────────────────────

  describe("getBridgeScores", () => {
    it("returns correct data with entity name and type", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges);

      const scores = getBridgeScores(t.db, 1);

      expect(scores.length).toBe(bridges.length);

      for (const score of scores) {
        expect(score.entityId).toBeTruthy();
        expect(score.entityName).toBeTruthy();
        expect(score.entityType).toBeTruthy();
        expect(score.betweenness).toBeGreaterThanOrEqual(0);
        expect(score.communitySpan).toBeGreaterThanOrEqual(1);
        expect(score.bridgeScore).toBeGreaterThan(0);
        expect(score.generation).toBe(1);
      }

      // Verify the bridge node is present and has correct entity metadata
      const bridgeNode = scores.find((s) => s.entityId === "bridge");
      if (bridgeNode) {
        expect(bridgeNode.entityName).toBe("Bridge Node");
        expect(bridgeNode.entityType).toBe("concept");
      }
    });

    it("returns latest generation when none specified", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      // Persist two generations
      persistBridgeScores(t.db, bridges);
      persistBridgeScores(t.db, bridges);

      // Retrieve without specifying generation
      const scores = getBridgeScores(t.db);

      // Should return generation 2 (latest)
      for (const score of scores) {
        expect(score.generation).toBe(2);
      }
    });

    it("returns empty array when no scores exist", () => {
      const scores = getBridgeScores(t.db);
      expect(scores).toEqual([]);
    });

    it("returns empty array for non-existent generation", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges);

      const scores = getBridgeScores(t.db, 999);
      expect(scores).toEqual([]);
    });

    it("returns results sorted by bridge_score descending", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges);

      const scores = getBridgeScores(t.db, 1);

      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1].bridgeScore).toBeGreaterThanOrEqual(
          scores[i].bridgeScore,
        );
      }
    });
  });

  // ─── Round-trip ───────────────────────────────────────────────

  describe("round-trip: persist -> retrieve", () => {
    it("retrieved data matches what was persisted", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      persistBridgeScores(t.db, bridges);

      const scores = getBridgeScores(t.db, 1);

      // Same count
      expect(scores.length).toBe(bridges.length);

      // Each original bridge should appear in retrieved scores
      for (const bridge of bridges) {
        const retrieved = scores.find((s) => s.entityId === bridge.entityId);
        expect(retrieved).toBeDefined();
        expect(retrieved!.betweenness).toBeCloseTo(bridge.betweenness, 10);
        expect(retrieved!.communitySpan).toBe(bridge.communitySpan);
        expect(retrieved!.bridgeScore).toBeCloseTo(bridge.bridgeScore, 10);
        expect(retrieved!.generation).toBe(1);

        // Verify entity metadata was joined correctly
        expect(retrieved!.entityName).toBeTruthy();
        expect(retrieved!.entityType).toBeTruthy();
      }
    });

    it("multiple generations preserve independent data", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      // Persist generation 1 with all bridges
      persistBridgeScores(t.db, bridges);

      // Persist generation 2 with only the first bridge
      const subset = bridges.slice(0, 1);
      persistBridgeScores(t.db, subset);

      const gen1 = getBridgeScores(t.db, 1);
      const gen2 = getBridgeScores(t.db, 2);

      expect(gen1.length).toBe(bridges.length);
      expect(gen2.length).toBe(1);

      // Generations are independent
      for (const s of gen1) {
        expect(s.generation).toBe(1);
      }
      for (const s of gen2) {
        expect(s.generation).toBe(2);
      }
    });
  });
});
