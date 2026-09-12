/**
 * WorkerPool unit tests — in-process fake workers so timing is deterministic.
 * (Real-thread behaviour is covered by http-health.test.ts.)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  WorkerPool,
  WorkerTimeoutError,
  WorkerCrashedError,
  WorkerPoolClosedError,
  type WorkerLike,
} from "../../../src/interfaces/mcp/worker-pool.js";

// ─── Fake worker ────────────────────────────────────────────────

type Behaviour = (
  msg: { id: number; tool: string; args: unknown },
  reply: (m: unknown) => void,
  self: FakeWorker,
) => void;

class FakeWorker extends EventEmitter implements WorkerLike {
  static instances: FakeWorker[] = [];
  terminated = false;
  sent: unknown[] = [];

  constructor(private behaviour: Behaviour, options: { autoReady?: boolean } = {}) {
    super();
    FakeWorker.instances.push(this);
    if (options.autoReady !== false) queueMicrotask(() => this.emit("message", { type: "ready" }));
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
    const msg = message as { id: number; tool: string; args: unknown };
    this.behaviour(msg, (m) => queueMicrotask(() => this.emit("message", m)), this);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }

  /** Simulate a crash (unexpected exit). */
  crash(code = 2): void {
    this.emit("exit", code);
  }
}

const echo: Behaviour = (msg, reply) => reply({ id: msg.id, ok: true, result: { echoed: msg.args, tool: msg.tool } });
const never: Behaviour = () => {};
const silentLog = () => {};

let pools: WorkerPool[] = [];
const makePool = (opts: ConstructorParameters<typeof WorkerPool>[0]) => {
  const p = new WorkerPool({ log: silentLog, ...opts });
  pools.push(p);
  return p;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.map((p) => p.close()));
  pools = [];
  FakeWorker.instances = [];
});

// ─── Tests ──────────────────────────────────────────────────────

