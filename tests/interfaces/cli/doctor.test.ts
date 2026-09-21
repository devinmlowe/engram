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
  checkDataDir,
  checkHosts,
  checkMcpDaemon,
  checkModelCache,
  checkNativeSqlite,
  formatDoctorReport,
  legacyDataDir,
  probeMcpHealth,
  probeNativeDep,
  runDoctor,
  type DoctorReport,
} from "../../../src/interfaces/cli/doctor.js";
import { loadPreflight, type PrebuildProbe } from "../../../src/interfaces/cli/preflight.js";
import { defaultHostContext } from "../../../src/interfaces/cli/hosts.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../../src/_core/config/index.js";
import { applyModelCacheDir } from "../../../src/_core/embeddings/model-cache.js";

// Issue #8: `engram doctor` must report node version, platform/arch,
// better-sqlite3 and sqlite-vec load status, and the model cache location +
// writability. These tests pin the *shape* of that report; they do not assume
// any particular platform verdict (a check may legitimately be [FAIL] on an
// unsupported target and the shape must still hold).

const LINE_RE = /^\[(ok|--|FAIL)\]\s+(.+?): (.+)$/;

let tmpRoot: string;
let report: DoctorReport;

// CI pins ENGRAM_MODEL_CACHE_DIR for the whole job; that tier outranks the
// programmatic override this suite passes (#53), so hide it while resolving.
const CACHE_ENV = ["ENGRAM_MODEL_CACHE_DIR", "HF_HOME"] as const;
const savedCacheEnv: Partial<Record<(typeof CACHE_ENV)[number], string | undefined>> = {};

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engram-doctor-"));
  for (const key of CACHE_ENV) {
    savedCacheEnv[key] = process.env[key];
    delete process.env[key];
  }
  // No smoke here: this suite pins the report's shape, and a real extraction
  // would talk to whatever LLM tier this machine has and write to its store.
  report = await runDoctor(
    loadConfig({ modelCacheDir: join(tmpRoot, "models") }),
    { noSmoke: true },
  );
});

