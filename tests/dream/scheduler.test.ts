import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createRun,
  completeRun,
  failRun,
  getIncompleteRun,
  isCheckpointed,
  recordCheckpoint,
  recordFailure,
  getRetryableItems,
  getCheckpointedItems,
  getUnprocessedConversations,
  prioritizeConversations,
  computeConversationFingerprint,
  getLatestExtractFingerprints,
} from "../../src/dream/scheduler.js";
import { createTestDb } from "../helpers.js";
import { insertConversation, insertExchange, insertMemory } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { DreamReport } from "../../src/dream/types.js";

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────

function makeDreamReport(overrides: Partial<DreamReport> = {}): DreamReport {
  return {
    startedAt: Math.floor(Date.now() / 1000) - 60,
    completedAt: Math.floor(Date.now() / 1000),
    phases: [
      { phase: "ingest", itemsProcessed: 5, errors: 0, durationMs: 100 },
      { phase: "extract", itemsProcessed: 3, errors: 1, durationMs: 500 },
    ],
    newMemories: 10,
    updatedMemories: 2,
    newEntities: 5,
    newRelationships: 8,
    conflictsDetected: 1,
    memoriesPruned: 3,
    ...overrides,
  };
}

// ─── Run Lifecycle ──────────────────────────────────────────────

