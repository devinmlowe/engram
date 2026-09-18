/**
 * #55 `forget` MCP tool — HTTP worker-pool mode.
 *
 * The same acceptance flow as forget-tool.test.ts, but over the real
 * Streamable-HTTP front end with tool calls dispatched to a REAL
 * worker_threads worker (tests/interfaces/mcp/fixtures/forget-worker.ts,
 * loaded through tsx by forget-worker-entry.mjs). The worker runs the real `handleToolCall` for
 * `forget`, so this proves: the client's `clientInfo.name` survives
 * transport → dispatcher → pool → worker and lands in the change log, and
 * the forget happens on the worker's own DB connection.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The main thread never runs a tool here (everything routes to the worker),
// but importing server.ts must not try to load a model.
vi.mock("../../../src/_core/embeddings/index.js", () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  embedQuery: vi.fn(),
  embedDocument: vi.fn(),
  embedDocumentBatch: vi.fn(),
  getActiveModel: vi.fn().mockReturnValue("mock-model"),
  resetEmbeddings: vi.fn(),
}));

const tmpDir = mkdtempSync(join(tmpdir(), "engram-forget-http-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "forget-http.db");
process.env.ENGRAM_DATA_DIR = tmpDir;
process.env.ENGRAM_RERANK_ENABLED = "0";
delete process.env.ENGRAM_SCOPE;
delete process.env.ENGRAM_READ_SCOPES;

const FIXTURE = fileURLToPath(new URL("./fixtures/forget-worker-entry.mjs", import.meta.url));
const FACT = "The nightly dream run starts at 02:00 local time";
const silent = () => {};

function memoryRow(content: string): { id: string; is_active: number; deleted_by: string | null } | undefined {
  const db = new Database(process.env.ENGRAM_DB_PATH!, { readonly: true });
  try {
    return db.prepare("SELECT id, is_active, deleted_by FROM memories WHERE content = ?").get(content) as
      | { id: string; is_active: number; deleted_by: string | null }
      | undefined;
  } finally {
    db.close();
  }
}

function changeActors(memoryId: string): string[] {
  const db = new Database(process.env.ENGRAM_DB_PATH!, { readonly: true });
  try {
    return (db.prepare("SELECT actor FROM memory_changes WHERE memory_id = ? ORDER BY at").all(memoryId) as Array<{ actor: string }>).map((r) => r.actor);
  } finally {
    db.close();
  }
}

function text(res: unknown): string {
  return (res as { content: Array<{ type: string; text?: string }> }).content.map((c) => c.text ?? "").join("\n");
}

describe("forget over HTTP with worker-pool dispatch", () => {
  let client: Client;
  let http: import("../../../src/interfaces/mcp/http.js").EngramHttpServer;
  let dispatcher: import("../../../src/interfaces/mcp/dispatch.js").ToolDispatcher;

  beforeAll(async () => {
    const { registerToolHandlers, handleToolCall } = await import("../../../src/interfaces/mcp/server.js");
    const { createToolDispatcher } = await import("../../../src/interfaces/mcp/dispatch.js");
    const { createEngramHttpServer } = await import("../../../src/interfaces/mcp/http.js");

    dispatcher = createToolDispatcher({
      workers: 1,
      direct: handleToolCall,
      spawn: () => new Worker(FIXTURE),
      timeoutMs: 20_000,
      log: silent,
    });
    await dispatcher.whenReady();

    http = createEngramHttpServer({
      port: 0,
      registerHandlers: (srv) => registerToolHandlers(srv, dispatcher.call),
      health: () => ({ workers: dispatcher.stats() ?? { size: 0 } }),
      log: silent,
    });
    const { port } = await http.listen();

    client = new Client({ name: "hermes-career", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await http?.close();
    await dispatcher?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("advertises forget and routes it to the worker pool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("forget");
    expect(dispatcher.workers).toBe(1);
    expect(dispatcher.stats()).toMatchObject({ size: 1, ready: 1, respawns: 0 });
    const { WORKER_TOOLS } = await import("../../../src/interfaces/mcp/dispatch.js");
    expect(WORKER_TOOLS.has("forget")).toBe(true);
  });

  it("remember → recall (id) → forget <id> → recall empty, actor = clientInfo.name, executed in the worker", async () => {
    const remembered = await client.callTool({ name: "remember", arguments: { content: FACT } });
    expect(text(remembered)).toContain("Remembered:");
    const row = memoryRow(FACT)!;
    expect(row.is_active).toBe(1);

    const before = text(await client.callTool({ name: "recall", arguments: { query: FACT } }));
    expect(before).toContain(`<semantic id="${row.id}"`);

    const forgotten = await client.callTool({ name: "forget", arguments: { memory_id: row.id } });
    expect(forgotten.isError).toBeFalsy();
    expect(text(forgotten)).toContain(`<forgotten id="${row.id}"`);
    expect(text(forgotten)).toContain('actor="hermes-career"');

    const after = text(await client.callTool({ name: "recall", arguments: { query: FACT } }));
    expect(after).not.toContain("<semantic");
    expect(after).toContain('total_results="0"');

    expect(memoryRow(FACT)).toMatchObject({ is_active: 0, deleted_by: "hermes-career" });
    expect(changeActors(row.id)).toEqual(["hermes-career"]);
    // the whole flow ran in the worker: the pool is intact and idle again
    expect(dispatcher.stats()).toMatchObject({ size: 1, ready: 1, busy: 0, respawns: 0 });
  }, 30_000);
});
