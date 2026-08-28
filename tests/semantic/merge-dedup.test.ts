import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rememberFact } from "../../src/interfaces/shared/remember.js";
import { createTestDb, type TestDb } from "../helpers.js";

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedDocument: vi.fn(),
  embedDocumentBatch: vi.fn(),
  initEmbeddings: vi.fn(),
}));

vi.mock("../../src/_core/llm/index.js", () => ({
  generateStructured: vi.fn(),
}));

import { embedDocument } from "../../src/_core/embeddings/index.js";
import { generateStructured } from "../../src/_core/llm/index.js";
import type { IntelligenceConfig } from "../../src/_core/llm/index.js";

const mockedEmbed = vi.mocked(embedDocument);
const mockedLlm = vi.mocked(generateStructured);

const FAKE_INTELLIGENCE: IntelligenceConfig = {
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "test",
  apiModel: "test",
  apiFallbackModel: "test",
  timeoutMs: 1000,
};

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

// ADR-010: at >=0.95 similarity, differing content must be MERGED via the
// LLM tier instead of silently discarded.
describe("LLM-merge dedup (ADR-010)", () => {
  it("merges differing near-duplicate content into the existing memory", async () => {
    mockedEmbed.mockResolvedValue(seededEmbedding(5));
    const first = await rememberFact(t.db, {
      content: "Deploy uses launchd",
      type: "fact",
      importance: 0.6,
    });
    mockedLlm.mockResolvedValue({
      result: { merged: "Deploy uses launchd with a 02:00 daily schedule" },
      source: "local",
      model: "test",
      durationMs: 5,
    });
    const second = await rememberFact(
      t.db,
      { content: "Deploy runs daily at 02:00", type: "fact", importance: 0.6 },
      { intelligence: FAKE_INTELLIGENCE },
    );
    expect(second.action).toBe("merged");
    expect(second.memoryId).toBe(first.memoryId);
    const row = t.db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .get(first.memoryId) as { content: string };
    expect(row.content).toBe("Deploy uses launchd with a 02:00 daily schedule");
    const count = t.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("identical content skips the LLM and just records access", async () => {
    mockedEmbed.mockResolvedValue(seededEmbedding(6));
    await rememberFact(t.db, { content: "Fish is the shell", type: "fact", importance: 0.5 });
    const second = await rememberFact(
      t.db,
      { content: "  fish is the shell ", type: "fact", importance: 0.5 },
      { intelligence: FAKE_INTELLIGENCE },
    );
    expect(second.action).toBe("updated");
    expect(mockedLlm).not.toHaveBeenCalled();
  });

  it("falls back to plain dedup when the LLM tier fails", async () => {
    mockedEmbed.mockResolvedValue(seededEmbedding(8));
    const first = await rememberFact(t.db, {
      content: "Caddy fronts local services",
      type: "fact",
      importance: 0.5,
    });
    mockedLlm.mockRejectedValue(new Error("all tiers down"));
    const second = await rememberFact(
      t.db,
      { content: "Local services sit behind Caddy", type: "fact", importance: 0.5 },
      { intelligence: FAKE_INTELLIGENCE },
    );
    expect(second.action).toBe("updated");
    const row = t.db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .get(first.memoryId) as { content: string };
    expect(row.content).toBe("Caddy fronts local services");
  });

  it("without an intelligence config, behavior is unchanged (no merge)", async () => {
    mockedEmbed.mockResolvedValue(seededEmbedding(10));
    await rememberFact(t.db, { content: "engram DB is SQLite", type: "fact", importance: 0.5 });
    const second = await rememberFact(t.db, {
      content: "The engram database uses SQLite",
      type: "fact",
      importance: 0.5,
    });
    expect(second.action).toBe("updated");
    expect(mockedLlm).not.toHaveBeenCalled();
  });
});
