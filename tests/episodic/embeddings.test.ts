import { describe, it, expect, beforeAll } from "vitest";
import {
  initEmbeddings,
  embedQuery,
  embedDocument,
  embedDocumentBatch,
  embedExchange,
  getActiveDimensions,
  getActiveModel,
} from "../../src/episodic/embeddings.js";
import { cosineSimilarity } from "../helpers.js";

describe("Embeddings", () => {
  beforeAll(async () => {
    await initEmbeddings();
  }, 120_000);

  it("returns 256-dimensional vectors", async () => {
    const vec = await embedQuery("test query");
    expect(vec).toHaveLength(256);
  });

  it("getActiveDimensions returns 256", () => {
    expect(getActiveDimensions()).toBe(256);
  });

  it("getActiveModel returns a valid model name", () => {
    const model = getActiveModel();
    expect(["nomic", "minilm"]).toContain(model);
  });

  it("produces L2-normalized vectors (norm ~1.0)", async () => {
    const vec = await embedQuery("normalization test");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it("embedQuery and embedDocument produce different vectors for same text", async () => {
    const text = "SQLite database indexing";
    const queryVec = await embedQuery(text);
    const docVec = await embedDocument(text);

    // They should be similar but not identical (different prefixes in nomic)
    const sim = cosineSimilarity(queryVec, docVec);
    // If using nomic, prefixes differ → similarity < 1.0
    // If using minilm, no prefixes → identical
    const model = getActiveModel();
    if (model === "nomic") {
      expect(sim).toBeLessThan(1.0);
      expect(sim).toBeGreaterThan(0.5);
    } else {
      expect(sim).toBeCloseTo(1.0, 5);
    }
  });

  it("related queries have higher similarity than unrelated", async () => {
    const vecSqlite = await embedQuery("How does SQLite WAL mode work?");
    const vecDatabase = await embedQuery("database write-ahead logging");
    const vecCooking = await embedQuery("best recipe for chocolate cake");

    const simRelated = cosineSimilarity(vecSqlite, vecDatabase);
    const simUnrelated = cosineSimilarity(vecSqlite, vecCooking);

    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it("embedExchange includes contextual metadata", async () => {
    const vecPlain = await embedDocument("How do I use vitest?");
    const vecContextual = await embedExchange(
      "How do I use vitest?",
      "Vitest is a fast test runner...",
      {
        project: "engram",
        date: "2026-02-26",
        branch: "main",
        tools: ["Read", "Write"],
      },
    );

    // Both should be 256 dims
    expect(vecPlain).toHaveLength(256);
    expect(vecContextual).toHaveLength(256);

    // Contextual embedding should differ from plain text
    const sim = cosineSimilarity(vecPlain, vecContextual);
    expect(sim).toBeLessThan(1.0);
  });

  it("embedDocumentBatch returns correct shapes", async () => {
    const texts = [
      "SQLite is a lightweight database engine",
      "TypeScript adds static types to JavaScript",
    ];
    const vectors = await embedDocumentBatch(texts);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(256);
    expect(vectors[1]).toHaveLength(256);
  });

  it("batch embedding matches individual embedding", async () => {
    const text = "How does SQLite WAL mode work?";
    const [individual] = await Promise.all([embedDocument(text)]);
    const [batchResult] = await embedDocumentBatch([text]);

    const sim = cosineSimilarity(individual, batchResult);
    expect(sim).toBeGreaterThan(0.99);
  });

  it("batch embeddings are L2-normalized", async () => {
    const texts = [
      "Rust memory safety guarantees",
      "PostgreSQL index optimization",
    ];
    const vectors = await embedDocumentBatch(texts);

    for (const vec of vectors) {
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 2);
    }
  });
});
