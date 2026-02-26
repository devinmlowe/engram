import { describe, it, expect, beforeAll } from "vitest";
import {
  initNli,
  classifyNli,
  classifyNliBatch,
  getActiveNliModel,
  resetNli,
  type NliResult,
} from "../../src/semantic/nli.js";

describe("NLI contradiction detection", () => {
  beforeAll(async () => {
    await initNli();
  }, 120_000);

  it("model initializes without error", () => {
    const model = getActiveNliModel();
    expect(model).toBeTruthy();
    expect(typeof model).toBe("string");
  });

  it("clear entailment pair returns entailment label", async () => {
    const result = await classifyNli(
      "User prefers Fish shell",
      "The user's preferred shell is Fish",
    );

    expect(result.label).toBe("entailment");
    expect(result.entailment).toBeGreaterThan(0.5);
  });

  it("clear contradiction pair returns contradiction label", async () => {
    const result = await classifyNli(
      "Project uses PostgreSQL",
      "Project uses SQLite instead of PostgreSQL",
    );

    expect(result.label).toBe("contradiction");
    expect(result.contradiction).toBeGreaterThan(0.5);
  });

  it("neutral pair returns neutral label", async () => {
    const result = await classifyNli(
      "User prefers dark mode",
      "Project uses React",
    );

    expect(result.label).toBe("neutral");
    expect(result.neutral).toBeGreaterThan(result.entailment);
    expect(result.neutral).toBeGreaterThan(result.contradiction);
  });

  it("probabilities sum to approximately 1.0", async () => {
    const result = await classifyNli(
      "TypeScript is a superset of JavaScript",
      "TypeScript extends JavaScript with static types",
    );

    const sum = result.entailment + result.contradiction + result.neutral;
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it("all probabilities are between 0 and 1", async () => {
    const result = await classifyNli(
      "The server runs on port 3000",
      "The application listens on port 8080",
    );

    for (const key of ["entailment", "contradiction", "neutral"] as const) {
      expect(result[key]).toBeGreaterThanOrEqual(0);
      expect(result[key]).toBeLessThanOrEqual(1);
    }
  });

  it("batch classification returns correct count", async () => {
    const pairs: [string, string][] = [
      ["The sky is blue", "The sky is colored blue"],
      ["Cats are mammals", "Cats are reptiles"],
      ["It rained today", "The weather was sunny all day"],
    ];

    const results = await classifyNliBatch(pairs);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toHaveProperty("entailment");
      expect(result).toHaveProperty("contradiction");
      expect(result).toHaveProperty("neutral");
      expect(result).toHaveProperty("label");
      expect(["entailment", "contradiction", "neutral"]).toContain(
        result.label,
      );
    }
  });

  it("batch results match individual classification", async () => {
    const pairs: [string, string][] = [
      ["Dogs are animals", "Dogs are living creatures"],
      ["Water boils at 100C", "Water freezes at 100C"],
    ];

    const batchResults = await classifyNliBatch(pairs);
    const individualResults: NliResult[] = [];
    for (const [premise, hypothesis] of pairs) {
      individualResults.push(await classifyNli(premise, hypothesis));
    }

    for (let i = 0; i < pairs.length; i++) {
      expect(batchResults[i].label).toBe(individualResults[i].label);
      expect(batchResults[i].entailment).toBeCloseTo(
        individualResults[i].entailment,
        4,
      );
    }
  });

  it("empty batch returns empty array", async () => {
    const results = await classifyNliBatch([]);
    expect(results).toEqual([]);
  });

  it("handles repeated initialization gracefully", async () => {
    // Calling initNli again should be a no-op
    await expect(initNli()).resolves.toBeUndefined();
    expect(getActiveNliModel()).toBeTruthy();
  });

  it("reset clears model state", () => {
    resetNli();
    expect(getActiveNliModel()).toBeNull();
  });

  it("lazy initialization works after reset", async () => {
    resetNli();
    // classifyNli should trigger re-initialization
    const result = await classifyNli(
      "The cat sat on the mat",
      "A feline was resting on a rug",
    );
    expect(result.label).toBe("entailment");
    expect(getActiveNliModel()).toBeTruthy();
  });
});
