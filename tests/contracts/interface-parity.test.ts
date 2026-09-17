/**
 * Contract: CLI / MCP capability parity (interfaces/SPEC.md REQ-2, POST-4).
 *
 * The two agent-facing surfaces must expose the same memory capabilities
 * and reach them through the same `interfaces/shared/` operation, so recall
 * ranking and remember dedup cannot drift between `engram search` and MCP
 * `recall`, or between `engram remember` and MCP `remember`. Operator
 * actions (dream, sync, init, …) are deliberately CLI-only.
 *
 * Registration is checked from the real objects where one exists
 * (MCP_TOOL_DEFINITIONS) and from the commander source for the CLI; routing
 * is checked structurally on the two entry-point sources, the same way
 * no-direct-anthropic.test.ts guards the LLM factory.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const tmpDir = mkdtempSync(join(tmpdir(), "engram-parity-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "parity.db");
process.env.ENGRAM_DATA_DIR = tmpDir;

const CLI_SRC = readFileSync(new URL("../../src/interfaces/cli/index.ts", import.meta.url), "utf-8");
const MCP_SRC = readFileSync(new URL("../../src/interfaces/mcp/server.ts", import.meta.url), "utf-8");

/** capability → [CLI command, MCP tool, shared module that must serve both] */
const SHARED_CAPABILITIES: Array<[string, string, string, string | null]> = [
  ["recall", "search", "recall", "../shared/search.js"],
  ["remember", "remember", "remember", "../shared/remember.js"],
  ["explore", "explore", "explore", "../shared/explore.js"],
  ["reflect", "reflect", "reflect", "../shared/reflect.js"], // routed through the shared wrapper since #38
];

let tools: Tool[];
let handleToolCall: typeof import("../../src/interfaces/mcp/server.js").handleToolCall;

beforeAll(async () => {
  ({ MCP_TOOL_DEFINITIONS: tools, handleToolCall } = await import("../../src/interfaces/mcp/server.js"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("REQ-2: the shared memory capabilities exist on both surfaces", () => {
  it.each(SHARED_CAPABILITIES)("%s: CLI `%s` and MCP `%s` are both registered", (_cap, cli, mcp) => {
    expect(CLI_SRC, `CLI command ${cli}`).toMatch(new RegExp(`\\.command\\("${cli}(?: <[^"]+>)?"\\)`));
    expect(tools.map((t) => t.name), `MCP tool ${mcp}`).toContain(mcp);
  });

  it("operator actions stay CLI-only", () => {
    for (const cmd of ["dream", "sync", "init", "migrate"]) {
      expect(CLI_SRC).toMatch(new RegExp(`\\.command\\("${cmd}"\\)`));
      expect(tools.map((t) => t.name)).not.toContain(cmd);
    }
  });
});

describe("POST-4 / REQ-1: both surfaces route through interfaces/shared", () => {
  it.each(SHARED_CAPABILITIES.filter(([, , , shared]) => shared !== null))(
    "%s: CLI and MCP both import %s",
    (_cap, _cli, _mcp, shared) => {
      expect(CLI_SRC).toContain(`"${shared}"`);
      expect(MCP_SRC).toContain(`"${shared}"`);
    },
  );

  it("neither surface calls the search engine or the memory store directly for recall/remember", () => {
    for (const [label, src] of [["cli", CLI_SRC], ["mcp", MCP_SRC]] as const) {
      expect(src, label).not.toMatch(/\bsearchMultiSource\b/);
      expect(src, label).not.toMatch(/\binsertMemory\b/);
      expect(src, label).not.toMatch(/\bdeduplicateFact\b/);
      expect(src, label).toMatch(/\brememberFact\b/);
    }
  });
});

describe("graph POST-2 surfaces through MCP", () => {
  it("explore of an unknown entity is an isError result with the descriptive message", async () => {
    const res = await handleToolCall("explore", { entity: "no-such-entity-xyz" });
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Entity not found: no-such-entity-xyz") });
  });
});
