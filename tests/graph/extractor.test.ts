import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildEntityExtractionPrompt,
  buildRelationshipExtractionPrompt,
  parseEntityExtractionResponse,
  parseRelationshipExtractionResponse,
  extractEntities,
  extractRelationships,
  resetGraphExtractor,
  setGraphExtractorClient,
} from "../../src/graph/extractor.js";
import type { ConversationExchange, ConversationMetadata } from "../../src/semantic/extractor.js";

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

// ─── buildEntityExtractionPrompt() ──────────────────────────────

describe("buildEntityExtractionPrompt", () => {
  it("includes metadata and exchange content", () => {
    const exchanges = makeExchanges(2);
    const prompt = buildEntityExtractionPrompt(exchanges, defaultMetadata);

    expect(prompt).toContain("Project: test-project");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("Date Range: 2026-02-01 to 2026-02-26");
    expect(prompt).toContain("[Exchange 0]");
    expect(prompt).toContain("User: User message 0");
    expect(prompt).toContain("Assistant: Assistant response 0");
    expect(prompt).toContain("[Exchange 1]");
  });

  it("loads prompt template from disk", () => {
    const exchanges = makeExchanges(1);
    const prompt = buildEntityExtractionPrompt(exchanges, defaultMetadata);

    // Template should contain key sections from extract-entities.md
    expect(prompt).toContain("Entity Extraction from Developer Conversation");
    expect(prompt).toContain("Entity Types");
    expect(prompt).toContain("project");
    expect(prompt).toContain("technology");
    expect(prompt).toContain("tool");
    expect(prompt).toContain("file");
    expect(prompt).toContain("repo");
    expect(prompt).toContain("person");
    expect(prompt).toContain("concept");
  });
});

// ─── buildRelationshipExtractionPrompt() ────────────────────────

describe("buildRelationshipExtractionPrompt", () => {
  it("includes entity list and conversation", () => {
    const exchanges = makeExchanges(2);
    const entities = [
      { index: 0, name: "TypeScript", type: "technology" as const },
      { index: 1, name: "engram", type: "project" as const },
    ];

    const prompt = buildRelationshipExtractionPrompt(
      exchanges,
      defaultMetadata,
      entities,
    );

    // Should contain the entity list
    expect(prompt).toContain("[0] TypeScript (technology)");
    expect(prompt).toContain("[1] engram (project)");

    // Should contain conversation
    expect(prompt).toContain("Project: test-project");
    expect(prompt).toContain("[Exchange 0]");
    expect(prompt).toContain("User: User message 0");

    // Should contain template content
    expect(prompt).toContain("Relationship Extraction");
    expect(prompt).toContain("Relationship Types");
  });
});

// ─── parseEntityExtractionResponse() ────────────────────────────

describe("parseEntityExtractionResponse", () => {
  it("handles valid tool_use response", () => {
    const response = {
      entities: [
        {
          name: "TypeScript",
          type: "technology",
          description: "A typed superset of JavaScript",
        },
        {
          name: "engram",
          type: "project",
          description: "Cognitive memory system",
        },
      ],
    };

    const entities = parseEntityExtractionResponse(response);

    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("TypeScript");
    expect(entities[0].type).toBe("technology");
    expect(entities[0].description).toBe("A typed superset of JavaScript");
    expect(entities[1].name).toBe("engram");
    expect(entities[1].type).toBe("project");
  });

  it("rejects invalid entity types", () => {
    const response = {
      entities: [
        {
          name: "TypeScript",
          type: "technology",
          description: "Valid type",
        },
        {
          name: "happiness",
          type: "emotion",
          description: "Invalid type",
        },
        {
          name: "engram",
          type: "project",
          description: "Another valid type",
        },
        {
          name: "empty type",
          type: "",
        },
      ],
    };

    const entities = parseEntityExtractionResponse(response);

    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("TypeScript");
    expect(entities[1].name).toBe("engram");
  });

  it("deduplicates by lowercase name", () => {
    const response = {
      entities: [
        {
          name: "TypeScript",
          type: "technology",
          description: "First mention",
        },
        {
          name: "typescript",
          type: "technology",
          description: "Duplicate mention",
        },
        {
          name: "TYPESCRIPT",
          type: "technology",
          description: "Another duplicate",
        },
      ],
    };

    const entities = parseEntityExtractionResponse(response);

    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("TypeScript"); // keeps first occurrence
    expect(entities[0].description).toBe("First mention");
  });

  it("filters empty names", () => {
    const response = {
      entities: [
        { name: "", type: "technology" },
        { name: "   ", type: "technology" },
        { name: "TypeScript", type: "technology" },
      ],
    };

    const entities = parseEntityExtractionResponse(response);

    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("TypeScript");
  });

  it("returns empty array for empty response", () => {
    expect(parseEntityExtractionResponse(null)).toEqual([]);
    expect(parseEntityExtractionResponse(undefined)).toEqual([]);
    expect(parseEntityExtractionResponse({})).toEqual([]);
    expect(parseEntityExtractionResponse({ entities: [] })).toEqual([]);
  });

  it("handles content blocks format (full API response shape)", () => {
    const response = {
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "extract_entities",
          input: {
            entities: [
              {
                name: "SQLite",
                type: "technology",
                description: "Database engine",
              },
            ],
          },
        },
      ],
    };

    const entities = parseEntityExtractionResponse(response);

    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("SQLite");
    expect(entities[0].type).toBe("technology");
  });
});

