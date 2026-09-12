/**
 * THE regression test for the original complaint: on the single-threaded
 * HTTP server a recall blocked `/health` for ~3s. With tool calls dispatched
 * to worker threads, `/health` must answer immediately while a slow recall is
 * in flight.
 *
 * Uses a REAL worker_threads fixture (tests/interfaces/mcp/fixtures/
 * fake-tool-worker.mjs) whose `recall` busy-loops synchronously — a genuine
 * off-main-thread block, not a setTimeout — plus the real StreamableHTTP
 * transport and SDK client, so the whole path is exercised end to end.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createEngramHttpServer, type EngramHttpServer } from "../../../src/interfaces/mcp/http.js";
import { createToolDispatcher, type ToolDispatcher, type ToolResult } from "../../../src/interfaces/mcp/dispatch.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-tool-worker.mjs", import.meta.url));
const silent = () => {};

function registerFakeTools(callTool: (name: string, args: unknown) => Promise<ToolResult>) {
  return (srv: Server) => {
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "recall", description: "slow fake recall", inputSchema: { type: "object", properties: { query: { type: "string" }, ms: { type: "number" } } } },
        { name: "whoami", description: "reports the worker thread id", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    srv.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments));
  };
}

async function timedHealth(port: number): Promise<{ ms: number; body: { status: string; workers?: unknown } }> {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await res.json()) as { status: string; workers?: unknown };
  return { ms: performance.now() - t0, body };
}

let servers: EngramHttpServer[] = [];
let dispatchers: ToolDispatcher[] = [];
let clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await Promise.allSettled(servers.map((s) => s.close()));
  await Promise.allSettled(dispatchers.map((d) => d.close()));
  clients = [];
  servers = [];
  dispatchers = [];
});

async function startServer(workers: number, direct?: (name: string, args: unknown) => Promise<ToolResult>) {
  const dispatcher = createToolDispatcher({
    workers,
    direct: direct ?? (async () => ({ content: [{ type: "text", text: "inline" }] })),
    spawn: () => new Worker(FIXTURE),
    timeoutMs: 10_000,
    log: silent,
  });
  dispatchers.push(dispatcher);
  await dispatcher.whenReady();
  const http = createEngramHttpServer({
    port: 0,
    registerHandlers: registerFakeTools(dispatcher.call),
    health: () => ({ workers: dispatcher.stats() ?? { size: 0 } }),
    log: silent,
  });
  servers.push(http);
  const { port } = await http.listen();
  return { port, dispatcher, http };
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: "health-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return client;
}

describe("HTTP server with worker-pool dispatch", () => {
  it("answers the MCP initialize handshake with 200 and a session id", async () => {
    const { port } = await startServer(1);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    await res.text();
  });

  it("/health stays fast (<500ms) while a 2s recall is executing in a worker", async () => {
    const { port } = await startServer(1);
    const client = await connectClient(port);

    // Baseline: health is fast on an idle server.
    const idle = await timedHealth(port);
    expect(idle.body.status).toBe("ok");
    expect(idle.ms).toBeLessThan(500);

    // Fire a recall that blocks its worker for 2000ms, then IMMEDIATELY probe /health.
    const recallStarted = performance.now();
    const recall = client.callTool({ name: "recall", arguments: { query: "block", ms: 2000 } });
    await new Promise((r) => setTimeout(r, 50)); // let the request reach the worker
    const probe = await timedHealth(port);

    expect(probe.body.status).toBe("ok");
    expect(probe.ms).toBeLessThan(500);
    expect(probe.body.workers).toMatchObject({ size: 1, busy: 1 });

    // The recall still completes normally, and really did take its 2s.
    const result = (await recall) as { content: Array<{ type: string; text: string }> };
    expect(performance.now() - recallStarted).toBeGreaterThanOrEqual(1900);
    expect(result.content[0].text).toContain('slow="2000"');

    // list-tools (main thread) also works after the churn
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["recall", "whoami"]);
  }, 15_000);

  it("two concurrent recalls on a 2-worker pool run in parallel on different threads", async () => {
    const { port } = await startServer(2);
    const client = await connectClient(port);
    const t0 = performance.now();
    const [a, b] = await Promise.all([
      client.callTool({ name: "recall", arguments: { query: "a", ms: 700 } }),
      client.callTool({ name: "recall", arguments: { query: "b", ms: 700 } }),
    ]);
    const elapsed = performance.now() - t0;
    expect((a as ToolResult).content[0].text).toContain('query="a"');
    expect((b as ToolResult).content[0].text).toContain('query="b"');
    // Serial execution would need ≥1400ms; parallel finishes well under that.
    expect(elapsed).toBeLessThan(1300);
  }, 15_000);
});
