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

vi.mock("../../../src/_core/embeddings/index.js", async () =>
  (await import("../../mocks/embeddings.js")).deterministicEmbeddings(),
);

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

  it("remember_batch rejects an unknown key on an item instead of ignoring it (#43)", async () => {
    const res = await handleToolCall("remember_batch", {
      memories: [{ content: "Strict batch item", bogus_field: "ignored before #43" }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text as string).toMatch(/bogus_field|unrecognized/i);
    expect(scopeOf("Strict batch item")).toBeUndefined();
  });

  it("episodic recall honours read_scopes: a turn ingested under a profile is hidden from others (#25)", async () => {
    const turn = await handleToolCall("ingest_turn", {
      session_id: "sess-scoped", turn_index: 0, scope: "hermes:career",
      user_text: "Rehearse the Databricks system design interview on Thursday",
      assistant_text: "Noted: Thursday rehearsal for the Databricks interview.",
    });
    expect(turn.isError, turn.content[0].text as string).toBeFalsy();
    const visible = await handleToolCall("recall", { query: "Databricks rehearsal Thursday", sources: ["episodic"], read_scopes: ["global", "hermes:career"] });
    // the header echoes the query, so assert on the assistant text only
    expect(visible.content[0].text as string).toContain("Noted: Thursday rehearsal");
    const hidden = await handleToolCall("recall", { query: "Databricks rehearsal Thursday", sources: ["episodic"], read_scopes: ["global", "hermes:finance"] });
    expect(hidden.content[0].text as string).not.toContain("Noted: Thursday rehearsal");
    const unscoped = await handleToolCall("recall", { query: "Databricks rehearsal Thursday", sources: ["episodic"] });
    expect(unscoped.content[0].text as string).toContain("Noted: Thursday rehearsal");
  });

  it("explore and commitments honour read_scopes (#25)", async () => {
    const { insertEntity } = await import("../../../src/graph/entity.js");
    const { findOrCreateRelationship } = await import("../../../src/graph/relationship.js");
    const { insertCommitments } = await import("../../../src/semantic/commitments.js");
    const { getDatabase } = await import("../../../src/_core/db/index.js");
    const db = getDatabase();
    const vec = (n: number) => { const v = Array.from({ length: 256 }, (_, i) => Math.cos(n + i)); const l = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / l); };
    insertEntity(db, { id: "ent-hub", name: "ScopeHub", type: "concept", aliases: [], firstSeen: 1, lastSeen: 1, mentionCount: 1, createdAt: 1 }, vec(1));
    insertEntity(db, { id: "ent-career", name: "CareerOnly", type: "concept", aliases: [], firstSeen: 1, lastSeen: 1, mentionCount: 1, createdAt: 1, scope: "hermes:career" }, vec(2));
    findOrCreateRelationship(db, "ent-hub", "ent-career", "related_to", undefined, undefined, "hermes:career");
    const career = await handleToolCall("explore", { entity: "ScopeHub", read_scopes: ["global", "hermes:career"] });
    expect(career.content[0].text as string).toContain("CareerOnly");
    const finance = await handleToolCall("explore", { entity: "ScopeHub", read_scopes: ["global", "hermes:finance"] });
    expect(finance.content[0].text as string).not.toContain("CareerOnly");
    const direct = await handleToolCall("explore", { entity: "CareerOnly", read_scopes: ["global", "hermes:finance"] });
    expect(direct.isError).toBe(true);

    insertCommitments(db, [{ content: "Book the PMP exam slot", origin: "stated", subject: "devin", sourceExchangeIds: [], dueHint: null }], new Map(), "hermes:pmp");
    const pmp = await handleToolCall("commitments", { read_scopes: ["global", "hermes:pmp"] });
    expect(pmp.content[0].text as string).toContain("PMP exam");
    const notPmp = await handleToolCall("commitments", { read_scopes: ["global", "hermes:career"] });
    expect(notPmp.content[0].text as string).not.toContain("PMP exam");
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
      // …and the call cannot widen past the env (#108): read_scopes intersects, scope must be readable
      const escape = await handleToolCall("recall", { query: "interview", sources: ["semantic"], read_scopes: ["hermes:career"] });
      expect(escape.isError).toBe(true);
      expect(escape.content[0].text as string).toContain("no scope inside");
      const write = await handleToolCall("remember", { content: "leak", scope: "hermes:career" });
      expect(write.isError).toBe(true);
      expect(write.content[0].text as string).toContain("outside");
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

  it.each(["recall", "recall_session", "explore", "explore_selective", "commitments"])("%s declares scope and read_scopes inside properties", (tool) => {
    const props = properties(tool);
    expect(props.scope).toBeDefined();
    expect(props.read_scopes).toBeDefined();
  });

  it.each(["remember", "remember_batch"])("%s declares scope inside properties", (tool) => {
    const props = properties(tool);
    expect(props.scope).toBeDefined();
    expect(props.read_scopes).toBeUndefined();
  });

  it("remember_batch items are closed like remember itself (#43)", () => {
    const props = properties("remember_batch");
    const items = (props.memories as { items: { additionalProperties?: boolean; required: string[] } }).items;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["content"]);
  });

  it("recall_drill is untouched (drills an already-scoped session result)", () => {
    expect(properties("recall_drill").scope).toBeUndefined();
  });

  it.each(["remember", "remember_batch"])("%s source enum includes hermes-mirror and context is a bounded string (#19)", (tool) => {
    const props = properties(tool);
    const memoryProps = tool === "remember"
      ? props
      : ((props.memories as { items: { properties: Record<string, unknown> } }).items.properties);
    expect(memoryProps.source).toMatchObject({
      type: "string",
      enum: ["user", "dream", "rlm", "import", "hermes-mirror"],
    });
    expect(memoryProps.context).toMatchObject({ type: "string", maxLength: 500 });
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
