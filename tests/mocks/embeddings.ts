/**
 * Deterministic stand-in for `src/_core/embeddings` (#126). Register it as
 *
 *   vi.mock("../../src/_core/embeddings/index.js", async () =>
 *     (await import("../mocks/embeddings.js")).deterministicEmbeddings());
 *
 * Every embedding is a unit vector hashed from its text, so the same text
 * always embeds identically (a query for a stored text finds it) and
 * different texts land far apart. No model is downloaded or loaded.
 */

import { vi } from "vitest";

export const DIMS = 256;

/** Unit-norm vector derived from a string hash; identical seeds give identical vectors. */
export function deterministicVector(seed: string, dims: number = DIMS): number[] {
  const vec = new Array<number>(dims);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < dims; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    vec[i] = (hash & 0xffff) / 0xffff - 0.5;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  return vec.map((x) => x / norm);
}

/** The mocked module: `embedDocument(text)` and `embedQuery(text)` both return `deterministicVector("doc:" + text)`. */
export function deterministicEmbeddings() {
  const doc = (text: string) => Promise.resolve(deterministicVector(`doc:${text}`));
  return {
    initEmbeddings: vi.fn(async () => undefined),
    embedQuery: vi.fn(doc),
    embedDocument: vi.fn(doc),
    embedDocumentBatch: vi.fn((texts: string[]) => Promise.all(texts.map(doc))),
    embedExchange: vi.fn((userMessage: string, assistantMessage: string) =>
      Promise.resolve(deterministicVector(`ex:${userMessage}|${assistantMessage}`)),
    ),
    getActiveModel: vi.fn(() => "mock-model"),
    resetEmbeddings: vi.fn(),
  };
}
