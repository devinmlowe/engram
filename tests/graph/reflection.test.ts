import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { ReflectionObservation } from "../../src/graph/types.js";

// ─── Mock intelligence layer ─────────────────────────────────────

vi.mock("../../src/_core/llm/index.js", () => ({
  buildIntelligenceConfig: vi.fn(() => ({
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "test-model",
    apiModel: "test-api",
    apiFallbackModel: "test-fallback",
    timeoutMs: 5000,
  })),
  generateStructured: vi.fn(async () => ({
    result: {
      name: "Test Community",
      description: "Test description",
      keywords: ["test"],
    },
    source: "local",
    model: "test",
    durationMs: 100,
  })),
  generate: vi.fn(async () => ({
    result: "Test observation content",
    source: "local",
    model: "test",
    durationMs: 50,
  })),
}));

import { generate } from "../../src/_core/llm/index.js";
import {
  linkMemoriesToCommunities,
  recomputeEdgeWeights,
  generateObservations,
  persistObservations,
  buildReflectResultFromCache,
  mergeRedundantEntities,
  pruneOrphanEntities,
  pruneStaleGenerations,
} from "../../src/graph/reflection.js";

const mockedGenerate = vi.mocked(generate);

// ─── Constants ────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// ─── Helpers ──────────────────────────────────────────────────────

function insertEntity(
  db: Database.Database,
  id: string,
  name: string,
  opts: {
    type?: string;
    firstSeen?: number;
    lastSeen?: number;
    mentionCount?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at)
    VALUES (?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    opts.type ?? "concept",
    opts.firstSeen ?? NOW,
    opts.lastSeen ?? NOW,
    opts.mentionCount ?? 1,
    NOW,
  );
}

function insertRelationship(
  db: Database.Database,
  id: string,
  sourceId: string,
  targetId: string,
  opts: {
    type?: string;
    weight?: number;
    sourceMemories?: string[];
  } = {},
) {
  db.prepare(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    targetId,
    opts.type ?? "related_to",
    opts.weight ?? 1.0,
    JSON.stringify(opts.sourceMemories ?? []),
    NOW,
  );
}

