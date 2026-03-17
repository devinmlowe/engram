import { describe, it, expect } from "vitest";
import { isBlockedEntityName, parseEntityExtractionResponse } from "../../src/graph/extractor.js";

describe("entity name blocklist", () => {
  it("blocks markdown artifacts", () => {
    expect(isBlockedEntityName("---")).toBe(true);
    expect(isBlockedEntityName("##")).toBe(true);
    expect(isBlockedEntityName("**")).toBe(true);
    expect(isBlockedEntityName("```")).toBe(true);
    expect(isBlockedEntityName("###")).toBe(true);
    expect(isBlockedEntityName("|")).toBe(true);
    expect(isBlockedEntityName("- [ ]")).toBe(true);
  });

  it("blocks single-character and empty names", () => {
    expect(isBlockedEntityName("")).toBe(true);
    expect(isBlockedEntityName(" ")).toBe(true);
    expect(isBlockedEntityName("-")).toBe(true);
    expect(isBlockedEntityName("*")).toBe(true);
  });

  it("blocks pure-punctuation strings", () => {
    expect(isBlockedEntityName("===")).toBe(true);
    expect(isBlockedEntityName(">>>")).toBe(true);
    expect(isBlockedEntityName("...")).toBe(true);
  });

  it("allows legitimate entity names", () => {
    expect(isBlockedEntityName("Claude")).toBe(false);
    expect(isBlockedEntityName("KiCad")).toBe(false);
    expect(isBlockedEntityName("engram")).toBe(false);
    expect(isBlockedEntityName("Node.js")).toBe(false);
    expect(isBlockedEntityName("C++")).toBe(false);
    expect(isBlockedEntityName("n8n")).toBe(false);
  });
});

describe("parseEntityExtractionResponse with blocklist", () => {
  it("filters blocked entity names from extraction results", () => {
    const mockResponse = {
      entities: [
        { name: "KiCad", type: "tool", description: "PCB design software" },
        { name: "---", type: "concept", description: "separator" },
        { name: "engram", type: "project", description: "memory system" },
        { name: "##", type: "concept", description: "heading" },
        { name: "**", type: "concept", description: "bold" },
      ],
    };

    const result = parseEntityExtractionResponse(mockResponse);
    const names = result.map(e => e.name);

    expect(names).toContain("KiCad");
    expect(names).toContain("engram");
    expect(names).not.toContain("---");
    expect(names).not.toContain("##");
    expect(names).not.toContain("**");
    expect(result).toHaveLength(2);
  });
});
