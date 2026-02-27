import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import {
  detectEntityBursts,
  detectTopicEmergence,
  detectTopicDecay,
  trackCommunityEvolution,
  detectPhaseTransitions,
  detectBridgeFormation,
  analyzeTemporalPatterns,
  persistTemporalPatterns,
  getTemporalPatterns,
  DEFAULT_TEMPORAL_CONFIG,
  _test,
} from "../../src/graph/temporal.js";
import type { TemporalPattern } from "../../src/graph/types.js";

// ─── Constants ────────────────────────────────────────────────────

const DAY = 86400; // seconds per day
const NOW = Math.floor(Date.now() / 1000);

// ─── Test Helpers ─────────────────────────────────────────────────

function insertTestEntity(
  db: Database.Database,
  id: string,
  name: string,
  type: string = "concept",
  overrides: {
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
    type,
    overrides.firstSeen ?? NOW,
    overrides.lastSeen ?? NOW,
    overrides.mentionCount ?? 1,
    NOW,
  );
}

function insertTestRelationship(
  db: Database.Database,
  id: string,
  source: string,
  target: string,
  type: string = "related_to",
  weight: number = 1.0,
  overrides: { createdAt?: number } = {},
) {
  db.prepare(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories, created_at)
    VALUES (?, ?, ?, ?, ?, '[]', ?)`,
  ).run(id, source, target, type, weight, overrides.createdAt ?? NOW);
}

function insertCluster(
  db: Database.Database,
  id: string,
  name: string,
  entityIds: string[],
  generation: number,
) {
  db.prepare(
    `INSERT INTO topic_clusters (id, name, entity_ids, memory_ids, coherence_score, created_at, updated_at, generation)
    VALUES (?, ?, ?, '[]', 0.5, ?, ?, ?)`,
  ).run(id, name, JSON.stringify(entityIds), NOW, NOW, generation);
}

function insertBridgeScore(
  db: Database.Database,
  entityId: string,
  generation: number,
  bridgeScore: number = 1.0,
) {
  db.prepare(
    `INSERT INTO bridge_scores (entity_id, betweenness, community_span, bridge_score, generation)
    VALUES (?, ?, ?, ?, ?)`,
  ).run(entityId, 0.5, 2, bridgeScore, generation);
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Temporal Pattern Analysis", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── detectEntityBursts ───────────────────────────────────────

  describe("detectEntityBursts", () => {
    it("detects entity with high recent rate triggering burst", () => {
      // Use 5 windows so the burst can exceed 2x average.
      // Windows 1-4: 1 entity each. Window 5: 8 entities.
      // avg = (1+1+1+1+8)/5 = 2.4, threshold = 2*2.4 = 4.8
      // 8 >= 4.8 -> burst detected
      const windowSeconds = 7 * DAY;
      const baseWindowIdx = Math.floor(NOW / windowSeconds) - 4;

      for (let w = 0; w < 4; w++) {
        const ts = (baseWindowIdx + w) * windowSeconds + 100;
        insertTestEntity(t.db, `normal-${w}`, `Normal ${w}`, "concept", {
          firstSeen: ts,
        });
      }

      // Burst window (the 5th window)
      const burstStart = (baseWindowIdx + 4) * windowSeconds + 100;
      for (let i = 0; i < 8; i++) {
        insertTestEntity(t.db, `burst-${i}`, `Burst ${i}`, "concept", {
          firstSeen: burstStart + i * 100,
        });
      }

      const patterns = detectEntityBursts(t.db, 7, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const burstPattern = patterns.find((p) => p.entityIds.length === 8);
      expect(burstPattern).toBeDefined();
      expect(burstPattern!.type).toBe("entity_burst");
      expect(burstPattern!.entityIds.length).toBe(8);
      expect(burstPattern!.confidence).toBeGreaterThan(0.5);
      expect(burstPattern!.generation).toBe(1);
      expect(burstPattern!.description).toContain("Burst of 8");
    });

    it("returns empty when all windows have similar counts", () => {
      const windowSeconds = 7 * DAY;
      const baseWindowIdx = Math.floor(NOW / windowSeconds) - 2;

      for (let week = 0; week < 3; week++) {
        const base = (baseWindowIdx + week) * windowSeconds + 100;
        for (let i = 0; i < 3; i++) {
          insertTestEntity(
            t.db,
            `w${week}-${i}`,
            `Week${week} Entity ${i}`,
            "concept",
            { firstSeen: base + i * 1000 },
          );
        }
      }

      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty when only one time window exists", () => {
      for (let i = 0; i < 10; i++) {
        insertTestEntity(t.db, `ent-${i}`, `Entity ${i}`, "concept", {
          firstSeen: NOW + i * 100,
        });
      }

      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(patterns.length).toBe(0);
    });

    it("includes correct time range in pattern", () => {
      const windowSeconds = 7 * DAY;
      const baseWindowIdx = Math.floor(NOW / windowSeconds) - 4;

      for (let w = 0; w < 4; w++) {
        const ts = (baseWindowIdx + w) * windowSeconds + 100;
        insertTestEntity(t.db, `n-${w}`, `Normal ${w}`, "concept", {
          firstSeen: ts,
        });
      }

      const burstStart = (baseWindowIdx + 4) * windowSeconds + 100;
      for (let i = 0; i < 8; i++) {
        insertTestEntity(t.db, `b-${i}`, `Burst ${i}`, "concept", {
          firstSeen: burstStart + i * 100,
        });
      }

      const patterns = detectEntityBursts(t.db, 7, 1);

      if (patterns.length > 0) {
        for (const p of patterns) {
          expect(p.timeStart).toBeLessThan(p.timeEnd);
          expect(p.timeEnd - p.timeStart).toBe(7 * DAY);
        }
      }
    });
  });

  // ─── detectTopicEmergence ─────────────────────────────────────

  describe("detectTopicEmergence", () => {
    it("flags recently appeared entities with relationships", () => {
      const windowSeconds = 7 * DAY;
      const windowIdx = Math.floor(NOW / windowSeconds);
      const windowStart = windowIdx * windowSeconds + 100;

      for (let i = 0; i < 5; i++) {
        insertTestEntity(
          t.db,
          `cluster-${i}`,
          `Cluster Entity ${i}`,
          "concept",
          { firstSeen: windowStart + i * 3600 },
        );
      }

      // Add a relationship to boost confidence
      insertTestRelationship(
        t.db,
        "rel-0-1",
        "cluster-0",
        "cluster-1",
        "related_to",
        1.0,
      );

      insertTestEntity(t.db, "loner", "Loner", "concept", {
        firstSeen: NOW - 30 * DAY,
      });

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const emergence = patterns.find((p) => p.entityIds.length >= 5);
      expect(emergence).toBeDefined();
      expect(emergence!.type).toBe("topic_emergence");
      expect(emergence!.confidence).toBeGreaterThan(0.4);
      expect(emergence!.description).toContain("emerged together");
    });

    it("respects minEntities threshold", () => {
      insertTestEntity(t.db, "pair-a", "Pair A", "concept", {
        firstSeen: NOW,
      });
      insertTestEntity(t.db, "pair-b", "Pair B", "concept", {
        firstSeen: NOW + 100,
      });

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectTopicEmergence(t.db, 7, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("shows entity names in description", () => {
      const windowSeconds = 7 * DAY;
      const windowIdx = Math.floor(NOW / windowSeconds);
      const base = windowIdx * windowSeconds + 100;

      insertTestEntity(t.db, "e1", "TypeScript", "concept", {
        firstSeen: base,
      });
      insertTestEntity(t.db, "e2", "React", "concept", {
        firstSeen: base + 100,
      });
      insertTestEntity(t.db, "e3", "Node.js", "concept", {
        firstSeen: base + 200,
      });

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);
      const p = patterns[0];
      expect(
        p.description.includes("TypeScript") ||
          p.description.includes("React") ||
          p.description.includes("Node.js"),
      ).toBe(true);
    });

    it("detects multiple emergence windows", () => {
      const windowSeconds = 7 * DAY;
      const baseWindowIdx = Math.floor(NOW / windowSeconds) - 3;

      const base1 = baseWindowIdx * windowSeconds + 100;
      for (let i = 0; i < 3; i++) {
        insertTestEntity(t.db, `g1-${i}`, `Group1 ${i}`, "concept", {
          firstSeen: base1 + i * 100,
        });
      }

      const base2 = (baseWindowIdx + 2) * windowSeconds + 100;
      for (let i = 0; i < 4; i++) {
        insertTestEntity(t.db, `g2-${i}`, `Group2 ${i}`, "concept", {
          firstSeen: base2 + i * 100,
        });
      }

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);
      expect(patterns.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── detectTopicDecay ─────────────────────────────────────────

  describe("detectTopicDecay", () => {
    it("flags old inactive entities", () => {
      const staleTime = NOW - 60 * DAY;
      for (let i = 0; i < 4; i++) {
        insertTestEntity(t.db, `stale-${i}`, `Stale Entity ${i}`, "concept", {
          firstSeen: staleTime - 30 * DAY,
          lastSeen: staleTime + i * 100,
          mentionCount: 3,
        });
      }

      insertTestEntity(t.db, "active-a", "Active A", "concept", {
        lastSeen: NOW,
        mentionCount: 5,
      });
      insertTestEntity(t.db, "active-b", "Active B", "concept", {
        lastSeen: NOW,
        mentionCount: 5,
      });

      const patterns = detectTopicDecay(t.db, 30, 3, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const decay = patterns.find((p) =>
        p.entityIds.some((id) => id.startsWith("stale-")),
      );
      expect(decay).toBeDefined();
      expect(decay!.type).toBe("topic_decay");
      expect(decay!.description).toContain("inactive");
      expect(decay!.entityIds.length).toBeGreaterThanOrEqual(4);
    });

    it("ignores entities with mention_count < 2", () => {
      const staleTime = NOW - 60 * DAY;
      for (let i = 0; i < 5; i++) {
        insertTestEntity(t.db, `once-${i}`, `Once Entity ${i}`, "concept", {
          firstSeen: staleTime,
          lastSeen: staleTime,
          mentionCount: 1,
        });
      }

      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("does not flag recently active entities", () => {
      for (let i = 0; i < 5; i++) {
        insertTestEntity(t.db, `recent-${i}`, `Recent ${i}`, "concept", {
          lastSeen: NOW - 5 * DAY,
          mentionCount: 3,
        });
      }

      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("respects minEntities threshold", () => {
      const staleTime = NOW - 60 * DAY;
      insertTestEntity(t.db, "stale-a", "Stale A", "concept", {
        lastSeen: staleTime,
        mentionCount: 3,
      });
      insertTestEntity(t.db, "stale-b", "Stale B", "concept", {
        lastSeen: staleTime,
        mentionCount: 3,
      });

      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });
  });

  // ─── trackCommunityEvolution ──────────────────────────────────

  describe("trackCommunityEvolution", () => {
    it("two generations with different compositions flagged", () => {
      insertCluster(t.db, "c1-gen1", "Backend Tools", ["e1", "e2", "e3"], 1);
      insertCluster(t.db, "c1-gen2", "Backend Tools", ["e1", "e2", "e3"], 2);
      insertCluster(
        t.db,
        "c2-gen2",
        "Frontend Framework",
        ["e10", "e11", "e12"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);

      const birth = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "birth",
      );
      expect(birth).toBeDefined();
      expect(birth!.type).toBe("community_shift");
      expect(birth!.description).toContain("Frontend Framework");
      expect(birth!.description).toContain("emerged");
    });

    it("detects community death when previous cluster disappears", () => {
      insertCluster(t.db, "c1-gen1", "Cluster Alpha", ["e1", "e2"], 1);
      insertCluster(t.db, "c2-gen1", "Cluster Beta", ["e5", "e6", "e7"], 1);
      insertCluster(t.db, "c1-gen2", "Cluster Alpha", ["e1", "e2"], 2);

      const patterns = trackCommunityEvolution(t.db, 2);

      const death = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "death",
      );
      expect(death).toBeDefined();
      expect(death!.type).toBe("community_shift");
      expect(death!.description).toContain("disappeared");
      expect(death!.description).toContain("Cluster Beta");
    });

    it("detects community growth", () => {
      insertCluster(t.db, "c1-gen1", "DevOps", ["e1", "e2", "e3"], 1);
      insertCluster(
        t.db,
        "c1-gen2",
        "DevOps",
        ["e1", "e2", "e3", "e4", "e5"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);

      const growth = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "growth",
      );
      expect(growth).toBeDefined();
      expect(growth!.type).toBe("community_shift");
      expect(growth!.description).toContain("grew");
      expect(
        (growth!.metadata as Record<string, unknown>).previousSize,
      ).toBe(3);
      expect(
        (growth!.metadata as Record<string, unknown>).currentSize,
      ).toBe(5);
    });

    it("detects community contraction", () => {
      insertCluster(
        t.db,
        "c1-gen1",
        "Testing Tools",
        ["e1", "e2", "e3", "e4", "e5"],
        1,
      );
      insertCluster(
        t.db,
        "c1-gen2",
        "Testing Tools",
        ["e1", "e2", "e3"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);

      const contraction = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType ===
          "contraction",
      );
      expect(contraction).toBeDefined();
      expect(contraction!.type).toBe("community_shift");
      expect(contraction!.description).toContain("contracted");
    });

    it("returns empty for generation 1 (no previous to compare)", () => {
      insertCluster(t.db, "c1", "First Gen", ["e1", "e2"], 1);
      const patterns = trackCommunityEvolution(t.db, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty when both generations are empty", () => {
      const patterns = trackCommunityEvolution(t.db, 2);
      expect(patterns.length).toBe(0);
    });

    it("includes Jaccard similarity in metadata for matched communities", () => {
      insertCluster(t.db, "c1-gen1", "Shared", ["e1", "e2", "e3"], 1);
      insertCluster(
        t.db,
        "c1-gen2",
        "Shared",
        ["e1", "e2", "e3", "e4"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);
      const growth = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "growth",
      );
      expect(growth).toBeDefined();
      const jaccard = (growth!.metadata as Record<string, unknown>)
        .jaccardSimilarity as number;
      // J({1,2,3}, {1,2,3,4}) = 3/4 = 0.75
      expect(jaccard).toBeCloseTo(0.75, 2);
    });
  });

  // ─── detectPhaseTransitions ───────────────────────────────────

  describe("detectPhaseTransitions", () => {
    it("detects phase transition between windows with different entity compositions", () => {
      const windowSeconds = 7 * DAY;
      const baseWindowIdx = Math.floor(NOW / windowSeconds) - 2;
      const window1Time = baseWindowIdx * windowSeconds + 100;

      insertTestEntity(t.db, "eA", "Entity A", "concept");
      insertTestEntity(t.db, "eB", "Entity B", "concept");
      insertTestEntity(t.db, "eC", "Entity C", "concept");
      insertTestEntity(t.db, "eX", "Entity X", "concept");
      insertTestEntity(t.db, "eY", "Entity Y", "concept");
      insertTestEntity(t.db, "eZ", "Entity Z", "concept");

      // Window 1: relationships among A, B, C
      insertTestRelationship(t.db, "r1", "eA", "eB", "related_to", 1.0, {
        createdAt: window1Time,
      });
      insertTestRelationship(t.db, "r2", "eA", "eC", "related_to", 1.0, {
        createdAt: window1Time + 100,
      });
      insertTestRelationship(t.db, "r3", "eB", "eC", "related_to", 1.0, {
        createdAt: window1Time + 200,
      });

      // Window 2: relationships among X, Y, Z (completely different)
      const window2Time = (baseWindowIdx + 1) * windowSeconds + 100;
      insertTestRelationship(t.db, "r4", "eX", "eY", "related_to", 1.0, {
        createdAt: window2Time,
      });
      insertTestRelationship(t.db, "r5", "eX", "eZ", "related_to", 1.0, {
        createdAt: window2Time + 100,
      });
      insertTestRelationship(t.db, "r6", "eY", "eZ", "related_to", 1.0, {
        createdAt: window2Time + 200,
      });

      const patterns = detectPhaseTransitions(t.db, { windowDays: 7 });

      expect(patterns.length).toBeGreaterThanOrEqual(1);
      const transition = patterns[0];
      expect(transition.type).toBe("phase_transition");
      expect(transition.confidence).toBeGreaterThan(0.5);
      expect(transition.description).toContain("Phase transition");
      expect(
        (transition.metadata as Record<string, unknown>).cosineDistance,
      ).toBeGreaterThan(0.5);
    });

    it("returns empty when consecutive windows have similar compositions", () => {
      const windowSeconds = 7 * DAY;
      const baseWindowIdx = Math.floor(NOW / windowSeconds) - 2;

      insertTestEntity(t.db, "eA", "Entity A", "concept");
      insertTestEntity(t.db, "eB", "Entity B", "concept");
      insertTestEntity(t.db, "eC", "Entity C", "concept");

      // Same entities in both windows (different edge types to avoid unique constraint)
      const window1Time = baseWindowIdx * windowSeconds + 100;
      insertTestRelationship(t.db, "r1", "eA", "eB", "related_to", 1.0, {
        createdAt: window1Time,
      });
      insertTestRelationship(t.db, "r1b", "eA", "eC", "related_to", 1.0, {
        createdAt: window1Time + 100,
      });

      const window2Time = (baseWindowIdx + 1) * windowSeconds + 100;
      insertTestRelationship(t.db, "r2", "eA", "eB", "uses", 1.0, {
        createdAt: window2Time,
      });
      insertTestRelationship(t.db, "r2b", "eA", "eC", "uses", 1.0, {
        createdAt: window2Time + 100,
      });

      const patterns = detectPhaseTransitions(t.db, { windowDays: 7 });
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectPhaseTransitions(t.db);
      expect(patterns.length).toBe(0);
    });

    it("returns empty when only one window has relationships", () => {
      insertTestEntity(t.db, "eA", "Entity A", "concept");
      insertTestEntity(t.db, "eB", "Entity B", "concept");

      insertTestRelationship(t.db, "r1", "eA", "eB", "related_to", 1.0, {
        createdAt: NOW,
      });

      const patterns = detectPhaseTransitions(t.db, { windowDays: 7 });
      expect(patterns.length).toBe(0);
    });
  });

  // ─── detectBridgeFormation ────────────────────────────────────

  describe("detectBridgeFormation", () => {
    it("detects new bridge entity in latest generation", () => {
      insertTestEntity(t.db, "old-bridge", "Old Bridge", "concept");
      insertTestEntity(t.db, "new-bridge", "New Bridge", "concept");

      insertBridgeScore(t.db, "old-bridge", 1, 1.5);
      insertBridgeScore(t.db, "old-bridge", 2, 1.5);
      insertBridgeScore(t.db, "new-bridge", 2, 2.0);

      const patterns = detectBridgeFormation(t.db);

      expect(patterns.length).toBe(1);
      expect(patterns[0].type).toBe("bridge_formation");
      expect(patterns[0].entityIds).toContain("new-bridge");
      expect(patterns[0].entityIds).not.toContain("old-bridge");
      expect(patterns[0].description).toContain("New Bridge");
      expect(patterns[0].description).toContain("new bridge");
    });

    it("returns all bridges when first generation (no previous)", () => {
      insertTestEntity(t.db, "bridge-a", "Bridge A", "concept");
      insertTestEntity(t.db, "bridge-b", "Bridge B", "concept");

      insertBridgeScore(t.db, "bridge-a", 1, 1.0);
      insertBridgeScore(t.db, "bridge-b", 1, 2.0);

      const patterns = detectBridgeFormation(t.db);

      expect(patterns.length).toBe(1);
      expect(patterns[0].entityIds.length).toBe(2);
      expect(patterns[0].entityIds).toContain("bridge-a");
      expect(patterns[0].entityIds).toContain("bridge-b");
    });

    it("returns empty when no bridge scores exist", () => {
      const patterns = detectBridgeFormation(t.db);
      expect(patterns.length).toBe(0);
    });

    it("returns empty when no new bridges formed", () => {
      insertTestEntity(t.db, "same-bridge", "Same Bridge", "concept");

      insertBridgeScore(t.db, "same-bridge", 1, 1.0);
      insertBridgeScore(t.db, "same-bridge", 2, 1.5);

      const patterns = detectBridgeFormation(t.db);
      expect(patterns.length).toBe(0);
    });
  });

  // ─── analyzeTemporalPatterns ──────────────────────────────────

  describe("analyzeTemporalPatterns", () => {
    it("integration test: runs all detectors and persists to DB", () => {
      // Set up community evolution data to guarantee at least one pattern
      insertCluster(
        t.db,
        "cluster-gen1",
        "Gen 1 Cluster",
        ["e1", "e2"],
        1,
      );
      insertCluster(
        t.db,
        "cluster-gen2",
        "Gen 2 New",
        ["e10", "e11", "e12"],
        2,
      );

      const patterns = analyzeTemporalPatterns(t.db, 2, {
        windowDays: 7,
        stalenessDays: 30,
        minEntities: 3,
      });

      expect(patterns.length).toBeGreaterThan(0);

      const types = new Set(patterns.map((p) => p.type));
      expect(types.size).toBeGreaterThanOrEqual(1);

      // Verify persistence
      const stored = getTemporalPatterns(t.db, 2);
      expect(stored.length).toBe(patterns.length);
    });

    it("uses default options when none provided", () => {
      const patterns = analyzeTemporalPatterns(t.db, 1);
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("returns empty array for empty database", () => {
      const patterns = analyzeTemporalPatterns(t.db, 1);
      expect(patterns.length).toBe(0);
    });
  });

  // ─── Persistence round-trip ───────────────────────────────────

  describe("persistTemporalPatterns + getTemporalPatterns", () => {
    it("round-trips patterns through the database correctly", () => {
      const pattern: TemporalPattern = {
        id: crypto.randomUUID(),
        type: "entity_burst",
        description: "Test burst pattern",
        entityIds: ["e1", "e2", "e3"],
        timeStart: NOW - 7 * DAY,
        timeEnd: NOW,
        confidence: 0.85,
        metadata: { count: 3, ratio: 2.5 },
        generation: 1,
      };

      persistTemporalPatterns(t.db, [pattern]);

      const retrieved = getTemporalPatterns(t.db, 1);

      expect(retrieved.length).toBe(1);
      const r = retrieved[0];
      expect(r.id).toBe(pattern.id);
      expect(r.type).toBe(pattern.type);
      expect(r.description).toBe(pattern.description);
      expect(r.entityIds).toEqual(pattern.entityIds);
      expect(r.timeStart).toBe(pattern.timeStart);
      expect(r.timeEnd).toBe(pattern.timeEnd);
      expect(r.confidence).toBe(pattern.confidence);
      expect(r.metadata).toEqual(pattern.metadata);
      expect(r.generation).toBe(pattern.generation);
    });

    it("persists multiple patterns in one call", () => {
      const patterns: TemporalPattern[] = [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Burst 1",
          entityIds: ["e1"],
          timeStart: NOW - 14 * DAY,
          timeEnd: NOW - 7 * DAY,
          confidence: 0.6,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "Emergence 1",
          entityIds: ["e2", "e3"],
          timeStart: NOW - 7 * DAY,
          timeEnd: NOW,
          confidence: 0.7,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_decay",
          description: "Decay 1",
          entityIds: ["e4", "e5", "e6"],
          timeStart: NOW - 60 * DAY,
          timeEnd: NOW - 30 * DAY,
          confidence: 0.8,
          metadata: {},
          generation: 1,
        },
      ];

      persistTemporalPatterns(t.db, patterns);

      const retrieved = getTemporalPatterns(t.db, 1);
      expect(retrieved.length).toBe(3);

      expect(retrieved[0].confidence).toBeGreaterThanOrEqual(
        retrieved[1].confidence,
      );
      expect(retrieved[1].confidence).toBeGreaterThanOrEqual(
        retrieved[2].confidence,
      );
    });

    it("stores all pattern types correctly", () => {
      const types: Array<TemporalPattern["type"]> = [
        "entity_burst",
        "community_shift",
        "phase_transition",
        "topic_emergence",
        "topic_decay",
        "bridge_formation",
      ];

      const patterns = types.map((type) => ({
        id: crypto.randomUUID(),
        type,
        description: `Pattern type: ${type}`,
        entityIds: ["e1"],
        timeStart: NOW - DAY,
        timeEnd: NOW,
        confidence: 0.5,
        metadata: {},
        generation: 1,
      }));

      persistTemporalPatterns(t.db, patterns);

      const retrieved = getTemporalPatterns(t.db, 1);
      expect(retrieved.length).toBe(types.length);

      const retrievedTypes = new Set(retrieved.map((p) => p.type));
      for (const type of types) {
        expect(retrievedTypes.has(type)).toBe(true);
      }
    });
  });

  // ─── getTemporalPatterns ──────────────────────────────────────

  describe("getTemporalPatterns", () => {
    it("retrieves patterns for a specific generation", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Gen 1 pattern",
          entityIds: ["e1"],
          timeStart: NOW - 14 * DAY,
          timeEnd: NOW - 7 * DAY,
          confidence: 0.5,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "Gen 2 pattern",
          entityIds: ["e2", "e3"],
          timeStart: NOW - 7 * DAY,
          timeEnd: NOW,
          confidence: 0.7,
          metadata: {},
          generation: 2,
        },
      ]);

      const gen1Results = getTemporalPatterns(t.db, 1);
      expect(gen1Results.length).toBe(1);
      expect(gen1Results[0].description).toBe("Gen 1 pattern");

      const gen2Results = getTemporalPatterns(t.db, 2);
      expect(gen2Results.length).toBe(1);
      expect(gen2Results[0].description).toBe("Gen 2 pattern");
    });

    it("retrieves latest generation when no generation specified", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Old pattern",
          entityIds: ["e1"],
          timeStart: NOW - 14 * DAY,
          timeEnd: NOW - 7 * DAY,
          confidence: 0.5,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "New pattern",
          entityIds: ["e2"],
          timeStart: NOW - 7 * DAY,
          timeEnd: NOW,
          confidence: 0.7,
          metadata: {},
          generation: 3,
        },
      ]);

      const latest = getTemporalPatterns(t.db);

      expect(latest.length).toBe(1);
      expect(latest[0].description).toBe("New pattern");
      expect(latest[0].generation).toBe(3);
    });

    it("filters by type when specified", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Burst",
          entityIds: ["e1"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.5,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_decay",
          description: "Decay",
          entityIds: ["e2"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.6,
          metadata: {},
          generation: 1,
        },
      ]);

      const bursts = getTemporalPatterns(t.db, 1, "entity_burst");
      expect(bursts.length).toBe(1);
      expect(bursts[0].type).toBe("entity_burst");

      const decays = getTemporalPatterns(t.db, 1, "topic_decay");
      expect(decays.length).toBe(1);
      expect(decays[0].type).toBe("topic_decay");
    });

    it("returns empty array when no patterns exist", () => {
      const results = getTemporalPatterns(t.db);
      expect(results.length).toBe(0);
    });

    it("returns empty array when generation has no patterns", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Gen 1",
          entityIds: ["e1"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.5,
          metadata: {},
          generation: 1,
        },
      ]);

      const results = getTemporalPatterns(t.db, 99);
      expect(results.length).toBe(0);
    });

    it("returns patterns ordered by confidence descending", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Low confidence",
          entityIds: ["e1"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.3,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "High confidence",
          entityIds: ["e2"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.9,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_decay",
          description: "Medium confidence",
          entityIds: ["e3"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.6,
          metadata: {},
          generation: 1,
        },
      ]);

      const results = getTemporalPatterns(t.db, 1);

      expect(results[0].confidence).toBe(0.9);
      expect(results[1].confidence).toBe(0.6);
      expect(results[2].confidence).toBe(0.3);
    });
  });

  // ─── Helper functions ─────────────────────────────────────────

  describe("jaccardSimilarity helper", () => {
    it("returns 1 for identical sets", () => {
      expect(_test.jaccardSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(
        1.0,
      );
    });

    it("returns 0 for disjoint sets", () => {
      expect(_test.jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0);
    });

    it("returns correct value for partial overlap", () => {
      // J({a,b,c}, {b,c,d}) = 2/4 = 0.5
      expect(
        _test.jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"]),
      ).toBeCloseTo(0.5, 5);
    });

    it("returns 0 for two empty sets", () => {
      expect(_test.jaccardSimilarity([], [])).toBe(0);
    });

    it("returns 0 when one set is empty", () => {
      expect(_test.jaccardSimilarity(["a"], [])).toBe(0);
    });

    it("computes known Jaccard values", () => {
      // J({1,2,3}, {1,2,3,4}) = 3/4 = 0.75
      expect(
        _test.jaccardSimilarity(["1", "2", "3"], ["1", "2", "3", "4"]),
      ).toBeCloseTo(0.75, 5);

      // J({a}, {a,b,c,d,e}) = 1/5 = 0.2
      expect(
        _test.jaccardSimilarity(["a"], ["a", "b", "c", "d", "e"]),
      ).toBeCloseTo(0.2, 5);
    });
  });

  describe("cosineDistance helper", () => {
    it("returns 0 for identical vectors", () => {
      const a = new Map([
        ["x", 1],
        ["y", 2],
      ]);
      const b = new Map([
        ["x", 1],
        ["y", 2],
      ]);
      expect(_test.cosineDistance(a, b)).toBeCloseTo(0, 5);
    });

    it("returns 1 for orthogonal vectors", () => {
      const a = new Map([
        ["x", 1],
        ["y", 0],
      ]);
      const b = new Map([
        ["x", 0],
        ["y", 1],
      ]);
      expect(_test.cosineDistance(a, b)).toBeCloseTo(1.0, 5);
    });

    it("returns 1 for completely disjoint key sets", () => {
      const a = new Map([["x", 1]]);
      const b = new Map([["y", 1]]);
      expect(_test.cosineDistance(a, b)).toBeCloseTo(1.0, 5);
    });

    it("returns 1 when either vector is empty", () => {
      const empty = new Map<string, number>();
      const nonEmpty = new Map([["x", 1]]);
      expect(_test.cosineDistance(empty, nonEmpty)).toBe(1.0);
      expect(_test.cosineDistance(nonEmpty, empty)).toBe(1.0);
    });

    it("returns value between 0 and 1 for partially overlapping vectors", () => {
      const a = new Map([
        ["x", 3],
        ["y", 4],
      ]);
      const b = new Map([
        ["x", 4],
        ["y", 3],
      ]);
      const dist = _test.cosineDistance(a, b);
      expect(dist).toBeGreaterThan(0);
      expect(dist).toBeLessThan(1);
    });
  });

  // ─── Empty graph edge cases ───────────────────────────────────

  describe("empty graph", () => {
    it("all detectors return empty arrays on empty database", () => {
      expect(detectEntityBursts(t.db, 7, 1)).toEqual([]);
      expect(detectTopicEmergence(t.db, 7, 3, 1)).toEqual([]);
      expect(detectTopicDecay(t.db, 30, 3, 1)).toEqual([]);
      expect(trackCommunityEvolution(t.db, 2)).toEqual([]);
      expect(detectPhaseTransitions(t.db)).toEqual([]);
      expect(detectBridgeFormation(t.db)).toEqual([]);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles entities with null first_seen in burst detection", () => {
      t.db
        .prepare(
          "INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at) VALUES (?, ?, ?, '[]', NULL, ?, 1, ?)",
        )
        .run("null-ent", "Null Entity", "concept", NOW, NOW);

      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("handles entities with null last_seen in decay detection", () => {
      t.db
        .prepare(
          "INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at) VALUES (?, ?, ?, '[]', ?, NULL, 3, ?)",
        )
        .run("null-ent", "Null Entity", "concept", NOW, NOW);

      const patterns = detectTopicDecay(t.db, 30, 1, 1);
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("persists empty pattern list without error", () => {
      persistTemporalPatterns(t.db, []);
      const results = getTemporalPatterns(t.db);
      expect(results.length).toBe(0);
    });

    it("handles metadata with nested objects", () => {
      const pattern: TemporalPattern = {
        id: crypto.randomUUID(),
        type: "entity_burst",
        description: "Test nested metadata",
        entityIds: ["e1"],
        timeStart: NOW,
        timeEnd: NOW,
        confidence: 0.5,
        metadata: {
          nested: { deep: "value" },
          array: [1, 2, 3],
          nullVal: null,
        },
        generation: 1,
      };

      persistTemporalPatterns(t.db, [pattern]);

      const retrieved = getTemporalPatterns(t.db, 1);
      expect(retrieved[0].metadata).toEqual(pattern.metadata);
    });
  });

  // ─── DEFAULT_TEMPORAL_CONFIG ──────────────────────────────────

  describe("DEFAULT_TEMPORAL_CONFIG", () => {
    it("has expected default values", () => {
      expect(DEFAULT_TEMPORAL_CONFIG.windowDays).toBe(7);
      expect(DEFAULT_TEMPORAL_CONFIG.burstThreshold).toBe(3);
      expect(DEFAULT_TEMPORAL_CONFIG.decayDaysThreshold).toBe(60);
      expect(DEFAULT_TEMPORAL_CONFIG.jaccardThreshold).toBe(0.3);
    });
  });
});
