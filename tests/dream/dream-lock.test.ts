/** #26: one dream run per data dir. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createTestDb, type TestDb } from "../helpers.js";
import { acquireDreamLock, dreamLockPath, DreamLockedError, processAlive } from "../../src/dream/lock.js";
import { runDream } from "../../src/dream/daemon.js";

let t: TestDb;
beforeEach(() => { t = createTestDb(); });
afterEach(() => { t.cleanup(); });

describe("dream advisory lock", () => {
  it("writes the pid, refuses a live second owner, is released on demand", () => {
    const release = acquireDreamLock(t.config, { pid: 1000, alive: () => true });
    const path = dreamLockPath(t.config);
    expect(readFileSync(path, "utf-8").trim()).toBe("1000");
    expect(() => acquireDreamLock(t.config, { pid: 2000, alive: () => true })).toThrow(DreamLockedError);
    try { acquireDreamLock(t.config, { pid: 2000, alive: () => true }); } catch (e) {
      expect((e as DreamLockedError).pid).toBe(1000);
      expect((e as DreamLockedError).message).toContain(path);
    }
    // same pid re-entering is fine
    acquireDreamLock(t.config, { pid: 1000, alive: () => true })();
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("takes over a stale lock whose owner is gone, and does not delete a lock it does not own", () => {
    const path = dreamLockPath(t.config);
    mkdirSync(`${t.config.dataDir}/tmp`, { recursive: true });
    writeFileSync(path, "424242\n");
    const release = acquireDreamLock(t.config, { pid: 7, alive: (pid) => pid !== 424242 });
    expect(readFileSync(path, "utf-8").trim()).toBe("7");
    writeFileSync(path, "8\n"); // someone else took it meanwhile
    release();
    expect(readFileSync(path, "utf-8").trim()).toBe("8");
  });

  it("processAlive: own pid yes, absurd pid no, EPERM counts as alive", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(2 ** 22 - 1, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); })).toBe(false);
    expect(processAlive(5, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); })).toBe(true);
  });

  it("runDream fails fast while another run holds the lock, and releases its own lock afterwards", async () => {
    // pid 1 is always alive (kill -0 answers EPERM at worst), so runDream must refuse
    const release = acquireDreamLock(t.config, { pid: 1, alive: () => true });
    await expect(runDream(t.db, t.config, { phases: [] })).rejects.toThrow(DreamLockedError);
    release();
    const report = await runDream(t.db, t.config, { phases: [] });
    expect(report.completedAt).toBeGreaterThan(0);
    expect(existsSync(dreamLockPath(t.config))).toBe(false);
  });
});
