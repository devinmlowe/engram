/**
 * Tool dispatcher tests: stdio-mode isolation (no workers are ever spawned),
 * worker routing in HTTP mode, session affinity, timeout selection and env
 * parsing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  argsDigest,
  createToolDispatcher,
  parseWorkerCount,
  parseTimeoutMs,
  toolTimeoutMs,
  WORKER_TOOLS,
  DEFAULT_WORKER_TIMEOUT_MS,
  type ToolDispatcher,
  type ToolResult,
} from "../../../src/interfaces/mcp/dispatch.js";
import { MCP_TOOL_NAMES } from "../../../src/interfaces/mcp/tool-names.js";
import { FakeWorker, type Behaviour } from "../../mocks/fake-worker.js";

/** Answers every call from "its" worker; recall_session pins the session to it. */
const dispatchReply: Behaviour = (msg, reply, self) => {
  const sid = (msg.args as { session_id?: string } | undefined)?.session_id;
  const result: ToolResult =
    msg.tool === "recall_session"
      ? { content: [{ type: "text", text: "<engram_memory/>" }], sessionId: sid ?? `sess-from-worker-${self.index}` }
      : { content: [{ type: "text", text: `${msg.tool}@worker${self.index}` }] };
  reply({ id: msg.id, ok: true, result });
};

let dispatchers: ToolDispatcher[] = [];
const direct = vi.fn(async (name: string, args: unknown): Promise<ToolResult> => ({
  content: [{ type: "text", text: `${name}@main:${JSON.stringify(args)}` }],
}));
const spawn = vi.fn(() => new FakeWorker(dispatchReply));
const silent = () => {};

afterEach(async () => {
  await Promise.all(dispatchers.map((d) => d.close()));
  dispatchers = [];
  FakeWorker.instances = [];
  direct.mockClear();
  spawn.mockClear();
});

