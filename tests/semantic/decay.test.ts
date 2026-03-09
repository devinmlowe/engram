import { describe, it, expect } from "vitest";
import {
  computeRetrievability,
  computeConfidence,
  computeRetrievalScore,
  onSuccessfulAccess,
  onContradiction,
  isPruneEligible,
  getMemoryHealth,
} from "../../src/semantic/decay.js";
import {
  INITIAL_STABILITY,
  STABILITY_GROWTH_RATE,
  CONTRADICTION_PENALTY,
  PRUNE_THRESHOLD,
} from "../../src/semantic/types.js";
import type { Memory } from "../../src/semantic/types.js";

const NOW = 1700000000; // fixed reference timestamp

function createDecayMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-decay-test",
    type: "fact",
    content: "Test memory",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: NOW,
    lastAccessed: NOW,
    sourceExchanges: [],
    isActive: true,
    ...overrides,
  };
}

describe("FSRS Decay Model", () => {
  describe("computeRetrievability", () => {
    it("fresh memory has retrievability of 1.0 when last_accessed is now", () => {
      const memory = createDecayMemory({ lastAccessed: NOW });
      const R = computeRetrievability(memory, NOW);
      expect(R).toBe(1.0);
    });

    it("decays correctly for a 30-day fact (R = 0.9^1)", () => {
      // fact stability = 30 days
      // After 30 days: R = 0.9 ^ (30/30) = 0.9
      const thirtyDaysLater = NOW + 30 * 86400;
      const memory = createDecayMemory({
        type: "fact",
        lastAccessed: NOW,
      });

      const R = computeRetrievability(memory, thirtyDaysLater);
      expect(R).toBeCloseTo(0.9, 5);
    });

    it("decays more slowly for high-stability types", () => {
      const sixtyDaysLater = NOW + 60 * 86400;

      // pattern: stability = 120 days
      // After 60 days: R = 0.9 ^ (60/120) = 0.9 ^ 0.5 ≈ 0.9487
      const pattern = createDecayMemory({ type: "pattern", lastAccessed: NOW });
      const patternR = computeRetrievability(pattern, sixtyDaysLater);

      // fact: stability = 30 days
      // After 60 days: R = 0.9 ^ (60/30) = 0.9 ^ 2 = 0.81
      const fact = createDecayMemory({ type: "fact", lastAccessed: NOW });
      const factR = computeRetrievability(fact, sixtyDaysLater);

      expect(patternR).toBeGreaterThan(factR);
      expect(patternR).toBeCloseTo(Math.pow(0.9, 0.5), 5);
      expect(factR).toBeCloseTo(0.81, 5);
    });

    it("uses createdAt when lastAccessed is undefined", () => {
      const memory = createDecayMemory({
        createdAt: NOW,
        lastAccessed: undefined,
      });
      const thirtyDaysLater = NOW + 30 * 86400;

      const R = computeRetrievability(memory, thirtyDaysLater);
      // fact type: R = 0.9 ^ (30/30) = 0.9
      expect(R).toBeCloseTo(0.9, 5);
    });
  });

  describe("corroboration factor", () => {
    it("starts at 0.5 for access_count=0", () => {
      const memory = createDecayMemory({ accessCount: 0, lastAccessed: NOW });
      const conf = computeConfidence(memory, NOW);
      // confidence = 0.5 (base) * 0.5 (corroboration) * 1.0 (retrievability) = 0.25
      expect(conf).toBeCloseTo(0.25, 5);
    });

    it("grows to 0.6 at access_count=1", () => {
      const memory = createDecayMemory({ accessCount: 1, lastAccessed: NOW });
      const conf = computeConfidence(memory, NOW);
      // confidence = 0.5 * 0.6 * 1.0 = 0.30
      expect(conf).toBeCloseTo(0.30, 5);
    });

    it("caps at 1.0 at access_count=5", () => {
      const memory = createDecayMemory({ accessCount: 5, lastAccessed: NOW });
      const conf = computeConfidence(memory, NOW);
      // confidence = 0.5 * 1.0 * 1.0 = 0.50
      expect(conf).toBeCloseTo(0.50, 5);
    });

    it("remains capped at access_count=10", () => {
      const memory = createDecayMemory({ accessCount: 10, lastAccessed: NOW });
      const conf = computeConfidence(memory, NOW);
      // min(1.0, 0.5 + 0.1*10) = min(1.0, 1.5) = 1.0
      // confidence = 0.5 * 1.0 * 1.0 = 0.50
      expect(conf).toBeCloseTo(0.50, 5);
    });
  });

  describe("computeConfidence", () => {
    it("computes composite = base * corroboration * decay", () => {
      const thirtyDaysLater = NOW + 30 * 86400;
      const memory = createDecayMemory({
        type: "fact",
        confidence: 0.8,
        accessCount: 3,
        lastAccessed: NOW,
      });

      const conf = computeConfidence(memory, thirtyDaysLater);
      // corroboration = min(1.0, 0.5 + 0.3) = 0.8
      // retrievability = 0.9 ^ (30/30) = 0.9
      // confidence = 0.8 * 0.8 * 0.9 = 0.576
      expect(conf).toBeCloseTo(0.576, 5);
    });
  });

  describe("onSuccessfulAccess", () => {
    it("increases stability proportional to difficulty (low R = more growth)", () => {
      // After 60 days for a fact (stability=30): R = 0.9^2 = 0.81
      const sixtyDaysLater = NOW + 60 * 86400;
      const hardMemory = createDecayMemory({
        type: "fact",
        lastAccessed: NOW,
      });
      const hardResult = onSuccessfulAccess(hardMemory, sixtyDaysLater);

      // After 1 day for a fact (stability=30): R = 0.9^(1/30) ≈ 0.9965
      const oneDayLater = NOW + 1 * 86400;
      const easyMemory = createDecayMemory({
        type: "fact",
        lastAccessed: NOW,
      });
      const easyResult = onSuccessfulAccess(easyMemory, oneDayLater);

      // Hard retrieval should produce more stability growth
      expect(hardResult.stability).toBeGreaterThan(easyResult.stability);

      // Verify formula: new_stability = 30 * (1 + 0.2 * (1 - R))
      const R_hard = Math.pow(0.9, 60 / 30);
      const expectedHard = 30 * (1 + STABILITY_GROWTH_RATE * (1 - R_hard));
      expect(hardResult.stability).toBeCloseTo(expectedHard, 5);
    });

    it("bumps importance by 0.02, capped at 1.0", () => {
      const memory = createDecayMemory({ importance: 0.5 });
      const result = onSuccessfulAccess(memory, NOW);
      expect(result.importance).toBeCloseTo(0.52, 5);

      const nearMax = createDecayMemory({ importance: 0.99 });
      const maxResult = onSuccessfulAccess(nearMax, NOW);
      expect(maxResult.importance).toBe(1.0);
    });
  });

  describe("onContradiction", () => {
    it("reduces stability by 20%", () => {
      const memory = createDecayMemory({ type: "fact" });
      const result = onContradiction(memory);

      // fact stability = 30, * 0.8 = 24
      expect(result.stability).toBeCloseTo(
        INITIAL_STABILITY.fact * CONTRADICTION_PENALTY,
        5,
      );
      expect(result.stability).toBeCloseTo(24, 5);
    });
  });

  describe("isPruneEligible", () => {
    it("returns true when confidence < 0.1", () => {
      // Very low base confidence, no accesses, heavily decayed
      const veryOld = NOW + 365 * 86400;
      const memory = createDecayMemory({
        type: "fact",
        confidence: 0.1,
        accessCount: 0,
        lastAccessed: NOW,
      });

      // confidence = 0.1 * 0.5 * R(365 days, stability=30)
      // R = 0.9 ^ (365/30) ≈ 0.288
      // = 0.1 * 0.5 * 0.288 ≈ 0.0144 < 0.1
      const eligible = isPruneEligible(memory, veryOld);
      expect(eligible).toBe(true);
    });

    it("returns false when confidence is healthy", () => {
      const memory = createDecayMemory({
        confidence: 0.8,
        accessCount: 5,
        lastAccessed: NOW,
      });

      const eligible = isPruneEligible(memory, NOW);
      // confidence = 0.8 * 1.0 * 1.0 = 0.8
      expect(eligible).toBe(false);
    });
  });

  describe("computeRetrievalScore", () => {
    it("weights: 0.55 relevance + 0.25 retrievability + 0.20 importance", () => {
      const memory = createDecayMemory({
        importance: 0.8,
        lastAccessed: NOW,
      });

      const score = computeRetrievalScore(1.0, memory, NOW);
      // score = 0.55 * 1.0 + 0.25 * 1.0 + 0.20 * 0.8
      // = 0.55 + 0.25 + 0.16 = 0.96
      expect(score).toBeCloseTo(0.96, 5);
    });

    it("produces lower score with low relevance", () => {
      const memory = createDecayMemory({ importance: 0.5, lastAccessed: NOW });

      const highRel = computeRetrievalScore(1.0, memory, NOW);
      const lowRel = computeRetrievalScore(0.2, memory, NOW);

      expect(highRel).toBeGreaterThan(lowRel);
    });

    it("factors in decay over time", () => {
      const memory = createDecayMemory({ lastAccessed: NOW });

      const freshScore = computeRetrievalScore(0.8, memory, NOW);
      const agedScore = computeRetrievalScore(
        0.8,
        memory,
        NOW + 90 * 86400,
      );

      expect(freshScore).toBeGreaterThan(agedScore);
    });
  });

  describe("initial stability varies by type", () => {
    it("pattern > preference > convention > decision > solution > fact", () => {
      expect(INITIAL_STABILITY.pattern).toBe(120);
      expect(INITIAL_STABILITY.preference).toBe(90);
      expect(INITIAL_STABILITY.convention).toBe(75);
      expect(INITIAL_STABILITY.decision).toBe(60);
      expect(INITIAL_STABILITY.solution).toBe(45);
      expect(INITIAL_STABILITY.fact).toBe(30);

      expect(INITIAL_STABILITY.pattern).toBeGreaterThan(
        INITIAL_STABILITY.preference,
      );
      expect(INITIAL_STABILITY.preference).toBeGreaterThan(
        INITIAL_STABILITY.fact,
      );
    });
  });

  describe("getMemoryHealth", () => {
    it("returns correct composite values", () => {
      const memory = createDecayMemory({
        id: "health-test",
        type: "preference",
        confidence: 0.7,
        accessCount: 3,
        importance: 0.6,
        lastAccessed: NOW,
      });

      const health = getMemoryHealth(memory, NOW);

      expect(health.memoryId).toBe("health-test");
      expect(health.retrievability).toBe(1.0); // just accessed
      expect(health.stability).toBe(INITIAL_STABILITY.preference); // 90
      // confidence = 0.7 * min(1.0, 0.5+0.3) * 1.0 = 0.7 * 0.8 = 0.56
      expect(health.confidence).toBeCloseTo(0.56, 5);
      expect(health.pruneEligible).toBe(false);
    });

    it("marks prune-eligible memory correctly", () => {
      const veryOld = NOW + 500 * 86400;
      const memory = createDecayMemory({
        id: "prune-test",
        type: "fact",
        confidence: 0.05,
        accessCount: 0,
        lastAccessed: NOW,
      });

      const health = getMemoryHealth(memory, veryOld);
      expect(health.pruneEligible).toBe(true);
      expect(health.confidence).toBeLessThan(PRUNE_THRESHOLD);
    });
  });
});
