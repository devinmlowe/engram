/**
 * WorkerPool — a small fixed-size pool of `node:worker_threads` workers that
 * execute MCP tool calls off the main thread.
 *
 * Why: the MCP HTTP server's tool handlers are dominated by synchronous
 * better-sqlite3 queries and ONNX embedding inference. On a single thread a
 * `recall` blocks the event loop for seconds, which starves `/health`, the
 * MCP handshake, and every other client. Running tool calls in workers keeps
 * the main thread free to answer cheap requests immediately.
 *
 * Protocol (main → worker): `{ id, tool, args }`
 * Protocol (worker → main): `{ id, ok: true, result }` | `{ id, ok: false, error }`
 *                            | `{ type: "ready" }` once the worker can accept calls
 *
 * Each worker handles ONE call at a time; additional calls queue in the pool.
 * Every call has a timeout: on expiry the caller is rejected and the worker is
 * given until 2× the timeout to finish. If it still has not answered it is
 * assumed hung, terminated, and respawned. A worker that exits unexpectedly is
 * respawned too. The pool never dies because of one bad call.
 *
 * The worker constructor is injected (`spawn`) so tests can use fake workers
 * or fixture scripts instead of the compiled production worker.
 */

// ─── Types ──────────────────────────────────────────────────────

/** Minimal surface of `worker_threads.Worker` used by the pool. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number> | number | void;
}

export interface WorkerRequest {
  id: number;
  tool: string;
  args: unknown;
  /** Transport-level call context (e.g. the MCP client name); optional, cloned as-is. */
  context?: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { type: "ready" };

export interface WorkerPoolOptions {
  /** Number of workers to keep alive. */
  size: number;
  /** Factory for a new worker (called on start and on every respawn). */
  spawn: () => WorkerLike;
  /** Default per-call timeout. Default 8000ms. */
  timeoutMs?: number;
  /** Logger for operational events (defaults to console.error). */
  log?: (message: string) => void;
}

export interface RunOptions {
  /** Override the pool default timeout for this call. */
  timeoutMs?: number;
  /** Pin the call to a specific worker slot (e.g. for in-memory session state). */
  affinity?: number;
  /** Transport-level call context forwarded to the worker unchanged. */
  context?: Record<string, unknown>;
}

export interface RunResult<T = unknown> {
  result: T;
  /** Index of the worker slot that executed the call. */
  slot: number;
}

export interface PoolStats {
  size: number;
  ready: number;
  busy: number;
  queued: number;
  /** Total workers respawned since the pool started (hangs + crashes). */
  respawns: number;
}

// ─── Internals ──────────────────────────────────────────────────

interface Inflight {
  id: number;
  tool: string;
  resolve: (value: RunResult) => void;
  reject: (error: Error) => void;
  /** Set once the caller has been rejected by timeout (worker may still answer). */
  settled: boolean;
  timeoutTimer: NodeJS.Timeout;
  hangTimer: NodeJS.Timeout;
}

interface Queued {
  tool: string;
  args: unknown;
  context?: Record<string, unknown>;
  timeoutMs: number;
  affinity?: number;
  resolve: (value: RunResult) => void;
  reject: (error: Error) => void;
}

interface Slot {
  index: number;
  /** The live worker. Listeners registered on an earlier worker compare identity and ignore themselves. */
  worker: WorkerLike | null;
  ready: boolean;
  inflight: Inflight | null;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** A call still unanswered at this multiple of its timeout means a hung worker: kill and respawn. */
const HANG_MULTIPLIER = 2;

/** Prefix for pool log lines: ISO timestamp so log-only incidents can be placed in time. */
function stamp(): string {
  return `[engram] ${new Date().toISOString()}`;
}

const closedError = () => new Error("Worker pool is closed");
const timeoutError = (tool: string, ms: number) => new Error(`Tool "${tool}" timed out after ${ms}ms in worker`);

/** Terminate a worker, swallowing "already gone". */
async function terminate(worker: WorkerLike): Promise<void> {
  try {
    await worker.terminate();
  } catch {
    /* already gone */
  }
}

// ─── Pool ───────────────────────────────────────────────────────

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Queued[] = [];
  private readonly spawnWorker: () => WorkerLike;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private nextId = 1;
  private closed = false;
  private respawns = 0;

