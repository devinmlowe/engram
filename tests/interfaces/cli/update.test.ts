/**
 * Issue #44: `engram update` / `engram migrate` / `engram import-legacy`.
 * Every supervisor and shell call is a fake; the data dir and database are
 * real files in a temp dir so the move/backup/snapshot logic is exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../../../src/_core/config/index.js";
import { initDatabase } from "../../../src/_core/db/index.js";
import { ENGRAM_VERSION, PACKAGE_NAME, PACKAGE_ROOT } from "../../../src/_core/version/index.js";
import { snapshotCounts, snapshotRegressions, SNAPSHOT_KEYS } from "../../../src/interfaces/cli/snapshot.js";
import { compareSemver, detectInstall, latestAvailable, formatCheck } from "../../../src/interfaces/cli/install-kind.js";
import {
  listServices, stopService, startService, portFor, LEGACY_MCP_LABEL,
  type ServiceDeps, type ExecResult,
} from "../../../src/interfaces/cli/services.js";
import {
  planDataDir, applyDataDirPlan, planModelCache, applyModelCachePlan, reportSchema, isSqliteFile, DATA_DIR_ITEMS,
} from "../../../src/interfaces/cli/data-migration.js";
import { buildUpdatePlan, formatPlan, runUpdate, backupDirFor, backupDataDir, pluginDeployTargets, MODEL_CACHE_BACKUP_NOTE, type UpdateDeps } from "../../../src/interfaces/cli/update.js";
import {
  listRollbackPlans, readRollbackPlan, restoreDataDir, rollbackPlanPath, rollbackUpdate, schemaRollbackCheck, selectRollbackPlan, formatRollbackPlans,
  writeRollbackPlan, ROLLBACK_PLANS_KEPT, type RollbackPlan,
} from "../../../src/interfaces/cli/rollback.js";
import { SCHEMA_MIGRATIONS, SCHEMA_VERSION, BREAKING_MIGRATIONS } from "../../../src/_core/db/schema.js";

const ENV_KEYS = ["ENGRAM_DATA_DIR", "ENGRAM_DB_PATH", "ENGRAM_MODEL_CACHE_DIR", "HF_HOME", "ENGRAM_MCP_PORT", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "LOCALAPPDATA", "ENGRAM_ENV_FILE", "PORT"];
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), "engram-update-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

/** A real engram database with a few rows, closed again. */
function seedDb(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig({ dataDir, dbPath: join(dataDir, "engram.db") });
  const db = initDatabase(cfg);
  db.prepare("INSERT INTO conversations (id, project, started_at, last_indexed) VALUES ('c1', 'p', 1, 1)").run();
  db.prepare("INSERT INTO entities (id, name, type, first_seen, last_seen) VALUES ('e1', 'engram', 'project', 1, 1)").run();
  db.close();
}

type Call = { cmd: string; args: string[] };
function fakeExec(handlers: Array<[RegExp, (args: string[]) => Partial<ExecResult> | void]>, calls: Call[] = []) {
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push({ cmd, args });
    const line = `${cmd} ${args.join(" ")}`;
    for (const [re, h] of handlers) {
      if (re.test(line)) return { status: 0, stdout: "", stderr: "", ...(h(args) ?? {}) };
    }
    return { status: 1, stdout: "", stderr: `no fake for: ${line}` };
  };
  return { exec, calls };
}

function deps(platform: ServiceDeps["platform"], exec: ServiceDeps["exec"], probe: ServiceDeps["probe"], home: string): ServiceDeps {
  return { platform, exec, probe, home, engramDir: root, env: process.env, uid: 501 };
}

// ─── snapshot ────────────────────────────────────────────────────────

describe("stats snapshot", () => {
  it("counts every table and flags only drops as regressions", () => {
    const dir = join(root, "data");
    seedDb(dir);
    const db = new Database(join(dir, "engram.db"), { readonly: true });
    const s = snapshotCounts(db);
    db.close();
    expect(s.conversations).toBe(1);
    expect(s.entities).toBe(1);
    expect(Object.keys(s).sort()).toEqual([...SNAPSHOT_KEYS].sort());
    expect(snapshotRegressions(s, { ...s, entities: 5 })).toEqual([]);
    expect(snapshotRegressions(s, { ...s, entities: 0, conversations: 0 })).toEqual(["conversations: 1 -> 0", "entities: 1 -> 0"]);
  });
});

// ─── install kind / --check ──────────────────────────────────────────

describe("install kind and --check", () => {
  it("compareSemver orders numerically with pre-releases below", () => {
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1);
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });

  it("a checkout with .git is a git install; tags on origin give the available version", async () => {
    mkdirSync(join(root, ".git"));
    const { exec } = fakeExec([
      [/rev-parse --abbrev-ref/, () => ({ stdout: "main\n" })],
      [/remote get-url/, () => ({ stdout: "git@github.com:devinmlowe/engram.git\n" })],
      [/status --porcelain/, () => ({ stdout: " M README.md\n" })],
      [/rev-parse --short/, () => ({ stdout: "abc1234\n" })],
      [/ls-remote --tags/, () => ({ stdout: "aaa\trefs/tags/v0.2.0\nbbb\trefs/tags/v0.10.0\nccc\trefs/tags/v0.3.0\n" })],
    ]);
    const info = await detectInstall({ exec, packageRoot: root, version: "0.3.0" });
    expect(info).toMatchObject({ kind: "git", root, version: "0.3.0", branch: "main", dirty: true, headSha: "abc1234" });
    const avail = await latestAvailable(info, exec);
    expect(avail.version).toBe("0.10.0");
    const lines = formatCheck(info, avail);
    expect(lines[0]).toContain("uncommitted changes");
    expect(lines.at(-1)).toContain("update available: 0.3.0 -> 0.10.0");
  });

  it("without .git it is an npm install; the registry dist-tag gives the available version", async () => {
    const { exec, calls } = fakeExec([[/npm view/, () => ({ stdout: "0.3.0\n" })]]);
    const info = await detectInstall({ exec, packageRoot: root, version: "0.3.0" });
    expect(info.kind).toBe("npm");
    expect(info.packageName).toBe(PACKAGE_NAME);
    const avail = await latestAvailable(info, exec);
    expect(avail.version).toBe("0.3.0");
    expect(calls[0].args).toEqual(["view", PACKAGE_NAME, "dist-tags.latest"]);
    expect(formatCheck(info, avail).at(-1)).toBe("up to date");
    const down = await latestAvailable(info, async () => ({ status: 1, stdout: "", stderr: "ENOTFOUND" }));
    expect(down.version).toBeNull();
    expect(formatCheck(info, down)[1]).toContain("ENOTFOUND");
  });

  it("the running version comes from package.json, not a literal", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
    expect(ENGRAM_VERSION).toBe(pkg.version);
    for (const f of ["src/interfaces/cli/index.ts", "src/interfaces/mcp/server.ts", "src/interfaces/mcp/http.ts"]) {
      expect(readFileSync(join(PACKAGE_ROOT, f), "utf-8"), `${f} uses ENGRAM_VERSION`).toContain("ENGRAM_VERSION");
      expect(readFileSync(join(PACKAGE_ROOT, f), "utf-8")).not.toMatch(/version: "\d+\.\d+\.\d+"|\.version\("\d/);
    }
  });
});

// ─── supervisor adapters ─────────────────────────────────────────────

