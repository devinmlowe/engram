/**
 * Contract tests ensuring the existing recall tool is unchanged
 * and the new recall_session/recall_drill tools are properly defined.
 *
 * Phase 6B: Iterative recall contract verification.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const serverSource = readFileSync(
  new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
  "utf-8",
);

// The advertised schemas are generated from the zod schemas (#119): read the
// exported definitions rather than the source. server.ts only starts a
// transport when run directly, so importing it is side-effect free.
let tools: Tool[];
const tool = (name: string) => tools.find((t) => t.name === name)!;
beforeAll(async () => {
  ({ MCP_TOOL_DEFINITIONS: tools } = await import("../../src/interfaces/mcp/server.js"));
});

describe("existing recall tool unchanged", () => {
  it("recall tool schema unchanged", () => {
    // Verify recall tool still exists with original structure
    expect(serverSource).toContain('name: "recall"');
    expect(serverSource).toContain("RecallInputSchema");

    // Verify original required field
    expect(tool("recall").inputSchema.required).toEqual(["query"]);

    // Verify recall does NOT reference session_id in its schema
    // (recall_session has session_id, not recall)
    expect(tool("recall").inputSchema.properties).not.toHaveProperty("session_id");
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
    expect(Object.keys(tool("recall_session").inputSchema.properties!)).toEqual(
      expect.arrayContaining(["query", "session_id", "budget", "sources"]),
    );
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

describe("temporal recall surface", () => {
  it("recall accepts dateHint and dateBasis in both the zod schema and the tool definition", () => {
    const schemaSection = serverSource.substring(
      serverSource.indexOf("const RecallInputSchema"),
      serverSource.indexOf("const RememberInputSchema"),
    );
    expect(schemaSection).toContain("dateHint");
    expect(schemaSection).toContain('dateBasis: z.enum(["filed", "event"])');

    const props = tool("recall").inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.dateHint).toMatchObject({ type: "string" });
    expect(props.dateBasis).toMatchObject({ enum: ["filed", "event"] });
  });

  it("recall handler forwards dateHint/dateBasis to unifiedSearch (explicit after/before still passed)", () => {
    const handler = serverSource.substring(
      serverSource.indexOf('if (name === "recall")'),
      serverSource.indexOf('if (name === "remember")'),
    );
    expect(handler).toContain("dateHint: params.dateHint");
    expect(handler).toContain("dateBasis: params.dateBasis");
    expect(handler).toContain("after: params.after");
    expect(handler).toContain("before: params.before");
  });
});
