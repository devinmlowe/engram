/**
 * In-process stand-in for the MCP worker pool's worker threads (#126), so
 * dispatch and pool tests are deterministic. A behaviour decides how each
 * posted message is answered; `echo` replies with the arguments it got.
 */

import { EventEmitter } from "node:events";
import type { WorkerLike } from "../../src/interfaces/mcp/worker-pool.js";

export interface WorkerMessage {
  id: number;
  tool: string;
  args: unknown;
}

export type Behaviour = (msg: WorkerMessage, reply: (m: unknown) => void, self: FakeWorker) => void;

export const echo: Behaviour = (msg, reply) => reply({ id: msg.id, ok: true, result: { echoed: msg.args, tool: msg.tool } });
export const never: Behaviour = () => {};

export class FakeWorker extends EventEmitter implements WorkerLike {
  static instances: FakeWorker[] = [];
  /** Spawn order within the current test (instances are reset between tests). */
  readonly index = FakeWorker.instances.length;
  terminated = false;
  sent: WorkerMessage[] = [];

  constructor(private behaviour: Behaviour = echo, options: { autoReady?: boolean } = {}) {
    super();
    FakeWorker.instances.push(this);
    if (options.autoReady !== false) queueMicrotask(() => this.emit("message", { type: "ready" }));
  }

  postMessage(message: unknown): void {
    const msg = message as WorkerMessage;
    this.sent.push(msg);
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
