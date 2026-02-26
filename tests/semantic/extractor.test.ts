import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chunkConversation,
  buildExtractionPrompt,
  parseExtractionResponse,
  extractFromConversation,
  resetExtractor,
  setClient,
  type ConversationExchange,
  type ConversationMetadata,
} from "../../src/semantic/extractor.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeExchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    userMessage: `User message ${i}`,
    assistantMessage: `Assistant response ${i}`,
  }));
}

const defaultMetadata: ConversationMetadata = {
  project: "test-project",
  branch: "main",
  dateRange: "2026-02-01 to 2026-02-26",
};

// ─── chunkConversation() ────────────────────────────────────────

describe("chunkConversation", () => {
  it("returns single chunk for conversations under maxTurns (100)", () => {
    const exchanges = makeExchanges(50);
    const chunks = chunkConversation(exchanges);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[0]).toBe(exchanges); // same reference — no copy needed
  });

  it("returns single chunk for exactly 100 exchanges", () => {
    const exchanges = makeExchanges(100);
    const chunks = chunkConversation(exchanges);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(100);
  });

  it("splits conversations exceeding 100 exchanges with correct overlap", () => {
    const exchanges = makeExchanges(110);
    const chunks = chunkConversation(exchanges, 25, 5);

    // 110 exchanges, chunk size 25, step 20 (25-5):
    // chunk 0: [0..24] (25 items)
    // chunk 1: [20..44] (25 items)
    // chunk 2: [40..64] (25 items)
    // chunk 3: [60..84] (25 items)
    // chunk 4: [80..104] (25 items)
    // chunk 5: [100..109] (10 items)
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should have at most 25 exchanges
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(25);
      expect(chunk.length).toBeGreaterThan(0);
    }

    // All original exchanges should be covered
    const allIndexes = new Set<number>();
    for (const chunk of chunks) {
      for (const ex of chunk) {
        allIndexes.add(ex.index);
      }
    }
    for (let i = 0; i < 110; i++) {
      expect(allIndexes.has(i)).toBe(true);
    }
  });

  it("preserves original exchange indexes after chunking", () => {
    const exchanges = makeExchanges(150);
    const chunks = chunkConversation(exchanges, 25, 5);

    for (const chunk of chunks) {
      for (const ex of chunk) {
        // Each exchange's index field should match its position in the original array
        expect(ex.index).toBe(exchanges[ex.index].index);
        expect(ex.userMessage).toBe(`User message ${ex.index}`);
      }
    }
  });

  it("handles empty exchanges array", () => {
    const chunks = chunkConversation([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(0);
  });
});

// ─── buildExtractionPrompt() ────────────────────────────────────

describe("buildExtractionPrompt", () => {
  it("includes project metadata in the prompt", () => {
    const exchanges = makeExchanges(2);
    const prompt = buildExtractionPrompt(exchanges, defaultMetadata);

    expect(prompt).toContain("Project: test-project");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("Date Range: 2026-02-01 to 2026-02-26");
  });

  it("includes exchange content in the prompt", () => {
    const exchanges = makeExchanges(3);
    const prompt = buildExtractionPrompt(exchanges, defaultMetadata);

    expect(prompt).toContain("[Exchange 0]");
    expect(prompt).toContain("User: User message 0");
    expect(prompt).toContain("Assistant: Assistant response 0");
    expect(prompt).toContain("[Exchange 1]");
    expect(prompt).toContain("[Exchange 2]");
  });

  it("handles empty exchanges gracefully", () => {
    const prompt = buildExtractionPrompt([], defaultMetadata);

    // Should still contain metadata and template content
    expect(prompt).toContain("Project: test-project");
    expect(prompt).toContain("Memory Extraction Specialist");
    // No appended exchange blocks (template examples like [Exchange 12] are expected)
    expect(prompt).not.toContain("[Exchange 0]");
  });

  it("omits branch when not provided", () => {
    const metadata: ConversationMetadata = {
      project: "my-project",
      dateRange: "2026-02-01 to 2026-02-15",
    };
    const prompt = buildExtractionPrompt(makeExchanges(1), metadata);

    expect(prompt).toContain("Project: my-project");
    expect(prompt).not.toContain("Branch:");
    expect(prompt).toContain("Date Range: 2026-02-01 to 2026-02-15");
  });

  it("includes the extraction prompt template content", () => {
    const prompt = buildExtractionPrompt(makeExchanges(1), defaultMetadata);

    // Template contains these key sections
    expect(prompt).toContain("Memory Extraction Specialist");
    expect(prompt).toContain("preference");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("pattern");
    expect(prompt).toContain("solution");
    expect(prompt).toContain("convention");
    expect(prompt).toContain("Score importance on a 0-1 scale");
  });
});

