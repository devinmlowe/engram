import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PREBUILT_TARGETS } from "../../src/interfaces/cli/doctor.js";

// Issue #8: package.json must either declare os/cpu or ship a documented
// postinstall preflight that prints a platform verdict WITHOUT failing the
// install. We chose the preflight: hard os/cpu fields would also block users
// who have a working C++ toolchain on an unlisted target.

const script = fileURLToPath(new URL("../../scripts/preflight.cjs", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string>; files: string[]; os?: string[]; cpu?: string[] };
const requireCjs = createRequire(import.meta.url);

function run(args: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [...args, script], {
    encoding: "utf8",
    env: { ...process.env, ENGRAM_SKIP_PREFLIGHT: "", ...extraEnv },
  });
}

let tmp: string;
let breakBetterSqlite: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "engram-preflight-"));
  // A --require preload that makes better-sqlite3 look like a missing prebuilt.
  breakBetterSqlite = join(tmp, "break-better-sqlite3.cjs");
  writeFileSync(
    breakBetterSqlite,
    `const M = require("node:module");
const load = M._load;
M._load = function (request, ...rest) {
  if (request === "better-sqlite3") throw new Error("simulated: no prebuilt for this target");
  return load.call(this, request, ...rest);
};
`,
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("install preflight wiring", () => {
  it("runs from postinstall and ships in the published package", () => {
    expect(pkg.scripts.postinstall).toBe("node scripts/preflight.cjs");
    expect(pkg.files).toContain("scripts/preflight.cjs");
  });

  it("does not use hard os/cpu fields (they would block working toolchains)", () => {
    expect(pkg.os).toBeUndefined();
    expect(pkg.cpu).toBeUndefined();
  });

  it("shares the prebuilt matrix with engram doctor", () => {
    const cjs = requireCjs(script) as { PREBUILT_TARGETS: string[]; MIN_NODE_MAJOR: number };
    expect([...cjs.PREBUILT_TARGETS].sort()).toEqual([...PREBUILT_TARGETS].sort());
    expect(cjs.MIN_NODE_MAJOR).toBe(22);
  });
});

describe("install preflight verdict", () => {
  it("prints node, platform/arch, both native modules, and a verdict, exiting 0", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^engram preflight: node v\d+\.\d+\.\d+ on [a-z0-9]+-[a-z0-9]+$/m);
    expect(r.stdout).toMatch(/^\s+\[(ok|FAIL)\]\s+node >= 22/m);
    expect(r.stdout).toMatch(/^\s+\[(ok|--)\]\s+[a-z0-9]+-[a-z0-9]+:/m);
    expect(r.stdout).toMatch(/^\s+\[(ok|FAIL)\]\s+better-sqlite3/m);
    expect(r.stdout).toMatch(/^\s+\[(ok|FAIL)\]\s+sqlite-vec/m);
    expect(r.stdout).toMatch(/^engram preflight: (OK|\d+ check\(s\) FAILED)/m);
  });

  it("never fails the install even when a native module cannot load", () => {
    const r = run(["--require", breakBetterSqlite]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[FAIL\]\s+better-sqlite3 failed to load/);
    expect(r.stdout).toMatch(/\[FAIL\]\s+sqlite-vec failed to load/);
    expect(r.stdout).toMatch(/^engram preflight: 2 check\(s\) FAILED/m);
    expect(r.stdout).toMatch(/engram doctor/);
  });

  it("--strict turns that verdict into a non-zero exit (for CI)", () => {
    expect(run(["--require", breakBetterSqlite]).status).toBe(0);
    const strict = spawnSync(process.execPath, ["--require", breakBetterSqlite, script, "--strict"], {
      encoding: "utf8",
      env: { ...process.env, ENGRAM_SKIP_PREFLIGHT: "" },
    });
    expect(strict.status).toBe(1);
  });

  it("is silent and exits 0 with ENGRAM_SKIP_PREFLIGHT=1", () => {
    const r = run([], { ENGRAM_SKIP_PREFLIGHT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
