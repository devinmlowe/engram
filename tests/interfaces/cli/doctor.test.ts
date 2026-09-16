import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCTOR_CHECK_NAMES,
  MIN_NODE_MAJOR,
  PREBUILT_TARGETS,
  checkModelCache,
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
} from "../../../src/interfaces/cli/doctor.js";
import { loadConfig } from "../../../src/_core/config/index.js";
import {
  applyModelCacheDir,
  resolveModelCacheDir,
} from "../../../src/_core/embeddings/model-cache.js";

// Issue #8: `engram doctor` must report node version, platform/arch,
// better-sqlite3 and sqlite-vec load status, and the model cache location +
// writability. These tests pin the *shape* of that report; they do not assume
// any particular platform verdict (a check may legitimately be [FAIL] on an
// unsupported target and the shape must still hold).

const LINE_RE = /^\[(ok|--|FAIL)\]\s+(.+?): (.+)$/;

let tmpRoot: string;
let report: DoctorReport;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engram-doctor-"));
  report = await runDoctor(
    loadConfig({ modelCacheDir: join(tmpRoot, "models") }),
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("doctor report shape", () => {
  it("emits every documented check exactly once, in order", () => {
    expect(report.checks.map((c) => c.name)).toEqual([...DOCTOR_CHECK_NAMES]);
  });

  it("records the node version and platform-arch pair", () => {
    expect(report.node).toBe(process.version);
    expect(report.platform).toBe(`${process.platform}-${process.arch}`);
    const node = report.checks.find((c) => c.name === "node")!;
    expect(node.detail).toContain(process.version);
    expect(node.detail).toContain(`>=${MIN_NODE_MAJOR}`);
    const platform = report.checks.find((c) => c.name === "platform/arch")!;
    expect(platform.detail).toContain(report.platform);
  });

  it("gives every check a level, a required flag, and a non-empty detail", () => {
    for (const check of report.checks) {
      expect(["ok", "warn", "fail"]).toContain(check.level);
      expect(typeof check.required).toBe("boolean");
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  it("derives ok from required failures only", () => {
    const requiredFailed = report.checks.some(
      (c) => c.required && c.level === "fail",
    );
    expect(report.ok).toBe(!requiredFailed);
    // platform/arch is advisory: an unsupported target warns, never fails
    expect(report.checks.find((c) => c.name === "platform/arch")!.required).toBe(false);
  });

  it("names the native modules by their package names", () => {
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("better-sqlite3");
    expect(names).toContain("sqlite-vec");
  });

  it("reports the model cache directory it was configured with, and whether it is writable", () => {
    const cache = report.checks.find((c) => c.name === "model cache")!;
    expect(cache.detail).toContain(join(tmpRoot, "models"));
    expect(cache.detail).toMatch(/writable/);
    expect(cache.detail).toContain("ENGRAM_MODEL_CACHE_DIR");
  });

  it("knows the prebuilt matrix that the README documents", () => {
    expect([...PREBUILT_TARGETS].sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].sort(),
    );
  });
});

describe("doctor text output", () => {
  it("prints one prefixed line per check, a blank line, and a verdict", () => {
    const lines = formatDoctorReport(report);
    expect(lines).toHaveLength(report.checks.length + 2);
    report.checks.forEach((check, i) => {
      const m = LINE_RE.exec(lines[i]!);
      expect(m, lines[i]).not.toBeNull();
      expect(m![2]).toBe(check.name);
    });
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toMatch(/^Doctor: /);
  });

  it("maps levels to [ok] / [--] / [FAIL] prefixes", () => {
    const lines = formatDoctorReport({
      node: "v0.0.0",
      platform: "test-arch",
      ok: false,
      checks: [
        { name: "node", level: "ok", required: true, detail: "a" },
        { name: "platform/arch", level: "warn", required: false, detail: "b" },
        { name: "sqlite-vec", level: "fail", required: true, detail: "c" },
      ],
    });
    expect(lines[0]).toMatch(/^\[ok\]\s+node: a$/);
    expect(lines[1]).toMatch(/^\[--\]\s+platform\/arch: b$/);
    expect(lines[2]).toMatch(/^\[FAIL\]\s+sqlite-vec: c$/);
    expect(lines.at(-1)).toBe("Doctor: 1 required check(s) failed");
  });

  it("says 'all checks passed' when nothing required failed", () => {
    const lines = formatDoctorReport({ ...report, ok: true, checks: report.checks.map((c) => ({ ...c, level: "ok" as const })) });
    expect(lines.at(-1)).toBe("Doctor: all checks passed");
  });
});

describe("model cache check", () => {
  it("prefers the engram override over the library default and creates it", () => {
    const dir = join(tmpRoot, "override-me");
    const check = checkModelCache(dir, "/lib/default/.cache/");
    expect(check.level).toBe("ok");
    expect(check.detail).toContain(dir);
    expect(check.detail).toContain("from ENGRAM_MODEL_CACHE_DIR");
    expect(existsSync(dir)).toBe(true);
  });

  it("falls back to the transformers default and says how to override it", () => {
    const dir = join(tmpRoot, "library-default");
    const check = checkModelCache(undefined, dir);
    expect(check.level).toBe("ok");
    expect(check.detail).toContain(dir);
    expect(check.detail).toMatch(/set ENGRAM_MODEL_CACHE_DIR/);
  });

  it("fails when neither the override nor the library default is known", () => {
    const check = checkModelCache(undefined, undefined);
    expect(check.level).toBe("fail");
    expect(check.required).toBe(true);
  });

  it("fails when the directory cannot be created", () => {
    // A path *under a regular file* cannot be mkdir'd on any platform.
    const file = join(tmpRoot, "not-a-dir");
    writeFileSync(file, "x");
    const check = checkModelCache(join(file, "models"), undefined);
    expect(check.level).toBe("fail");
    expect(check.detail).toMatch(/not writable/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "warns (does not fail) for a populated read-only cache",
    () => {
      const dir = join(tmpRoot, "readonly");
      mkdirSync(dir);
      writeFileSync(join(dir, "model.onnx"), "weights");
      chmodSync(dir, 0o555);
      try {
        const check = checkModelCache(dir, undefined);
        expect(check.level).toBe("warn");
        expect(check.detail).toMatch(/read-only/);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
});

describe("model cache resolution", () => {
  it("resolveModelCacheDir is pure and prefers a non-blank override", () => {
    const env = { cacheDir: "/lib/.cache/" };
    expect(resolveModelCacheDir(env, "/custom")).toBe("/custom");
    expect(resolveModelCacheDir(env, "   ")).toBe("/lib/.cache/");
    expect(resolveModelCacheDir(env, undefined)).toBe("/lib/.cache/");
    expect(env.cacheDir).toBe("/lib/.cache/");
  });

  it("applyModelCacheDir mutates env only when an override is given", () => {
    const env = { cacheDir: "/lib/.cache/" };
    expect(applyModelCacheDir(env, "/custom")).toBe("/custom");
    expect(env.cacheDir).toBe("/custom");
    expect(applyModelCacheDir(env, undefined)).toBe("/custom");
  });
});

describe("engram doctor CLI", () => {
  const cli = fileURLToPath(
    new URL("../../../dist/interfaces/cli/index.js", import.meta.url),
  );
  const built = existsSync(cli);

  function run(...args: string[]): string {
    return execFileSync(process.execPath, [cli, "doctor", ...args], {
      encoding: "utf8",
      env: { ...process.env, ENGRAM_MODEL_CACHE_DIR: join(tmpRoot, "cli-cache") },
    });
  }

  it.skipIf(!built)("prints every check and a verdict, exiting 0 on a supported platform", () => {
    const out = run();
    for (const name of DOCTOR_CHECK_NAMES) {
      expect(out).toMatch(new RegExp(`^\\[(ok|--|FAIL)\\]\\s+${name.replace("/", "\\/")}: `, "m"));
    }
    expect(out).toMatch(/^Doctor: /m);
  });

  it.skipIf(!built)("--json emits a parseable report with the same checks", () => {
    const parsed = JSON.parse(run("--json")) as DoctorReport;
    expect(parsed.checks.map((c) => c.name)).toEqual([...DOCTOR_CHECK_NAMES]);
    expect(parsed.platform).toBe(`${process.platform}-${process.arch}`);
  });
});
