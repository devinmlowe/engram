/**
 * W9: transient-status classifier for dream extraction noise.
 *
 * Live-DB evidence (2026-09-16): dream memories such as "Phase 6A (Adaptive
 * Chunking) for Engram is complete, adding 23 new tests" and "The current
 * date for the run is ... and the run ID is ..." were stored as durable
 * `fact`/`solution` rows at importance 0.5. The classifier is a conservative
 * regex list (no LLM). Matches are not dropped: they get the transient
 * stability tier and an importance cap so they decay quickly.
 */
import { describe, it, expect } from "vitest";
import {
  isTransientStatus,
  applyTransientPolicy,
  TRANSIENT_STATUS_PATTERNS,
} from "../../src/semantic/transient.js";
import {
  INITIAL_STABILITY,
  TRANSIENT_STABILITY,
  TRANSIENT_IMPORTANCE_CAP,
} from "../../src/semantic/types.js";

const POSITIVES: string[] = [
  "Phase 6A (Adaptive Chunking) for Engram is complete, adding 23 new tests, all passing, and a clean build.",
  "Phase 1D, 'Batch Remember', has been completed, adding 22 new tests.",
  "Task #2 (implement traverse workflow pipeline) is complete and unblocked Task #5.",
  "The Engram project's MCP server is fully operational with 5 tools loaded.",
  "The ASR server currently uses the `models/ggml-base.bin` model.",
  "The current date for the email monitoring run is 2026-08-09 and the run ID is 20260809-151205.",
  "The RLM integration project is currently in Phase 1 execution.",
  "The migration to the new schema is in progress.",
  "Engram currently has 671+ tests passing and a SRC-compliant architecture.",
  "As of 2026-08-02 the dream daemon has not been run against the new database.",
  "TODO: wire the reranker into the recall path.",
  "The nova-voice client is WIP and not yet wired to the gateway.",
  "The project version was bumped to 0.9.0 after the latency work.",
  "Gateway mode for the Nova Voice project is currently blocked due to a device identity requirement.",
  "The user's current working directory is '/Users/<user>/git/asr-server'.",
  "The sensor-node firmware is now at v1.4.0.",
];

const NEGATIVES: string[] = [
  "We decided to use SQLite with sqlite-vec for the database layer, with no ORM.",
  "The project uses ESM modules with \"type\": \"module\" in package.json and requires .js extensions in all import paths.",
  "The user's default shell is Fish and they require Fish-compatible syntax in all shell commands.",
  "Commit messages must state what changed and why, and include the plan step being executed.",
  "Every pull request must be complete with tests before requesting review.",
  "The COMPSTAT field in the EAC tool represents completion percentage on a 0-100 scale.",
  "nomic-embed-text-v1.5 requires layer_norm before Matryoshka dimension truncation.",
  "Environment variables for the nova-voice project are prefixed with NOVA_.",
  "Version bumps follow semver; breaking changes bump the major version.",
  "The user prefers working in git worktrees and commits after each meaningful unit of progress.",
  "All tests must pass before merging; the user verifies changes by running the full vitest suite.",
  "The email scanner targets Apple Mail's local SQLite database directly rather than IMAP.",
  "Row expansion for KiCad export uses a 17mm spacing along the column trendline direction.",
  "The user requires the assistant to output all results to a single markdown file using a specific format.",
  "The programmer dongle KiCad project will be kept flat, with project files directly in configurations/programmer-dongle/.",
  "Use DEVELOPER_DIR=/Library/Developer/CommandLineTools so git works without accepting the Xcode license.",
];

describe("isTransientStatus", () => {
  it.each(POSITIVES)("flags status phrasing: %s", (content) => {
    expect(isTransientStatus(content)).toBe(true);
  });

  it.each(NEGATIVES)("leaves durable knowledge alone: %s", (content) => {
    expect(isTransientStatus(content)).toBe(false);
  });

  it("has at least 8 positives and 8 negatives under test", () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(8);
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(8);
  });

  it("exposes the pattern list for inspection", () => {
    expect(TRANSIENT_STATUS_PATTERNS.length).toBeGreaterThan(5);
    for (const p of TRANSIENT_STATUS_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });

  it("handles empty and whitespace content without throwing", () => {
    expect(isTransientStatus("")).toBe(false);
    expect(isTransientStatus("   ")).toBe(false);
  });
});

describe("applyTransientPolicy", () => {
  it("caps importance and assigns the transient stability tier for status facts", () => {
    const policy = applyTransientPolicy({
      content: "Phase 6A (Adaptive Chunking) for Engram is complete, adding 23 new tests.",
      importance: 0.7,
    });
    expect(policy.transient).toBe(true);
    expect(policy.importance).toBe(TRANSIENT_IMPORTANCE_CAP);
    expect(policy.stability).toBe(TRANSIENT_STABILITY);
  });

  it("does not raise importance that is already below the cap", () => {
    const policy = applyTransientPolicy({
      content: "The migration is in progress.",
      importance: 0.1,
    });
    expect(policy.transient).toBe(true);
    expect(policy.importance).toBe(0.1);
  });

  it("leaves durable facts untouched (no stability override)", () => {
    const policy = applyTransientPolicy({
      content: "We decided to use SQLite with sqlite-vec for the database layer.",
      importance: 0.7,
    });
    expect(policy.transient).toBe(false);
    expect(policy.importance).toBe(0.7);
    expect(policy.stability).toBeUndefined();
  });

  it("transient tier decays faster than every type's initial stability", () => {
    const shortest = Math.min(...Object.values(INITIAL_STABILITY));
    expect(TRANSIENT_STABILITY).toBeLessThan(shortest);
    expect(TRANSIENT_IMPORTANCE_CAP).toBeLessThanOrEqual(0.3);
  });
});
