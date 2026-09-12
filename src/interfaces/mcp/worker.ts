/**
 * Worker-thread entry point for the Engram MCP worker pool.
 *
 * Spawned by `WorkerPool` (see worker-pool.ts) pointing at the compiled
 * `dist/interfaces/mcp/worker.js`. Each worker imports the tool handlers from
 * server.ts — which does NOT start a transport when loaded off the main
 * thread — and therefore owns its own better-sqlite3 connection (WAL mode,
 * busy_timeout) and its own embedding model instance.
 *
 * Protocol: receives `{ id, tool, args }`, answers `{ id, ok, result }` or
 * `{ id, ok: false, error }`. Posts `{ type: "ready" }` once the embedding
 * model is warm so the first real recall does not pay ONNX start-up cost
 * inside its timeout window.
 */

import { isMainThread, parentPort, threadId } from "node:worker_threads";
import { handleToolCall, warmUpEmbeddings } from "./server.js";
import { argsDigest } from "./dispatch.js";
import type { WorkerRequest, WorkerResponse } from "./worker-pool.js";

if (isMainThread || !parentPort) {
  throw new Error("worker.ts must be started as a worker thread by the WorkerPool");
}

const port = parentPort;

/** Calls slower than this are logged with their duration and an args digest. */
const SLOW_CALL_MS = Number.parseInt(process.env.ENGRAM_WORKER_SLOW_MS ?? "", 10) || 2_000;

function post(message: WorkerResponse): void {
  port.postMessage(message);
}

port.on("message", (message: unknown) => {
  const request = message as Partial<WorkerRequest> | null;
  if (!request || typeof request.id !== "number" || typeof request.tool !== "string") return;
  const { id, tool, args } = request as WorkerRequest;
  const started = performance.now();
  const finish = (outcome: string) => {
    const ms = Math.round(performance.now() - started);
    if (ms >= SLOW_CALL_MS) {
      console.error(
        `[engram] ${new Date().toISOString()} worker ${threadId}: slow "${tool}" ${outcome} in ${ms}ms args=${argsDigest(args)}`,
      );
    }
  };
  handleToolCall(tool, args).then(
    (result) => {
      finish(result.isError ? "errored" : "completed");
      post({ id, ok: true, result });
    },
    (error) => {
      finish("threw");
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    },
  );
});

warmUpEmbeddings()
  .catch((error) => {
    console.error(`[engram] worker ${threadId}: embedding pre-warm failed: ${String(error)}`);
  })
  .finally(() => {
    post({ type: "ready" });
  });
