import { describe, it, expect } from "vitest";
import { isBlockedEntityName } from "../../src/graph/extractor.js";

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