describe("createToolDispatcher — stdio / inline mode", () => {
  it("never spawns a worker and calls the inline handler directly", async () => {
    const d = createToolDispatcher({ workers: 0, direct, spawn, log: silent });
    dispatchers.push(d);
    expect(d.workers).toBe(0);
    expect(d.stats()).toBeNull();
    const result = await d.call("recall", { query: "x" });
    expect(result.content[0].text).toBe('recall@main:{"query":"x"}');
    expect(direct).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("does not require a spawn factory when workers is 0", async () => {
    const d = createToolDispatcher({ workers: 0, direct, log: silent });
    dispatchers.push(d);
    await expect(d.whenReady()).resolves.toBeUndefined();
    await expect(d.call("explore", {})).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("createToolDispatcher — worker mode", () => {
  it("requires a spawn factory", () => {
    expect(() => createToolDispatcher({ workers: 2, direct, log: silent })).toThrow(/spawn/);
  });

  it("spawns exactly N workers and routes DB-heavy tools to them", async () => {
    const d = createToolDispatcher({ workers: 2, direct, spawn, log: silent });
    dispatchers.push(d);
    await d.whenReady();
    expect(spawn).toHaveBeenCalledTimes(2);
    const result = await d.call("recall", { query: "x" });
    expect(result.content[0].text).toMatch(/^recall@worker\d$/);
    expect(direct).not.toHaveBeenCalled();
  });

  it("every registered MCP tool is worker-eligible", () => {
    for (const name of MCP_TOOL_NAMES) expect(WORKER_TOOLS.has(name)).toBe(true);
  });

  it("falls back to the inline handler for tools outside the worker table", async () => {
    const d = createToolDispatcher({ workers: 1, direct, spawn, log: silent });
    dispatchers.push(d);
    const result = await d.call("not_a_tool", {});
    expect(result.content[0].text).toBe("not_a_tool@main:{}");
    expect(FakeWorker.instances[0].sent).toHaveLength(0);
  });

  it("pins follow-up session calls to the worker that created the session", async () => {
    const d = createToolDispatcher({ workers: 3, direct, spawn, log: silent });
    dispatchers.push(d);
    await d.whenReady();

    // Occupy nothing; just create sessions and see which worker each lands on.
    const created = await d.call("recall_session", { query: "first" });
    const sid = created.sessionId!;
    expect(sid).toMatch(/^sess-from-worker-\d$/);
    const owner = Number(sid.slice(-1));

    // Follow-ups must all go to the owner, regardless of which workers are idle.
    for (const [tool, args] of [
      ["recall_drill", { session_id: sid, result_index: 0 }],
      ["fetch_snippets", { path: "/x", ranges: [{ start: 1, end: 2 }], session_id: sid }],
      ["scan_file", { path: "/x", patterns: ["a"], session_id: sid }],
      ["recall_session", { query: "refine", session_id: sid }],
    ] as const) {
      const r = await d.call(tool, args);
      expect(r.content[0].text.startsWith(`${tool}@worker${owner}`) || tool === "recall_session").toBe(true);
      const last = FakeWorker.instances[owner].sent.at(-1)!;
      expect(last.tool).toBe(tool);
    }
    const sentToOwner = FakeWorker.instances[owner].sent.length;
    expect(sentToOwner).toBe(5);
    const sentElsewhere = FakeWorker.instances.filter((_, i) => i !== owner).reduce((n, w) => n + w.sent.length, 0);
    expect(sentElsewhere).toBe(0);
  });

  it("calls without a session id are free to use any worker", async () => {
    const d = createToolDispatcher({ workers: 2, direct, spawn, log: silent });
    dispatchers.push(d);
    await d.whenReady();
    await d.call("recall_drill", { result_index: 0 });
    await d.call("fetch_snippets", { path: "/x", ranges: [] });
    expect(FakeWorker.instances.reduce((n, w) => n + w.sent.length, 0)).toBe(2);
  });

  it("converts a worker failure into an isError tool result instead of throwing", async () => {
    const broken: Behaviour = (msg, reply) => reply({ id: msg.id, ok: false, error: "sqlite exploded" });
    const d = createToolDispatcher({ workers: 1, direct, spawn: () => new FakeWorker(broken), log: silent });
    dispatchers.push(d);
    const r = await d.call("recall", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("sqlite exploded");
  });
});

describe("timeouts and env parsing", () => {
  it("uses the pool default for recall-class tools", () => {
    expect(toolTimeoutMs("recall", {}, 8000)).toBe(8000);
    expect(toolTimeoutMs("explore", {}, 8000)).toBe(8000);
    expect(toolTimeoutMs("recall", {}, 20_000)).toBe(20_000);
  });

  it("raises the floor for tools that legitimately run long", () => {
    expect(toolTimeoutMs("remember", {}, 8000)).toBeGreaterThanOrEqual(15_000 + 5_000);
    expect(toolTimeoutMs("remember_batch", {}, 8000)).toBeGreaterThan(toolTimeoutMs("remember", {}, 8000));
    expect(toolTimeoutMs("reflect", { refresh: false }, 8000)).toBe(8000);
    expect(toolTimeoutMs("reflect", { refresh: true }, 8000)).toBeGreaterThanOrEqual(60_000);
  });

  it("parses ENGRAM_HTTP_WORKERS with a safe fallback", () => {
    expect(parseWorkerCount(undefined, 2)).toBe(2);
    expect(parseWorkerCount("", 2)).toBe(2);
    expect(parseWorkerCount("4", 2)).toBe(4);
    expect(parseWorkerCount("0", 2)).toBe(0);
    expect(parseWorkerCount("-1", 2)).toBe(2);
    expect(parseWorkerCount("lots", 2)).toBe(2);
  });

  it("parses ENGRAM_WORKER_TIMEOUT_MS with a safe fallback", () => {
    expect(parseTimeoutMs(undefined, DEFAULT_WORKER_TIMEOUT_MS)).toBe(8000);
    expect(parseTimeoutMs("12000", 8000)).toBe(12000);
    expect(parseTimeoutMs("0", 8000)).toBe(8000);
    expect(parseTimeoutMs("nope", 8000)).toBe(8000);
  });

  it("argsDigest renders args on one line and caps the length", () => {
    // JSON escapes the newline; runs of literal whitespace collapse to one space
    expect(argsDigest({ query: "a\nb   c" })).toBe('{"query":"a\\nb c"}');
    const long = argsDigest({ query: "x".repeat(500) }, 40);
    expect(long.length).toBeLessThan(80);
    expect(long).toMatch(/…\(\d+ chars\)$/);
    expect(argsDigest(undefined)).toBe("undefined");
  });
});
