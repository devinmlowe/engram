/**
 * Contract tests ensuring the existing recall tool is unchanged
 * and the new recall_session/recall_drill tools are properly defined.
 *
 * Phase 6B: Iterative recall contract verification.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(
  new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
  "utf-8",
);

describe("existing recall tool unchanged", () => {
  it("recall tool schema unchanged", () => {
    // Verify recall tool still exists with original structure
    expect(serverSource).toContain('name: "recall"');
    expect(serverSource).toContain("RecallInputSchema");

    // Verify original required field
    expect(serverSource).toContain('required: ["query"]');

    // Verify recall does NOT reference session_id in its schema
    // (recall_session has session_id, not recall)
    const recallSection = serverSource.substring(
      serverSource.indexOf('name: "recall"'),
      serverSource.indexOf('name: "remember"'),
    );
    expect(recallSection).not.toContain("session_id");
  });

  it("recall returns same format as before", () => {
    // Verify recall handler still uses formatRecallXml
    expect(serverSource).toContain("formatRecallXml(response)");
    // Verify recall handler structure
    expect(serverSource).toContain('if (name === "recall")');
    expect(serverSource).toContain("RecallInputSchema.parse(args)");
    expect(serverSource).toContain("unifiedSearch(getDb()");
  });

  it("recall does not require session_id", () => {
    // Verify RecallInputSchema doesn't include session_id
    const schemaSection = serverSource.substring(
      serverSource.indexOf("const RecallInputSchema"),
      serverSource.indexOf("const RememberInputSchema"),
    );
    expect(schemaSection).not.toContain("session_id");
  });
});

describe("new tools are properly defined", () => {
  it("recall_session tool exists with correct schema", () => {
    expect(serverSource).toContain('name: "recall_session"');
    expect(serverSource).toContain("RecallSessionInputSchema");

    // Verify it accepts query and session_id
    const toolSection = serverSource.substring(
      serverSource.indexOf('name: "recall_session"'),
      serverSource.indexOf('name: "recall_drill"'),
    );
    expect(toolSection).toContain("query");
    expect(toolSection).toContain("session_id");
    expect(toolSection).toContain("budget");
    expect(toolSection).toContain("sources");
  });

  it("recall_drill tool exists with correct schema", () => {
    expect(serverSource).toContain('name: "recall_drill"');
    expect(serverSource).toContain("RecallDrillInputSchema");

    const toolSection = serverSource.substring(
      serverSource.indexOf('name: "recall_drill"'),
      serverSource.indexOf("</engram_drill>") > 0
        ? serverSource.indexOf("</engram_drill>") + 20
        : serverSource.length,
    );
    expect(toolSection).toContain("session_id");
    expect(toolSection).toContain("result_index");
  });

  it("recall_session handler uses createOrRefineRecallSession", () => {
    expect(serverSource).toContain("createOrRefineRecallSession");
  });

  it("recall_drill handler uses drillRecallResult", () => {
    expect(serverSource).toContain("drillRecallResult");
  });

  it("recall_drill outputs XML format", () => {
    expect(serverSource).toContain("<engram_drill");
    expect(serverSource).toContain("</engram_drill>");
    expect(serverSource).toContain("<content>");
    expect(serverSource).toContain("<suggestions>");
  });

  it("all original tools still present", () => {
    const expectedTools = ["recall", "remember", "remember_batch", "show", "explore", "reflect"];
    for (const tool of expectedTools) {
      expect(serverSource).toContain(`name: "${tool}"`);
    }
  });

  it("new tools are added alongside originals", () => {
    const allTools = ["recall", "remember", "remember_batch", "show", "explore", "reflect", "recall_session", "recall_drill"];
    for (const tool of allTools) {
      expect(serverSource).toContain(`name: "${tool}"`);
    }
  });
});