// ─── parseRelationshipExtractionResponse() ──────────────────────

describe("parseRelationshipExtractionResponse", () => {
  it("handles valid response", () => {
    const response = {
      relationships: [
        {
          source_entity_index: 0,
          target_entity_index: 1,
          type: "uses",
          context: "Project uses TypeScript",
        },
        {
          source_entity_index: 1,
          target_entity_index: 2,
          type: "depends_on",
          context: "TypeScript depends on Node.js",
        },
      ],
    };

    const relationships = parseRelationshipExtractionResponse(response, 3);

    expect(relationships).toHaveLength(2);
    expect(relationships[0].sourceEntityIndex).toBe(0);
    expect(relationships[0].targetEntityIndex).toBe(1);
    expect(relationships[0].type).toBe("uses");
    expect(relationships[0].context).toBe("Project uses TypeScript");
    expect(relationships[1].sourceEntityIndex).toBe(1);
    expect(relationships[1].targetEntityIndex).toBe(2);
    expect(relationships[1].type).toBe("depends_on");
  });

  it("rejects out-of-bounds entity indexes", () => {
    const response = {
      relationships: [
        {
          source_entity_index: 0,
          target_entity_index: 1,
          type: "uses",
        },
        {
          source_entity_index: 0,
          target_entity_index: 5, // out of bounds
          type: "uses",
        },
        {
          source_entity_index: -1, // negative
          target_entity_index: 1,
          type: "uses",
        },
      ],
    };

    const relationships = parseRelationshipExtractionResponse(response, 3);

    expect(relationships).toHaveLength(1);
    expect(relationships[0].sourceEntityIndex).toBe(0);
    expect(relationships[0].targetEntityIndex).toBe(1);
  });

  it("rejects self-referential edges", () => {
    const response = {
      relationships: [
        {
          source_entity_index: 0,
          target_entity_index: 0, // self-referential
          type: "uses",
        },
        {
          source_entity_index: 0,
          target_entity_index: 1,
          type: "uses",
        },
        {
          source_entity_index: 2,
          target_entity_index: 2, // self-referential
          type: "related_to",
        },
      ],
    };

    const relationships = parseRelationshipExtractionResponse(response, 3);

    expect(relationships).toHaveLength(1);
    expect(relationships[0].sourceEntityIndex).toBe(0);
    expect(relationships[0].targetEntityIndex).toBe(1);
  });

  it("rejects invalid relationship types", () => {
    const response = {
      relationships: [
        {
          source_entity_index: 0,
          target_entity_index: 1,
          type: "uses",
        },
        {
          source_entity_index: 0,
          target_entity_index: 1,
          type: "loves", // invalid
        },
        {
          source_entity_index: 0,
          target_entity_index: 1,
          type: "", // empty
        },
      ],
    };

    const relationships = parseRelationshipExtractionResponse(response, 3);

    expect(relationships).toHaveLength(1);
    expect(relationships[0].type).toBe("uses");
  });

  it("returns empty array for empty response", () => {
    expect(parseRelationshipExtractionResponse(null, 3)).toEqual([]);
    expect(parseRelationshipExtractionResponse(undefined, 3)).toEqual([]);
    expect(parseRelationshipExtractionResponse({}, 3)).toEqual([]);
    expect(
      parseRelationshipExtractionResponse({ relationships: [] }, 3),
    ).toEqual([]);
  });

  it("handles content blocks format (full API response shape)", () => {
    const response = {
      content: [
        {
          type: "tool_use",
          id: "toolu_456",
          name: "extract_relationships",
          input: {
            relationships: [
              {
                source_entity_index: 0,
                target_entity_index: 1,
                type: "part_of",
                context: "File is part of the project",
              },
            ],
          },
        },
      ],
    };

    const relationships = parseRelationshipExtractionResponse(response, 3);

    expect(relationships).toHaveLength(1);
    expect(relationships[0].type).toBe("part_of");
    expect(relationships[0].context).toBe("File is part of the project");
  });
});