describe("Run Lifecycle", () => {
  describe("createRun", () => {
    it("returns a valid UUID", () => {
      const id = createRun(t.db);

      // UUID v4 format: 8-4-4-4-12 hex chars
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("creates a record in dream_runs table", () => {
      const id = createRun(t.db);

      const row = t.db
        .prepare("SELECT * FROM dream_runs WHERE id = ?")
        .get(id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.id).toBe(id);
      expect(row.started_at).toBeTypeOf("number");
      expect(row.started_at).toBeGreaterThan(0);
      expect(row.completed_at).toBeNull();
      expect(row.error).toBeNull();
    });

    it("creates unique IDs for each run", () => {
      const id1 = createRun(t.db);
      const id2 = createRun(t.db);

      expect(id1).not.toBe(id2);
    });
  });

  describe("completeRun", () => {
    it("updates all stat fields from the report", () => {
      const runId = createRun(t.db);
      const report = makeDreamReport();

      completeRun(t.db, runId, report);

      const row = t.db
        .prepare("SELECT * FROM dream_runs WHERE id = ?")
        .get(runId) as Record<string, unknown>;

      expect(row.completed_at).toBe(report.completedAt);
      expect(row.new_memories).toBe(10);
      expect(row.updated_memories).toBe(2);
      expect(row.new_entities).toBe(5);
      expect(row.new_relationships).toBe(8);
      expect(row.conflicts_detected).toBe(1);
      expect(row.memories_pruned).toBe(3);
    });

    it("stores phases_completed as JSON array", () => {
      const runId = createRun(t.db);
      const report = makeDreamReport();

      completeRun(t.db, runId, report);

      const row = t.db
        .prepare("SELECT phases_completed FROM dream_runs WHERE id = ?")
        .get(runId) as { phases_completed: string };

      const phases = JSON.parse(row.phases_completed);
      expect(phases).toEqual(["ingest", "extract"]);
    });

    it("marks the run as no longer incomplete", () => {
      const runId = createRun(t.db);

      // Before completion, run is incomplete
      expect(getIncompleteRun(t.db)).not.toBeNull();

      completeRun(t.db, runId, makeDreamReport());

      // After completion, no incomplete runs
      expect(getIncompleteRun(t.db)).toBeNull();
    });
  });

  describe("failRun", () => {
    it("records the error message", () => {
      const runId = createRun(t.db);

      failRun(t.db, runId, "Ollama connection timed out");

      const row = t.db
        .prepare("SELECT * FROM dream_runs WHERE id = ?")
        .get(runId) as Record<string, unknown>;

      expect(row.error).toBe("Ollama connection timed out");
      expect(row.completed_at).toBeTypeOf("number");
      expect(row.completed_at).toBeGreaterThan(0);
    });

    it("marks the run as no longer incomplete", () => {
      const runId = createRun(t.db);

      expect(getIncompleteRun(t.db)).not.toBeNull();

      failRun(t.db, runId, "fatal error");

      expect(getIncompleteRun(t.db)).toBeNull();
    });
  });

  describe("getIncompleteRun", () => {
    it("returns null when no runs exist", () => {
      expect(getIncompleteRun(t.db)).toBeNull();
    });

    it("returns null when all runs are complete", () => {
      const runId = createRun(t.db);
      completeRun(t.db, runId, makeDreamReport());

      expect(getIncompleteRun(t.db)).toBeNull();
    });

    it("returns the incomplete run with empty phases when none recorded", () => {
      const runId = createRun(t.db);

      const result = getIncompleteRun(t.db);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(runId);
      expect(result!.phasesCompleted).toEqual([]);
    });

    it("returns the most recent incomplete run when multiple exist", () => {
      // Insert runs with explicit timestamps to avoid same-second races
      const firstId = "run-first";
      const secondId = "run-second";
      t.db
        .prepare("INSERT INTO dream_runs (id, started_at) VALUES (?, ?)")
        .run(firstId, 1000);
      t.db
        .prepare("INSERT INTO dream_runs (id, started_at) VALUES (?, ?)")
        .run(secondId, 2000);

      const result = getIncompleteRun(t.db);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(secondId);
    });

    it("skips completed runs and returns incomplete one", () => {
      const completedRunId = createRun(t.db);
      completeRun(t.db, completedRunId, makeDreamReport());

      const incompleteRunId = createRun(t.db);

      const result = getIncompleteRun(t.db);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(incompleteRunId);
    });

    it("returns phases_completed when partially set", () => {
      const runId = createRun(t.db);

      // Manually set phases_completed to simulate partial progress
      t.db
        .prepare("UPDATE dream_runs SET phases_completed = ? WHERE id = ?")
        .run(JSON.stringify(["ingest", "extract"]), runId);

      const result = getIncompleteRun(t.db);
      expect(result).not.toBeNull();
      expect(result!.phasesCompleted).toEqual(["ingest", "extract"]);
    });
  });
});

// ─── Checkpointing ──────────────────────────────────────────────

describe("Checkpointing", () => {
  describe("recordCheckpoint and isCheckpointed", () => {
    it("records a checkpoint and confirms it exists", () => {
      const runId = createRun(t.db);

      expect(isCheckpointed(t.db, runId, "extract", "conv-001")).toBe(false);

      recordCheckpoint(t.db, runId, "extract", "conv-001");

      expect(isCheckpointed(t.db, runId, "extract", "conv-001")).toBe(true);
    });

    it("does not cross-contaminate between phases", () => {
      const runId = createRun(t.db);

      recordCheckpoint(t.db, runId, "extract", "conv-001");

      expect(isCheckpointed(t.db, runId, "extract", "conv-001")).toBe(true);
      expect(isCheckpointed(t.db, runId, "consolidate", "conv-001")).toBe(false);
    });

    it("does not cross-contaminate between runs", () => {
      const runId1 = createRun(t.db);
      const runId2 = createRun(t.db);

      recordCheckpoint(t.db, runId1, "extract", "conv-001");

      expect(isCheckpointed(t.db, runId1, "extract", "conv-001")).toBe(true);
      expect(isCheckpointed(t.db, runId2, "extract", "conv-001")).toBe(false);
    });
  });

  describe("checkpoint idempotency", () => {
    it("inserting the same checkpoint twice does not error", () => {
      const runId = createRun(t.db);

      recordCheckpoint(t.db, runId, "extract", "conv-001");
      // Second insert should be silently ignored, not throw
      expect(() => {
        recordCheckpoint(t.db, runId, "extract", "conv-001");
      }).not.toThrow();

      expect(isCheckpointed(t.db, runId, "extract", "conv-001")).toBe(true);
    });

    it("does not create duplicate rows", () => {
      const runId = createRun(t.db);

      recordCheckpoint(t.db, runId, "extract", "conv-001");
      recordCheckpoint(t.db, runId, "extract", "conv-001");
      recordCheckpoint(t.db, runId, "extract", "conv-001");

      const count = t.db
        .prepare(
          "SELECT COUNT(*) as count FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND item_id = ?",
        )
        .get(runId, "extract", "conv-001") as { count: number };

      expect(count.count).toBe(1);
    });
  });

  describe("getCheckpointedItems", () => {
    it("returns empty set when no checkpoints exist", () => {
      const runId = createRun(t.db);
      const items = getCheckpointedItems(t.db, runId, "extract");

      expect(items).toBeInstanceOf(Set);
      expect(items.size).toBe(0);
    });

    it("returns all checkpointed items for a phase", () => {
      const runId = createRun(t.db);

      recordCheckpoint(t.db, runId, "extract", "conv-001");
      recordCheckpoint(t.db, runId, "extract", "conv-002");
      recordCheckpoint(t.db, runId, "extract", "conv-003");

      const items = getCheckpointedItems(t.db, runId, "extract");

      expect(items.size).toBe(3);
      expect(items.has("conv-001")).toBe(true);
      expect(items.has("conv-002")).toBe(true);
      expect(items.has("conv-003")).toBe(true);
    });

    it("only returns items for the specified phase", () => {
      const runId = createRun(t.db);

      recordCheckpoint(t.db, runId, "extract", "conv-001");
      recordCheckpoint(t.db, runId, "consolidate", "mem-001");

      const extractItems = getCheckpointedItems(t.db, runId, "extract");
      const consolidateItems = getCheckpointedItems(t.db, runId, "consolidate");

      expect(extractItems.size).toBe(1);
      expect(extractItems.has("conv-001")).toBe(true);
      expect(consolidateItems.size).toBe(1);
      expect(consolidateItems.has("mem-001")).toBe(true);
    });
  });
});

// ─── Work Queue ─────────────────────────────────────────────────

describe("Work Queue", () => {
  describe("getUnprocessedConversations", () => {
    it("returns all conversations when none are checkpointed", () => {
      const runId = createRun(t.db);
      insertConversation(t.db, "conv-001");
      insertConversation(t.db, "conv-002");
      insertConversation(t.db, "conv-003");

      const unprocessed = getUnprocessedConversations(t.db, runId);

      expect(unprocessed).toHaveLength(3);
      expect(unprocessed).toContain("conv-001");
      expect(unprocessed).toContain("conv-002");
      expect(unprocessed).toContain("conv-003");
    });

    it("excludes conversations that have been checkpointed", () => {
      const runId = createRun(t.db);
      insertConversation(t.db, "conv-001");
      insertConversation(t.db, "conv-002");
      insertConversation(t.db, "conv-003");

      recordCheckpoint(t.db, runId, "extract", "conv-001");
      recordCheckpoint(t.db, runId, "extract", "conv-002");

      const unprocessed = getUnprocessedConversations(t.db, runId);

      expect(unprocessed).toHaveLength(1);
      expect(unprocessed).toContain("conv-003");
      expect(unprocessed).not.toContain("conv-001");
      expect(unprocessed).not.toContain("conv-002");
    });

    it("returns empty array when all conversations are checkpointed", () => {
      const runId = createRun(t.db);
      insertConversation(t.db, "conv-001");
      insertConversation(t.db, "conv-002");

      recordCheckpoint(t.db, runId, "extract", "conv-001");
      recordCheckpoint(t.db, runId, "extract", "conv-002");

      const unprocessed = getUnprocessedConversations(t.db, runId);
      expect(unprocessed).toHaveLength(0);
    });

    it("returns empty array when no conversations exist", () => {
      const runId = createRun(t.db);
      const unprocessed = getUnprocessedConversations(t.db, runId);
      expect(unprocessed).toHaveLength(0);
    });

    it("only considers checkpoints for the given run", () => {
      const runId1 = createRun(t.db);
      const runId2 = createRun(t.db);
      insertConversation(t.db, "conv-001");

      recordCheckpoint(t.db, runId1, "extract", "conv-001");

      // conv-001 is checkpointed for run1 but not run2
      const unprocessedRun1 = getUnprocessedConversations(t.db, runId1);
      const unprocessedRun2 = getUnprocessedConversations(t.db, runId2);

      expect(unprocessedRun1).toHaveLength(0);
      expect(unprocessedRun2).toHaveLength(1);
      expect(unprocessedRun2).toContain("conv-001");
    });
  });

  describe("prioritizeConversations", () => {
    it("returns empty array for empty input", () => {
      const result = prioritizeConversations(t.db, []);
      expect(result).toEqual([]);
    });

    it("sorts by last_indexed descending (newest first)", () => {
      insertConversation(t.db, "conv-old", { lastIndexed: 1000 });
      insertConversation(t.db, "conv-mid", { lastIndexed: 2000 });
      insertConversation(t.db, "conv-new", { lastIndexed: 3000 });

      const result = prioritizeConversations(t.db, [
        "conv-old",
        "conv-mid",
        "conv-new",
      ]);

      expect(result).toEqual(["conv-new", "conv-mid", "conv-old"]);
    });

    it("sorts by exchange_count when last_indexed is equal", () => {
      insertConversation(t.db, "conv-small", {
        lastIndexed: 1000,
        exchangeCount: 5,
      });
      insertConversation(t.db, "conv-large", {
        lastIndexed: 1000,
        exchangeCount: 50,
      });

      const result = prioritizeConversations(t.db, [
        "conv-small",
        "conv-large",
      ]);

      expect(result).toEqual(["conv-large", "conv-small"]);
    });

    it("handles conversations with null last_indexed", () => {
      insertConversation(t.db, "conv-null", { lastIndexed: undefined });
      insertConversation(t.db, "conv-indexed", { lastIndexed: 1000 });

      const result = prioritizeConversations(t.db, [
        "conv-null",
        "conv-indexed",
      ]);

      // The indexed conversation should come first (COALESCE null to 0)
      expect(result[0]).toBe("conv-indexed");
    });

    it("only returns IDs that exist in the database", () => {
      insertConversation(t.db, "conv-exists");

      const result = prioritizeConversations(t.db, [
        "conv-exists",
        "conv-ghost",
      ]);

      expect(result).toEqual(["conv-exists"]);
    });
  });
});

// ─── Resume Scenario ────────────────────────────────────────────

describe("Resume after crash", () => {
  it("processes only unfinished work after resuming an incomplete run", () => {
    // Simulate: start a run, checkpoint 2 of 3 conversations, then "crash"
    const runId = createRun(t.db);
    insertConversation(t.db, "conv-001", { lastIndexed: 1000 });
    insertConversation(t.db, "conv-002", { lastIndexed: 2000 });
    insertConversation(t.db, "conv-003", { lastIndexed: 3000 });

    // Process first two
    recordCheckpoint(t.db, runId, "extract", "conv-001");
    recordCheckpoint(t.db, runId, "extract", "conv-002");

    // "Crash" — now resume
    const incomplete = getIncompleteRun(t.db);
    expect(incomplete).not.toBeNull();
    expect(incomplete!.id).toBe(runId);

    // Get remaining work
    const remaining = getUnprocessedConversations(t.db, incomplete!.id);
    expect(remaining).toEqual(["conv-003"]);

    // Verify the checkpointed items match what was already processed
    const checkpointed = getCheckpointedItems(t.db, incomplete!.id, "extract");
    expect(checkpointed.has("conv-001")).toBe(true);
    expect(checkpointed.has("conv-002")).toBe(true);
    expect(checkpointed.has("conv-003")).toBe(false);
  });

  it("returns no incomplete run after the run is completed", () => {
    const runId = createRun(t.db);
    insertConversation(t.db, "conv-001");

    recordCheckpoint(t.db, runId, "extract", "conv-001");
    completeRun(t.db, runId, makeDreamReport());

    expect(getIncompleteRun(t.db)).toBeNull();
  });
});

// ─── W12: conversation fingerprints on extract checkpoints ──────

describe("computeConversationFingerprint / getLatestExtractFingerprints (W12)", () => {
  it("is a deterministic sha256 hex digest, distinct per conversation", () => {
    insertConversation(t.db, "conv-fp-a");
    insertExchange(t.db, "a-1", "conv-fp-a", { index: 1 });
    insertExchange(t.db, "a-0", "conv-fp-a", { index: 0 });
    const first = computeConversationFingerprint(t.db, "conv-fp-a");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(computeConversationFingerprint(t.db, "conv-fp-a")).toBe(first);

    insertConversation(t.db, "conv-fp-b");
    insertExchange(t.db, "b-0", "conv-fp-b", { index: 0 });
    expect(computeConversationFingerprint(t.db, "conv-fp-b")).not.toBe(first);
    // a conversation with no exchanges still fingerprints (stable empty digest)
    insertConversation(t.db, "conv-fp-empty");
    expect(computeConversationFingerprint(t.db, "conv-fp-empty")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when an exchange is edited or added", () => {
    insertConversation(t.db, "conv-fp-c");
    insertExchange(t.db, "c-0", "conv-fp-c", { index: 0 });
    const before = computeConversationFingerprint(t.db, "conv-fp-c");

    t.db.prepare("UPDATE exchanges SET assistant_message = 'edited, and longer' WHERE id = 'c-0'").run();
    const edited = computeConversationFingerprint(t.db, "conv-fp-c");
    expect(edited).not.toBe(before);

    insertExchange(t.db, "c-1", "conv-fp-c", { index: 1 });
    expect(computeConversationFingerprint(t.db, "conv-fp-c")).not.toBe(edited);
  });

  it("changes on a same-length in-place edit and is stable when nothing changed (#23)", () => {
    insertConversation(t.db, "conv-fp-d");
    insertExchange(t.db, "d-0", "conv-fp-d", { index: 0, assistantMessage: "abc" });
    const before = computeConversationFingerprint(t.db, "conv-fp-d");
    expect(computeConversationFingerprint(t.db, "conv-fp-d")).toBe(before);

    t.db.prepare("UPDATE exchanges SET assistant_message = 'cba' WHERE id = 'd-0'").run();
    expect(computeConversationFingerprint(t.db, "conv-fp-d")).not.toBe(before);

    // Field boundaries are length-prefixed: moving text across the
    // user/assistant boundary is a change even though the concatenation is not.
    t.db.prepare("UPDATE exchanges SET user_message = 'User 0c', assistant_message = 'ba' WHERE id = 'd-0'").run();
    const shifted = computeConversationFingerprint(t.db, "conv-fp-d");
    t.db.prepare("UPDATE exchanges SET user_message = 'User 0', assistant_message = 'cba' WHERE id = 'd-0'").run();
    expect(computeConversationFingerprint(t.db, "conv-fp-d")).not.toBe(shifted);
  });

  it("recordCheckpoint stores the fingerprint and the latest one per conversation wins", () => {
    const run1 = createRun(t.db);
    recordCheckpoint(t.db, run1, "extract", "conv-x", { fingerprint: "fp-old" });
    recordCheckpoint(t.db, run1, "extract", "conv-legacy");
    const run2 = createRun(t.db);
    recordCheckpoint(t.db, run2, "extract", "conv-x", { fingerprint: "fp-new" });
    recordFailure(t.db, run2, "extract", "conv-y", { errorClass: "transient" });

    const latest = getLatestExtractFingerprints(t.db);
    expect(latest.get("conv-x")).toBe("fp-new");
    expect(latest.has("conv-legacy")).toBe(true);
    expect(latest.get("conv-legacy")).toBeNull();
    expect(latest.has("conv-y")).toBe(false);
  });
});
