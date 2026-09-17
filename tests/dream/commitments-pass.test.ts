/**
 * Dream commitments pass — selection, checkpointing, dedupe on re-run,
 * error isolation, and the no-provider skip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { createRun } from "../../src/dream/scheduler.js";
import {
  runCommitmentsPass,
  selectConversationsForCommitments,
  extractCommitmentsForConversation,
  maxConversationsFromEnv,
} from "../../src/dream/commitments-pass.js";
import type { CommitmentsLlm } from "../../src/semantic/commitments.js";

function seedConversation(t: TestDb, id: string, lastIndexed: number, userMessages: string[]): void {
  t.db.prepare(
    "INSERT INTO conversations (id, project, exchange_count, last_indexed) VALUES (?, 'demo', ?, ?)",
  ).run(id, userMessages.length, lastIndexed);
  const stmt = t.db.prepare(
    `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index)
     VALUES (?, ?, 'demo', ?, ?, 'ok', ?)`,
  );
  userMessages.forEach((m, i) =>
    stmt.run(`${id}-ex-${i}`, id, `2026-09-1${i}T10:00:00Z`, m, i),
  );
}

const llmSayingAlan: CommitmentsLlm = async (prompt) => {
  const hit = /I'll send Alan/.test(prompt);
  return {
    model: "stub-model",
    raw: {
      commitments: hit
        ? [{ content: "Send Alan the leave timeline", subject: "devin", origin: "stated", due_hint: "tomorrow", source_exchange_indexes: [1] }]
        : [],
    },
  };
};

describe("commitments pass", () => {
  let t: TestDb;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    t = createTestDb();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ENGRAM_LOCAL_MODEL;
    delete process.env.ENGRAM_COMMITMENTS_MAX_CONVERSATIONS;
    // Isolate from a developer's live Ollama: the pass probes it when no
    // cloud provider is configured and no LLM is injected
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
  });

  afterEach(() => {
    t.cleanup();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  it("skips entirely (no throw, nothing written) when no provider is configured", async () => {
    seedConversation(t, "c1", 100, ["hello there, this is long enough to scan", "I'll send Alan the timeline tomorrow"]);
    const logs: string[] = [];
    const r = await runCommitmentsPass(t.db, t.config, { log: (m) => logs.push(m) });
    expect(r.disabledReason).toMatch(/no extraction provider/);
    expect(r.conversations).toBe(0);
    expect(logs[0]).toMatch(/skipped/);
    expect(t.db.prepare("SELECT count(*) AS n FROM commitments").get()).toEqual({ n: 0 });
  });

  it("extracts, checkpoints across runs, and a re-run adds no duplicates", async () => {
    seedConversation(t, "c1", 100, ["setting things up for the week ahead", "I'll send Alan the timeline tomorrow"]);
    seedConversation(t, "c2", 90, ["nothing to see here, just a plain chat about the weather"]);
    seedConversation(t, "tiny", 80, ["ok"]); // below the trivial threshold → skipped but checkpointed

    expect(selectConversationsForCommitments(t.db, 10)).toEqual(["c1", "c2", "tiny"]);

    const run1 = createRun(t.db);
    const r1 = await runCommitmentsPass(t.db, t.config, { runId: run1, callLlm: llmSayingAlan });
    expect(r1).toMatchObject({ conversations: 3, skipped: 1, candidates: 1, inserted: 1, duplicates: 0, errors: 0, model: "stub-model" });
    expect(r1.items[0]).toMatchObject({ content: "Send Alan the leave timeline", subject: "devin", sourceExchanges: ["c1-ex-1"] });
    // due "tomorrow" relative to the exchange timestamp 2026-09-11 → 2026-09-12
    expect(r1.items[0].dueAt).toBe(Math.floor(Date.UTC(2026, 8, 12) / 1000));

    const ckpts = t.db.prepare("SELECT item_id FROM dream_checkpoints WHERE phase = 'commitments' AND status = 'success' ORDER BY item_id").all();
    expect(ckpts).toEqual([{ item_id: "c1" }, { item_id: "c2" }, { item_id: "tiny" }]);

    // Nothing new → next run selects nothing
    expect(selectConversationsForCommitments(t.db, 10)).toEqual([]);
    const run2 = createRun(t.db);
    const r2 = await runCommitmentsPass(t.db, t.config, { runId: run2, callLlm: llmSayingAlan });
    expect(r2.conversations).toBe(0);

    // A grown conversation is rescanned; the same commitment is deduped, not duplicated
    t.db.prepare("UPDATE conversations SET last_indexed = ? WHERE id = 'c1'").run(Math.floor(Date.now() / 1000) + 10);
    expect(selectConversationsForCommitments(t.db, 10)).toEqual(["c1"]);
    const r3 = await runCommitmentsPass(t.db, t.config, { runId: run2, callLlm: llmSayingAlan });
    expect(r3).toMatchObject({ conversations: 1, candidates: 1, inserted: 0, duplicates: 1 });
    expect(t.db.prepare("SELECT count(*) AS n FROM commitments").get()).toEqual({ n: 1 });
  });

  it("manual re-scan of one conversation never checkpoints and dedupes", async () => {
    seedConversation(t, "c1", 100, ["warm-up message that is long enough", "I'll send Alan the timeline tomorrow"]);
    const a = await extractCommitmentsForConversation(t.db, "c1", { callLlm: llmSayingAlan });
    const b = await extractCommitmentsForConversation(t.db, "c1", { callLlm: llmSayingAlan });
    expect(a).toMatchObject({ candidates: 1, inserted: 1, duplicates: 0 });
    expect(b).toMatchObject({ candidates: 1, inserted: 0, duplicates: 1 });
    expect(t.db.prepare("SELECT count(*) AS n FROM dream_checkpoints").get()).toEqual({ n: 0 });
  });

  it("rejects LLM candidates whose source text carries no first-person cue", async () => {
    seedConversation(t, "spec", 100, ["Read the spec and execute it: (1) add the migration; (2) build the pass; (3) restart the agent"]);
    const eager: CommitmentsLlm = async () => ({
      model: "stub",
      raw: { commitments: [{ content: "Add the migration", subject: "devin", origin: "stated", due_hint: null, source_exchange_indexes: [0] }] },
    });
    const r = await runCommitmentsPass(t.db, t.config, { callLlm: eager });
    expect(r).toMatchObject({ conversations: 1, candidates: 1, rejected: 1, inserted: 0 });
  });

  it("isolates per-conversation LLM failures and records them", async () => {
    seedConversation(t, "bad", 100, ["this conversation will blow up in the model for sure"]);
    seedConversation(t, "good", 90, ["another one here", "I'll send Alan the timeline tomorrow"]);
    const flaky: CommitmentsLlm = async (prompt) => {
      if (/blow up/.test(prompt)) throw new Error("OpenRouter API error 401: User not found.");
      return llmSayingAlan(prompt);
    };
    const runId = createRun(t.db);
    const r = await runCommitmentsPass(t.db, t.config, { runId, callLlm: flaky });
    expect(r).toMatchObject({ conversations: 1, inserted: 1, errors: 1 });
    const failure = t.db.prepare("SELECT item_id, status, error_class FROM dream_checkpoints WHERE phase = 'commitments' AND status = 'error'").get();
    expect(failure).toEqual({ item_id: "bad", status: "error", error_class: "permanent" });
  });

  it("honours the per-run cap and env override", async () => {
    for (let i = 0; i < 5; i++) seedConversation(t, `c${i}`, 100 - i, ["a message that is comfortably long enough to scan"]);
    expect(selectConversationsForCommitments(t.db, 2)).toEqual(["c0", "c1"]);
    expect(maxConversationsFromEnv({})).toBe(60);
    expect(maxConversationsFromEnv({ ENGRAM_COMMITMENTS_MAX_CONVERSATIONS: "7" })).toBe(7);
    expect(maxConversationsFromEnv({ ENGRAM_COMMITMENTS_MAX_CONVERSATIONS: "junk" })).toBe(60);
    const r = await runCommitmentsPass(t.db, t.config, { callLlm: llmSayingAlan, maxConversations: 2 });
    expect(r.conversations).toBe(2);
  });
});
