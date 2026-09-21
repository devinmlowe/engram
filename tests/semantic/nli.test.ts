import { describe, it, expect, beforeAll } from "vitest";
import { initNli, classifyNli } from "../../src/semantic/nli.js";

describe("NLI contradiction detection", () => {
  beforeAll(async () => {
    await initNli();
  }, 120_000);

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

  it("handles repeated initialization gracefully", async () => {
    // Calling initNli again should be a no-op
    await expect(initNli()).resolves.toBeUndefined();
  });
});