  constructor(options: WorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new Error(`WorkerPool size must be a positive integer (got ${options.size})`);
    }
    this.spawnWorker = options.spawn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? ((m) => console.error(m));

    for (let i = 0; i < options.size; i++) {
      this.slots.push({ index: i, worker: null, ready: false, inflight: null });
      this.startSlot(this.slots[i]);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  stats(): PoolStats {
    return {
      size: this.slots.length,
      ready: this.slots.filter((s) => s.ready).length,
      busy: this.slots.filter((s) => s.inflight !== null).length,
      queued: this.queue.length,
      respawns: this.respawns,
    };
  }

  /** Resolves once every slot has reported ready (or rejects when closed). */
  async whenReady(): Promise<void> {
    while (!this.closed && this.slots.some((s) => !s.ready)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.closed) throw closedError();
  }

  /** Run a tool call on any free worker (or the affinity slot). */
  async run<T = unknown>(tool: string, args: unknown, options: RunOptions = {}): Promise<T> {
    const { result } = await this.runWithSlot<T>(tool, args, options);
    return result;
  }

  /** Like `run`, but also reports which slot handled the call. */
  runWithSlot<T = unknown>(tool: string, args: unknown, options: RunOptions = {}): Promise<RunResult<T>> {
    if (this.closed) return Promise.reject(closedError());
    if (options.affinity !== undefined && (options.affinity < 0 || options.affinity >= this.slots.length)) {
      return Promise.reject(new Error(`Worker affinity ${options.affinity} out of range (pool size ${this.slots.length})`));
    }
    return new Promise<RunResult<T>>((resolve, reject) => {
      this.queue.push({
        tool,
        args,
        context: options.context,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        affinity: options.affinity,
        resolve: resolve as (value: RunResult) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Terminate all workers and reject everything queued or in flight. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const q of this.queue.splice(0)) q.reject(closedError());
    const terminations: Promise<void>[] = [];
    for (const slot of this.slots) {
      this.abandon(slot, closedError());
      const worker = slot.worker;
      slot.worker = null;
      slot.ready = false;
      if (worker) terminations.push(terminate(worker));
    }
    await Promise.allSettled(terminations);
  }

  // ─── Scheduling ─────────────────────────────────────────────

  private pump(): void {
    if (this.closed) return;
    for (let i = 0; i < this.queue.length; ) {
      const item = this.queue[i];
      const slot = this.pickSlot(item.affinity);
      if (!slot) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.dispatch(slot, item);
    }
  }

  private pickSlot(affinity?: number): Slot | null {
    if (affinity !== undefined) {
      const slot = this.slots[affinity];
      return slot.ready && slot.inflight === null && slot.worker ? slot : null;
    }
    return this.slots.find((s) => s.ready && s.inflight === null && s.worker !== null) ?? null;
  }

  private dispatch(slot: Slot, item: Queued): void {
    const id = this.nextId++;
    const inflight: Inflight = {
      id,
      tool: item.tool,
      resolve: item.resolve,
      reject: item.reject,
      settled: false,
      timeoutTimer: setTimeout(() => this.onTimeout(slot, inflight, item.timeoutMs), item.timeoutMs),
      hangTimer: setTimeout(() => this.onHang(slot, inflight, item.timeoutMs), item.timeoutMs * HANG_MULTIPLIER),
    };
    slot.inflight = inflight;
    const request: WorkerRequest = { id, tool: item.tool, args: item.args };
    if (item.context !== undefined) request.context = item.context;
    try {
      slot.worker!.postMessage(request);
    } catch (error) {
      this.abandon(slot, error instanceof Error ? error : new Error(String(error)));
      this.pump();
    }
  }

  private onTimeout(slot: Slot, inflight: Inflight, timeoutMs: number): void {
    if (slot.inflight !== inflight || inflight.settled) return;
    inflight.settled = true;
    this.log(`${stamp()} worker ${slot.index}: tool "${inflight.tool}" exceeded ${timeoutMs}ms; rejecting call (worker kept alive)`);
    inflight.reject(timeoutError(inflight.tool, timeoutMs));
  }

  private onHang(slot: Slot, inflight: Inflight, timeoutMs: number): void {
    if (slot.inflight !== inflight) return;
    const ms = timeoutMs * HANG_MULTIPLIER;
    this.log(`${stamp()} worker ${slot.index}: tool "${inflight.tool}" still unanswered after ${ms}ms; killing and respawning worker`);
    this.abandon(slot, timeoutError(inflight.tool, ms));
    this.respawn(slot);
  }

  /** Drop the slot's in-flight call: clear its timers and reject the caller unless a timeout already did. */
  private abandon(slot: Slot, error: Error): void {
    const inflight = slot.inflight;
    if (!inflight) return;
    clearTimeout(inflight.timeoutTimer);
    clearTimeout(inflight.hangTimer);
    slot.inflight = null;
    if (!inflight.settled) {
      inflight.settled = true;
      inflight.reject(error);
    }
  }

  // ─── Worker lifecycle ────────────────────────────────────────

  private startSlot(slot: Slot): void {
    if (this.closed) return;
    slot.ready = false;
    slot.inflight = null;

    let worker: WorkerLike;
    try {
      worker = this.spawnWorker();
    } catch (error) {
      this.log(`${stamp()} worker ${slot.index}: spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      slot.worker = null;
      // Retry later rather than tight-looping.
      setTimeout(() => {
        if (!this.closed && slot.worker === null) this.startSlot(slot);
      }, 1000).unref?.();
      return;
    }
    slot.worker = worker;

    // Events from a worker this slot has since replaced (respawn) or dropped (close) are ignored.
    worker.on("message", (message: unknown) => {
      if (slot.worker === worker) this.onMessage(slot, message as WorkerResponse);
    });
    worker.on("error", (error: Error) => {
      if (slot.worker === worker) this.log(`${stamp()} worker ${slot.index}: error: ${error?.message ?? String(error)}`);
    });
    worker.on("exit", (code: number) => {
      if (slot.worker !== worker || this.closed) return;
      this.log(`${stamp()} worker ${slot.index}: exited with code ${code}; respawning`);
      if (slot.inflight) this.abandon(slot, new Error(`Tool "${slot.inflight.tool}" failed: worker exited with code ${code}`));
      this.respawn(slot);
    });
  }

  private onMessage(slot: Slot, message: WorkerResponse): void {
    if (message && typeof message === "object" && "type" in message && message.type === "ready") {
      slot.ready = true;
      this.pump();
      return;
    }
    if (!message || typeof message !== "object" || !("id" in message)) return;

    const inflight = slot.inflight;
    // A late answer for a call we already gave up on (or a stray message).
    if (!inflight || inflight.id !== message.id) return;
    clearTimeout(inflight.timeoutTimer);
    clearTimeout(inflight.hangTimer);
    slot.inflight = null;
    if (!inflight.settled) {
      inflight.settled = true;
      if (message.ok) inflight.resolve({ result: message.result, slot: slot.index });
      else inflight.reject(new Error(message.error));
    }
    this.pump();
  }

  private respawn(slot: Slot): void {
    if (this.closed) return;
    this.respawns++;
    const old = slot.worker;
    slot.worker = null;
    slot.ready = false;
    if (old) void terminate(old);
    this.startSlot(slot);
  }
}