function insertMemory(
  db: Database.Database,
  id: string,
  opts: {
    isActive?: number;
    confidence?: number;
    importance?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO memories (id, type, content, confidence, importance, access_count, is_active, created_at, source_exchanges)
    VALUES (?, 'fact', 'Test memory content', ?, ?, 0, ?, ?, '[]')`,
  ).run(
    id,
    opts.confidence ?? 0.8,
    opts.importance ?? 0.7,
    opts.isActive ?? 1,
    NOW,
  );
}

function insertCluster(
  db: Database.Database,
  id: string,
  name: string,
  entityIds: string[],
  generation: number,
  opts: { memoryIds?: string[]; coherenceScore?: number } = {},
) {
  db.prepare(
    `INSERT INTO topic_clusters (id, name, description, entity_ids, memory_ids, coherence_score, created_at, updated_at, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    `Description of ${name}`,
    JSON.stringify(entityIds),
    JSON.stringify(opts.memoryIds ?? []),
    opts.coherenceScore ?? 0.8,
    NOW,
    NOW,
    generation,
  );
}

function insertBridgeScore(
  db: Database.Database,
  entityId: string,
  generation: number,
  opts: {
    betweenness?: number;
    communitySpan?: number;
    bridgeScore?: number;
    narrative?: string;
  } = {},
) {
  db.prepare(
    `INSERT INTO bridge_scores (entity_id, betweenness, community_span, bridge_score, narrative, generation)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entityId,
    opts.betweenness ?? 0.5,
    opts.communitySpan ?? 2,
    opts.bridgeScore ?? 1.0,
    opts.narrative ?? null,
    generation,
  );
}

function insertObservation(
  db: Database.Database,
  obs: ReflectionObservation,
) {
  db.prepare(
    `INSERT INTO reflection_observations (id, type, content, related_entity_ids, confidence, generation)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    obs.id,
    obs.type,
    obs.content,
    JSON.stringify(obs.relatedEntityIds),
    obs.confidence,
    obs.generation,
  );
}

function insertTemporalPattern(
  db: Database.Database,
  id: string,
  generation: number,
  opts: {
    type?: string;
    description?: string;
  } = {},
) {
  db.prepare(
    `INSERT INTO temporal_patterns (id, type, description, entity_ids, time_start, time_end, confidence, metadata, generation)
    VALUES (?, ?, ?, '[]', ?, ?, 0.7, '{}', ?)`,
  ).run(
    id,
    opts.type ?? "entity_burst",
    opts.description ?? "Test pattern",
    NOW - DAY,
    NOW,
    generation,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Reflection Orchestration", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── linkMemoriesToCommunities ──────────────────────────────

  describe("linkMemoriesToCommunities", () => {
    it("updates topic_clusters.memory_ids from relationship source_memories", () => {
      // Entities
      insertEntity(t.db, "e1", "Alpha");
      insertEntity(t.db, "e2", "Beta");

      // Memories
      insertMemory(t.db, "mem-1");
      insertMemory(t.db, "mem-2");

      // Relationship with source_memories
      insertRelationship(t.db, "rel-1", "e1", "e2", {
        sourceMemories: ["mem-1", "mem-2"],
      });

      // Topic cluster containing these entities
      insertCluster(t.db, "tc-1", "Test Cluster", ["e1", "e2"], 1);

      const result = linkMemoriesToCommunities(t.db, 1);

      expect(result.clustersUpdated).toBe(1);
      expect(result.memoriesLinked).toBe(2);

      // Verify the cluster was updated
      const cluster = t.db
        .prepare("SELECT memory_ids FROM topic_clusters WHERE id = ?")
        .get("tc-1") as { memory_ids: string };
      const memoryIds = JSON.parse(cluster.memory_ids);
      expect(memoryIds).toContain("mem-1");
      expect(memoryIds).toContain("mem-2");
    });

    it("deduplicates memory IDs across relationships", () => {
      insertEntity(t.db, "e1", "Alpha");
      insertEntity(t.db, "e2", "Beta");
      insertEntity(t.db, "e3", "Gamma");

      insertMemory(t.db, "mem-shared");
      insertMemory(t.db, "mem-unique");

      // Two relationships referencing the same memory
      insertRelationship(t.db, "rel-1", "e1", "e2", {
        sourceMemories: ["mem-shared", "mem-unique"],
      });
      insertRelationship(t.db, "rel-2", "e2", "e3", {
        sourceMemories: ["mem-shared"],
      });

      insertCluster(t.db, "tc-1", "Test Cluster", ["e1", "e2", "e3"], 1);

      const result = linkMemoriesToCommunities(t.db, 1);

      // Deduplicated: mem-shared should appear only once
      const cluster = t.db
        .prepare("SELECT memory_ids FROM topic_clusters WHERE id = ?")
        .get("tc-1") as { memory_ids: string };
      const memoryIds: string[] = JSON.parse(cluster.memory_ids);
      expect(memoryIds).toHaveLength(2);
      expect(memoryIds).toContain("mem-shared");
      expect(memoryIds).toContain("mem-unique");
      expect(result.memoriesLinked).toBe(2);
    });

    it("filters out inactive memories", () => {
      insertEntity(t.db, "e1", "Alpha");
      insertEntity(t.db, "e2", "Beta");

      insertMemory(t.db, "mem-active", { isActive: 1 });
      insertMemory(t.db, "mem-inactive", { isActive: 0 });

      insertRelationship(t.db, "rel-1", "e1", "e2", {
        sourceMemories: ["mem-active", "mem-inactive"],
      });

      insertCluster(t.db, "tc-1", "Test Cluster", ["e1", "e2"], 1);

      linkMemoriesToCommunities(t.db, 1);

      const cluster = t.db
        .prepare("SELECT memory_ids FROM topic_clusters WHERE id = ?")
        .get("tc-1") as { memory_ids: string };
      const memoryIds: string[] = JSON.parse(cluster.memory_ids);
      expect(memoryIds).toHaveLength(1);
      expect(memoryIds).toContain("mem-active");
      expect(memoryIds).not.toContain("mem-inactive");
    });
  });

  // ─── recomputeEdgeWeights ───────────────────────────────────

  describe("recomputeEdgeWeights", () => {
    it("updates weights based on edge weight factors", () => {
      insertEntity(t.db, "e1", "Alpha", { lastSeen: NOW, mentionCount: 5 });
      insertEntity(t.db, "e2", "Beta", { lastSeen: NOW, mentionCount: 3 });

      insertMemory(t.db, "mem-1", { confidence: 0.9, importance: 0.8 });
      insertMemory(t.db, "mem-2", { confidence: 0.7, importance: 0.6 });

      insertRelationship(t.db, "rel-1", "e1", "e2", {
        weight: 0.5,
        sourceMemories: ["mem-1", "mem-2"],
      });

      const result = recomputeEdgeWeights(t.db);

      expect(result.updated).toBe(1);

      // Verify the weight was actually updated
      const rel = t.db
        .prepare("SELECT weight FROM relationships WHERE id = ?")
        .get("rel-1") as { weight: number };
      // Weight should be different from original 0.5
      // And should be > 0.01 (floor)
      expect(rel.weight).toBeGreaterThan(0.01);
      // With 2 memories, recent last_seen, decent confidence/importance,
      // the weight should be reasonable
      expect(rel.weight).toBeLessThanOrEqual(1.0);
    });

    it("handles relationships with no source_memories", () => {
      insertEntity(t.db, "e1", "Alpha");
      insertEntity(t.db, "e2", "Beta");

      insertRelationship(t.db, "rel-1", "e1", "e2", {
        weight: 1.0,
        sourceMemories: [],
      });

      const result = recomputeEdgeWeights(t.db);

      expect(result.updated).toBe(1);

      // With 0 mentions and default 0.5 confidence/importance,
      // the weight should be small but non-zero
      const rel = t.db
        .prepare("SELECT weight FROM relationships WHERE id = ?")
        .get("rel-1") as { weight: number };
      expect(rel.weight).toBeGreaterThanOrEqual(0.01);
    });
  });

  // ─── generateObservations ───────────────────────────────────

  describe("generateObservations", () => {
    it("returns observation objects with correct structure", async () => {
      const partialResult = {
        communities: [
          {
            name: "Web Dev",
            description: "Web development tools",
            entityCount: 5,
            coherenceScore: 0.85,
            topEntities: [
              { name: "TypeScript", type: "technology" as const },
              { name: "React", type: "technology" as const },
            ],
            memoryCount: 3,
          },
        ],
        bridges: [
          {
            entityName: "Node.js",
            entityType: "technology" as const,
            bridgeScore: 0.9,
            communitySpan: 3,
            connectedCommunities: ["Web Dev", "Backend"],
          },
        ],
        health: {
          totalNodes: 10,
          totalEdges: 15,
          modularity: 0.45,
          communityCount: 3,
          orphanNodes: 2,
          averageCoherence: 0.78,
          generationCount: 1,
        },
        generation: 1,
        generatedAt: NOW,
      };

      const observations = await generateObservations(
        t.db,
        partialResult,
        t.config,
      );

      expect(observations.length).toBeGreaterThan(0);

      for (const obs of observations) {
        expect(obs.id).toBeTruthy();
        expect(obs.type).toBeTruthy();
        expect(obs.content).toBe("Test observation content");
        expect(obs.relatedEntityIds).toEqual([]);
        expect(obs.confidence).toBeGreaterThanOrEqual(0.7);
        expect(obs.confidence).toBeLessThanOrEqual(0.9);
        expect(obs.generation).toBe(1);
      }

      // Should have growth, quality, community summary, and bridge narrative
      const types = observations.map((o) => o.type);
      expect(types).toContain("growth_observation");
      expect(types).toContain("quality_assessment");
      expect(types).toContain("community_summary");
      expect(types).toContain("bridge_narrative");
    });

    it("returns empty array when LLM fails", async () => {
      mockedGenerate.mockRejectedValue(new Error("LLM unavailable"));

      const partialResult = {
        health: {
          totalNodes: 10,
          totalEdges: 15,
          modularity: 0.45,
          communityCount: 3,
          orphanNodes: 2,
          averageCoherence: 0.78,
          generationCount: 1,
        },
        communities: [],
        bridges: [],
        generation: 1,
        generatedAt: NOW,
      };

      const observations = await generateObservations(
        t.db,
        partialResult,
        t.config,
      );

      expect(observations).toEqual([]);
    });
  });

  // ─── persistObservations ────────────────────────────────────

  describe("persistObservations", () => {
    it("round-trips observations through the database", () => {
      const observations: ReflectionObservation[] = [
        {
          id: crypto.randomUUID(),
          type: "growth_observation",
          content: "The graph has grown significantly.",
          relatedEntityIds: ["e1", "e2"],
          confidence: 0.85,
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "quality_assessment",
          content: "Modularity is excellent.",
          relatedEntityIds: [],
          confidence: 0.75,
          generation: 1,
        },
      ];

      persistObservations(t.db, observations);

      // Read back
      const rows = t.db
        .prepare(
          "SELECT id, type, content, related_entity_ids, confidence, generation FROM reflection_observations ORDER BY confidence DESC",
        )
        .all() as Array<{
        id: string;
        type: string;
        content: string;
        related_entity_ids: string;
        confidence: number;
        generation: number;
      }>;

      expect(rows).toHaveLength(2);

      expect(rows[0].id).toBe(observations[0].id);
      expect(rows[0].type).toBe("growth_observation");
      expect(rows[0].content).toBe("The graph has grown significantly.");
      expect(JSON.parse(rows[0].related_entity_ids)).toEqual(["e1", "e2"]);
      expect(rows[0].confidence).toBe(0.85);
      expect(rows[0].generation).toBe(1);

      expect(rows[1].id).toBe(observations[1].id);
      expect(rows[1].type).toBe("quality_assessment");
    });

    it("handles empty observations array", () => {
      persistObservations(t.db, []);

      const count = t.db
        .prepare("SELECT COUNT(*) as cnt FROM reflection_observations")
        .get() as { cnt: number };
      expect(count.cnt).toBe(0);
    });
  });

  // ─── buildReflectResultFromCache ────────────────────────────

  describe("buildReflectResultFromCache", () => {
    it("returns data from pre-populated tables", () => {
      // Set up entities
      insertEntity(t.db, "e1", "TypeScript", { type: "technology", mentionCount: 5 });
      insertEntity(t.db, "e2", "React", { type: "technology", mentionCount: 3 });
      insertEntity(t.db, "e3", "Node.js", { type: "technology", mentionCount: 4 });

      // Relationships
      insertRelationship(t.db, "rel-1", "e1", "e2");
      insertRelationship(t.db, "rel-2", "e1", "e3");

      // Clusters
      insertCluster(t.db, "tc-1", "Web Development", ["e1", "e2"], 1, {
        memoryIds: ["mem-1", "mem-2"],
        coherenceScore: 0.9,
      });
      insertCluster(t.db, "tc-2", "Backend", ["e3"], 1, {
        coherenceScore: 0.7,
      });

      // Bridge scores
      insertBridgeScore(t.db, "e1", 1, {
        betweenness: 0.8,
        communitySpan: 2,
        bridgeScore: 1.6,
      });

      // Temporal pattern
      insertTemporalPattern(t.db, "tp-1", 1);

      // Observation
      insertObservation(t.db, {
        id: "obs-1",
        type: "growth_observation",
        content: "Steady growth observed.",
        relatedEntityIds: [],
        confidence: 0.8,
        generation: 1,
      });

      const result = buildReflectResultFromCache(t.db);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(1);
      expect(result!.communities).toHaveLength(2);
      expect(result!.communities[0].name).toBe("Web Development");
      expect(result!.communities[0].entityCount).toBe(2);
      expect(result!.communities[0].memoryCount).toBe(2);
      expect(result!.communities[0].coherenceScore).toBe(0.9);
      expect(result!.communities[0].topEntities.length).toBeGreaterThan(0);

      expect(result!.bridges).toHaveLength(1);
      expect(result!.bridges[0].entityName).toBe("TypeScript");
      expect(result!.bridges[0].bridgeScore).toBe(1.6);

      expect(result!.temporalPatterns).toHaveLength(1);
      expect(result!.observations).toHaveLength(1);
      expect(result!.observations[0].content).toBe("Steady growth observed.");

      expect(result!.health.totalNodes).toBe(3);
      expect(result!.health.totalEdges).toBe(2);
      expect(result!.health.communityCount).toBe(2);
    });

    it("returns null when no data exists", () => {
      const result = buildReflectResultFromCache(t.db);
      expect(result).toBeNull();
    });

    it("returns latest generation data", () => {
      insertEntity(t.db, "e1", "Alpha");

      // Generation 1
      insertCluster(t.db, "tc-old", "Old Cluster", ["e1"], 1);

      // Generation 2
      insertCluster(t.db, "tc-new", "New Cluster", ["e1"], 2);

      const result = buildReflectResultFromCache(t.db);

      expect(result).not.toBeNull();
      expect(result!.generation).toBe(2);
      expect(result!.communities).toHaveLength(1);
      expect(result!.communities[0].name).toBe("New Cluster");
    });
  });

  // ─── mergeRedundantEntities ─────────────────────────────────

  describe("mergeRedundantEntities", () => {
    it("merges exact name matches case-insensitively", () => {
      insertEntity(t.db, "e1", "TypeScript", { mentionCount: 10 });
      insertEntity(t.db, "e2", "typescript", { mentionCount: 3 });
      insertEntity(t.db, "e3", "TYPESCRIPT", { mentionCount: 1 });

      const result = mergeRedundantEntities(t.db);

      expect(result.merged).toBe(2);

      // Only the survivor (highest mention_count) should remain
      const entities = t.db
        .prepare("SELECT id, name FROM entities")
        .all() as Array<{ id: string; name: string }>;

      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe("e1"); // highest mention_count
    });

    it("redirects relationships from duplicates to survivor", () => {
      insertEntity(t.db, "e1", "TypeScript", { mentionCount: 10 });
      insertEntity(t.db, "e2", "typescript", { mentionCount: 3 });
      insertEntity(t.db, "e3", "React");

      // Relationship pointing to the duplicate
      insertRelationship(t.db, "rel-1", "e2", "e3");

      mergeRedundantEntities(t.db);

      // Relationship should now point to survivor
      const rel = t.db
        .prepare("SELECT source_entity_id FROM relationships WHERE id = ?")
        .get("rel-1") as { source_entity_id: string };

      expect(rel.source_entity_id).toBe("e1");
    });

    it("handles no duplicates gracefully", () => {
      insertEntity(t.db, "e1", "TypeScript");
      insertEntity(t.db, "e2", "React");
      insertEntity(t.db, "e3", "Node.js");

      const result = mergeRedundantEntities(t.db);
      expect(result.merged).toBe(0);

      const count = t.db
        .prepare("SELECT COUNT(*) as cnt FROM entities")
        .get() as { cnt: number };
      expect(count.cnt).toBe(3);
    });
  });

  // ─── pruneOrphanEntities ────────────────────────────────────

  describe("pruneOrphanEntities", () => {
    it("deletes isolated old entities with low mention count", () => {
      // Old orphan with low mentions — should be pruned
      insertEntity(t.db, "orphan-1", "Orphan", {
        mentionCount: 1,
        lastSeen: NOW - 120 * DAY,
      });

      // Recent orphan — should be preserved
      insertEntity(t.db, "orphan-recent", "Recent Orphan", {
        mentionCount: 1,
        lastSeen: NOW,
      });

      const result = pruneOrphanEntities(t.db, {
        minMentions: 2,
        maxAgeDays: 90,
      });

      expect(result.pruned).toBe(1);

      const remaining = t.db
        .prepare("SELECT id FROM entities")
        .all() as Array<{ id: string }>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("orphan-recent");
    });

    it("preserves connected entities even if old", () => {
      insertEntity(t.db, "connected", "Connected", {
        mentionCount: 1,
        lastSeen: NOW - 120 * DAY,
      });
      insertEntity(t.db, "partner", "Partner", {
        mentionCount: 1,
        lastSeen: NOW - 120 * DAY,
      });

      // This relationship makes "connected" non-orphan
      insertRelationship(t.db, "rel-1", "connected", "partner");

      const result = pruneOrphanEntities(t.db, {
        minMentions: 2,
        maxAgeDays: 90,
      });

      // Neither should be pruned since both have relationships
      expect(result.pruned).toBe(0);
    });

    it("preserves entities with high mention count", () => {
      insertEntity(t.db, "popular", "Popular Entity", {
        mentionCount: 10,
        lastSeen: NOW - 120 * DAY,
      });

      const result = pruneOrphanEntities(t.db, {
        minMentions: 2,
        maxAgeDays: 90,
      });

      expect(result.pruned).toBe(0);
    });
  });

  // ─── pruneStaleGenerations ──────────────────────────────────

  describe("pruneStaleGenerations", () => {
    it("keeps recent generations and deletes old ones", () => {
      // Create data across multiple generations
      for (let gen = 1; gen <= 8; gen++) {
        insertCluster(t.db, `tc-gen${gen}`, `Gen ${gen}`, [`e-${gen}`], gen);
      }

      // Also add bridge_scores and temporal_patterns for old generations
      insertEntity(t.db, "bridge-ent", "Bridge Entity");
      insertBridgeScore(t.db, "bridge-ent", 1);
      insertBridgeScore(t.db, "bridge-ent", 2);

      insertTemporalPattern(t.db, "tp-old", 1);
      insertTemporalPattern(t.db, "tp-new", 8);

      insertObservation(t.db, {
        id: "obs-old",
        type: "growth_observation",
        content: "Old observation",
        relatedEntityIds: [],
        confidence: 0.8,
        generation: 1,
      });
      insertObservation(t.db, {
        id: "obs-new",
        type: "growth_observation",
        content: "New observation",
        relatedEntityIds: [],
        confidence: 0.8,
        generation: 8,
      });

      const result = pruneStaleGenerations(t.db, { keepGenerations: 3 });

      // Generations 1-4 should be pruned (cutoff = 8 - 3 = 5)
      expect(result.pruned).toBeGreaterThan(0);

      // Verify remaining clusters are gen 5-8
      const remaining = t.db
        .prepare("SELECT generation FROM topic_clusters ORDER BY generation")
        .all() as Array<{ generation: number }>;
      for (const row of remaining) {
        expect(row.generation).toBeGreaterThanOrEqual(5);
      }

      // Verify old observation is gone, new one remains
      const obsCount = t.db
        .prepare("SELECT COUNT(*) as cnt FROM reflection_observations WHERE generation = 1")
        .get() as { cnt: number };
      expect(obsCount.cnt).toBe(0);

      const newObsCount = t.db
        .prepare("SELECT COUNT(*) as cnt FROM reflection_observations WHERE generation = 8")
        .get() as { cnt: number };
      expect(newObsCount.cnt).toBe(1);
    });

    it("does nothing when no data exists", () => {
      const result = pruneStaleGenerations(t.db, { keepGenerations: 3 });
      expect(result.pruned).toBe(0);
    });

    it("does nothing when fewer generations than threshold", () => {
      insertCluster(t.db, "tc-1", "Cluster 1", ["e1"], 1);
      insertCluster(t.db, "tc-2", "Cluster 2", ["e2"], 2);

      const result = pruneStaleGenerations(t.db, { keepGenerations: 5 });
      expect(result.pruned).toBe(0);

      const count = t.db
        .prepare("SELECT COUNT(*) as cnt FROM topic_clusters")
        .get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });
  });
});
