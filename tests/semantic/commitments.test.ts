/**
 * Commitments ledger — parsing, due-date resolution, dedupe, store, lifecycle, XML.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import {
  parseCommitmentsResponse,
  normalizeSubject,
  resolveDueHint,
  lexicalOverlap,
  cosineSimilarity,
  dedupeCandidates,
  insertCommitments,
  listCommitments,
  getCommitment,
  updateCommitmentStatus,
  formatCommitmentsXml,
  buildCommitmentsPrompt,
  type CommitmentCandidate,
} from "../../src/semantic/commitments.js";

const DAY = 86_400;
const idByIndex = new Map<number, string>([[0, "ex-0"], [1, "ex-1"], [2, "ex-2"]]);

function cand(over: Partial<CommitmentCandidate> = {}): CommitmentCandidate {
  return {
    content: "Send Alan the leave timeline",
    subject: "devin",
    origin: "stated",
    dueHint: null,
    sourceExchangeIds: ["ex-1"],
    ...over,
  };
}

describe("parseCommitmentsResponse", () => {
  it("accepts {commitments: [...]} and resolves exchange indexes to ids", () => {
    const out = parseCommitmentsResponse(
      { commitments: [{ content: "Send Alan the timeline", subject: "Devin", origin: "stated", due_hint: "next week", source_exchange_indexes: [1, 7] }] },
      idByIndex,
    );
    expect(out).toEqual([
      { content: "Send Alan the timeline", subject: "devin", origin: "stated", dueHint: "next week", sourceExchangeIds: ["ex-1"] },
    ]);
  });

  it("drops items with no resolvable source exchange or empty content", () => {
    const out = parseCommitmentsResponse(
      { commitments: [
        { content: "Ghost", subject: "devin", origin: "stated", source_exchange_indexes: [99] },
        { content: "  ", subject: "devin", origin: "stated", source_exchange_indexes: [1] },
        { content: "Real", subject: "alan", origin: "inferred", source_exchange_id: "ex-2" },
      ] },
      idByIndex,
    );
    expect(out.map((c) => c.content)).toEqual(["Real"]);
    expect(out[0].origin).toBe("inferred");
    expect(out[0].subject).toBe("alan");
  });

  it("tolerates a bare array, string 'null' due hints and unknown origins", () => {
    const out = parseCommitmentsResponse(
      [{ content: "x y z", subject: "HR dept", origin: "guessed", due_hint: "null", source_exchange_indexes: ["0"] }],
      idByIndex,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subject: "hr", origin: "stated", dueHint: null, sourceExchangeIds: ["ex-0"] });
  });

  it("returns [] for garbage", () => {
    expect(parseCommitmentsResponse(null, idByIndex)).toEqual([]);
    expect(parseCommitmentsResponse("nope", idByIndex)).toEqual([]);
    expect(parseCommitmentsResponse({ commitments: "not json" }, idByIndex)).toEqual([]);
  });

  it("normalizes subjects", () => {
    expect(normalizeSubject("The user")).toBe("devin");
    expect(normalizeSubject("Alan B.")).toBe("alan");
    expect(normalizeSubject(undefined)).toBe("devin");
  });
});

describe("resolveDueHint", () => {
  const base = new Date("2026-09-15T14:00:00Z"); // a Tuesday
  const day0 = Math.floor(Date.UTC(2026, 8, 15) / 1000);

  it("handles relative and absolute expressions relative to the base date", () => {
    expect(resolveDueHint(null, base)).toBeNull();
    expect(resolveDueHint("tomorrow morning", base)).toBe(day0 + DAY);
    expect(resolveDueHint("by Friday", base)).toBe(day0 + 3 * DAY);
    expect(resolveDueHint("next Tuesday", base)).toBe(day0 + 7 * DAY);
    expect(resolveDueHint("next week", base)).toBe(day0 + 7 * DAY);
    expect(resolveDueHint("in two weeks", base)).toBe(day0 + 14 * DAY);
    expect(resolveDueHint("3 days", base)).toBe(day0 + 3 * DAY);
    expect(resolveDueHint("end of the week", base)).toBe(day0 + 5 * DAY); // Sunday
    expect(resolveDueHint("end of month", base)).toBe(Math.floor(Date.UTC(2026, 8, 30) / 1000));
    expect(resolveDueHint("2026-10-01", base)).toBe(Math.floor(Date.UTC(2026, 9, 1) / 1000));
  });

  it("returns null rather than inventing a date", () => {
    expect(resolveDueHint("when the vendor API stabilizes", base)).toBeNull();
    expect(resolveDueHint("", base)).toBeNull();
  });
});

describe("similarity", () => {
  it("lexical overlap ignores stopwords and plural suffixes", () => {
    expect(lexicalOverlap("Send Alan the leave timeline", "send alan timeline for the leave")).toBe(1);
    expect(lexicalOverlap("Send Alan the timeline", "Ask Joe about budgets")).toBe(0);
    expect(lexicalOverlap("", "x")).toBe(0);
  });

  it("cosine of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
});

describe("dedupe + store + lifecycle", () => {
  let t: TestDb;
  const stamps = new Map<string, string>([["ex-0", "2026-09-01T10:00:00Z"], ["ex-1", "2026-09-10T10:00:00Z"], ["ex-2", "2026-09-12T10:00:00Z"]]);

  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it("stores candidates with due_at relative to the source exchange", () => {
    const [c] = insertCommitments(t.db, [cand({ dueHint: "tomorrow" })], stamps);
    expect(c.status).toBe("pending");
    expect(c.dueAt).toBe(Math.floor(Date.UTC(2026, 8, 11) / 1000));
    const row = t.db.prepare("SELECT source_exchanges FROM commitments WHERE id = ?").get(c.id) as { source_exchanges: string };
    expect(JSON.parse(row.source_exchanges)).toEqual(["ex-1"]);
  });

  it("dedupes lexically against pending rows, within the batch, and by same subject only", async () => {
    insertCommitments(t.db, [cand()], stamps);
    const { fresh, duplicates, lexicalOnly } = await dedupeCandidates(t.db, [
      cand({ content: "Send Alan the timeline for leave" }),          // dup of stored
      cand({ content: "Ask Joe for the budget report" }),              // fresh
      cand({ content: "Ask Joe for the budget reports" }),             // dup within batch
      cand({ content: "Send Alan the leave timeline", subject: "alan" }), // different subject → fresh
    ]);
    expect(lexicalOnly).toBe(true);
    expect(duplicates).toBe(2);
    expect(fresh.map((c) => `${c.subject}:${c.content}`)).toEqual([
      "devin:Ask Joe for the budget report",
      "alan:Send Alan the leave timeline",
    ]);
  });

  it("dedupes by embedding cosine when the wording differs", async () => {
    insertCommitments(t.db, [cand({ content: "Send Alan the leave timeline" })], stamps);
    const vecFor = (text: string) => (text.includes("Alan") ? [1, 0.02, 0] : [0, 1, 0]);
    const embed = async (texts: string[]) => texts.map(vecFor);
    const { fresh, duplicates, lexicalOnly } = await dedupeCandidates(t.db, [
      cand({ content: "Email Alan regarding the schedule for the leave" }),
      cand({ content: "Book the dentist appointment" }),
    ], { embed });
    expect(lexicalOnly).toBe(false);
    expect(duplicates).toBe(1);
    expect(fresh.map((c) => c.content)).toEqual(["Book the dentist appointment"]);
  });

  it("does not resurrect a done commitment from the same exchanges", async () => {
    const [c] = insertCommitments(t.db, [cand()], stamps);
    updateCommitmentStatus(t.db, c.id, "done");
    const { fresh, duplicates } = await dedupeCandidates(t.db, [cand()]);
    expect(fresh).toEqual([]);
    expect(duplicates).toBe(1);
  });

  it("degrades to lexical-only when embedding fails", async () => {
    const { fresh, lexicalOnly } = await dedupeCandidates(t.db, [cand()], {
      embed: async () => { throw new Error("model offline"); },
    });
    expect(lexicalOnly).toBe(true);
    expect(fresh).toHaveLength(1);
  });

  it("lists overdue first, then by due date, then undated newest first; filters by status and due window", () => {
    const now = Math.floor(Date.UTC(2026, 8, 15) / 1000);
    const ins = (content: string, dueAt: number | null, createdAt: number, status = "pending") =>
      t.db.prepare("INSERT INTO commitments (id, content, status, due_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(content, content, status, dueAt, createdAt);
    ins("undated-old", null, now - 10 * DAY);
    ins("undated-new", null, now - 1 * DAY);
    ins("due-soon", now + 2 * DAY, now - 3 * DAY);
    ins("due-later", now + 20 * DAY, now - 3 * DAY);
    ins("overdue", now - 5 * DAY, now - 30 * DAY);
    ins("done-one", null, now - 2 * DAY, "done");

    const all = listCommitments(t.db, { now });
    expect(all.total).toBe(5);
    expect(all.items.map((c) => c.id)).toEqual(["overdue", "due-soon", "due-later", "undated-new", "undated-old"]);

    const week = listCommitments(t.db, { now, dueWithinDays: 7 });
    expect(week.items.map((c) => c.id)).toEqual(["overdue", "due-soon"]);

    expect(listCommitments(t.db, { now, status: "done" }).items.map((c) => c.id)).toEqual(["done-one"]);
    expect(listCommitments(t.db, { now, status: "all" }).total).toBe(6);
    expect(listCommitments(t.db, { now, limit: 2 }).items).toHaveLength(2);
    expect(listCommitments(t.db, { now, limit: 2 }).total).toBe(5);
  });

  it("updates lifecycle status, accepts unique id prefixes, and rejects bad transitions", () => {
    const [a, b] = insertCommitments(t.db, [cand(), cand({ content: "Ask Joe for the budget" })], stamps);
    const done = updateCommitmentStatus(t.db, a.id.slice(0, 8), "done", { now: 1_800_000_000 });
    expect(done).toMatchObject({ id: a.id, status: "done", resolvedAt: 1_800_000_000 });
    expect(listCommitments(t.db).items.map((c) => c.id)).toEqual([b.id]);

    const sup = updateCommitmentStatus(t.db, b.id, "superseded", { supersededBy: a.id });
    expect(sup.supersededBy).toBe(a.id);

    expect(() => updateCommitmentStatus(t.db, b.id, "superseded")).toThrow(/superseded_by/);
    expect(() => updateCommitmentStatus(t.db, "nope-nope", "done")).toThrow(/not found/);
    expect(() => updateCommitmentStatus(t.db, a.id, "pending")).toThrow(/Invalid resolution/);
    expect(getCommitment(t.db, "zz")).toBeUndefined();
  });

  it("formats token-budgeted XML with due/overdue/sources attributes", () => {
    const now = Math.floor(Date.UTC(2026, 8, 15) / 1000);
    const items = insertCommitments(t.db, [
      cand({ content: "Send Alan the leave <timeline>", dueHint: "tomorrow" }),
      cand({ content: "Ask Joe for the budget", sourceExchangeIds: ["ex-2"] }),
    ], stamps);
    const xml = formatCommitmentsXml(listCommitments(t.db, { now }));
    expect(xml.startsWith('<engram_commitments status="pending" count="2" total="2" as_of="2026-09-15"')).toBe(true);
    expect(xml).toContain(`id="${items[0].id}"`);
    expect(xml).toContain('due="2026-09-11" overdue="true"');
    expect(xml).toContain('sources="ex-1"');
    expect(xml).toContain("Send Alan the leave &lt;timeline&gt;");
    expect(xml.endsWith("</engram_commitments>")).toBe(true);

    const tight = formatCommitmentsXml(listCommitments(t.db, { now }), { budget: 30 });
    expect(tight).toContain('count="1"');
    expect(tight).toContain('truncated="true"');
  });

  it("builds a prompt with abbreviated assistant turns and the template", () => {
    const prompt = buildCommitmentsPrompt(
      [{ id: "ex-0", index: 0, userMessage: "I'll send Alan the timeline tomorrow", assistantMessage: "x".repeat(2000) }],
      { project: "demo", dateRange: "2026-09-01 to 2026-09-02" },
    );
    expect(prompt).toContain("Commitment Extraction Specialist");
    expect(prompt).toContain("[Exchange 0]\nUser: I'll send Alan the timeline tomorrow");
    expect(prompt).toContain("…[truncated]");
    expect(prompt).toContain("Project: demo");
  });
});
