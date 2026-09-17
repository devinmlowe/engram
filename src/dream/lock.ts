/**
 * Advisory lock for the dream pipeline (#26): one consolidation run per data
 * dir at a time. The nightly daemon, `engram dream` from a shell, and the
 * visualizer's Dream button all go through `runDream`, so they all respect
 * it. The lock is `<dataDir>/tmp/dream.lock` holding the owner pid; a stale
 * file whose pid is gone is taken over.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngramConfig } from "../_core/types/index.js";

export class DreamLockedError extends Error {
  constructor(public readonly lockPath: string, public readonly pid: number) {
    super(`another dream run is in progress (pid ${pid}, ${lockPath}); wait for it or remove the lock if that process is gone`);
    this.name = "DreamLockedError";
  }
}

export function dreamLockPath(config: EngramConfig): string {
  return join(config.dataDir, "tmp", "dream.lock");
}

export function processAlive(pid: number, kill: (pid: number, sig: 0) => void = process.kill.bind(process)): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** Take the lock or throw `DreamLockedError`. Returns the release function. */
export function acquireDreamLock(
  config: EngramConfig,
  opts: { pid?: number; alive?: (pid: number) => boolean } = {},
): () => void {
  const path = dreamLockPath(config);
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? processAlive;
  mkdirSync(join(config.dataDir, "tmp"), { recursive: true });
  if (existsSync(path)) {
    const owner = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (owner !== pid && alive(owner)) throw new DreamLockedError(path, owner);
  }
  writeFileSync(path, `${pid}\n`);
  return () => {
    try {
      if (existsSync(path) && readFileSync(path, "utf-8").trim() === String(pid)) rmSync(path, { force: true });
    } catch { /* best effort */ }
  };
}
