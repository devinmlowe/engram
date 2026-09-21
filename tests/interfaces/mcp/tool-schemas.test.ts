/**
 * #119 — every tool's advertised inputSchema is generated from its zod schema.
 *
 * Comparison form: for each of the 16 tools the JSON Schema generated from
 * the zod schema must carry every property, description, enum, default and
 * constraint the hand-written `MCP_TOOL_DEFINITIONS` entry had. Extra keys in
 * the generated schema (a tighter `integer` type, a uuid `pattern`, a
 * `maximum` the validator always enforced) are reported, not failed.
 *
 * server.ts only starts a transport when run directly, so importing it is
 * side-effect free (ENGRAM_DB_PATH is set before the lazy DB open).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { MCP_TOOL_NAMES } from "../../../src/interfaces/mcp/tool-names.js";

const tmpDir = mkdtempSync(join(tmpdir(), "engram-tool-schemas-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "schemas.db");
process.env.ENGRAM_DATA_DIR = tmpDir;

let tools: Tool[];
let schemas: Record<string, z.ZodType>;
let toInputSchema: (schema: z.ZodType) => Tool["inputSchema"];

beforeAll(async () => {
  ({ MCP_TOOL_DEFINITIONS: tools, MCP_TOOL_INPUT_SCHEMAS: schemas, toInputSchema } = await import(
    "../../../src/interfaces/mcp/server.js"
  ));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

/** Every key of `expected` must exist in `actual` with an equal value (arrays compared in order; `required` sorted). */
function missing(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (Array.isArray(expected)) {
    const a = Array.isArray(actual) ? [...actual] : undefined;
    const e = [...expected];
    if (path.endsWith(".required")) {
      e.sort();
      a?.sort();
    }
    if (JSON.stringify(e) !== JSON.stringify(a)) out.push(`${path}: expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") {
      out.push(`${path}: expected object got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [k, v] of Object.entries(expected as Json)) missing(v, (actual as Json)[k], `${path}.${k}`, out);
    return;
  }
  // The hand-written table said "number" where zod validates an integer; the generated schema is the stricter truth.
  if (path.endsWith(".type") && expected === "number" && actual === "integer") return;
  if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

/** Keys present in `actual` but absent from `expected` — informational. */
function extras(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    out.push(`${path}: ${JSON.stringify(actual)}`);
    return;
  }
  for (const [k, v] of Object.entries(actual as Json)) {
    if (!(k in (expected as Json))) out.push(`${path}.${k}: ${JSON.stringify(v)}`);
    else extras((expected as Json)[k], v, `${path}.${k}`, out);
  }
}

/**
 * The one advertised constraint the generated schema drops on purpose: the
 * hand-written table closed `tool_calls[]` items, but the zod object never
 * did (unknown keys were stripped, never rejected). The generated schema now
 * says what the validator does.
 */
const ACCEPTED_LOSSES = new Set([
  "ingest_turn.properties.tool_calls.items.additionalProperties: expected false got undefined",
]);

const report: string[] = [];
afterAll(() => {
  if (report.length > 0) process.stdout.write(`generated schemas add (informational):\n  ${report.join("\n  ")}\n`);
});

describe("generated inputSchema carries everything the hand-written one had (#119)", () => {
  it("has a zod schema for exactly the registered tools", () => {
    expect(Object.keys(schemas).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it.each(MCP_TOOL_NAMES)("%s", (name) => {
    const handWritten = tools.find((t) => t.name === name)!.inputSchema;
    const generated = toInputSchema(schemas[name]);
    const lost: string[] = [];
    missing(handWritten, generated, name, lost);
    extras(handWritten, generated, name, report);
    expect(lost.filter((l) => !ACCEPTED_LOSSES.has(l)), `[${name}] generated schema lacks:\n  ${lost.join("\n  ")}`).toEqual([]);
  });
});
