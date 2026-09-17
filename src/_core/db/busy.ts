/**
 * SQLITE_BUSY handling for writers that share one WAL database across
 * processes (dream daemon, HTTP worker threads, stdio servers, CLI) (#26).
 *
 * `busy_timeout` (5 s, set in schema.ts) makes SQLite itself wait for the
 * lock on most statements, but a `BEGIN IMMEDIATE` that cannot get the
 * reserved lock within that window still raises SQLITE_BUSY. Hot-path,
 * best-effort writes (recall reinforcement) retry a few times with jittered
 * backoff and then give up; they must never fail the read they ride on.
 */

export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Block the current thread for `ms` (better-sqlite3 is synchronous; there is nothing to yield to mid-write). */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(sleepBuffer, 0, 0, ms);
}

export interface BusyRetryOptions {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Backoff before the 2nd attempt; doubles each time, plus jitter (default 25 ms). */
  baseMs?: number;
  /** Called after each SQLITE_BUSY that will be retried. */
  onBusy?: (attempt: number, err: unknown) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => void;
}

/**
 * Run `fn`, retrying on SQLITE_BUSY. Any other error, and the last BUSY,
 * propagate to the caller.
 */
export function withBusyRetry<T>(fn: () => T, opts: BusyRetryOptions = {}): T {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 25;
  const sleep = opts.sleep ?? sleepSync;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= attempts) throw err;
      opts.onBusy?.(attempt, err);
      sleep(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
}