describe("supervisor adapters", () => {
  it("launchd: reads plists under ~/Library/LaunchAgents, PID from launchctl list, falls back to the legacy mcp label", async () => {
    const home = join(root, "home");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", `${LEGACY_MCP_LABEL}.plist`), "<plist/>");
    writeFileSync(join(home, "Library", "LaunchAgents", "com.engram.dreamstate.plist"), "<plist/>");
    const { exec, calls } = fakeExec([
      [/launchctl list com\.engram\.mcp$/, () => ({ status: 113 })],
      [/launchctl list ai\.hermes\.engram-mcp$/, () => ({ stdout: '{\n\t"PID" = 4242;\n\t"Label" = "ai.hermes.engram-mcp";\n};' })],
      [/launchctl list com\.engram\.dreamstate$/, () => ({ stdout: '{\n\t"LastExitStatus" = 0;\n};' })],
      [/launchctl list com\.engram\.visualizer$/, () => ({ status: 113 })],
      [/launchctl (unload|load)/, () => ({})],
    ]);
    const d = deps("darwin", exec, async (port) => port === 9907 || port === 3001, home);
    const list = await listServices(d);
    const mcp = list.find((s) => s.id === "mcp")!;
    expect(mcp).toMatchObject({ supervisor: "launchd", unit: LEGACY_MCP_LABEL, installed: true, running: true, listening: true, unsupervised: false });
    expect(mcp.restartCommand).toBe(`launchctl kickstart -k gui/501/${LEGACY_MCP_LABEL}`);
    const dream = list.find((s) => s.id === "dream")!;
    expect(dream).toMatchObject({ installed: true, running: true, listening: null });
    const vis = list.find((s) => s.id === "visualizer")!;
    expect(vis).toMatchObject({ installed: false, running: false, listening: true, unsupervised: true });
    expect(vis.installHint).toContain("install-visualizer.sh install");
    await stopService(mcp, d);
    expect(calls.at(-1)!.args).toEqual(["unload", join(home, "Library", "LaunchAgents", `${LEGACY_MCP_LABEL}.plist`)]);
    await startService(mcp, d);
    expect(calls.at(-1)!.args[0]).toBe("load");
  });

  it("systemd: unit files under $XDG_CONFIG_HOME/systemd/user and is-active decide installed/running", async () => {
    const xdg = join(root, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    mkdirSync(join(xdg, "systemd", "user"), { recursive: true });
    writeFileSync(join(xdg, "systemd", "user", "engram-mcp.service"), "[Unit]");
    const { exec, calls } = fakeExec([
      [/is-active engram-mcp\.service/, () => ({ stdout: "active\n" })],
      [/is-active/, () => ({ status: 3, stdout: "inactive\n" })],
      [/systemctl --user (stop|start|restart)/, () => ({})],
    ]);
    const d = deps("linux", exec, async () => false, join(root, "home"));
    const list = await listServices(d);
    const mcp = list.find((s) => s.id === "mcp")!;
    expect(mcp).toMatchObject({ supervisor: "systemd", unit: "engram-mcp.service", installed: true, running: true, listening: false });
    expect(mcp.restartCommand).toBe("systemctl --user restart engram-mcp.service");
    expect(list.find((s) => s.id === "dream")).toMatchObject({ unit: "engram-dream.timer", installed: false, running: false });
    await stopService(mcp, d);
    expect(calls.at(-1)!.args).toEqual(["--user", "stop", "engram-mcp.service"]);
  });

  it("windows: schtasks CSV status, ps1 installers drive stop/start, dream is ended not stopped", async () => {
    const { exec, calls } = fakeExec([
      [/schtasks\.exe \/Query \/TN \\Engram\\MCP/, () => ({ stdout: '"\\Engram\\MCP","N/A","Running"\r\n' })],
      [/schtasks\.exe \/Query \/TN \\Engram\\Dream/, () => ({ stdout: '"\\Engram\\Dream","9/18/2026 2:00:00 AM","Ready"\r\n' })],
      [/schtasks\.exe \/Query/, () => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." })],
      [/powershell\.exe/, () => ({})],
      [/schtasks\.exe \/End/, () => ({})],
    ]);
    const d = deps("win32", exec, async () => true, "C:\\Users\\x");
    const list = await listServices(d);
    const mcp = list.find((s) => s.id === "mcp")!;
    expect(mcp).toMatchObject({ supervisor: "task-scheduler", unit: "\\Engram\\MCP", installed: true, running: true, unsupervised: false });
    expect(mcp.stopCommand).toContain("install-mcp-daemon.ps1 stop");
    expect(list.find((s) => s.id === "dream")).toMatchObject({ installed: true, running: false });
    expect(list.find((s) => s.id === "visualizer")).toMatchObject({ installed: false, unsupervised: true });
    await stopService(mcp, d);
    expect(calls.at(-1)!.cmd).toBe("powershell.exe");
    expect(calls.at(-1)!.args.at(-1)).toBe("stop");
    const dream = { ...list.find((s) => s.id === "dream")!, running: true };
    await stopService(dream, d);
    expect(calls.at(-1)!.args).toEqual(["/End", "/TN", "\\Engram\\Dream"]);
  });

  it("ports follow ENGRAM_MCP_PORT / PORT", () => {
    process.env.ENGRAM_MCP_PORT = "9910";
    process.env.PORT = "4001";
    expect(portFor("mcp", process.env)).toEqual({ port: 9910, path: "/health" });
    expect(portFor("visualizer", process.env)).toEqual({ port: 4001, path: "/api/health" });
    expect(portFor("dream", process.env)).toBeNull();
  });
});

// ─── engram migrate ──────────────────────────────────────────────────

describe("migrate data-dir", () => {
  it("a fresh install has nothing to do", () => {
    const home = join(root, "home");
    const cfg = loadConfig({ dataDir: join(root, "data") });
    const plan = planDataDir({ config: cfg, env: {}, platform: "darwin", home });
    expect(plan.action).toMatchObject({ kind: "none" });
    expect(plan.candidates.map((c) => c.reasons)).toContainEqual(["effective"]);
  });

  it("legacy populated + effective empty => move every item (dry-run changes nothing, run moves and leaves a note)", () => {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    mkdirSync(join(legacy, "archive", "proj"), { recursive: true });
    writeFileSync(join(legacy, "archive", "proj", "c.jsonl"), "{}\n");
    mkdirSync(join(legacy, "logs"), { recursive: true });
    const xdg = join(root, "xdg");
    const env = { XDG_DATA_HOME: xdg };
    const cfg = loadConfig({ dataDir: join(xdg, "engram") });
    const plan = planDataDir({ config: cfg, env, platform: "linux", home });
    expect(plan.action).toMatchObject({ kind: "move", from: legacy, to: join(xdg, "engram") });
    expect((plan.action as { items: string[] }).items).toEqual(["engram.db", "archive", "logs"]);
    const dry = applyDataDirPlan(plan, { dryRun: true });
    expect(dry.every((l) => l.startsWith("would "))).toBe(true);
    expect(existsSync(join(legacy, "engram.db"))).toBe(true);
    expect(existsSync(join(xdg, "engram", "engram.db"))).toBe(false);
    const done = applyDataDirPlan(plan, { dryRun: false });
    expect(done.some((l) => l.startsWith("moved "))).toBe(true);
    expect(isSqliteFile(join(xdg, "engram", "engram.db"))).toBe(true);
    expect(existsSync(join(xdg, "engram", "archive", "proj", "c.jsonl"))).toBe(true);
    expect(existsSync(join(legacy, "engram.db"))).toBe(false);
    expect(readFileSync(join(legacy, "MOVED-TO.txt"), "utf-8")).toContain(join(xdg, "engram"));
    // idempotent: a second plan finds the data where it belongs
    expect(planDataDir({ config: cfg, env, platform: "linux", home }).action.kind).toBe("none");
  });

  it("two populated directories => refuse; ENGRAM_DB_PATH => leave alone", () => {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    const local = join(root, "LocalAppData");
    seedDb(join(local, "engram"));
    const env = { LOCALAPPDATA: local };
    const both = planDataDir({ config: loadConfig({ dataDir: join(local, "engram") }), env, platform: "win32", home });
    expect(both.action.kind).toBe("refuse");
    expect((both.action as { populated: string[] }).populated).toHaveLength(2);
    expect(applyDataDirPlan(both, { dryRun: false })[0]).toContain("nothing to do");
    const explicit = planDataDir({
      config: loadConfig({ dataDir: join(root, "elsewhere"), dbPath: join(root, "elsewhere", "engram.db") }),
      env: { ENGRAM_DB_PATH: join(root, "elsewhere", "engram.db") }, platform: "darwin", home,
    });
    expect(explicit.source).toBe("ENGRAM_DB_PATH");
    expect(explicit.action).toMatchObject({ kind: "none" });
    expect((explicit.action as { reason: string }).reason).toContain("ignored on purpose");
  });

  it("DATA_DIR_ITEMS covers the database, its WAL, archive, logs and tmp", () => {
    expect([...DATA_DIR_ITEMS]).toEqual(["engram.db", "engram.db-wal", "engram.db-shm", "archive", "logs", "tmp"]);
  });
});

describe("migrate model-cache and schema", () => {
  /** A fake pre-0.4.0 cache inside a package's node_modules, with a couple of model files. */
  function legacyCache(pkg: string): string {
    const legacy = join(pkg, "node_modules", "@xenova", "transformers", ".cache");
    mkdirSync(join(legacy, "Xenova", "m", "onnx"), { recursive: true });
    writeFileSync(join(legacy, "Xenova", "m", "config.json"), "{}");
    writeFileSync(join(legacy, "Xenova", "m", "onnx", "model.onnx"), "weights");
    return legacy;
  }

  it("default tier (#53): moves a legacy node_modules cache into <dataDir>/models once, then is a no-op", () => {
    const pkg = join(root, "pkg");
    const legacy = legacyCache(pkg);
    const home = join(root, "home");
    const envFile = join(home, ".config", "engram", "env");
    mkdirSync(join(home, ".config", "engram"), { recursive: true });
    writeFileSync(envFile, "#ANTHROPIC_API_KEY=\n");
    const cfg = loadConfig({ dataDir: join(root, "data") });
    const plan = planModelCache({ config: cfg, env: {}, platform: "linux", home }, pkg);
    expect(plan).toMatchObject({
      durable: true, source: "default", current: join(root, "data", "models"), proposed: join(root, "data", "models"), legacy, hasModels: true, envFile,
    });
    const dry = applyModelCachePlan(plan, { dryRun: true });
    expect(dry.join("\n")).toContain("would move the downloaded models");
    expect(existsSync(plan.proposed)).toBe(false);
    expect(existsSync(join(legacy, "Xenova", "m", "onnx", "model.onnx"))).toBe(true);

    const lines = applyModelCachePlan(plan, { dryRun: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^moved the model cache from .* \(2 files; npm no longer wipes it\)$/);
    expect(readFileSync(join(plan.proposed, "Xenova", "m", "onnx", "model.onnx"), "utf-8")).toBe("weights");
    expect(existsSync(legacy)).toBe(false); // du of the legacy dir is 0
    // the default needs no env var: the service env file is left alone
    expect(readFileSync(envFile, "utf-8")).not.toContain("ENGRAM_MODEL_CACHE_DIR");

    // second run: nothing legacy left, the default already applies
    const again = planModelCache({ config: cfg, env: {}, platform: "linux", home }, pkg);
    expect(again.hasModels).toBe(false);
    const noop = applyModelCachePlan(again, { dryRun: false });
    expect(noop).toHaveLength(1);
    expect(noop[0]).toContain("nothing to do: the durable default");
    expect(noop[0]).toContain(again.current);
  });

  it("explicit durable dirs: already-durable message, legacy models still adopted when the target is empty", () => {
    const pkg = join(root, "pkg");
    const home = join(root, "home");
    const explicit = join(root, "m");
    const durable = planModelCache({ config: loadConfig({ dataDir: join(root, "data"), modelCacheDir: explicit }), env: {}, platform: "win32", home }, pkg);
    expect(durable).toMatchObject({ durable: true, source: "override", current: explicit, proposed: explicit, hasModels: false });
    expect(applyModelCachePlan(durable, { dryRun: false })[0]).toContain("already durable");
    expect(durable.envLine).toMatch(/^setx ENGRAM_MODEL_CACHE_DIR/);
    expect(durable.envFile).toBeNull();

    // ENGRAM_MODEL_CACHE_DIR set + a legacy cache: the weights move rather than re-download
    legacyCache(pkg);
    const env = { ENGRAM_MODEL_CACHE_DIR: explicit };
    const withLegacy = planModelCache({ config: loadConfig({ dataDir: join(root, "data"), modelCacheDir: explicit }), env, platform: "linux", home }, pkg);
    expect(withLegacy).toMatchObject({ durable: true, source: "ENGRAM_MODEL_CACHE_DIR", hasModels: true });
    applyModelCachePlan(withLegacy, { dryRun: false });
    expect(existsSync(join(explicit, "Xenova", "m", "config.json"))).toBe(true);
    expect(existsSync(withLegacy.legacy)).toBe(false);
  });

  it("explicit relocation: an ENGRAM_MODEL_CACHE_DIR inside node_modules is not durable and moves to <dataDir>/models with the env line", () => {
    const pkg = join(root, "pkg");
    const legacy = legacyCache(pkg);
    const home = join(root, "home");
    const envFile = join(home, ".config", "engram", "env");
    mkdirSync(join(home, ".config", "engram"), { recursive: true });
    writeFileSync(envFile, "#ANTHROPIC_API_KEY=\n");
    const env = { ENGRAM_MODEL_CACHE_DIR: legacy };
    const cfg = loadConfig({ dataDir: join(root, "data"), modelCacheDir: legacy });
    const plan = planModelCache({ config: cfg, env, platform: "linux", home }, pkg);
    expect(plan).toMatchObject({ durable: false, source: "ENGRAM_MODEL_CACHE_DIR", current: legacy, proposed: join(root, "data", "models"), hasModels: true, envFile });
    const dry = applyModelCachePlan(plan, { dryRun: true }).join("\n");
    expect(dry).toContain("would create");
    expect(dry).toContain("would move the downloaded models");
    expect(existsSync(plan.proposed)).toBe(false);
    applyModelCachePlan(plan, { dryRun: false });
    expect(existsSync(join(plan.proposed, "Xenova", "m", "onnx", "model.onnx"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(envFile, "utf-8")).toContain(`ENGRAM_MODEL_CACHE_DIR='${plan.proposed}'`);
    // second run: env line not duplicated, nothing left to move
    const again = planModelCache({ config: cfg, env, platform: "linux", home }, pkg);
    expect(again.hasModels).toBe(false);
    applyModelCachePlan(again, { dryRun: false });
    expect(readFileSync(envFile, "utf-8").match(/ENGRAM_MODEL_CACHE_DIR=/g)).toHaveLength(1);
  });

  it("schema: opening once runs the migrations and lists the checkpoints", async () => {
    const dir = join(root, "data");
    const cfg = loadConfig({ dataDir: dir, dbPath: join(dir, "engram.db") });
    mkdirSync(dir, { recursive: true });
    const report = await reportSchema(cfg);
    expect(report.dbPath).toBe(join(dir, "engram.db"));
    expect(report.applied.map((m) => m.name)).toEqual(expect.arrayContaining(["commitments_v1"]));
  });
});

// ─── engram update ───────────────────────────────────────────────────

function updateDeps(platform: ServiceDeps["platform"], home: string, cfg: ReturnType<typeof loadConfig>, exec: ServiceDeps["exec"], probe: ServiceDeps["probe"], log: string[]): UpdateDeps {
  return {
    config: cfg,
    services: deps(platform, exec, probe, home),
    packageRoot: root,
    hermesHome: join(home, ".hermes"),
    now: () => new Date("2026-09-17T12:34:56Z"),
    log: (l) => log.push(l),
    node: process.execPath,
    cliScript: () => "cli.js",
  };
}

describe("update --plan", () => {
  it("reports the legacy split, model cache, services, plugin targets and blockers, touching nothing", async () => {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    mkdirSync(join(home, ".hermes", "plugins", "engram"), { recursive: true });
    mkdirSync(join(home, ".hermes", "profiles", "work", "plugins", "engram"), { recursive: true });
    mkdirSync(join(root, ".git"));
    const xdg = join(root, "xdg");
    process.env.XDG_DATA_HOME = xdg;
    const cfg = loadConfig({ dataDir: join(xdg, "engram") });
    const { exec } = fakeExec([
      [/rev-parse --abbrev-ref/, () => ({ stdout: "main\n" })],
      [/remote get-url/, () => ({ stdout: "origin\n" })],
      [/status --porcelain/, () => ({ stdout: "" })],
      [/rev-parse --short/, () => ({ stdout: "abc1234\n" })],
      [/ls-remote --tags/, () => ({ stdout: "x\trefs/tags/v0.4.0\n" })],
      [/launchctl list/, () => ({ status: 113 })],
    ]);
    // nothing supervised, but something answers on 9907 => unsupervised blocker
    const d = updateDeps("darwin", home, cfg, exec, async (port) => port === 9907, []);
    const plan = await buildUpdatePlan(d);
    expect(plan.install.kind).toBe("git");
    expect(plan.target).toBe("0.4.0");
    expect(plan.dataDir.action).toMatchObject({ kind: "move", from: legacy });
    // #53: durable by default, no ENGRAM_MODEL_CACHE_DIR needed
    expect(plan.modelCache).toMatchObject({ durable: true, source: "default", current: join(xdg, "engram", "models") });
    expect(plan.pluginTargets).toHaveLength(2);
    expect(plan.pluginProfiles).toEqual(["work"]);
    expect(plan.backupDir).toBe(backupDirFor(legacy, d.now()));
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain("mcp answers on its port but no supervisor owns it");
    const text = formatPlan(plan).join("\n");
    expect(text).toContain("[db]  " + legacy);
    expect(text).toContain("will move engram.db");
    expect(text).toContain("0.3.0 -> 0.4.0");
    expect(text).toContain("UNSUPERVISED");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("Hermes plugin: 2 deploy target(s) (profiles: work)");
    expect(text).toContain(`Model cache: ${join(xdg, "engram", "models")} (durable; default`);
    expect(text).toContain(MODEL_CACHE_BACKUP_NOTE); // decision #54, printed once
    expect(text.split(MODEL_CACHE_BACKUP_NOTE)).toHaveLength(2);
    expect(existsSync(join(legacy, "engram.db"))).toBe(true); // untouched
    expect(existsSync(plan.backupDir!)).toBe(false);
    // dry run prints the plan and does nothing either
    const res = await runUpdate({ ...plan, blockers: [] }, d, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(existsSync(join(legacy, "engram.db"))).toBe(true);
    const noBackup = await buildUpdatePlan(d, { noBackup: true });
    expect(noBackup.backupDir).toBeNull();
    expect(noBackup.steps[0]).toContain("skip the backup");
  });

  it("a dirty checkout and two populated data dirs are blockers", async () => {
    const home = join(root, "home");
    seedDb(join(home, ".local", "share", "engram"));
    const xdg = join(root, "xdg");
    process.env.XDG_DATA_HOME = xdg;
    seedDb(join(xdg, "engram"));
    mkdirSync(join(root, ".git"));
    const { exec } = fakeExec([
      [/status --porcelain/, () => ({ stdout: " M x\n" })],
      [/git/, () => ({ stdout: "" })],
      [/launchctl list/, () => ({ status: 113 })],
    ]);
    const plan = await buildUpdatePlan(updateDeps("darwin", home, loadConfig({ dataDir: join(xdg, "engram") }), exec, async () => false, []));
    expect(plan.blockers.some((b) => b.includes("uncommitted changes"))).toBe(true);
    expect(plan.blockers.some((b) => b.includes("two directories both hold a database"))).toBe(true);
    const res = await runUpdate(plan, updateDeps("darwin", home, plan.dataDir as never, exec, async () => false, []) as never);
    expect(res.ok).toBe(false);
    expect(res.lines[0]).toBe("Refusing to update:");
  });

  it("prints the doctor install-path warning as a plan warning, never a blocker (#65)", async () => {
    const home = join(root, "home");
    seedDb(join(root, "data"));
    const other = join(root, "other", "lib", "node_modules", "@devinmlowe", "engram", "dist", "interfaces", "cli");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "index.js"), "");
    mkdirSync(join(root, "other", "bin"));
    writeFileSync(join(root, "other", "bin", "engram"), `#!/bin/sh\nexec node ${join(other, "index.js")} "$@"\n`);
    const { exec } = fakeExec([[/npm view/, () => ({ stdout: "0.3.0\n" })], [/launchctl list/, () => ({ status: 113 })]]);
    const d = updateDeps("darwin", home, loadConfig({ dataDir: join(root, "data") }), exec, async () => false, []);
    // the check's install root is this checkout, not the temp root that holds the other tree
    const checkout = join(root, "checkout");
    d.installPath = { packageRoot: checkout, argv1: join(checkout, "dist", "interfaces", "cli", "index.js"), path: join(root, "other", "bin") };
    const plan = await buildUpdatePlan(d, { noBackup: true });
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("install path: `engram` on PATH is not this install: " + join(root, "other", "bin", "engram"));
    const text = formatPlan(plan).join("\n");
    expect(text).toContain("Warnings:\n  -- install path:");
    expect(text).not.toContain("BLOCKED");
    expect(text).toContain("Rollback:   plan recorded in " + join(root, "data", "updates"));
    d.installPath = { packageRoot: checkout, argv1: join(checkout, "dist", "interfaces", "cli", "index.js"), path: "/nowhere" };
    expect((await buildUpdatePlan(d, { noBackup: true })).warnings).toEqual([]);
  });

  it("pluginDeployTargets ignores a missing hermes home", () => {
    expect(pluginDeployTargets(join(root, "nope"))).toEqual({ targets: [], profiles: [] });
  });
});

describe("backup allowlist (decision #54)", () => {
  it("copies engram.db + wal/shm + archive/ only; models/, logs/ and tmp/ never enter the backup", () => {
    const data = join(root, "data");
    seedDb(data);
    writeFileSync(join(data, "engram.db-wal"), "wal");
    mkdirSync(join(data, "archive", "p"), { recursive: true });
    writeFileSync(join(data, "archive", "p", "c.jsonl"), "{}");
    mkdirSync(join(data, "models", "Xenova", "m"), { recursive: true });
    writeFileSync(join(data, "models", "Xenova", "m", "model.onnx"), "weights");
    mkdirSync(join(data, "logs"), { recursive: true });
    writeFileSync(join(data, "logs", "dream.txt"), "x");
    mkdirSync(join(data, "tmp"), { recursive: true });
    const to = join(root, "data.backup-x");
    const lines = backupDataDir(data, to);
    expect(readdirSync(to).sort()).toEqual(["archive", "engram.db", "engram.db-wal"]);
    expect(existsSync(join(to, "models"))).toBe(false);
    expect(lines.join("\n")).not.toContain("models");
    expect(MODEL_CACHE_BACKUP_NOTE).toBe("models/ is not backed up (re-downloadable); rollback re-downloads if the cache is missing");
  });
});

describe("update run (git install, macOS, legacy data dir)", () => {
  function setup() {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.engram.mcp.plist"), "<plist/>");
    mkdirSync(join(root, ".git"));
    const xdg = join(root, "xdg");
    process.env.XDG_DATA_HOME = xdg;
    const cfg = loadConfig({ dataDir: join(xdg, "engram") });
    let mcpUp = true;
    const probe = async (port: number) => port === 9907 && mcpUp;
    return { home, legacy, xdg, cfg, probe, setMcp: (v: boolean) => { mcpUp = v; } };
  }

  it("stops services, backs up, moves the data, pulls, builds, migrates, restarts, verifies", async () => {
    const { home, legacy, xdg, cfg, probe, setMcp } = setup();
    const newDb = join(xdg, "engram", "engram.db");
    const log: string[] = [];
    const { exec, calls } = fakeExec([
      [/rev-parse --abbrev-ref/, () => ({ stdout: "main\n" })],
      [/remote get-url/, () => ({ stdout: "origin\n" })],
      [/status --porcelain/, () => ({ stdout: "" })],
      [/rev-parse --short/, () => ({ stdout: "abc1234\n" })],
      [/ls-remote --tags/, () => ({ stdout: "x\trefs/tags/v0.4.0\n" })],
      [/launchctl list com\.engram\.mcp$/, () => ({ stdout: '"PID" = 7;' })],
      [/launchctl list/, () => ({ status: 113 })],
      [/launchctl unload/, () => { setMcp(false); }],
      [/launchctl load/, () => { setMcp(true); }],
      [/git -C .* pull --ff-only/, () => ({ stdout: "Already up to date.\n" })],
      [/^npm ci$/, () => ({})],
      [/cli\.js migrate schema/, () => ({ stdout: "schema: ok\n  commitments_v1\n" })],
      [/cli\.js doctor --json/, () => ({ stdout: JSON.stringify({ ok: true, checks: [] }) })],
      [/cli\.js stats --json/, () => {
        const db = new Database(newDb, { readonly: true });
        try { return { stdout: JSON.stringify({ counts: snapshotCounts(db) }) }; } finally { db.close(); }
      }],
    ]);
    const d = updateDeps("darwin", home, cfg, exec, probe, log);
    const plan = await buildUpdatePlan(d);
    expect(plan.blockers).toEqual([]);
    const res = await runUpdate(plan, d);
    expect(res.ok, res.lines.join("\n")).toBe(true);
    // order: unload before backup before pull before npm ci before migrate before load before verify
    const seq = calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    const idx = (re: RegExp) => seq.findIndex((s) => re.test(s));
    expect(idx(/launchctl unload/)).toBeLessThan(idx(/pull --ff-only/));
    expect(idx(/pull --ff-only/)).toBeLessThan(idx(/npm ci/));
    expect(idx(/npm ci/)).toBeLessThan(idx(/migrate schema/));
    expect(idx(/migrate schema/)).toBeLessThan(idx(/launchctl load/));
    expect(idx(/launchctl load/)).toBeLessThan(idx(/doctor --json/));
    // backup holds the db (and never models/); data moved; the model cache is durable by default so npm ci ran without ENGRAM_MODEL_CACHE_DIR
    expect(isSqliteFile(join(plan.backupDir!, "engram.db"))).toBe(true);
    expect(existsSync(join(plan.backupDir!, "models"))).toBe(false);
    expect(isSqliteFile(newDb)).toBe(true);
    expect(existsSync(join(legacy, "engram.db"))).toBe(false);
    expect(plan.modelCache.durable).toBe(true);
    expect(res.lines.some((l) => l.startsWith("model-cache:"))).toBe(false);
    const text = res.lines.join("\n");
    expect(text).toContain("snapshot: exchanges=0 conversations=1");
    expect(text).toContain("counts:   exchanges=0 conversations=1");
    expect(text).toContain("verification passed");
    expect(text).toContain(plan.backupDir!);
  });

  it("a count drop after the update fails loudly and prints rollback steps", async () => {
    const { home, cfg, probe, setMcp } = setup();
    const log: string[] = [];
    const { exec } = fakeExec([
      [/status --porcelain/, () => ({ stdout: "" })],
      [/rev-parse --short/, () => ({ stdout: "abc1234\n" })],
      [/ls-remote --tags/, () => ({ stdout: "x\trefs/tags/v0.4.0\n" })],
      [/git/, () => ({ stdout: "" })],
      [/launchctl list com\.engram\.mcp$/, () => ({ stdout: '"PID" = 7;' })],
      [/launchctl list/, () => ({ status: 113 })],
      [/launchctl unload/, () => { setMcp(false); }],
      [/launchctl load/, () => { setMcp(true); }],
      [/npm ci/, () => ({})],
      [/migrate schema/, () => ({ stdout: "ok\n" })],
      [/doctor --json/, () => ({ stdout: JSON.stringify({ ok: true }) })],
      [/stats --json/, () => ({ stdout: JSON.stringify({ counts: { exchanges: 0, conversations: 0, tool_calls: 0, memories_active: 0, memories_inactive: 0, entities: 0, relationships: 0, topic_clusters: 0, commitments: 0 } }) })],
    ]);
    const d = updateDeps("darwin", home, cfg, exec, probe, log);
    const plan = await buildUpdatePlan(d, { noBackup: true });
    const res = await runUpdate(plan, d);
    expect(res.ok).toBe(false);
    const text = res.lines.join("\n");
    expect(text).toContain("counts DROPPED: conversations: 1 -> 0; entities: 1 -> 0");
    expect(text).toContain("UPDATE FAILED.");
    // #65: not a terminal and no --yes → the rollback command is printed, not run; --no-backup → code-only
    expect(text).toContain("Not a terminal: run `engram update --rollback 20260917-123456Z` to roll back");
    expect(text).toContain("no backup to restore, so a rollback is code-only");
    expect(text).toContain("Manual steps, in order");
    expect(text).toContain(MODEL_CACHE_BACKUP_NOTE); // #54: rollback re-downloads, never restores, models/
    expect(text).toContain("restarted mcp"); // services come back even when verification fails
    expect(text).toContain("stop mcp: launchctl unload");
    expect(text).toContain("git -C " + root + " checkout abc1234 && npm ci");
    expect(text).toContain("the update moved it from");
    expect(res.rollback).toBeUndefined();
    expect(JSON.parse(readFileSync(res.planFile!, "utf-8")).progress).toBe("failed:verify");
  });

  it("a failed git pull aborts before the data dir moves", async () => {
    const { home, legacy, cfg, probe, setMcp } = setup();
    const { exec, calls } = fakeExec([
      [/rev-parse --abbrev-ref/, () => ({ stdout: "main\n" })],
      [/status --porcelain/, () => ({ stdout: "" })],
      [/ls-remote --tags/, () => ({ stdout: "" })],
      [/pull --ff-only/, () => ({ status: 1, stderr: "fatal: Not possible to fast-forward" })],
      [/git/, () => ({ stdout: "" })],
      [/launchctl list com\.engram\.mcp$/, () => ({ stdout: '"PID" = 7;' })],
      [/launchctl list/, () => ({ status: 113 })],
      [/launchctl unload/, () => { setMcp(false); }],
      [/launchctl load/, () => { setMcp(true); }],
    ]);
    const d = updateDeps("darwin", home, cfg, exec, probe, []);
    const plan = await buildUpdatePlan(d, { noBackup: true });
    const res = await runUpdate(plan, d);
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("git pull failed: fatal: Not possible to fast-forward");
    expect(existsSync(join(legacy, "engram.db"))).toBe(true);
    // the branch is named explicitly (a branch with no upstream would otherwise fail), and the
    // services stopped earlier are brought back before the rollback steps are printed
    expect(calls.some((c) => c.cmd === "git" && c.args.join(" ").endsWith("pull --ff-only origin main"))).toBe(true);
    expect(calls.filter((c) => c.cmd === "launchctl" && c.args[0] === "load")).toHaveLength(1);
    expect(res.lines.join("\n")).toContain("restarted mcp");
  });

  it("npm installs use npm install -g <package>@<target>", async () => {
    const home = join(root, "home");
    const data = join(root, "data");
    seedDb(data);
    const { exec, calls } = fakeExec([
      [/npm view/, () => ({ stdout: "0.5.0\n" })],
      [/npm install -g/, () => ({})],
      [/launchctl list/, () => ({ status: 113 })],
      [/migrate schema/, () => ({ stdout: "ok\n" })],
      [/doctor --json/, () => ({ stdout: JSON.stringify({ ok: true }) })],
      [/stats --json/, () => {
        const db = new Database(join(data, "engram.db"), { readonly: true });
        try { return { stdout: JSON.stringify({ counts: snapshotCounts(db) }) }; } finally { db.close(); }
      }],
    ]);
    const d = updateDeps("darwin", home, loadConfig({ dataDir: data, modelCacheDir: join(root, "models") }), exec, async () => false, []);
    const plan = await buildUpdatePlan(d, { noBackup: true });
    expect(plan.install.kind).toBe("npm");
    const res = await runUpdate(plan, d);
    expect(res.ok, res.lines.join("\n")).toBe(true);
    expect(calls.some((c) => c.cmd === "npm" && c.args.join(" ") === `install -g ${PACKAGE_NAME}@0.5.0`)).toBe(true);
  });
});

// ─── rollback plan + engram update --rollback (#65, decision #66) ────

describe("rollback plan file (#65)", () => {
  function setup() {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.engram.mcp.plist"), "<plist/>");
    mkdirSync(join(root, ".git"));
    const xdg = join(root, "xdg");
    process.env.XDG_DATA_HOME = xdg;
    const cfg = loadConfig({ dataDir: join(xdg, "engram") });
    let mcpUp = true;
    const probe = async (port: number) => port === 9907 && mcpUp;
    return { home, legacy, xdg, cfg, probe, setMcp: (v: boolean) => { mcpUp = v; } };
  }
  const gitBase: Array<[RegExp, (args: string[]) => Partial<ExecResult> | void]> = [
    [/rev-parse --abbrev-ref/, () => ({ stdout: "main\n" })],
    [/remote get-url/, () => ({ stdout: "origin\n" })],
    [/status --porcelain/, () => ({ stdout: "" })],
    [/rev-parse --short/, () => ({ stdout: "abc1234\n" })],
    [/ls-remote --tags/, () => ({ stdout: "x\trefs/tags/v0.4.0\n" })],
    [/launchctl list com\.engram\.mcp$/, () => ({ stdout: '"PID" = 7;' })],
    [/launchctl list/, () => ({ status: 113 })],
  ];

  it("is written before step 1, survives an abort at step 1, and advances its progress marker to done", async () => {
    const { home, xdg, cfg, probe, setMcp } = setup();
    const dataDir = join(xdg, "engram");
    // 12 stale plans from earlier runs: only ROLLBACK_PLANS_KEPT survive
    for (let i = 0; i < 12; i++) {
      const stamp = `2026010${i < 10 ? `${i}-00000${i}` : `${i}-000000`}Z`;
      writeRollbackPlan(dataDir, { v: 1, stamp, at: "x", install: { kind: "git", root, packageName: PACKAGE_NAME, version: "0.1.0" }, target: "0.2.0", dataDir, dataDirFrom: null, modelCacheDir: null, backupDir: null, services: [], pluginTargets: [], pluginProfiles: [], schema: { version: 0, applied: [] }, snapshot: null, progress: "done" });
    }
    // step 1 fails: launchctl unload exits 1 while mcp is running
    const failing = fakeExec([...gitBase, [/launchctl unload/, () => ({ status: 1, stderr: "Could not find specified service" })]]);
    const d = updateDeps("darwin", home, cfg, failing.exec, probe, []);
    const plan = await buildUpdatePlan(d, { noBackup: true });
    const res = await runUpdate(plan, d);
    expect(res.ok).toBe(false);
    expect(res.planFile).toBe(rollbackPlanPath(dataDir, "20260917-123456Z"));
    expect(existsSync(res.planFile!)).toBe(true);
    let rb = readRollbackPlan(res.planFile!);
    expect(rb).toMatchObject({
      v: 1, stamp: "20260917-123456Z", at: "2026-09-17T12:34:56.000Z", progress: "failed:stop",
      install: { kind: "git", root, version: ENGRAM_VERSION, headSha: "abc1234", branch: "main", packageName: PACKAGE_NAME },
      target: "0.4.0", backupDir: null, dataDir, dataDirFrom: join(home, ".local", "share", "engram"),
      schema: { version: SCHEMA_VERSION, applied: [...SCHEMA_MIGRATIONS].sort() },
      snapshot: null,
    });
    expect(rb.services.map((s) => s.id)).toEqual(["mcp"]);
    expect(rb.services[0].startCommand).toContain("launchctl load");
    expect(listRollbackPlans(dataDir)).toHaveLength(ROLLBACK_PLANS_KEPT);
    expect(listRollbackPlans(dataDir)[0].stamp).toBe("20260917-123456Z"); // newest first
    expect(res.lines.join("\n")).toContain("aborting before anything changed");

    // a full run: snapshot filled in, progress ends at done
    const { exec } = fakeExec([
      ...gitBase,
      [/launchctl unload/, () => { setMcp(false); }],
      [/launchctl load/, () => { setMcp(true); }],
      [/pull --ff-only/, () => ({ stdout: "Already up to date.\n" })],
      [/^npm ci$/, () => ({})],
      [/cli\.js migrate schema/, () => ({ stdout: "ok\n" })],
      [/cli\.js doctor --json/, () => ({ stdout: JSON.stringify({ ok: true }) })],
      [/cli\.js stats --json/, () => {
        const db = new Database(join(dataDir, "engram.db"), { readonly: true });
        try { return { stdout: JSON.stringify({ counts: snapshotCounts(db) }) }; } finally { db.close(); }
      }],
    ]);
    const d2 = updateDeps("darwin", home, cfg, exec, probe, []);
    d2.now = () => new Date("2026-09-17T13:00:00Z");
    const ok = await runUpdate(await buildUpdatePlan(d2), d2);
    expect(ok.ok, ok.lines.join("\n")).toBe(true);
    rb = readRollbackPlan(ok.planFile!);
    expect(rb.progress).toBe("done");
    expect(rb.snapshot).toMatchObject({ conversations: 1, entities: 1 });
    expect(rb.backupDir).toBe(backupDirFor(join(home, ".local", "share", "engram"), d2.now()));
    expect(rb.rolledBack).toBeUndefined();
    expect(formatRollbackPlans(listRollbackPlans(dataDir))[0]).toContain(`20260917-130000Z  ${ENGRAM_VERSION} -> 0.4.0  done  (git @ abc1234`);
  });

  it("restoreDataDir puts the allowlist back, drops a stale WAL, merges archive/ with the backup winning", () => {
    const data = join(root, "data");
    seedDb(data);
    const backup = join(root, "data.backup-x");
    mkdirSync(join(data, "archive", "p"), { recursive: true });
    writeFileSync(join(data, "archive", "p", "old.jsonl"), "old");
    backupDataDir(data, backup);
    // life after the update: a row added, a new archive file, an overwritten one, a stale WAL
    const db = new Database(join(data, "engram.db"));
    db.prepare("INSERT INTO conversations (id, project, started_at, last_indexed) VALUES ('c2', 'p', 2, 2)").run();
    db.close();
    writeFileSync(join(data, "engram.db-wal"), "stale");
    writeFileSync(join(data, "archive", "p", "old.jsonl"), "changed");
    writeFileSync(join(data, "archive", "p", "new.jsonl"), "new");
    const lines = restoreDataDir(backup, data);
    expect(lines.join("\n")).toContain("engram.db (");
    expect(lines.join("\n")).toContain("archive/ (merged, backup wins)");
    expect(existsSync(join(data, "engram.db-wal"))).toBe(false);
    expect(readFileSync(join(data, "archive", "p", "old.jsonl"), "utf-8")).toBe("old");
    expect(readFileSync(join(data, "archive", "p", "new.jsonl"), "utf-8")).toBe("new");
    const after = new Database(join(data, "engram.db"), { readonly: true });
    expect(snapshotCounts(after).conversations).toBe(1);
    after.close();
    expect(() => restoreDataDir(join(root, "nope"), data)).toThrow(/does not exist/);
  });

  it("schemaRollbackCheck: unchanged, additive caveat, breaking refusal; BREAKING_MIGRATIONS is empty today", () => {
    const all = [...SCHEMA_MIGRATIONS].sort();
    expect(BREAKING_MIGRATIONS.size).toBe(0);
    expect(schemaRollbackCheck({ version: 5, applied: all }, { version: 5, applied: all })).toMatchObject({ ok: true, added: [], line: expect.stringContaining("unchanged") });
    const additive = schemaRollbackCheck({ version: 4, applied: all.filter((n) => n !== "forget_v1") }, { version: 5, applied: all });
    expect(additive).toMatchObject({ ok: true, added: ["forget_v1"] });
    expect(additive.line).toContain("additive migration(s) applied by the update stay in place (forget_v1; version 4 -> 5)");
    const breaking = schemaRollbackCheck({ version: 4, applied: all.filter((n) => n !== "forget_v1") }, { version: 5, applied: all }, new Set(["forget_v1"]));
    expect(breaking).toMatchObject({ ok: false, breaking: ["forget_v1"] });
    expect(breaking.line).toContain("breaking migration(s) forget_v1");
  });

  it("selectRollbackPlan: newest by default, exact or prefix stamp, .json tolerated", () => {
    const mk = (stamp: string) => ({ file: `${stamp}.json`, stamp, plan: {} as RollbackPlan });
    const plans = [mk("20260917-130000Z"), mk("20260917-123456Z"), mk("20260101-000000Z")];
    expect(selectRollbackPlan(plans)!.stamp).toBe("20260917-130000Z");
    expect(selectRollbackPlan(plans, "20260917-123456Z.json")!.stamp).toBe("20260917-123456Z");
    expect(selectRollbackPlan(plans, "202601")!.stamp).toBe("20260101-000000Z");
    expect(selectRollbackPlan(plans, "2027")).toBeNull();
    expect(selectRollbackPlan([], undefined)).toBeNull();
  });
});

describe("engram update --rollback (#65, decision #66)", () => {
  function setup(opts: { backup?: boolean } = {}) {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.engram.mcp.plist"), "<plist/>");
    mkdirSync(join(root, ".git"));
    const xdg = join(root, "xdg");
    process.env.XDG_DATA_HOME = xdg;
    const dataDir = join(xdg, "engram");
    const cfg = loadConfig({ dataDir });
    const state = { mcpUp: true, probesSinceLoad: 0, onNewBuild: false, healthBrokenOnNewBuild: false };
    // /health answers once after each start (so the start step passes), then follows the build's health
    const probe = async (port: number) => {
      if (port !== 9907 || !state.mcpUp) return false;
      state.probesSinceLoad++;
      if (state.probesSinceLoad === 1) return true;
      return !(state.onNewBuild && state.healthBrokenOnNewBuild);
    };
    const stats = () => {
      const db = new Database(join(dataDir, "engram.db"), { readonly: true });
      try { return { stdout: JSON.stringify({ counts: snapshotCounts(db) }) }; } finally { db.close(); }
    };
    const handlers: Array<[RegExp, (args: string[]) => Partial<ExecResult> | void]> = [
      [/rev-parse --abbrev-ref/, () => ({ stdout: "main\n" })],
      [/remote get-url/, () => ({ stdout: "origin\n" })],
      [/status --porcelain/, () => ({ stdout: "" })],
      [/rev-parse --short/, () => ({ stdout: "abc1234\n" })],
      [/ls-remote --tags/, () => ({ stdout: "x\trefs/tags/v0.4.0\n" })],
      [/launchctl list com\.engram\.mcp$/, () => ({ stdout: '"PID" = 7;' })],
      [/launchctl list/, () => ({ status: 113 })],
      [/launchctl unload/, () => { state.mcpUp = false; }],
      [/launchctl load/, () => { state.mcpUp = true; state.probesSinceLoad = 0; }],
      [/pull --ff-only/, () => { state.onNewBuild = true; return { stdout: "Updating abc1234..def5678\n" }; }],
      [/git -C .* checkout abc1234$/, () => { state.onNewBuild = false; }],
      [/^npm ci$/, () => ({})],
      [/cli\.js --version/, () => ({ stdout: `${ENGRAM_VERSION}\n` })],
      [/cli\.js doctor --json/, () => ({ stdout: JSON.stringify({ ok: true }) })],
      [/cli\.js stats --json/, stats],
    ];
    return { home, legacy, xdg, dataDir, cfg, probe, state, handlers, backup: opts.backup ?? true };
  }
  const seq = (calls: Call[]) => calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);

  it("a failing /health on the new build + --yes → automatic code-only rollback: services restarted with the prior command, code restored, verify via the restored build, rolledBack recorded", async () => {
    const { home, dataDir, cfg, probe, state, handlers } = setup();
    state.healthBrokenOnNewBuild = true;
    const { exec, calls } = fakeExec([...handlers, [/cli\.js migrate schema/, () => ({ stdout: "ok\n" })]]);
    const log: string[] = [];
    const d = updateDeps("darwin", home, cfg, exec, probe, log);
    const plan = await buildUpdatePlan(d);
    const res = await runUpdate(plan, d, { yes: true });
    expect(res.ok).toBe(false);
    expect(res.rollback).toMatchObject({ ok: true, mode: "code-only" });
    const text = res.lines.join("\n");
    expect(text).toContain("health: NOT answering");
    expect(text).toContain("UPDATE FAILED.");
    expect(text).toContain(`rolling back to ${ENGRAM_VERSION} (code-only)`);
    expect(text).toContain("rollback mode: code-only — engram.db keeps everything written since the update (reason: verify failed)");
    expect(text).toContain(MODEL_CACHE_BACKUP_NOTE);
    expect(text).toContain("schema: unchanged since the update");
    expect(text).toContain(`the checkout is detached at abc1234; \`git -C ${root} checkout main\` returns to the branch`);
    expect(text).toContain(`rolled back to ${ENGRAM_VERSION} (code-only); verification passed`);
    expect(text).not.toContain("restoring ");
    // exec order: update (unload, pull, ci, migrate, load, doctor, stats) then rollback (unload, checkout, ci, migrate, load, --version, doctor, stats)
    const s = seq(calls);
    const nth = (re: RegExp, n: number) => s.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0)[n];
    expect(nth(/launchctl unload/, 1)).toBeGreaterThan(nth(/stats --json/, 0));
    expect(nth(/checkout abc1234/, 0)).toBeGreaterThan(nth(/launchctl unload/, 1));
    expect(nth(/^npm ci$/, 1)).toBeGreaterThan(nth(/checkout abc1234/, 0));
    expect(nth(/migrate schema/, 1)).toBeGreaterThan(nth(/^npm ci$/, 1));
    expect(nth(/launchctl load/, 1)).toBeGreaterThan(nth(/migrate schema/, 1));
    expect(nth(/cli\.js --version/, 0)).toBeGreaterThan(nth(/launchctl load/, 1));
    expect(nth(/doctor --json/, 1)).toBeGreaterThan(nth(/launchctl load/, 1));
    expect(s.filter((l) => /launchctl load/.test(l))).toHaveLength(2);
    expect(s.at(-1)).toMatch(/stats --json$/);
    // the plan file records the outcome; counts equal the snapshot
    const rb = readRollbackPlan(res.planFile!);
    expect(rb.progress).toBe("failed:verify");
    expect(rb.rolledBack).toMatchObject({ ok: true, mode: "code-only", reason: "verify failed" });
    const db = new Database(join(dataDir, "engram.db"), { readonly: true });
    expect(snapshotCounts(db)).toEqual(rb.snapshot);
    db.close();
    expect(existsSync(plan.backupDir!)).toBe(true); // the backup is kept, untouched
  });

  it("counts below the snapshot after the update → the auto-rollback also restores the backup (code + data)", async () => {
    const { home, dataDir, cfg, probe, state, handlers } = setup();
    // a "bad migration" on the new build loses a row; the restored build's migrate is harmless
    const { exec, calls } = fakeExec([...handlers, [/cli\.js migrate schema/, () => {
      if (state.onNewBuild) { const db = new Database(join(dataDir, "engram.db")); db.prepare("DELETE FROM conversations").run(); db.close(); }
      return { stdout: "ok\n" };
    }]]);
    const d = updateDeps("darwin", home, cfg, exec, probe, []);
    const plan = await buildUpdatePlan(d);
    const res = await runUpdate(plan, d, { yes: true });
    expect(res.ok).toBe(false);
    expect(res.rollback).toMatchObject({ ok: true, mode: "code + data" });
    const text = res.lines.join("\n");
    expect(text).toContain("counts DROPPED: conversations: 1 -> 0");
    expect(text).toContain(`rolling back to ${ENGRAM_VERSION} (code + data: verification proved data loss)`);
    expect(text).toContain(`restoring ${plan.backupDir} -> ${dataDir}`);
    expect(text).toContain(`rolled back to ${ENGRAM_VERSION} (code + data); verification passed`);
    // the restore happened after the stop and before the checkout
    const s = seq(calls);
    const nth = (re: RegExp, n: number) => s.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0)[n];
    expect(nth(/checkout abc1234/, 0)).toBeGreaterThan(nth(/launchctl unload/, 1));
    const rb = readRollbackPlan(res.planFile!);
    expect(rb.rolledBack).toMatchObject({ ok: true, mode: "code + data", reason: "counts dropped: conversations: 1 -> 0" });
    const db = new Database(join(dataDir, "engram.db"), { readonly: true });
    expect(snapshotCounts(db)).toEqual(rb.snapshot);
    db.close();
  });

  it("a terminal is asked; declining restarts the services on the new code and prints the command", async () => {
    const { home, cfg, probe, state, handlers } = setup();
    state.healthBrokenOnNewBuild = true;
    const { exec, calls } = fakeExec([...handlers, [/cli\.js migrate schema/, () => ({ stdout: "ok\n" })]]);
    const questions: string[] = [];
    const d = updateDeps("darwin", home, cfg, exec, probe, []);
    d.confirm = async (q) => { questions.push(q); return false; };
    const res = await runUpdate(await buildUpdatePlan(d), d);
    expect(res.ok).toBe(false);
    expect(res.rollback).toBeUndefined();
    expect(questions).toEqual([`Roll back to ${ENGRAM_VERSION} (code-only)? [y/N] `]);
    expect(seq(calls).some((l) => /checkout abc1234/.test(l))).toBe(false);
    expect(res.lines.join("\n")).toContain("Rollback: engram update --rollback 20260917-123456Z");
    expect(res.lines.join("\n")).toContain("restarted mcp");
  });

  it("by hand: --restore-data is refused without a backup; a breaking migration refuses code-only but not --restore-data", async () => {
    const { home, dataDir, cfg, probe, handlers } = setup();
    const { exec, calls } = fakeExec([...handlers, [/cli\.js migrate schema/, () => ({ stdout: "ok\n" })]]);
    const d = updateDeps("darwin", home, cfg, exec, probe, []);
    const plan = await buildUpdatePlan(d, { noBackup: true });
    const res = await runUpdate(plan, d); // a clean update; then roll it back by hand
    expect(res.ok, res.lines.join("\n")).toBe(true);
    const rb = readRollbackPlan(res.planFile!);
    calls.length = 0;
    const noBackup = await rollbackUpdate(rb, res.planFile!, d, { restoreData: true });
    expect(noBackup).toMatchObject({ ok: false, mode: "code + data", refused: expect.stringContaining("--no-backup") });
    expect(calls).toHaveLength(0);
    // pretend the update applied forget_v1 and that it is breaking
    const older: RollbackPlan = { ...rb, schema: { version: 4, applied: rb.schema.applied.filter((n) => n !== "forget_v1") } };
    const refused = await rollbackUpdate(older, res.planFile!, d, { breaking: new Set(["forget_v1"]) });
    expect(refused.ok).toBe(false);
    expect(refused.refused).toContain("breaking migration(s) forget_v1");
    expect(refused.lines.join("\n")).toContain("engram update --rollback 20260917-123456Z --restore-data");
    expect(calls).toHaveLength(0);
    expect(readRollbackPlan(res.planFile!).rolledBack).toBeUndefined();
    // the additive caveat when the update added checkpoints that are not breaking
    const additive = await rollbackUpdate(older, res.planFile!, d);
    expect(additive.ok, additive.lines.join("\n")).toBe(true);
    expect(additive.lines.join("\n")).toContain("additive migration(s) applied by the update stay in place (forget_v1; version 4 -> 5)");
    expect(readRollbackPlan(res.planFile!).rolledBack).toMatchObject({ ok: true, mode: "code-only" });
    // with a backup, --restore-data is allowed across a breaking migration (the backup predates it)
    mkdirSync(join(root, "bk"), { recursive: true });
    backupDataDir(dataDir, join(root, "bk"));
    const withBackup: RollbackPlan = { ...older, backupDir: join(root, "bk") };
    const restored = await rollbackUpdate(withBackup, res.planFile!, d, { restoreData: true, breaking: new Set(["forget_v1"]) });
    expect(restored.ok, restored.lines.join("\n")).toBe(true);
    expect(restored.lines.join("\n")).toContain("rollback mode: code + data");
  });

  it("npm installs roll back with npm install -g <package>@<previous>", async () => {
    const home = join(root, "home");
    const data = join(root, "data");
    seedDb(data);
    const { exec, calls } = fakeExec([
      [/npm view/, () => ({ stdout: "0.5.0\n" })],
      [/npm install -g/, () => ({})],
      [/launchctl list/, () => ({ status: 113 })],
      [/migrate schema/, () => ({ stdout: "ok\n" })],
      [/cli\.js --version/, () => ({ stdout: `${ENGRAM_VERSION}\n` })],
      [/doctor --json/, () => ({ stdout: JSON.stringify({ ok: true }) })],
      [/stats --json/, () => {
        const db = new Database(join(data, "engram.db"), { readonly: true });
        try { return { stdout: JSON.stringify({ counts: snapshotCounts(db) }) }; } finally { db.close(); }
      }],
    ]);
    const d = updateDeps("darwin", home, loadConfig({ dataDir: data, modelCacheDir: join(root, "models") }), exec, async () => false, []);
    const res = await runUpdate(await buildUpdatePlan(d, { noBackup: true }), d);
    expect(res.ok).toBe(true);
    const rb = readRollbackPlan(res.planFile!);
    expect(rb.install).toMatchObject({ kind: "npm", version: ENGRAM_VERSION, packageName: PACKAGE_NAME });
    const r = await rollbackUpdate(rb, res.planFile!, d);
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(calls.some((c) => c.cmd === "npm" && c.args.join(" ") === `install -g ${PACKAGE_NAME}@${ENGRAM_VERSION}`)).toBe(true);
    expect(r.lines.join("\n")).toContain("no running services to stop");
  });

  it("a rollback whose restored build reports the wrong version fails verification and records it", async () => {
    const { home, cfg, probe, handlers } = setup();
    const { exec } = fakeExec([...handlers.filter(([re]) => !/--version/.test(re.source)), [/cli\.js --version/, () => ({ stdout: "9.9.9\n" })], [/cli\.js migrate schema/, () => ({ stdout: "ok\n" })]]);
    const d = updateDeps("darwin", home, cfg, exec, probe, []);
    const res = await runUpdate(await buildUpdatePlan(d, { noBackup: true }), d);
    expect(res.ok).toBe(true);
    const r = await rollbackUpdate(readRollbackPlan(res.planFile!), res.planFile!, d);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain(`version: 9.9.9 — expected ${ENGRAM_VERSION}`);
    expect(r.lines.join("\n")).toContain("ROLLBACK VERIFICATION FAILED (code-only): version");
    expect(readRollbackPlan(res.planFile!).rolledBack).toMatchObject({ ok: false });
  });
});

// ─── CLI surface ─────────────────────────────────────────────────────

describe("engram migrate / import-legacy / update CLI", () => {
  const cli = fileURLToPath(new URL("../../../dist/interfaces/cli/index.js", import.meta.url));
  const built = existsSync(cli);
  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, ENGRAM_DATA_DIR: join(root, "cli-data"), ENGRAM_MODEL_CACHE_DIR: join(root, "cli-models"), ENGRAM_MCP_PORT: "1", ...env },
    });
  }

  it.skipIf(!built)("migrate --dry-run lists every action and changes nothing", () => {
    const home = join(root, "home");
    const legacy = join(home, ".local", "share", "engram");
    seedDb(legacy);
    const r = run(["migrate", "--dry-run"], { HOME: home, XDG_DATA_HOME: join(root, "xdg"), ENGRAM_DATA_DIR: undefined as unknown as string });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("would move");
    expect(r.stdout).toContain("model-cache:");
    expect(r.stdout).toContain("schema: would open");
    expect(existsSync(join(legacy, "engram.db"))).toBe(true);
    expect(existsSync(join(root, "xdg", "engram", "engram.db"))).toBe(false);
  });

  it.skipIf(!built)("migrate --source forwards to the legacy importer with a deprecation notice; import-legacy exists", () => {
    const r = run(["migrate", "--source", join(root, "missing.sqlite"), "--dry-run"]);
    expect(r.stderr).toContain("engram migrate --source is deprecated");
    expect(r.stderr).toContain("engram import-legacy --source");
    const h = run(["import-legacy", "--help"]);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("--source <path>");
  });

  it.skipIf(!built)("update --check and --plan are read-only and exit 0", () => {
    const c = run(["update", "--check"]);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stdout).toMatch(/^engram \d+\.\d+\.\d+ \((git checkout|npm install)/);
    const p = run(["update", "--plan"]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain("Steps:");
    expect(readdirSync(root).some((n) => n.includes("backup"))).toBe(false);
  });
});
