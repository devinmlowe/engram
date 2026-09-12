/**
 * Tool dispatcher — decides where an MCP tool call executes.
 *
 * - `workers: 0` (always the case in stdio mode): every call runs on the
 *   calling thread through `direct`, exactly as the server behaved before
 *   the worker pool existed. No worker is ever spawned.
 * - `workers: N > 0` (HTTP mode): DB-heavy tools run on a WorkerPool so the
 *   main thread stays free for `/health`, the MCP handshake and list-tools.
 *
 * Session affinity: `recall_session` creates state in the worker's in-memory
 * SessionStore. Follow-up calls that carry that `session_id` (`recall_drill`,
 * `fetch_snippets`, `scan_file`, `recall_session` refinements) are pinned to
 * the worker that created the session so they can find it.
 */

import { WorkerPool, type WorkerLike, type WorkerPoolOptions } from "./worker-pool.js";

// ─── Types ──────────────────────────────────────────────────────

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ToolHandler = (name: string, args: unknown) => Promise<ToolResult>;

export interface DispatcherOptions {
  /** Number of workers (0 = run everything inline on this thread). */
  workers: number;
  /** Inline handler used when `workers` is 0 or a tool is not worker-eligible. */
  direct: ToolHandler;
  /** Worker factory. Required when `workers > 0`. */
  spawn?: () => WorkerLike;
  /** Default per-call timeout in the pool (ms). */
  timeoutMs?: number;
  /** Pool tuning passthrough (tests). */
  poolOptions?: Partial<Pick<WorkerPoolOptions, "hangMultiplier" | "readyTimeoutMs">>;
  log?: (message: string) => void;
}

export interface ToolDispatcher {
  call: ToolHandler;
  /** Number of workers in the pool (0 in inline mode). */
  readonly workers: number;
  /** Pool statistics (null in inline mode). */
  stats(): ReturnType<WorkerPool["stats"]> | null;
  /** Resolves when all workers are ready (immediately in inline mode). */
  whenReady(): Promise<void>;
  close(): Promise<void>;
}

// ─── Tool routing table ─────────────────────────────────────────

/**
 * Tools executed in workers when a pool exists. Everything that touches the
 * database or the embedding model. (`show` only reads a file but is grouped
 * here so the main thread does no request work beyond routing.)
 */
export const WORKER_TOOLS: ReadonlySet<string> = new Set([
  "recall",
  "remember",
  "remember_batch",
  "reflect",
  "explore",
  "explore_selective",
  "show",
  "recall_drill",
  "recall_session",
  "scan_file",
  "fetch_snippets",
  "index_file_structure",
]);

/** Tools whose results reference an in-memory recall session. */
const SESSION_TOOLS: ReadonlySet<string> = new Set([
  "recall_session",
  "recall_drill",
  "fetch_snippets",
  "scan_file",
]);

export const DEFAULT_WORKER_TIMEOUT_MS = 8_000;

/**
 * Per-tool timeout floors. The pool default (ENGRAM_WORKER_TIMEOUT_MS, 8s)
 * is right for recall/explore, but a few tools legitimately run longer:
 * `remember` may spend up to MERGE_TIMEOUT_MS (15s) in an LLM merge, batch
 * stores embed up to 50 memories, and `reflect --refresh` recomputes the
 * whole graph. Using the bare default would reject healthy calls.
 */
const TOOL_TIMEOUT_FLOORS_MS: Record<string, number> = {
  remember: 25_000,
  remember_batch: 60_000,
  index_file_structure: 30_000,
};

export function toolTimeoutMs(tool: string, args: unknown, defaultMs: number): number {
  let floor = TOOL_TIMEOUT_FLOORS_MS[tool] ?? 0;
  if (tool === "reflect" && isRecord(args) && args.refresh === true) floor = 120_000;
  return Math.max(defaultMs, floor);
}

// ─── Helpers ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdOf(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const sid = args.session_id;
  return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

/** Extract the session id a `recall_session` call reported in its result. */
export function extractSessionId(result: ToolResult): string | undefined {
  for (const part of result.content ?? []) {
    if (part.type !== "text") continue;
    const match = /<session id="([^"]+)"/.exec(part.text);
    if (match) return match[1];
  }
  return undefined;
}

export function parseWorkerCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

const MAX_AFFINITY_ENTRIES = 256;

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Short, single-line, size-capped rendering of tool args for log lines. */
export function argsDigest(args: unknown, max = 160): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = String(args);
  }
  text = text.replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;
}

// ─── Factory ────────────────────────────────────────────────────

export function createToolDispatcher(options: DispatcherOptions): ToolDispatcher {
  const log = options.log ?? ((m) => console.error(m));

  if (options.workers <= 0) {
    return {
      call: options.direct,
      workers: 0,
      stats: () => null,
      whenReady: async () => {},
      close: async () => {},
    };
  }

  if (!options.spawn) {
    throw new Error("createToolDispatcher: `spawn` is required when workers > 0");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const pool = new WorkerPool({
    size: options.workers,
    spawn: options.spawn,
    timeoutMs,
    log,
    ...options.poolOptions,
  });

  // session_id → worker slot that owns the session
  const affinity = new Map<string, number>();
  const remember = (sid: string, slot: number) => {
    if (affinity.size >= MAX_AFFINITY_ENTRIES) {
      const oldest = affinity.keys().next().value;
      if (oldest !== undefined) affinity.delete(oldest);
    }
    affinity.set(sid, slot);
  };

  const call: ToolHandler = async (name, args) => {
    if (!WORKER_TOOLS.has(name)) {
      return options.direct(name, args);
    }
    const sid = SESSION_TOOLS.has(name) ? sessionIdOf(args) : undefined;
    const pinned = sid !== undefined ? affinity.get(sid) : undefined;
    const started = performance.now();
    try {
      const { result, slot } = await pool.runWithSlot<ToolResult>(name, args, {
        timeoutMs: toolTimeoutMs(name, args, timeoutMs),
        affinity: pinned,
      });
      if (name === "recall_session") {
        const created = extractSessionId(result);
        if (created) remember(created, slot);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ms = Math.round(performance.now() - started);
      log(`[engram] ${new Date().toISOString()} tool "${name}" failed in worker after ${ms}ms: ${message} args=${argsDigest(args)}`);
      return errorResult(message);
    }
  };

  return {
    call,
    workers: options.workers,
    stats: () => pool.stats(),
    whenReady: () => pool.whenReady(),
    close: () => pool.close(),
  };
}
