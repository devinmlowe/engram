import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PREBUILT_TARGETS } from "../../src/interfaces/cli/doctor.js";
import { builtCli as cli, itBuilt } from "../helpers.js";

// Issue #8: package.json must either declare os/cpu or ship a documented
// postinstall preflight that prints a platform verdict WITHOUT failing the
// install. We chose the preflight: hard os/cpu fields would also block users
// who have a working C++ toolchain on an unlisted target.

const script = fileURLToPath(new URL("../../scripts/preflight.cjs", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string>; files: string[]; os?: string[]; cpu?: string[] };
const requireCjs = createRequire(import.meta.url);

/** Node flags (e.g. --require) go before the script; script flags (--json, --expect) after it. */
function run(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const nodeFlags = args.filter((a) => a === "--require" || args[args.indexOf(a) - 1] === "--require");
  const scriptArgs = args.filter((a) => !nodeFlags.includes(a));
  return spawnSync(process.execPath, [...nodeFlags, script, ...scriptArgs], {
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

  it("prints one prebuild verdict line per native dependency, with fix lines under warn/fail (#63)", () => {
    const r = run();
    const verdict = /^\s+\[(ok|warn|FAIL|--)\]\s+(better-sqlite3|sqlite-vec|onnxruntime-node): (prebuilt|compiled locally|will compile \(needs python3 \+ C\+\+ toolchain\)|unsupported|unknown) — .+$/gm;
    const deps = [...r.stdout.matchAll(verdict)].map((m) => m[2]);
    expect(deps).toEqual(["better-sqlite3", "sqlite-vec", "onnxruntime-node"]);
    const lines = r.stdout.split("\n");
    lines.forEach((line, i) => {
      if (/^\s+\[(warn|FAIL)\]\s+(better-sqlite3|sqlite-vec|onnxruntime-node): /.test(line)) {
        expect(lines[i + 1], `fix line after: ${line}`).toMatch(/^\s{9}(fix|or): {1,2}\S/);
      }
    });
  });

  it("--json prints the structured result: target, one probe per dep, load results, counts", () => {
    const r = run(["--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      node: string;
      target: { platform: string; arch: string; libc: string; abi: number; key: string };
      deps: Array<{ dep: string; status: string; level: string; source: string; label: string; detail: string; fix: string[] }>;
      loads: Array<{ dep: string; ok: boolean }>;
      failed: number;
      warned: number;
      ok: boolean;
      lines?: unknown;
    };
    expect(parsed.node).toBe(process.version);
    expect(parsed.target.platform).toBe(process.platform);
    expect(parsed.target.arch).toBe(process.arch);
    expect(parsed.target.abi).toBe(Number(process.versions.modules));
    expect(parsed.deps.map((d) => d.dep)).toEqual(["better-sqlite3", "sqlite-vec", "onnxruntime-node"]);
    for (const d of parsed.deps) {
      expect(["prebuilt", "compiled", "will-compile", "unsupported", "unknown"]).toContain(d.status);
      expect(["ok", "warn", "fail", "skip"]).toContain(d.level);
      expect(d.source).toBe("installed"); // this checkout has node_modules
      expect(Array.isArray(d.fix)).toBe(true);
    }
    expect(parsed.loads.map((l) => l.dep)).toEqual(["better-sqlite3", "sqlite-vec"]);
    expect(parsed.ok).toBe(parsed.failed === 0);
    expect(parsed.lines).toBeUndefined();
  });

  it("installed verdicts agree with the static table for this target (what CI asserts per matrix entry)", () => {
    const cjs = requireCjs(script) as { preflight(o?: object): { deps: Array<{ dep: string; status: string; source: string }> } };
    const installed = cjs.preflight().deps;
    const absent = mkdtempSync(join(tmpdir(), "engram-preflight-absent-"));
    try {
      const fromTable = cjs.preflight({ root: absent }).deps;
      for (const d of fromTable) expect(d.source).toBe("static");
      expect(installed.map((d) => [d.dep, d.status])).toEqual(fromTable.map((d) => [d.dep, d.status]));
    } finally {
      rmSync(absent, { recursive: true, force: true });
    }
  });

  it("--expect exits 1 with a message when a verdict differs, 0 when it matches", () => {
    const wrong = run(["--expect", "better-sqlite3=will-compile,sqlite-vec=unknown"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/engram preflight: expected (better-sqlite3|sqlite-vec) to be/);
    const json = JSON.parse(run(["--json"]).stdout) as { deps: Array<{ dep: string; status: string }> };
    const right = run(["--expect", json.deps.map((d) => `${d.dep}=${d.status}`).join(",")]);
    expect(right.status).toBe(0);
  });

  it("never fails the install even when a native module cannot load", () => {
    const r = run(["--require", breakBetterSqlite]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[FAIL\]\s+better-sqlite3 failed to load/);
    expect(r.stdout).toMatch(/\[FAIL\]\s+sqlite-vec failed to load/);
    // At least the two load failures; a documented-unsupported CI target
    // (windows-11-arm, musl) adds its [FAIL] prebuild lines on top.
    const failed = Number(/^engram preflight: (\d+) check\(s\) FAILED/m.exec(r.stdout)?.[1]);
    expect(failed).toBeGreaterThanOrEqual(2);
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

describe("engram preflight CLI (#63)", () => {

  function cliRun(...args: string[]) {
    return spawnSync(process.execPath, [cli, "preflight", ...args], {
      encoding: "utf8",
      // A data dir that must NOT be created: preflight needs no database or models.
      env: { ...process.env, ENGRAM_SKIP_PREFLIGHT: "1", ENGRAM_DATA_DIR: join(tmp, "never-created") },
    });
  }

  itBuilt("reuses scripts/preflight.cjs and runs without a data dir, ignoring ENGRAM_SKIP_PREFLIGHT", () => {
    const r = cliRun();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^engram preflight: node v\d+/m);
    expect(r.stdout).toMatch(/^\s+\[(ok|warn|FAIL|--)\]\s+onnxruntime-node: /m);
    expect(existsSync(join(tmp, "never-created"))).toBe(false);
  });

  itBuilt("--json matches the script's shape", () => {
    const parsed = JSON.parse(cliRun("--json").stdout) as { deps: Array<{ dep: string }>; target: { key: string } };
    expect(parsed.deps.map((d) => d.dep)).toEqual(["better-sqlite3", "sqlite-vec", "onnxruntime-node"]);
    expect(parsed.target.key).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  itBuilt("--expect and --strict drive the exit code", () => {
    expect(cliRun("--expect", "onnxruntime-node=will-compile").status).toBe(1);
    const json = JSON.parse(cliRun("--json").stdout) as { deps: Array<{ dep: string; status: string }>; failed: number };
    const matching = json.deps.map((d) => `${d.dep}=${d.status}`).join(",");
    expect(cliRun("--expect", matching).status).toBe(0);
    expect(cliRun("--strict").status).toBe(json.failed > 0 ? 1 : 0);
  });

  it("is listed in the package's CLI docs and CLAUDE.md", () => {
    const docs = ["../../CLAUDE.md", "../../src/interfaces/cli/README.md", "../../src/interfaces/README.md", "../../docs/api-reference.md"];
    for (const doc of docs) {
      expect(readFileSync(new URL(doc, import.meta.url), "utf8"), doc).toMatch(/`preflight`|engram preflight/);
    }
  });
});
