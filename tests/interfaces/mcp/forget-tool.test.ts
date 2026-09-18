/**
 * #55 `forget` MCP tool — stdio mode.
 *
 * Acceptance: remember "X" → recall "X" finds it (with a memory id the agent
 * can pass back) → forget <id> → recall "X" returns nothing. Driven through a
 * real `Server` over the SDK's in-memory transport (what stdio does minus the
 * pipes) so the actor recorded in the change log is the client's
 * `clientInfo.name`. Query-mode safety and scope refusal go through
 * `handleToolCall` directly. The HTTP worker-pool path is in
 * forget-tool-http.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  // Query and document embeddings share a seed so recall of the exact text hits.
  return {
    initEmbeddings: vi.fn().mockResolvedValue(undefined),
    embedQuery: vi.fn().mockImplementation((text: string) => Promise.resolve(deterministicVector(`doc:${text}`))),
    embedDocument: vi.fn().mockImplementation((text: string) => Promise.resolve(deterministicVector(`doc:${text}`))),
    embedDocumentBatch: vi.fn().mockImplementation((texts: string[]) => Promise.resolve(texts.map((t) => deterministicVector(`doc:${t}`)))),
    embedExchange: vi.fn().mockImplementation((u: string, a: string) => Promise.resolve(deterministicVector(`ex:${u}|${a}`))),
    getActiveModel: vi.fn().mockReturnValue("mock-model"),
    resetEmbeddings: vi.fn(),
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), "engram-forget-tool-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "forget.db");
process.env.ENGRAM_DATA_DIR = tmpDir;
process.env.ENGRAM_RERANK_ENABLED = "0";
delete process.env.ENGRAM_SCOPE;
delete process.env.ENGRAM_READ_SCOPES;

const FACT = "The staging cluster runs Kubernetes 1.31 on Hetzner";

function ro(): Database.Database {
  return new Database(process.env.ENGRAM_DB_PATH!, { readonly: true });
}

function memoryRow(content: string): { id: string; is_active: number; deleted_at: string | null; deleted_by: string | null } | undefined {
  const db = ro();
  try {
    return db.prepare("SELECT id, is_active, deleted_at, deleted_by FROM memories WHERE content = ?").get(content) as
      | { id: string; is_active: number; deleted_at: string | null; deleted_by: string | null }
      | undefined;
  } finally {
    db.close();
  }
}

function changes(memoryId: string): Array<{ op: string; actor: string; before: string | null }> {
  const db = ro();
  try {
    return db.prepare("SELECT op, actor, before FROM memory_changes WHERE memory_id = ? ORDER BY at").all(memoryId) as Array<{
      op: string;
      actor: string;
      before: string | null;
    }>;
  } finally {
    db.close();
  }
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("forget tool over a real Server (stdio-equivalent in-memory transport)", () => {
  let client: Client;
  let server: Server;

  beforeAll(async () => {
    const { registerToolHandlers } = await import("../../../src/interfaces/mcp/server.js");
    server = new Server({ name: "engram", version: "test" }, { capabilities: { tools: {} } });
    registerToolHandlers(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "claude-code-test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("lists forget with destructive annotations", async () => {
    const { tools } = await client.listTools();
    const forget = tools.find((t) => t.name === "forget")!;
    expect(forget).toBeDefined();
    expect(forget.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools).toHaveLength(16);
  });

  it("remember → recall (with id) → forget <id> → recall returns nothing; actor is clientInfo.name", async () => {
    const remembered = await client.callTool({ name: "remember", arguments: { content: FACT } });
    expect(remembered.isError).toBeFalsy();
    const row = memoryRow(FACT)!;
    expect(row.is_active).toBe(1);

    const before = await client.callTool({ name: "recall", arguments: { query: FACT, sources: ["semantic"] } });
    const beforeXml = text(before as { content: Array<{ type: string; text?: string }> });
    expect(beforeXml).toContain(`<semantic id="${row.id}"`);
    expect(beforeXml).toContain("Kubernetes 1.31");

    const forgotten = await client.callTool({ name: "forget", arguments: { memory_id: row.id } });
    expect(forgotten.isError).toBeFalsy();
    const forgottenXml = text(forgotten as { content: Array<{ type: string; text?: string }> });
    expect(forgottenXml).toContain(`<forgotten id="${row.id}"`);
    expect(forgottenXml).toContain('actor="claude-code-test"');
    expect(forgottenXml).toContain('hard="false"');

    const after = await client.callTool({ name: "recall", arguments: { query: FACT, sources: ["semantic"] } });
    const afterXml = text(after as { content: Array<{ type: string; text?: string }> });
    expect(afterXml).not.toContain("<semantic");
    expect(afterXml).toMatch(/total_results="0"/);

    expect(memoryRow(FACT)).toMatchObject({ is_active: 0, deleted_by: "claude-code-test" });
    expect(changes(row.id)).toEqual([{ op: "forget", actor: "claude-code-test", before: FACT }]);

    // forgetting it again is refused, not silently repeated
    const again = await client.callTool({ name: "forget", arguments: { memory_id: row.id } });
    expect(again.isError).toBe(true);
    expect(text(again as { content: Array<{ type: string; text?: string }> })).toMatch(/already forgotten/);
  });

  it("rejects calls with both or neither of memory_id / query", async () => {
    const neither = await client.callTool({ name: "forget", arguments: {} });
    expect(neither.isError).toBe(true);
    expect(text(neither as { content: Array<{ type: string; text?: string }> })).toMatch(/exactly one of memory_id or query/);
    const both = await client.callTool({ name: "forget", arguments: { memory_id: "abcdef", query: "abc" } });
    expect(both.isError).toBe(true);
  });
});

describe("forget query mode never deletes on a weak match (handleToolCall)", () => {
  let handleToolCall: typeof import("../../../src/interfaces/mcp/server.js").handleToolCall;
  const A = "Our on-call rotation swaps every Monday at 09:00";
  const B = "Our on-call rotation swaps every Tuesday at 09:00";

  beforeAll(async () => {
    ({ handleToolCall } = await import("../../../src/interfaces/mcp/server.js"));
    await handleToolCall("remember", { content: A });
    await handleToolCall("remember", { content: B });
  });

  it("without confirm: returns candidates with ids, forgets nothing", async () => {
    const res = await handleToolCall("forget", { query: "on-call rotation swaps" });
    expect(res.isError).toBeFalsy();
    const xml = text(res);
    expect(xml).toMatch(/<forget_candidates [^>]*forgotten="none"/);
    expect(xml).toContain('reason="confirm was not set"');
    expect(xml).toContain(`<candidate id="${memoryRow(A)!.id}"`);
    expect(xml).toContain(`<candidate id="${memoryRow(B)!.id}"`);
    expect(memoryRow(A)!.is_active).toBe(1);
    expect(memoryRow(B)!.is_active).toBe(1);
  });

  it("with confirm but several candidates and no exact match: forgets nothing", async () => {
    const res = await handleToolCall("forget", { query: "on-call rotation swaps", confirm: true });
    expect(res.isError).toBeFalsy();
    const xml = text(res);
    expect(xml).toContain('forgotten="none"');
    expect(xml).toMatch(/ambiguous/);
    expect(xml).toContain("Call forget again with memory_id");
    expect(memoryRow(A)!.is_active).toBe(1);
    expect(memoryRow(B)!.is_active).toBe(1);
  });

  it("with confirm and exactly one exact-content match: forgets that one only", async () => {
    const res = await handleToolCall("forget", { query: "our on-call rotation swaps every monday at 09:00", confirm: true }, { clientName: "hermes-career" });
    expect(res.isError).toBeFalsy();
    const xml = text(res);
    expect(xml).toContain(`<forgotten id="${memoryRow(A)!.id}"`);
    expect(memoryRow(A)).toMatchObject({ is_active: 0, deleted_by: "hermes-career" });
    expect(memoryRow(B)!.is_active).toBe(1);
  });

  it("with confirm and a single remaining candidate: forgets it", async () => {
    const res = await handleToolCall("forget", { query: "on-call rotation swaps", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain(`<forgotten id="${memoryRow(B)!.id}"`);
    expect(memoryRow(B)!.is_active).toBe(0);
    // actor falls back to "mcp" when the transport gave no client name
    expect(memoryRow(B)!.deleted_by).toBe("mcp");
  });

  it("with confirm and nothing matching: says so", async () => {
    const res = await handleToolCall("forget", { query: "on-call rotation swaps", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('count="0"');
    expect(text(res)).toContain("No memory matched");
  });

  it("memory_id accepts a unique prefix and reports unknown ids", async () => {
    await handleToolCall("remember", { content: "Prefix-addressable memory" });
    const id = memoryRow("Prefix-addressable memory")!.id;
    const res = await handleToolCall("forget", { memory_id: id.slice(0, 8) });
    expect(res.isError).toBeFalsy();
    expect(memoryRow("Prefix-addressable memory")!.is_active).toBe(0);
    const missing = await handleToolCall("forget", { memory_id: "000000-not-a-memory" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/Memory not found/);
  });

  it("hard: true deletes the row outright", async () => {
    await handleToolCall("remember", { content: "Hard-deleted memory" });
    const id = memoryRow("Hard-deleted memory")!.id;
    const res = await handleToolCall("forget", { memory_id: id, hard: true });
    expect(text(res)).toContain('hard="true"');
    expect(memoryRow("Hard-deleted memory")).toBeUndefined();
    expect(changes(id).map((c) => c.op)).toEqual(["forget", "purge"]);
  });
});

describe("forget honours read_scopes (#25)", () => {
  let handleToolCall: typeof import("../../../src/interfaces/mcp/server.js").handleToolCall;
  const HOME = "The boiler service is booked for October";

  beforeAll(async () => {
    ({ handleToolCall } = await import("../../../src/interfaces/mcp/server.js"));
    await handleToolCall("remember", { content: HOME, scope: "hermes:home" });
  });

  it("refuses a memory outside read_scopes and does not log a change", async () => {
    const id = memoryRow(HOME)!.id;
    const res = await handleToolCall("forget", { memory_id: id, read_scopes: ["global", "hermes:career"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/outside read_scopes/);
    expect(memoryRow(HOME)!.is_active).toBe(1);
    expect(changes(id)).toEqual([]);
  });

  it("query mode does not even list memories outside read_scopes", async () => {
    const id = memoryRow(HOME)!.id;
    const res = await handleToolCall("forget", { query: HOME, read_scopes: ["global", "hermes:career"], confirm: true });
    expect(res.isError).toBeFalsy();
    const xml = text(res);
    expect(xml).toContain('forgotten="none"');
    expect(xml).not.toContain(id);
    expect(memoryRow(HOME)!.is_active).toBe(1);
  });

  it('scope: "global" acts across scopes', async () => {
    const id = memoryRow(HOME)!.id;
    const res = await handleToolCall("forget", { memory_id: id, read_scopes: ["global", "hermes:career"], scope: "global" });
    expect(res.isError).toBeFalsy();
    expect(memoryRow(HOME)!.is_active).toBe(0);
  });
});
