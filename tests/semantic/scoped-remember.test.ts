import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rememberFact, storeMemoryBatch } from "../../src/interfaces/shared/remember.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

// ─── Mock embeddings to avoid loading the real model ────────────

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedDocument: vi.fn(),
  embedDocumentBatch: vi.fn(),
  initEmbeddings: vi.fn(),
}));

import { embedDocument, embedDocumentBatch } from "../../src/_core/embeddings/index.js";

const mockedEmbedDocument = vi.mocked(embedDocument);
const mockedEmbedBatch = vi.mocked(embedDocumentBatch);

let t: TestDb;

function seededEmbedding(seed: number, dims: number = 256): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
  vi.clearAllMocks();
});

// ADR-010: Hermes writes carry a tenant scope; dedup must not collapse
// memories across scope boundaries.
describe("scope-aware write path (ADR-010)", () => {
  it("rememberFact persists the given scope", async () => {
    mockedEmbedDocument.mockResolvedValue(seededEmbedding(1));
    const res = await rememberFact(t.db, {
      content: "career interview scheduled",
      type: "fact",
      importance: 0.7,
      scope: "hermes:career",
    });
    expect(res.action).toBe("created");
    const row = t.db
      .prepare("SELECT scope FROM memories WHERE id = ?")
      .get(res.memoryId) as { scope: string };
    expect(row.scope).toBe("hermes:career");
  });

  it("dedup does NOT collapse near-duplicates across scopes", async () => {
    const emb = seededEmbedding(7);
    mockedEmbedDocument.mockResolvedValue(emb);
    const first = await rememberFact(t.db, {
      content: "the mini runs Tailscale",
      type: "fact",
      importance: 0.6,
    }); // scope: global
    const second = await rememberFact(t.db, {
      content: "the mini runs Tailscale",
      type: "fact",
      importance: 0.6,
      scope: "hermes:career",
    });
    expect(first.action).toBe("created");
    expect(second.action).toBe("created");
    expect(second.memoryId).not.toBe(first.memoryId);
  });

  it("dedup still deduplicates within the same scope", async () => {
    const emb = seededEmbedding(9);
    mockedEmbedDocument.mockResolvedValue(emb);
    const first = await rememberFact(t.db, {
      content: "prefer fish shell",
      type: "preference",
      importance: 0.6,
      scope: "hermes:career",
    });
    const second = await rememberFact(t.db, {
      content: "prefer fish shell",
      type: "preference",
      importance: 0.6,
      scope: "hermes:career",
    });
    expect(first.action).toBe("created");
    expect(second.action).toBe("updated");
    expect(second.memoryId).toBe(first.memoryId);
  });

  it("storeMemoryBatch applies a default scope to every memory", async () => {
    mockedEmbedBatch.mockResolvedValue([seededEmbedding(11), seededEmbedding(12)]);
    await storeMemoryBatch(
      t.db,
      [
        { content: "batch fact one", type: "fact" },
        { content: "batch fact two", type: "fact" },
      ],
      { scope: "hermes:finance" },
    );
    const rows = t.db
      .prepare("SELECT scope FROM memories")
      .all() as Array<{ scope: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === "hermes:finance")).toBe(true);
  });
});