// ─── Extraction with mock API client ────────────────────────────

describe("extractEntities (mocked API)", () => {
  beforeEach(() => {
    resetGraphExtractor();
  });

  afterEach(() => {
    resetGraphExtractor();
  });

  it("returns correct EntityExtractionResult structure with mocked client", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_entity",
          name: "extract_entities",
          input: {
            entities: [
              {
                name: "TypeScript",
                type: "technology",
                description: "Programming language",
              },
              {
                name: "engram",
                type: "project",
                description: "Memory system",
              },
            ],
          },
        },
      ],
    });

    const mockClient = {
      messages: { create: mockCreate },
    } as unknown as import("@anthropic-ai/sdk").default;

    setGraphExtractorClient(mockClient);

    const exchanges = makeExchanges(3);
    const result = await extractEntities(exchanges, defaultMetadata);

    // Verify result structure
    expect(result.entities).toHaveLength(2);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.tier).toBe("haiku");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify individual entities
    expect(result.entities[0].name).toBe("TypeScript");
    expect(result.entities[0].type).toBe("technology");
    expect(result.entities[1].name).toBe("engram");
    expect(result.entities[1].type).toBe("project");

    // Verify the API was called correctly
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe("extract_entities");
    expect(callArgs.tool_choice).toEqual({
      type: "tool",
      name: "extract_entities",
    });
  });

  it("throws when no API client is initialized", async () => {
    await expect(
      extractEntities(makeExchanges(1), defaultMetadata),
    ).rejects.toThrow("Graph extractor not initialized");
  });
});

describe("extractRelationships (mocked API)", () => {
  beforeEach(() => {
    resetGraphExtractor();
  });

  afterEach(() => {
    resetGraphExtractor();
  });

  it("returns correct RelationshipExtractionResult structure with mocked client", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_rel",
          name: "extract_relationships",
          input: {
            relationships: [
              {
                source_entity_index: 0,
                target_entity_index: 1,
                type: "uses",
                context: "Project uses TypeScript",
              },
            ],
          },
        },
      ],
    });

    const mockClient = {
      messages: { create: mockCreate },
    } as unknown as import("@anthropic-ai/sdk").default;

    setGraphExtractorClient(mockClient);

    const exchanges = makeExchanges(3);
    const resolvedEntities = [
      { index: 0, id: "ent-1", name: "engram", type: "project" as const },
      { index: 1, id: "ent-2", name: "TypeScript", type: "technology" as const },
    ];

    const result = await extractRelationships(
      exchanges,
      defaultMetadata,
      resolvedEntities,
    );

    // Verify result structure
    expect(result.relationships).toHaveLength(1);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.tier).toBe("haiku");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify individual relationships
    expect(result.relationships[0].sourceEntityIndex).toBe(0);
    expect(result.relationships[0].targetEntityIndex).toBe(1);
    expect(result.relationships[0].type).toBe("uses");
    expect(result.relationships[0].context).toBe("Project uses TypeScript");

    // Verify the API was called correctly
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe("extract_relationships");
    expect(callArgs.tool_choice).toEqual({
      type: "tool",
      name: "extract_relationships",
    });
  });

  it("throws when no API client is initialized", async () => {
    const resolvedEntities = [
      { index: 0, id: "ent-1", name: "engram", type: "project" as const },
    ];

    await expect(
      extractRelationships(makeExchanges(1), defaultMetadata, resolvedEntities),
    ).rejects.toThrow("Graph extractor not initialized");
  });
});
