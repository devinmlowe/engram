/**
 * Contract: Chunking Backward Compatibility
 *
 * Ensures chunkConversation() maintains its existing behavior after
 * the adaptive chunker is added alongside it.
 */

import { describe, it, expect } from "vitest";
import { chunkConversation } from "../../src/_core/search/text.js";
import type { ConversationExchange } from "../../src/semantic/extractor.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeExchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    userMessage: `User message ${i}`,
    assistantMessage: `Assistant response ${i}`,
  }));
}

// ─── Contract Tests ─────────────────────────────────────────────

describe("chunkConversation backward compatibility", () => {
  it("chunkConversation signature unchanged (accepts array, chunkSize, overlap)", () => {
    const exchanges = makeExchanges(10);
    // Should accept these three args and return T[][]
    const result = chunkConversation(exchanges, 25, 5);
    expect(Array.isArray(result)).toBe(true);
    expect(Array.isArray(result[0])).toBe(true);
  });

  it("chunkConversation(100 exchanges) returns single chunk", () => {
    const exchanges = makeExchanges(100);
    const chunks = chunkConversation(exchanges);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(100);
    // Must be same reference (no unnecessary copy)
    expect(chunks[0]).toBe(exchanges);
  });

  it("chunkConversation(50 exchanges, 25, 5) returns single chunk (under maxTurns)", () => {
    const exchanges = makeExchanges(50);
    const chunks = chunkConversation(exchanges, 25, 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(50);
  });

  it("chunkConversation(110 exchanges, 25, 5) produces deterministic chunking", () => {
    const exchanges = makeExchanges(110);
    const chunks = chunkConversation(exchanges, 25, 5);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk max 25 items
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(25);
      expect(chunk.length).toBeGreaterThan(0);
    }

    // All exchanges covered
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (const ex of chunk) {
        covered.add(ex.index);
      }
    }
    for (let i = 0; i < 110; i++) {
      expect(covered.has(i)).toBe(true);
    }

    // Running again with same input produces identical output
    const chunks2 = chunkConversation(exchanges, 25, 5);
    expect(chunks2.length).toBe(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks2[i].length).toBe(chunks[i].length);
      expect(chunks2[i][0].index).toBe(chunks[i][0].index);
    }
  });

  it("default parameters are 25 chunk size and 5 overlap", () => {
    // 110 exchanges with default params should behave identically to explicit 25, 5
    const exchanges = makeExchanges(110);
    const defaultChunks = chunkConversation(exchanges);
    const explicitChunks = chunkConversation(exchanges, 25, 5);

    expect(defaultChunks.length).toBe(explicitChunks.length);
    for (let i = 0; i < defaultChunks.length; i++) {
      expect(defaultChunks[i].length).toBe(explicitChunks[i].length);
    }
  });
});