// ─── parseExtractionResponse() ──────────────────────────────────

describe("parseExtractionResponse", () => {
  it("handles valid tool_use response with multiple facts", () => {
    const response = {
      facts: [
        {
          type: "preference",
          content: "The user prefers Fish shell.",
          context: "Stated explicitly in exchange 3.",
          importance: 0.7,
          source_exchange_indexes: [3],
        },
        {
          type: "decision",
          content: "The project uses ESM modules.",
          context: "Architectural decision for modern Node.js.",
          importance: 0.8,
          source_exchange_indexes: [12, 15],
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    expect(facts).toHaveLength(2);
    expect(facts[0].type).toBe("preference");
    expect(facts[0].content).toBe("The user prefers Fish shell.");
    expect(facts[0].context).toBe("Stated explicitly in exchange 3.");
    expect(facts[0].importance).toBe(0.7);
    expect(facts[0].sourceExchangeIds).toEqual(["3"]);

    expect(facts[1].type).toBe("decision");
    expect(facts[1].content).toBe("The project uses ESM modules.");
    expect(facts[1].sourceExchangeIds).toEqual(["12", "15"]);
  });

  it("filters out facts with empty content", () => {
    const response = {
      facts: [
        {
          type: "fact",
          content: "",
          importance: 0.5,
          source_exchange_indexes: [1],
        },
        {
          type: "fact",
          content: "   ",
          importance: 0.5,
          source_exchange_indexes: [2],
        },
        {
          type: "fact",
          content: "Valid fact content.",
          importance: 0.5,
          source_exchange_indexes: [3],
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Valid fact content.");
  });

  it("clamps importance to [0, 1]", () => {
    const response = {
      facts: [
        {
          type: "preference",
          content: "Over-important fact.",
          importance: 1.5,
          source_exchange_indexes: [1],
        },
        {
          type: "preference",
          content: "Under-important fact.",
          importance: -0.3,
          source_exchange_indexes: [2],
        },
        {
          type: "preference",
          content: "Normal fact.",
          importance: 0.6,
          source_exchange_indexes: [3],
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    // -0.3 gets clamped to 0, which is < 0.1, so filtered out
    expect(facts).toHaveLength(2);
    expect(facts[0].importance).toBe(1);
    expect(facts[1].importance).toBe(0.6);
  });

  it("rejects invalid memory types (returns only valid ones)", () => {
    const response = {
      facts: [
        {
          type: "preference",
          content: "Valid type.",
          importance: 0.5,
          source_exchange_indexes: [1],
        },
        {
          type: "emotion",
          content: "Invalid type.",
          importance: 0.5,
          source_exchange_indexes: [2],
        },
        {
          type: "solution",
          content: "Another valid type.",
          importance: 0.5,
          source_exchange_indexes: [3],
        },
        {
          type: "",
          content: "Empty type.",
          importance: 0.5,
          source_exchange_indexes: [4],
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    expect(facts).toHaveLength(2);
    expect(facts[0].type).toBe("preference");
    expect(facts[1].type).toBe("solution");
  });

  it("returns empty array for null response", () => {
    expect(parseExtractionResponse(null)).toEqual([]);
  });

  it("returns empty array for undefined response", () => {
    expect(parseExtractionResponse(undefined)).toEqual([]);
  });

  it("returns empty array for empty object", () => {
    expect(parseExtractionResponse({})).toEqual([]);
  });

  it("returns empty array for response with empty facts array", () => {
    expect(parseExtractionResponse({ facts: [] })).toEqual([]);
  });

  it("handles content blocks format (full API response shape)", () => {
    const response = {
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "extract_memories",
          input: {
            facts: [
              {
                type: "convention",
                content: "The project uses ESM with .js extensions.",
                importance: 0.7,
                source_exchange_indexes: [5],
              },
            ],
          },
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("convention");
    expect(facts[0].content).toBe("The project uses ESM with .js extensions.");
  });

  it("filters out facts with importance below 0.1 threshold", () => {
    const response = {
      facts: [
        {
          type: "fact",
          content: "Very low importance fact.",
          importance: 0.05,
          source_exchange_indexes: [1],
        },
        {
          type: "fact",
          content: "At threshold fact.",
          importance: 0.1,
          source_exchange_indexes: [2],
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("At threshold fact.");
  });

  it("handles missing source_exchange_indexes gracefully", () => {
    const response = {
      facts: [
        {
          type: "fact",
          content: "No source indexes.",
          importance: 0.5,
        },
      ],
    };

    const facts = parseExtractionResponse(response);

    expect(facts).toHaveLength(1);
    expect(facts[0].sourceExchangeIds).toEqual([]);
  });
});

// ─── extractFromConversation() with mocked Anthropic ─────────

describe("extractFromConversation (mocked API)", () => {
  beforeEach(() => {
    resetExtractor();
  });

  afterEach(() => {
    resetExtractor();
  });

  it("returns correct ExtractionResult structure with mocked client", async () => {
    // Build a mock Anthropic client
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_123",
          name: "extract_memories",
          input: {
            facts: [
              {
                type: "preference",
                content: "The user prefers dark mode.",
                context: "Stated during setup.",
                importance: 0.6,
                source_exchange_indexes: [0],
              },
              {
                type: "fact",
                content: "The project uses Node.js 22.",
                importance: 0.5,
                source_exchange_indexes: [1],
              },
            ],
          },
        },
      ],
    });

    const mockClient = {
      messages: { create: mockCreate },
    } as unknown as import("@anthropic-ai/sdk").default;

    setClient(mockClient);

    const exchanges = makeExchanges(5);
    const result = await extractFromConversation(
      "conv-test-001",
      exchanges,
      defaultMetadata,
    );

    // Verify result structure
    expect(result.conversationId).toBe("conv-test-001");
    expect(result.facts).toHaveLength(2);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.tier).toBe("haiku");
    expect(result.confidence).toBeGreaterThan(0);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify individual facts
    expect(result.facts[0].type).toBe("preference");
    expect(result.facts[0].content).toBe("The user prefers dark mode.");
    expect(result.facts[1].type).toBe("fact");
    expect(result.facts[1].content).toBe("The project uses Node.js 22.");

    // Verify the API was called with correct parameters
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe("extract_memories");
    expect(callArgs.tool_choice).toEqual({
      type: "tool",
      name: "extract_memories",
    });
  });

  it("falls back to Sonnet when Haiku fails with auto tier", async () => {
    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(({ model }) => {
      callCount++;
      if (model === "claude-haiku-4-5-20251001") {
        throw new Error("Rate limit exceeded");
      }
      // Sonnet succeeds
      return Promise.resolve({
        content: [
          {
            type: "tool_use",
            id: "toolu_fallback",
            name: "extract_memories",
            input: {
              facts: [
                {
                  type: "convention",
                  content: "Fallback extraction succeeded.",
                  importance: 0.5,
                  source_exchange_indexes: [0],
                },
              ],
            },
          },
        ],
      });
    });

    const mockClient = {
      messages: { create: mockCreate },
    } as unknown as import("@anthropic-ai/sdk").default;

    setClient(mockClient);

    const result = await extractFromConversation(
      "conv-fallback",
      makeExchanges(3),
      defaultMetadata,
      { tier: "auto" },
    );

    expect(result.tier).toBe("sonnet");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe("Fallback extraction succeeded.");
    // Should have been called twice: once for Haiku (failed), once for Sonnet
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws when no API client is initialized", async () => {
    // resetExtractor was called in beforeEach, so client is null
    await expect(
      extractFromConversation("conv-err", makeExchanges(1), defaultMetadata),
    ).rejects.toThrow("Extractor not initialized");
  });

  it("returns empty facts and low confidence for conversations with no extractable content", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_empty",
          name: "extract_memories",
          input: { facts: [] },
        },
      ],
    });

    const mockClient = {
      messages: { create: mockCreate },
    } as unknown as import("@anthropic-ai/sdk").default;

    setClient(mockClient);

    const result = await extractFromConversation(
      "conv-empty",
      makeExchanges(2),
      defaultMetadata,
    );

    expect(result.facts).toHaveLength(0);
    expect(result.confidence).toBe(1);
  });
});
