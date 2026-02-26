import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import {
  loadGraph,
  detectCommunities,
  groupByCommunity,
  computeCoherence,
  computeBetweenness,
  detectBridgeEntities,
  analyzeGraph,
  persistAnalysis,
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
 * Build a star graph: one center node connected to N leaf nodes.
 *
 *       L1
 *       |
 *  L4 - C - L2
 *       |
 *       L3
 *       |
 *       L5
 */
function buildStarGraph(db: Database.Database, leafCount: number = 5) {
  insertTestEntity(db, "center", "Center", "concept");
  for (let i = 1; i <= leafCount; i++) {
    insertTestEntity(db, `leaf-${i}`, `Leaf ${i}`, "concept");
    insertTestRelationship(
      db,
      `rel-center-leaf-${i}`,
      "center",
      `leaf-${i}`,
      "related_to",
      1.0,
    );
  }
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

describe("Graph Analyzer", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── loadGraph ───────────────────────────────────────────────

  describe("loadGraph", () => {
    it("creates correct node and edge count from DB", () => {
      buildStarGraph(t.db, 5);
      const graph = loadGraph(t.db);

      expect(graph.order).toBe(6); // center + 5 leaves
      expect(graph.size).toBe(5); // 5 edges
    });

    it("preserves node attributes (name, type)", () => {
      insertTestEntity(t.db, "node-1", "Test Node", "technology");
      const graph = loadGraph(t.db);

      expect(graph.getNodeAttribute("node-1", "name")).toBe("Test Node");
      expect(graph.getNodeAttribute("node-1", "type")).toBe("technology");
    });

    it("preserves edge attributes (type, weight)", () => {
      insertTestEntity(t.db, "src", "Source", "concept");
      insertTestEntity(t.db, "tgt", "Target", "concept");
      insertTestRelationship(t.db, "rel-1", "src", "tgt", "depends_on", 3.5);

      const graph = loadGraph(t.db);
      const edgeKey = graph.edge("src", "tgt");

      expect(edgeKey).toBeDefined();
      expect(graph.getEdgeAttribute(edgeKey!, "type")).toBe("depends_on");
      expect(graph.getEdgeAttribute(edgeKey!, "weight")).toBe(3.5);
    });

    it("returns empty graph when no entities exist", () => {
      const graph = loadGraph(t.db);

      expect(graph.order).toBe(0);
      expect(graph.size).toBe(0);
    });

    it("skips duplicate undirected edges", () => {
      insertTestEntity(t.db, "n1", "Node 1", "concept");
      insertTestEntity(t.db, "n2", "Node 2", "concept");
      // Insert the same edge twice (source/target swapped)
      insertTestRelationship(t.db, "rel-1", "n1", "n2", "related_to", 1.0);
      insertTestRelationship(t.db, "rel-2", "n2", "n1", "related_to", 1.0);

      const graph = loadGraph(t.db);
      expect(graph.size).toBe(1); // only one edge
    });
  });

  // ─── detectCommunities ───────────────────────────────────────

  describe("detectCommunities", () => {
    it("finds at least 1 community", () => {
      buildStarGraph(t.db, 5);
      const graph = loadGraph(t.db);
      const result = detectCommunities(graph);

      expect(result.count).toBeGreaterThanOrEqual(1);
    });

    it("assigns every node to a community", () => {
      buildStarGraph(t.db, 5);
      const graph = loadGraph(t.db);
      const result = detectCommunities(graph);

      expect(result.communities.size).toBe(graph.order);
      graph.forEachNode((nodeId) => {
        expect(result.communities.has(nodeId)).toBe(true);
      });
    });

    it("returns modularity in valid range", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const result = detectCommunities(graph);

      // Modularity is in range [-0.5, 1.0] for standard graphs
      expect(result.modularity).toBeGreaterThanOrEqual(-0.5);
      expect(result.modularity).toBeLessThanOrEqual(1.0);
    });

    it("handles empty graph gracefully", () => {
      const graph = loadGraph(t.db);
      const result = detectCommunities(graph);

      expect(result.communities.size).toBe(0);
      expect(result.count).toBe(0);
      expect(result.modularity).toBe(0);
    });

    it("handles single-node graph", () => {
      insertTestEntity(t.db, "solo", "Solo Node", "concept");
      const graph = loadGraph(t.db);
      const result = detectCommunities(graph);

      expect(result.communities.size).toBe(1);
      expect(result.count).toBe(1);
    });
  });

  // ─── groupByCommunity ────────────────────────────────────────

  describe("groupByCommunity", () => {
    it("inverts node->community to community->nodes[]", () => {
      const communities = new Map<string, number>([
        ["a", 0],
        ["b", 0],
        ["c", 1],
        ["d", 1],
        ["e", 1],
      ]);

      const groups = groupByCommunity(communities);

      expect(groups.size).toBe(2);
      expect(groups.get(0)).toEqual(expect.arrayContaining(["a", "b"]));
      expect(groups.get(0)!.length).toBe(2);
      expect(groups.get(1)).toEqual(expect.arrayContaining(["c", "d", "e"]));
      expect(groups.get(1)!.length).toBe(3);
    });
  });

  // ─── computeCoherence ────────────────────────────────────────

  describe("computeCoherence", () => {
    it("returns 1.0 for fully connected clique with no external edges", () => {
      // Build a 3-node clique with no external connections
      insertTestEntity(t.db, "c1", "Clique 1", "concept");
      insertTestEntity(t.db, "c2", "Clique 2", "concept");
      insertTestEntity(t.db, "c3", "Clique 3", "concept");
      insertTestRelationship(t.db, "r12", "c1", "c2", "related_to", 1.0);
      insertTestRelationship(t.db, "r13", "c1", "c3", "related_to", 1.0);
      insertTestRelationship(t.db, "r23", "c2", "c3", "related_to", 1.0);

      const graph = loadGraph(t.db);
      const coherence = computeCoherence(graph, ["c1", "c2", "c3"]);

      expect(coherence).toBe(1.0);
    });

    it("returns less than 1.0 when community has external edges", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);

      // Clique A has a1 connected to the bridge (external edge)
      const coherence = computeCoherence(graph, ["a1", "a2", "a3"]);
      expect(coherence).toBeGreaterThan(0);
      expect(coherence).toBeLessThan(1.0);
    });

    it("returns 0 for isolated nodes with no edges", () => {
      insertTestEntity(t.db, "iso1", "Isolated 1", "concept");
      insertTestEntity(t.db, "iso2", "Isolated 2", "concept");

      const graph = loadGraph(t.db);
      const coherence = computeCoherence(graph, ["iso1", "iso2"]);

      expect(coherence).toBe(0);
    });
  });

  // ─── computeBetweenness ──────────────────────────────────────

  describe("computeBetweenness", () => {
    it("returns non-negative scores", () => {
      buildStarGraph(t.db, 5);
      const graph = loadGraph(t.db);
      const scores = computeBetweenness(graph);

      for (const [, score] of scores) {
        expect(score).toBeGreaterThanOrEqual(0);
      }
    });

    it("gives highest score to central node in star graph", () => {
      buildStarGraph(t.db, 5);
      const graph = loadGraph(t.db);
      const scores = computeBetweenness(graph);

      const centerScore = scores.get("center") ?? 0;

      // Every leaf should have lower betweenness than the center
      for (let i = 1; i <= 5; i++) {
        const leafScore = scores.get(`leaf-${i}`) ?? 0;
        expect(centerScore).toBeGreaterThan(leafScore);
      }
    });

    it("returns empty map for empty graph", () => {
      const graph = loadGraph(t.db);
      const scores = computeBetweenness(graph);

      expect(scores.size).toBe(0);
    });
  });

  // ─── detectBridgeEntities ────────────────────────────────────

  describe("detectBridgeEntities", () => {
    it("identifies bridge node connecting two cliques", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      // The bridge node should appear in the results
      const bridgeNode = bridges.find((b) => b.entityId === "bridge");
      expect(bridgeNode).toBeDefined();
      expect(bridgeNode!.bridgeScore).toBeGreaterThan(0);
      expect(bridgeNode!.communitySpan).toBeGreaterThanOrEqual(2);
    });

    it("returns results sorted by bridgeScore descending", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      for (let i = 1; i < bridges.length; i++) {
        expect(bridges[i - 1].bridgeScore).toBeGreaterThanOrEqual(
          bridges[i].bridgeScore,
        );
      }
    });

    it("returns only entities with bridgeScore > 0", () => {
      buildTwoCliquesWithBridge(t.db);
      const graph = loadGraph(t.db);
      const { communities } = detectCommunities(graph);
      const bridges = detectBridgeEntities(graph, communities);

      for (const bridge of bridges) {
        expect(bridge.bridgeScore).toBeGreaterThan(0);
      }
    });
  });

  // ─── analyzeGraph ────────────────────────────────────────────

  describe("analyzeGraph", () => {
    it("returns complete GraphAnalysisResult structure", () => {
      buildTwoCliquesWithBridge(t.db);
      const result = analyzeGraph(t.db);

      expect(result.communities).toBeDefined();
      expect(result.communities.length).toBeGreaterThanOrEqual(1);
      expect(result.modularity).toBeDefined();
      expect(result.bridgeEntities).toBeDefined();
      expect(result.totalNodes).toBe(8); // 3 + 4 + 1 bridge
      expect(result.totalEdges).toBe(11); // 3 + 6 + 2 bridge connections
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Each community should have valid fields
      for (const community of result.communities) {
        expect(community.communityId).toBeDefined();
        expect(community.entityIds.length).toBeGreaterThan(0);
        expect(community.coherenceScore).toBeGreaterThanOrEqual(0);
        expect(community.coherenceScore).toBeLessThanOrEqual(1);
      }
    });

    it("handles empty graph gracefully (0 entities)", () => {
      const result = analyzeGraph(t.db);

      expect(result.communities).toEqual([]);
      expect(result.modularity).toBe(0);
      expect(result.bridgeEntities).toEqual([]);
      expect(result.totalNodes).toBe(0);
      expect(result.totalEdges).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── persistAnalysis ─────────────────────────────────────────

  describe("persistAnalysis", () => {
    it("writes topic clusters to DB", () => {
      buildTwoCliquesWithBridge(t.db);
      const result = analyzeGraph(t.db);

      persistAnalysis(t.db, result);

      const clusters = t.db
        .prepare("SELECT * FROM topic_clusters")
        .all() as Array<{
        id: string;
        name: string;
        entity_ids: string;
        coherence_score: number;
        generation: number;
      }>;

      expect(clusters.length).toBe(result.communities.length);

      for (const cluster of clusters) {
        expect(cluster.id).toBeDefined();
        expect(cluster.name).toBeTruthy();
        expect(cluster.entity_ids).toBeTruthy();
        // Verify entity_ids is valid JSON
        const entityIds = JSON.parse(cluster.entity_ids);
        expect(Array.isArray(entityIds)).toBe(true);
        expect(entityIds.length).toBeGreaterThan(0);
        expect(cluster.generation).toBe(1);
      }
    });

    it("increments generation counter", () => {
      buildTwoCliquesWithBridge(t.db);
      const result = analyzeGraph(t.db);

      // First persist
      persistAnalysis(t.db, result);

      const gen1 = t.db
        .prepare("SELECT MAX(generation) as maxGen FROM topic_clusters")
        .get() as { maxGen: number };
      expect(gen1.maxGen).toBe(1);

      // Second persist
      persistAnalysis(t.db, result);

      const gen2 = t.db
        .prepare("SELECT MAX(generation) as maxGen FROM topic_clusters")
        .get() as { maxGen: number };
      expect(gen2.maxGen).toBe(2);

      // Verify both generations exist
      const allClusters = t.db
        .prepare("SELECT generation FROM topic_clusters")
        .all() as Array<{ generation: number }>;

      const gen1Count = allClusters.filter((c) => c.generation === 1).length;
      const gen2Count = allClusters.filter((c) => c.generation === 2).length;

      expect(gen1Count).toBe(result.communities.length);
      expect(gen2Count).toBe(result.communities.length);
    });

    it("stores coherence scores correctly", () => {
      buildTwoCliquesWithBridge(t.db);
      const result = analyzeGraph(t.db);

      persistAnalysis(t.db, result);

      const clusters = t.db
        .prepare("SELECT coherence_score FROM topic_clusters")
        .all() as Array<{ coherence_score: number }>;

      for (const cluster of clusters) {
        expect(cluster.coherence_score).toBeGreaterThanOrEqual(0);
        expect(cluster.coherence_score).toBeLessThanOrEqual(1);
      }
    });
  });
});
