import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtCli as cli, itBuilt } from "../../helpers.js";

// Issue #37: an async command that throws must exit 1 with the error's
// message on stderr — never an unhandled-rejection stack trace. Exercised
// through the built CLI, like the doctor tests.

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engram-cli-errors-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ENGRAM_DB_PATH: join(tmpRoot, "engram.db"),
      ENGRAM_MODEL_CACHE_DIR: join(tmpRoot, "models"),
    },
  });
}

describe("engram CLI uncaught command errors (#37)", () => {
  itBuilt("explore of an unknown entity prints one line to stderr and exits 1, with no stack trace", () => {
    const res = run("explore", "no-such-entity-xyz");

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Entity not found: no-such-entity-xyz");
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).not.toMatch(/^\s+at /m);
    expect(res.stderr).not.toMatch(/UnhandledPromiseRejection/);
  });

  itBuilt("an error before the database opens is reported the same way", () => {
    // `/dev/null` cannot be a directory, so getDatabase's mkdir throws
    // before any connection exists; the finally-side closeDatabase is a no-op.
    const res = spawnSync(process.execPath, [cli, "stats"], {
      encoding: "utf8",
      env: { ...process.env, ENGRAM_DB_PATH: "/dev/null/engram.db" },
    });

    expect(res.status).toBe(1);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).not.toMatch(/^\s+at /m);
  });
});
