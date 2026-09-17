/**
 * Per-request tenant scoping (W1): `scope` / `read_scopes` tool params
 * override the ENGRAM_SCOPE / ENGRAM_READ_SCOPES env defaults for a single
 * call, so one HTTP daemon can serve every Hermes profile. Exercises the real
 * `handleToolCall` against a temp DB with deterministic mock embeddings.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

vi.mock("../../../src/_core/embeddings/index.js", () => {
  const dims = 256;
  function deterministicVector(seed: string): number[] {
    const vec = new Array(dims);
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    for (let i = 0; i < dims; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      vec[i] = (hash & 0xffff) / 0xffff - 0.5;
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
    return vec;
  }
  return {
    initEmbeddings: vi.fn().mockResolvedValue(undefined),
    embedQuery: vi.fn().mockImplementation((text: string) => Promise.resolve(deterministicVector(`query:${text}`))),
    embedDocument: vi.fn().mockImplementation((text: string) => Promise.resolve(deterministicVector(`doc:${text}`))),
    embedDocumentBatch: vi.fn().mockImplementation((texts: string[]) => Promise.resolve(texts.map((t) => deterministicVector(`doc:${t}`)))),
    getActiveModel: vi.fn().mockReturnValue("mock-model"),
    resetEmbeddings: vi.fn(),
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), "engram-scope-params-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "scoped.db");
process.env.ENGRAM_DATA_DIR = tmpDir;
delete process.env.ENGRAM_SCOPE;
delete process.env.ENGRAM_READ_SCOPES;

const CAREER = "Interview with Databricks scheduled for the delivery manager role";
const GLOBAL = "Interview prep checklist lives in the career vault";

function scopeOf(content: string): string | undefined {
  const db = new Database(process.env.ENGRAM_DB_PATH!, { readonly: true });
  try {
    const row = db.prepare("SELECT scope FROM memories WHERE content = ?").get(content) as { scope: string } | undefined;
    return row?.scope;
  } finally {
    db.close();
  }
}

describe("per-request scope / read_scopes params", () => {
  let handleToolCall: typeof import("../../../src/interfaces/mcp/server.js").handleToolCall;

  beforeAll(async () => {
    ({ handleToolCall } = await import("../../../src/interfaces/mcp/server.js"));
  });

  afterAll(() => {
    delete process.env.ENGRAM_SCOPE;
    delete process.env.ENGRAM_READ_SCOPES;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("remember with scope param writes that scope while env is unset", async () => {
    const res = await handleToolCall("remember", { content: CAREER, scope: "hermes:career" });
    expect(res.isError).toBeFalsy();
    expect(scopeOf(CAREER)).toBe("hermes:career");
  });

  it("remember without scope param still writes the column default (global)", async () => {
    const res = await handleToolCall("remember", { content: GLOBAL });
    expect(res.isError).toBeFalsy();
    expect(scopeOf(GLOBAL)).toBe("global");
  });

  it("recall with read_scopes returns only that scope's memories", async () => {
    const res = await handleToolCall("recall", {
      query: "interview",
      sources: ["semantic"],
      read_scopes: ["hermes:career"],
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text as string;
    expect(text).toContain("Databricks");
    expect(text).not.toContain("checklist");
  });

  it("recall without params sees every scope (env unset)", async () => {
    const res = await handleToolCall("recall", { query: "interview", sources: ["semantic"] });
    const text = res.content[0].text as string;
    expect(text).toContain("Databricks");
    expect(text).toContain("checklist");
  });

  it("recall_session honours read_scopes too", async () => {
    const res = await handleToolCall("recall_session", {
      query: "interview",
      sources: ["semantic"],
      read_scopes: ["global"],
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text as string;
    expect(text).toContain("checklist");
    expect(text).not.toContain("Databricks");
  });

  it("remember_batch with scope param stamps every row", async () => {
    const res = await handleToolCall("remember_batch", {
      scope: "hermes:pmp",
      memories: [{ content: "PMP exam window opens in February" }, { content: "PMBOK 8 replaced the sixth edition" }],
    });
    expect(res.isError).toBeFalsy();
    expect(scopeOf("PMP exam window opens in February")).toBe("hermes:pmp");
    expect(scopeOf("PMBOK 8 replaced the sixth edition")).toBe("hermes:pmp");
  });

  it("params absent → env-derived scoping still applies", async () => {
    process.env.ENGRAM_SCOPE = "hermes:finance";
    try {
      const res = await handleToolCall("remember", { content: "Plaid sync is blocked on placeholder secrets" });
      expect(res.isError).toBeFalsy();
      expect(scopeOf("Plaid sync is blocked on placeholder secrets")).toBe("hermes:finance");

      // env read default = global + own, so the career memory is hidden…
      const hidden = await handleToolCall("recall", { query: "interview", sources: ["semantic"] });
      expect(hidden.content[0].text as string).not.toContain("Databricks");
      // …unless the call overrides read_scopes
      const shown = await handleToolCall("recall", { query: "interview", sources: ["semantic"], read_scopes: ["hermes:career"] });
      expect(shown.content[0].text as string).toContain("Databricks");
    } finally {
      delete process.env.ENGRAM_SCOPE;
    }
  });

  it("rejects empty / whitespace scope and empty read_scopes with a clear error", async () => {
    const blank = await handleToolCall("remember", { content: "x", scope: "   " });
    expect(blank.isError).toBe(true);
    expect(blank.content[0].text as string).toMatch(/scope/i);
    expect(scopeOf("x")).toBeUndefined();

    const empty = await handleToolCall("recall", { query: "interview", read_scopes: [] });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text as string).toMatch(/read_scopes/i);

    const blankItem = await handleToolCall("recall", { query: "interview", read_scopes: ["global", ""] });
    expect(blankItem.isError).toBe(true);
  });
});

// ListTools advertises the params. Nesting matters: the keys must sit inside
// `properties`, not beside it — `additionalProperties: false` would reject
// them otherwise — so this reads the exported definitions, not the source.
describe("per-request scope params are advertised in the tool schemas", () => {
  let properties: (tool: string) => Record<string, unknown>;

  beforeAll(async () => {
    const { MCP_TOOL_DEFINITIONS } = await import("../../../src/interfaces/mcp/server.js");
    properties = (tool) => {
      const def = MCP_TOOL_DEFINITIONS.find((t) => t.name === tool);
      expect(def, tool).toBeDefined();
      expect(def!.inputSchema.additionalProperties).toBe(false);
      return def!.inputSchema.properties as Record<string, unknown>;
    };
  });

  it.each(["recall", "recall_session"])("%s declares scope and read_scopes inside properties", (tool) => {
    const props = properties(tool);
    expect(props.scope).toBeDefined();
    expect(props.read_scopes).toBeDefined();
  });

  it.each(["remember", "remember_batch"])("%s declares scope inside properties", (tool) => {
    const props = properties(tool);
    expect(props.scope).toBeDefined();
    expect(props.read_scopes).toBeUndefined();
  });

  it("recall_drill is untouched (drills an already-scoped session result)", () => {
    expect(properties("recall_drill").scope).toBeUndefined();
  });

  it("ingest_turn declares an optional closed author {id, name, is_bot} object (#18)", () => {
    const props = properties("ingest_turn");
    expect(props.author).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        is_bot: { type: "boolean" },
      },
    });
    expect((props.author as { required?: string[] }).required).toBeUndefined();
  });
});
