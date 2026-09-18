/**
 * #22 — readOnlyHint policy (interfaces/SPEC.md INV-3).
 *
 * Retrieval tools keep `readOnlyHint: true` although recall reinforces the
 * memories it returns: reinforcement is FSRS bookkeeping (access_count,
 * last_accessed, stability), never a content change, and a write hint would
 * make MCP clients confirm every recall. This test pins the annotation of
 * every tool so a change is a deliberate one, and checks the reinforcing
 * tools say so in their description.
 *
 * server.ts only starts a transport when run directly, so importing it is
 * side-effect free (ENGRAM_DB_PATH is set before the lazy DB open).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_NAMES } from "../../../src/interfaces/mcp/tool-names.js";

const tmpDir = mkdtempSync(join(tmpdir(), "engram-tool-annotations-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "annotations.db");
process.env.ENGRAM_DATA_DIR = tmpDir;

/** Every tool, by name → expected readOnlyHint. Add a row when adding a tool. */
const EXPECTED_READ_ONLY: Record<(typeof MCP_TOOL_NAMES)[number], boolean> = {
  recall: true,
  recall_session: true,
  recall_drill: true,
  show: true,
  explore: true,
  explore_selective: true,
  fetch_snippets: true,
  scan_file: true,
  commitments: true,
  remember: false,
  remember_batch: false,
  reflect: false,
  index_file_structure: false,
  commitments_update: false,
  ingest_turn: false,
  forget: false,
};

/** Tools that delete data: the only ones allowed to carry destructiveHint: true. */
const DESTRUCTIVE = ["forget"] as const;

/** Tools whose handler reinforces returned memories (accept `reinforce`). */
const REINFORCING = ["recall", "recall_session", "recall_drill"] as const;

let tools: Tool[];

beforeAll(async () => {
  ({ MCP_TOOL_DEFINITIONS: tools } = await import("../../../src/interfaces/mcp/server.js"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MCP tool annotations (#22)", () => {
  it("the expectation table covers exactly the registered tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_READ_ONLY).sort());
  });

  it.each(MCP_TOOL_NAMES)("%s has readOnlyHint = expected", (name) => {
    const tool = tools.find((t) => t.name === name)!;
    expect(tool.annotations?.readOnlyHint, name).toBe(EXPECTED_READ_ONLY[name]);
  });

  it.each(REINFORCING)("%s accepts `reinforce` and its description states the bookkeeping and the opt-out", (name) => {
    const tool = tools.find((t) => t.name === name)!;
    const props = tool.inputSchema.properties as Record<string, { type?: string; default?: unknown }>;
    expect(props.reinforce).toMatchObject({ type: "boolean", default: true });
    expect(tool.description).toMatch(/access_count, last_accessed, stability/);
    expect(tool.description).toMatch(/reinforce: false/);
  });

  it("destructiveHint is true exactly for the tools that delete (#55)", () => {
    for (const tool of tools) {
      const expected = (DESTRUCTIVE as readonly string[]).includes(tool.name);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(expected);
    }
  });

  it("tools that do not reinforce do not claim to", () => {
    for (const tool of tools) {
      if ((REINFORCING as readonly string[]).includes(tool.name)) continue;
      expect(tool.description, tool.name).not.toMatch(/reinforce/i);
      expect((tool.inputSchema.properties as Record<string, unknown>).reinforce, tool.name).toBeUndefined();
    }
  });
});
