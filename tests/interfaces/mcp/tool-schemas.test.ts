/**
 * #119 — every tool's advertised inputSchema is generated from its zod schema
 * (`z.toJSONSchema`, io: "input"), so the description, enum, default or
 * constraint a client sees is the one the validator enforces.
 *
 * The snapshot pins the full ListTools surface (name, description,
 * inputSchema, annotations) of all 16 tools. It was recorded from the
 * generated output after a deep comparison against the previous hand-written
 * table proved nothing was lost; a change to any zod schema or description
 * fails here until `vitest -u` records the new contract on purpose.
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

const tmpDir = mkdtempSync(join(tmpdir(), "engram-tool-schemas-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "schemas.db");
process.env.ENGRAM_DATA_DIR = tmpDir;

let tools: Tool[];

beforeAll(async () => {
  ({ MCP_TOOL_DEFINITIONS: tools } = await import("../../../src/interfaces/mcp/server.js"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("generated tool schemas (#119)", () => {
  it("advertises exactly the registered tools, each with a closed object schema", () => {
    expect(tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.inputSchema, tool.name).not.toHaveProperty("$schema");
    }
  });

  it.each(MCP_TOOL_NAMES)("%s matches the recorded contract", (name) => {
    expect(tools.find((t) => t.name === name)).toMatchSnapshot();
  });
});