afterAll(() => {
  for (const key of CACHE_ENV) {
    if (savedCacheEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedCacheEnv[key];
  }
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

  it("reports the model cache directory it was configured with, its durability and whether it is writable", () => {
    const cache = report.checks.find((c) => c.name === "model cache")!;
    expect(cache.detail).toContain(join(tmpRoot, "models"));
    expect(cache.detail).toMatch(/writable/);
    expect(cache.detail).toContain("durable: yes");
    expect(cache.detail).toContain("from config override");
  });

  it("knows the prebuilt matrix that the README documents", () => {
    expect([...PREBUILT_TARGETS].sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].sort(),
    );
    // shared with scripts/preflight.cjs rather than duplicated (#63)
    expect([...PREBUILT_TARGETS]).toEqual([...loadPreflight().PREBUILT_TARGETS]);
  });

  it("names the Node ABI (and libc on Linux) on the platform/arch line", () => {
    const platform = report.checks.find((c) => c.name === "platform/arch")!;
    expect(platform.detail).toContain(`(node-v${process.versions.modules})`);
    if (process.platform === "linux") expect(platform.detail).toMatch(/, (glibc|musl) \(/);
  });

  it("ends the native-module lines with the prebuild verdict from the preflight probe (#63)", () => {
    const verdict = /; (prebuilt|compiled locally|will compile \(needs python3 \+ C\+\+ toolchain\)|unsupported|unknown) — .+/;
    for (const name of ["better-sqlite3", "sqlite-vec"] as const) {
      const check = report.checks.find((c) => c.name === name)!;
      expect(check.detail, name).toMatch(verdict);
    }
    // and agrees with `engram preflight` itself
    const { deps } = loadPreflight().preflight();
    for (const d of deps.filter((x) => x.dep !== "onnxruntime-node")) {
      expect(report.checks.find((c) => c.name === d.dep)!.detail).toContain(`; ${d.label} — ${d.detail}`);
    }
  });
});

describe("doctor prebuild verdicts (#63)", () => {
  const fake = (status: PrebuildProbe["status"], label: string, detail: string, fix: string[] = []): PrebuildProbe => ({
    dep: "better-sqlite3", status, label, level: "ok", source: "installed", detail, fix,
  });

  it("says compiled locally when the probe found node-gyp artefacts, with its hints", async () => {
    const [bs3, vec] = await checkNativeSqlite((dep) =>
      dep === "better-sqlite3"
        ? fake("compiled", "compiled locally", "node-gyp artefacts build/config.gypi; no prebuilt for node-v131-linux-x64", ["fix: nvm use 24   (a Node major better-sqlite3 ships prebuilts for)"])
        : fake("prebuilt", "prebuilt", "sqlite-vec-linux-x64/vec0.so"),
    );
    expect(bs3.level).toBe("ok"); // it loads; the verdict is diagnostic
    expect(bs3.detail).toMatch(/^loaded \(SQLite [\d.]+\); compiled locally — node-gyp artefacts build\/config\.gypi; .*; fix: nvm use 24/);
    expect(vec.detail).toMatch(/; prebuilt — sqlite-vec-linux-x64\/vec0\.so$/);
  });

  it("says prebuilt when the probe found a prebuild-install tarball", async () => {
    const [bs3] = await checkNativeSqlite(() => fake("prebuilt", "prebuilt", "build/Release/better_sqlite3.node with no node-gyp artefacts"));
    expect(bs3.detail).toMatch(/; prebuilt — build\/Release\/better_sqlite3\.node/);
  });

  it("degrades to unknown when the probe itself throws", async () => {
    const p = probeNativeDep("sqlite-vec", () => { throw new Error("script missing"); });
    expect(p.status).toBe("unknown");
    expect(p.label).toBe("unknown");
    expect(p.detail).toContain("script missing");
    const [, vec] = await checkNativeSqlite(() => { throw new Error("boom"); });
    expect(vec.detail).toMatch(/; unknown — preflight probe unavailable: boom$/);
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

describe("model cache check (#53)", () => {
  it("reports an explicit ENGRAM_MODEL_CACHE_DIR as durable and creates it", () => {
    const dir = join(tmpRoot, "override-me");
    const check = checkModelCache({ dir, source: "ENGRAM_MODEL_CACHE_DIR" });
    expect(check.level).toBe("ok");
    expect(check.detail).toContain(dir);
    expect(check.detail).toContain("durable: yes");
    expect(check.detail).toContain("from ENGRAM_MODEL_CACHE_DIR");
    expect(existsSync(dir)).toBe(true);
  });

  it("names the default tier and says how to relocate it", () => {
    const dir = join(tmpRoot, "data", "models");
    const check = checkModelCache({ dir, source: "default" });
    expect(check.level).toBe("ok");
    expect(check.detail).toContain(dir);
    expect(check.detail).toContain("durable: yes");
    expect(check.detail).toMatch(/default; set ENGRAM_MODEL_CACHE_DIR/);
    expect(checkModelCache({ dir, source: "HF_HOME" }).detail).toContain("from HF_HOME");
  });

  it("says durable: no (and warns) only when the dir sits inside a node_modules directory", () => {
    const inside = join(tmpRoot, "pkg", "node_modules", "@xenova", "transformers", ".cache");
    const check = checkModelCache({ dir: inside, source: "ENGRAM_MODEL_CACHE_DIR" });
    expect(check.level).toBe("warn");
    expect(check.required).toBe(true);
    expect(check.detail).toContain("durable: no");
    expect(check.detail).toMatch(/wiped by npm ci/);
    // a path that merely *contains* the word is not inside node_modules
    const lookalike = join(tmpRoot, "my_node_modules_backup", "models");
    expect(checkModelCache({ dir: lookalike, source: "ENGRAM_MODEL_CACHE_DIR" }).detail).toContain("durable: yes");
  });

  it("fails when the directory cannot be created", () => {
    // A path *under a regular file* cannot be mkdir'd on any platform.
    const file = join(tmpRoot, "not-a-dir");
    writeFileSync(file, "x");
    const check = checkModelCache({ dir: join(file, "models"), source: "ENGRAM_MODEL_CACHE_DIR" });
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
        const check = checkModelCache({ dir, source: "default" });
        expect(check.level).toBe("warn");
        expect(check.detail).toMatch(/read-only/);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
});

describe("model cache resolution", () => {
  it("applyModelCacheDir points env at the override, else at the config's resolved dir", () => {
    const env = { cacheDir: "/lib/.cache/" };
    expect(applyModelCacheDir(env, "/custom")).toBe("/custom");
    expect(env.cacheDir).toBe("/custom");
    // No override: loadConfig() always resolves a durable dir now (#53), never the library default.
    const resolved = applyModelCacheDir(env, undefined);
    expect(resolved).toBe(loadConfig().modelCacheDir);
    expect(env.cacheDir).toBe(resolved);
    expect(resolved).not.toContain("node_modules");
  });
});

describe("engram doctor CLI", () => {
  const cli = fileURLToPath(
    new URL("../../../dist/interfaces/cli/index.js", import.meta.url),
  );
  const built = existsSync(cli);

  // --no-smoke and a temp data dir: the built CLI must never extract against
  // (or write to) the developer's real store from a test.
  function run(...args: string[]): string {
    return execFileSync(process.execPath, [cli, "doctor", "--no-smoke", ...args], {
      encoding: "utf8",
      env: { ...process.env, ENGRAM_MODEL_CACHE_DIR: join(tmpRoot, "cli-cache"), ENGRAM_DATA_DIR: join(tmpRoot, "cli-data") },
    });
  }

  // Spawning the built CLI cold (ESM import + native modules + network probes
  // that must time out) takes well over vitest's 5 s default on CI runners.
  const CLI_TIMEOUT_MS = 60_000;

  it.skipIf(!built)("prints every check and a verdict, exiting 0 on a supported platform", () => {
    const out = run();
    for (const name of DOCTOR_CHECK_NAMES) {
      expect(out).toMatch(new RegExp(`^\\[(ok|--|FAIL)\\]\\s+${name.replace("/", "\\/")}: `, "m"));
    }
    expect(out).toMatch(/^Doctor: /m);
  }, CLI_TIMEOUT_MS);

  it.skipIf(!built)("--json emits a parseable report with the same checks", () => {
    const parsed = JSON.parse(run("--json")) as DoctorReport;
    expect(parsed.checks.map((c) => c.name)).toEqual([...DOCTOR_CHECK_NAMES]);
    expect(parsed.platform).toBe(`${process.platform}-${process.arch}`);
    expect(parsed.smoke?.status).toBe("skipped");
    expect(parsed.checks.find((c) => c.name === "extraction smoke")!.detail).toBe("skipped (--no-smoke)");
  }, CLI_TIMEOUT_MS);

  it.skipIf(!built)("--strict exits 1 when any check is not [ok] (the skipped smoke is one)", () => {
    let status = 0;
    try { run("--strict"); } catch (err) { status = (err as { status: number }).status; }
    expect(status).toBe(1);
  }, CLI_TIMEOUT_MS);
});

describe("data dir check (issues #13, #44)", () => {
  function populated(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const db = join(dir, "engram.db");
    writeFileSync(db, "not really sqlite but populated");
    return db;
  }

  it("reports the effective data dir and db path", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-dd-"));
    try {
      const cfg = loadConfig({ dataDir: join(root, "data") });
      const c = checkDataDir(cfg, join(root, "legacy"));
      expect(c.name).toBe("data dir");
      expect(c.level).toBe("ok");
      expect(c.required).toBe(false);
      expect(c.detail).toContain(join(root, "data"));
      expect(c.detail).toContain("not created yet");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns when this process would start empty while a populated legacy database exists", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-dd-"));
    try {
      const legacyDb = populated(join(root, "legacy"));
      const cfg = loadConfig({ dataDir: join(root, "new") });
      const c = checkDataDir(cfg, join(root, "legacy"));
      expect(c.level).toBe("warn");
      expect(c.detail).toContain("would start EMPTY");
      expect(c.detail).toContain(legacyDb);
      expect(c.detail).toContain("engram update --plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns about a second database when both are populated, and is ok when they are the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-doctor-dd-"));
    try {
      populated(join(root, "legacy"));
      populated(join(root, "new"));
      const both = checkDataDir(loadConfig({ dataDir: join(root, "new") }), join(root, "legacy"));
      expect(both.level).toBe("warn");
      expect(both.detail).toContain("second database");
      const same = checkDataDir(loadConfig({ dataDir: join(root, "legacy") }), join(root, "legacy"));
      expect(same.level).toBe("ok");
      expect(same.detail).toContain("MB");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("legacyDataDir is ~/.local/share/engram on every platform", () => {
    expect(legacyDataDir("/home/x")).toBe(join("/home/x", ".local", "share", "engram"));
  });
});

describe("mcp daemon check (issue #28)", () => {
  it("is ok with worker counts when /health answers like the daemon", async () => {
    const c = await checkMcpDaemon(9907, async () => ({
      status: 200, body: JSON.stringify({ status: "ok", workers: { size: 2, ready: 2, busy: 0 } }),
    }));
    expect(c.name).toBe("mcp daemon");
    expect(c.level).toBe("ok");
    expect(c.required).toBe(false);
    expect(c.detail).toContain("http://127.0.0.1:9907/health");
    expect(c.detail).toContain("workers: 2, ready: 2");
  });

  it("warns (never fails) when nothing answers, naming the installer", async () => {
    const c = await checkMcpDaemon(9907, async () => { throw new Error("ECONNREFUSED"); });
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("not answering");
    expect(c.detail).toContain("install-mcp-daemon.sh");
  });

  it("warns when something else holds the port", async () => {
    const c = await checkMcpDaemon(9907, async () => ({ status: 404, body: "<html>nope</html>" }));
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("not like the engram daemon");
    expect(c.detail).toContain("HTTP 404");
  });

  it("the real probe talks HTTP to 127.0.0.1 and rejects on a closed port", async () => {
    const srv = createServer((req, res) => {
      expect(req.url).toBe("/health");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", workers: { size: 0 } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const live = await checkMcpDaemon(port);
      expect(live.level).toBe("ok");
      expect(live.detail).toContain("workers: 0");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    await expect(probeMcpHealth(port, 500)).rejects.toThrow();
    const dead = await checkMcpDaemon(port);
    expect(dead.level).toBe("warn");
  });
});

describe("hosts check (issue #50)", () => {
  it("sits right before the extraction smoke, never required, and warns with the install hint on an empty home", async () => {
    expect(DOCTOR_CHECK_NAMES.at(-2)).toBe("hosts");
    expect(DOCTOR_CHECK_NAMES.at(-1)).toBe("extraction smoke");
    // #61: `env file` follows `data dir`
    expect(DOCTOR_CHECK_NAMES[DOCTOR_CHECK_NAMES.indexOf("data dir") + 1]).toBe("env file");
    const home = mkdtempSync(join(tmpdir(), "engram-doctor-hosts-"));
    try {
      const c = await checkHosts(defaultHostContext({ home, env: { HOME: home }, packageRoot: join(home, "pkg"), hermesHome: join(home, ".hermes") }));
      expect(c.name).toBe("hosts");
      expect(c.level).toBe("warn");
      expect(c.required).toBe(false);
      expect(c.detail).toContain("engram mcp install");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const live = report.checks.find((c) => c.name === "hosts")!;
    expect(["ok", "warn"]).toContain(live.level);
    expect(live.required).toBe(false);
  });
});