describe("WorkerPool", () => {
  it("round-trips a tool call through a worker", async () => {
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(echo) });
    const result = await pool.run("recall", { query: "hi" });
    expect(result).toEqual({ echoed: { query: "hi" }, tool: "recall" });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].sent).toEqual([{ id: 1, tool: "recall", args: { query: "hi" } }]);
  });

  it("propagates a worker-side error as a rejection", async () => {
    const failing: Behaviour = (msg, reply) => reply({ id: msg.id, ok: false, error: "boom" });
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(failing) });
    await expect(pool.run("recall", {})).rejects.toThrow("boom");
  });

  it("queues calls until a worker reports ready, then runs them", async () => {
    let worker: FakeWorker | undefined;
    const pool = makePool({ size: 1, spawn: () => (worker = new FakeWorker(echo, { autoReady: false })) });
    const pending = pool.run("recall", { n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.stats()).toMatchObject({ ready: 0, busy: 0, queued: 1 });
    worker!.emit("message", { type: "ready" });
    await expect(pending).resolves.toEqual({ echoed: { n: 1 }, tool: "recall" });
  });

  it("runs at most one call per worker and spreads load across the pool", async () => {
    const pool = makePool({ size: 2, spawn: () => new FakeWorker(never) });
    await pool.whenReady();
    const a = pool.runWithSlot("recall", { a: 1 });
    const b = pool.runWithSlot("recall", { b: 1 });
    const c = pool.run("recall", { c: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.stats()).toMatchObject({ size: 2, busy: 2, queued: 1 });
    const [w0, w1] = FakeWorker.instances;
    expect(w0.sent).toHaveLength(1);
    expect(w1.sent).toHaveLength(1);
    // answer both; the queued third call should then be dispatched
    w0.emit("message", { id: (w0.sent[0] as { id: number }).id, ok: true, result: "a" });
    w1.emit("message", { id: (w1.sent[0] as { id: number }).id, ok: true, result: "b" });
    expect((await a).slot).toBe(0);
    expect((await b).slot).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    const third = [w0, w1].find((w) => w.sent.length === 2)!;
    expect(third).toBeDefined();
    third.emit("message", { id: (third.sent[1] as { id: number }).id, ok: true, result: "c" });
    await expect(c).resolves.toBe("c");
  });

  it("honours affinity by waiting for the pinned worker", async () => {
    const pool = makePool({ size: 2, spawn: () => new FakeWorker(never) });
    await pool.whenReady();
    const first = pool.runWithSlot("recall_session", {});
    await new Promise((r) => setTimeout(r, 2));
    const pinned = pool.runWithSlot("recall_drill", {}, { affinity: 0 });
    await new Promise((r) => setTimeout(r, 2));
    // slot 1 is idle but the pinned call must not go there
    expect(pool.stats()).toMatchObject({ busy: 1, queued: 1 });
    const w0 = FakeWorker.instances[0];
    w0.emit("message", { id: (w0.sent[0] as { id: number }).id, ok: true, result: "s" });
    expect((await first).slot).toBe(0);
    await new Promise((r) => setTimeout(r, 2));
    expect(w0.sent).toHaveLength(2);
    w0.emit("message", { id: (w0.sent[1] as { id: number }).id, ok: true, result: "d" });
    expect(await pinned).toEqual({ result: "d", slot: 0 });
  });

  it("rejects a call that exceeds its timeout but keeps the worker alive", async () => {
    vi.useFakeTimers();
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(never), timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(1); // let ready land
    const call = pool.run("recall", {});
    const rejection = expect(call).rejects.toBeInstanceOf(WorkerTimeoutError);
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    expect(pool.stats().respawns).toBe(0);
    // the worker is still marked busy until it answers or hangs past 2×
    expect(pool.stats().busy).toBe(1);
  });

  it("frees the worker when a late answer arrives after the timeout", async () => {
    vi.useFakeTimers();
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(never), timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(1);
    const call = pool.run("recall", {});
    const rejection = expect(call).rejects.toBeInstanceOf(WorkerTimeoutError);
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    const w = FakeWorker.instances[0];
    w.emit("message", { id: (w.sent[0] as { id: number }).id, ok: true, result: "late" });
    await vi.advanceTimersByTimeAsync(1);
    expect(pool.stats()).toMatchObject({ busy: 0, respawns: 0 });
    // and it accepts new work
    const next = pool.run("recall", { again: true });
    await vi.advanceTimersByTimeAsync(1);
    w.emit("message", { id: (w.sent[1] as { id: number }).id, ok: true, result: "fresh" });
    await expect(next).resolves.toBe("fresh");
  });

  it("kills and respawns a worker that hangs past 2× the timeout, then serves new calls", async () => {
    vi.useFakeTimers();
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(never), timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(1);
    const hung = pool.run("recall", {});
    const rejection = expect(hung).rejects.toBeInstanceOf(WorkerTimeoutError);
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(FakeWorker.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100); // reaches 2× timeout
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(pool.stats()).toMatchObject({ size: 1, respawns: 1, busy: 0 });

    // the replacement worker takes new work
    const next = pool.run("recall", { after: "respawn" });
    await vi.advanceTimersByTimeAsync(1);
    const w = FakeWorker.instances[1];
    expect(w.sent).toHaveLength(1);
    w.emit("message", { id: (w.sent[0] as { id: number }).id, ok: true, result: "ok" });
    await expect(next).resolves.toBe("ok");
  });

  it("respawns a crashed worker and rejects its in-flight call", async () => {
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(never) });
    await pool.whenReady();
    const call = pool.run("recall", {});
    await new Promise((r) => setTimeout(r, 2));
    FakeWorker.instances[0].crash(9);
    await expect(call).rejects.toBeInstanceOf(WorkerCrashedError);
    await pool.whenReady();
    expect(FakeWorker.instances).toHaveLength(2);
    expect(pool.stats().respawns).toBe(1);
    const ok = pool.run("recall", {});
    await new Promise((r) => setTimeout(r, 2));
    const w = FakeWorker.instances[1];
    w.emit("message", { id: (w.sent[0] as { id: number }).id, ok: true, result: 42 });
    await expect(ok).resolves.toBe(42);
  });

  it("close() terminates workers and rejects queued and in-flight calls", async () => {
    const pool = makePool({ size: 1, spawn: () => new FakeWorker(never) });
    await pool.whenReady();
    const inflight = pool.run("recall", {});
    const queued = pool.run("recall", {});
    await new Promise((r) => setTimeout(r, 2));
    await pool.close();
    await expect(inflight).rejects.toBeInstanceOf(WorkerPoolClosedError);
    await expect(queued).rejects.toBeInstanceOf(WorkerPoolClosedError);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await expect(pool.run("recall", {})).rejects.toBeInstanceOf(WorkerPoolClosedError);
  });

  it("rejects an invalid pool size", () => {
    expect(() => new WorkerPool({ size: 0, spawn: () => new FakeWorker(echo), log: silentLog })).toThrow(/positive integer/);
  });
});
