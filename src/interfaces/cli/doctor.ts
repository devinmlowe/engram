/**
 * `engram doctor` — runtime diagnostics for the native/prebuilt dependency
 * chain. Answers "will this install work on this machine?" before `engram
 * init` gets far enough to crash.
 *
 * Every probe is isolated in its own try/catch; a failing probe becomes a
 * `fail` check, never an exception. Only `required` checks at level `fail`
 * make the report not-ok (and the CLI exit non-zero).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { describeModelCacheDir, loadConfig, type ModelCacheResolution } from "../../_core/config/index.js";
import { isInsideNodeModules } from "../../_core/embeddings/model-cache.js";
import { buildIntelligenceConfig, describeProviders, resolveOllamaModel } from "../../_core/llm/index.js";
import type { EngramConfig } from "../../_core/types/index.js";
import { modelCacheSourceLabel } from "./data-migration.js";
import { MIN_NODE_MAJOR, PREBUILT_TARGETS, describePrebuild, loadPreflight, type PrebuildProbe } from "./preflight.js";
import { parseMcpPort } from "../mcp/port.js";

export type DoctorLevel = "ok" | "warn" | "fail";

/** Order and names of the checks `runDoctor` always emits. */
export const DOCTOR_CHECK_NAMES = [
  "node",
  "platform/arch",
  "better-sqlite3",
  "sqlite-vec",
  "transformers.js",
  "model cache",
  "ollama",
  "llm providers",
  "data dir",
  "mcp daemon",
] as const;
export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];

export interface DoctorCheck {
  /** Stable identifier; also the label printed on the line. */
  name: DoctorCheckName;
  level: DoctorLevel;
  /** A required check at level `fail` makes the whole report fail. */
  required: boolean;
  detail: string;
}

export interface DoctorReport {
  node: string;
  platform: string;
  checks: DoctorCheck[];
  /** True when no required check failed. */
  ok: boolean;
}

/**
 * MIN_NODE_MAJOR and PREBUILT_TARGETS (the `<platform>[musl]-<arch>` targets
 * for which better-sqlite3, sqlite-vec and onnxruntime-node all ship prebuilt
 * binaries) come from scripts/preflight.cjs, the single source of truth the
 * README table is generated from (#63). Anything else needs a C++ toolchain
 * at `npm install` time, and sqlite-vec has no build at all (notably Windows
 * on ARM, 32-bit ARM Linux and Alpine/musl).
 */
export { MIN_NODE_MAJOR, PREBUILT_TARGETS };

const LINE_PREFIX: Record<DoctorLevel, string> = {
  ok: "[ok]  ",
  warn: "[--]  ",
  fail: "[FAIL]",
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function currentTarget(): string {
  return `${process.platform}-${process.arch}`;
}

function checkNode(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    name: "node",
    level: ok ? "ok" : "fail",
    required: true,
    detail: `${process.version} (>=${MIN_NODE_MAJOR} required)`,
  };
}

function checkPlatform(): DoctorCheck {
  const target = currentTarget();
  let key = target;
  let libc = "";
  try {
    const resolved = loadPreflight().resolveTarget();
    key = resolved.key;
    libc = resolved.libc;
  } catch {
    /* the preflight script is missing or broken: judge on platform-arch alone */
  }
  const prebuilt = PREBUILT_TARGETS.includes(key);
  const where = `${target}${libc ? `, ${libc}` : ""} (node-v${process.versions.modules})`;
  return {
    name: "platform/arch",
    level: prebuilt ? "ok" : "warn",
    required: false,
    detail: prebuilt
      ? `${where}: prebuilt native modules available`
      : `${where}: not every native module ships a prebuilt for ${key}; sqlite-vec has no build for this target — see README "Supported platforms" and \`engram preflight\``,
  };
}

/**
 * The prebuild verdict for one native dependency — `prebuilt` vs `compiled
 * locally` tells an upgrade failure apart from a missing toolchain. Never
 * throws: a broken preflight script becomes an `unknown` probe.
 */
export function probeNativeDep(dep: string, probe: (dep: string) => PrebuildProbe = (d) => loadPreflight().probePrebuild(d)): PrebuildProbe {
  try {
    return probe(dep);
  } catch (err) {
    return { dep, status: "unknown", label: "unknown", level: "skip", source: "installed", detail: `preflight probe unavailable: ${errMsg(err)}`, fix: [] };
  }
}

/**
 * better-sqlite3 and sqlite-vec share one throwaway in-memory database. Each
 * line ends with the prebuild verdict (`prebuilt` / `compiled locally` /
 * `unknown` …) from the same probe `engram preflight` runs (#63).
 */
export async function checkNativeSqlite(
  probe: (dep: string) => PrebuildProbe = (d) => loadPreflight().probePrebuild(d),
): Promise<[DoctorCheck, DoctorCheck]> {
  const origin = (dep: string): string => describePrebuild(probeNativeDep(dep, probe));
  let db: Database.Database;
  let betterSqlite: DoctorCheck;
  try {
    const { default: BetterSqlite } = await import("better-sqlite3");
    db = new BetterSqlite(":memory:");
    const { v } = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    betterSqlite = {
      name: "better-sqlite3",
      level: "ok",
      required: true,
      detail: `loaded (SQLite ${v}); ${origin("better-sqlite3")}`,
    };
  } catch (err) {
    return [
      {
        name: "better-sqlite3",
        level: "fail",
        required: true,
        detail: `failed to load for ${currentTarget()}: ${errMsg(err)}; ${origin("better-sqlite3")}`,
      },
      {
        name: "sqlite-vec",
        level: "fail",
        required: true,
        detail: `skipped (better-sqlite3 unavailable); ${origin("sqlite-vec")}`,
      },
    ];
  }

  let sqliteVec: DoctorCheck;
  try {
    const vec = await import("sqlite-vec");
    vec.load(db);
    const { v } = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    sqliteVec = {
      name: "sqlite-vec",
      level: "ok",
      required: true,
      detail: `loaded (${v}); ${origin("sqlite-vec")}`,
    };
  } catch (err) {
    sqliteVec = {
      name: "sqlite-vec",
      level: "fail",
      required: true,
      detail: `failed to load for ${currentTarget()}: ${errMsg(err)}; ${origin("sqlite-vec")}`,
    };
  } finally {
    db.close();
  }
  return [betterSqlite, sqliteVec];
}

/** Returns `true`, or the error message explaining why `dir` is not writable. */
function probeWritable(dir: string): true | string {
  const probe = join(dir, `.engram-doctor-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "ok");
    return true;
  } catch (err) {
    return errMsg(err);
  } finally {
    // `force` only swallows ENOENT; a probe path under a regular file
    // throws ENOTDIR on cleanup and must not mask the real verdict.
    try {
      rmSync(probe, { force: true });
    } catch {
      /* nothing to clean up */
    }
  }
}

/**
 * Report where transformers.js will put model weights, whether it can, and
 * whether the location survives `npm ci` (#53). Exported for tests. `durable:
 * no` only when the resolved dir sits inside a `node_modules` directory, which
 * since 0.4.0 takes an explicit ENGRAM_MODEL_CACHE_DIR pointing there.
 */
export function checkModelCache(resolution: ModelCacheResolution): DoctorCheck {
  const name = "model cache";
  const { dir, source } = resolution;
  const durable = !isInsideNodeModules(dir);
  const detail = (access: string): string =>
    `${dir} (${access}; durable: ${durable ? "yes" : "no — inside node_modules, wiped by npm ci"}; ${modelCacheSourceLabel(source)})`;

  const writable = probeWritable(dir);
  if (writable === true) {
    return { name, level: durable ? "ok" : "warn", required: true, detail: detail("writable") };
  }

  // A read-only but already-populated cache still works offline.
  const populated = existsSync(dir) && readdirSync(dir).length > 0;
  return populated
    ? {
        name,
        level: "warn",
        required: true,
        detail: detail(`read-only: ${writable}; cached models will load but new downloads will fail`),
      }
    : {
        name,
        level: "fail",
        required: true,
        detail: detail(`not writable: ${writable}`),
      };
}

async function checkTransformers(): Promise<DoctorCheck> {
  try {
    const { env } = await import("@xenova/transformers");
    return {
      name: "transformers.js",
      level: "ok",
      required: true,
      detail: `loaded (@xenova/transformers ${env.version})`,
    };
  } catch (err) {
    return {
      name: "transformers.js",
      level: "fail",
      required: true,
      detail: `failed to load for ${currentTarget()}: ${errMsg(err)}`,
    };
  }
}

/**
 * Which local model the Ollama tier will use, if any. Never required: a
 * missing local tier only means extraction goes to the cloud tiers.
 */
async function checkOllama(config: EngramConfig): Promise<DoctorCheck> {
  const name = "ollama";
  const intel = buildIntelligenceConfig(config);
  try {
    const probe = await resolveOllamaModel(intel);
    if (probe.model === intel.ollamaModel) {
      return { name, level: "ok", required: false, detail: `${probe.model} at ${intel.ollamaUrl} (ollama tier active)` };
    }
    if (probe.model) {
      return {
        name,
        level: "ok",
        required: false,
        detail: `${probe.model} at ${intel.ollamaUrl} (fallback: ${intel.ollamaModel} is not pulled; ollama tier active)`,
      };
    }
    return {
      name,
      level: "warn",
      required: false,
      detail: probe.reachable
        ? `ollama tier inactive: ${intel.ollamaModel} not found at ${intel.ollamaUrl}; available: [${probe.available.join(", ")}] — \`ollama pull ${intel.ollamaModel}\` or set ENGRAM_LOCAL_MODEL / ENGRAM_LOCAL_MODEL_FALLBACKS`
        : `ollama tier inactive: Ollama not reachable at ${intel.ollamaUrl}; extraction uses the cloud tiers`,
    };
  } catch (err) {
    return { name, level: "warn", required: false, detail: `ollama tier inactive: probe failed: ${errMsg(err)}` };
  }
}

/**
 * Tier order and per-tier configuration (#45): endpoints, models and the
 * NAMES of the env vars credentials come from — never their values. Warns
 * when no cloud tier is configured (Ollama alone is fine when it answers).
 */
export function checkLlmProviders(config: EngramConfig, env: Record<string, string | undefined> = process.env): DoctorCheck {
  const name = "llm providers";
  const { order, tiers } = describeProviders(buildIntelligenceConfig(config), env);
  const parts = tiers.map((t) => `${t.tier}: ${t.detail}`);
  const cloudConfigured = tiers.some((t) => t.tier !== "ollama" && t.configured);
  const detail = `order ${order.join(" > ")} (ENGRAM_LLM_PROVIDERS); ${parts.join("; ")}`;
  return cloudConfigured
    ? { name, level: "ok", required: false, detail }
    : { name, level: "warn", required: false, detail: `${detail} — no cloud tier configured; extraction needs a reachable Ollama model or one of ENGRAM_OPENAI_MODEL, OPENROUTER_API_KEY, ANTHROPIC_API_KEY` };
}

/** The pre-0.2.0 default data directory on every platform (`~/.local/share/engram`). */
export function legacyDataDir(home: string = homedir()): string {
  return join(home, ".local", "share", "engram");
}

/**
 * Which database this process will open, and whether a *different* populated
 * database exists at the legacy default. 0.2.0 moved the default data dir
 * (Windows: `%LOCALAPPDATA%\engram`; Linux/macOS: `$XDG_DATA_HOME/engram`), so
 * an upgraded install can silently start a new empty database (#13, #44).
 */
export function checkDataDir(config: EngramConfig, legacyDir: string = legacyDataDir()): DoctorCheck {
  const name = "data dir";
  const dbPath = config.dbPath;
  const dbExists = existsSync(dbPath);
  const dbSize = dbExists ? statSync(dbPath).size : 0;
  const source = process.env.ENGRAM_DB_PATH?.trim()
    ? "ENGRAM_DB_PATH"
    : process.env.ENGRAM_DATA_DIR?.trim()
      ? "ENGRAM_DATA_DIR"
      : "default";
  const legacyDb = join(legacyDir, "engram.db");
  const legacyPopulated =
    resolve(legacyDb) !== resolve(dbPath) && existsSync(legacyDb) && statSync(legacyDb).size > 0;
  const where = `${config.dataDir} (db: ${dbPath}, ${dbExists ? `${(dbSize / 1024 / 1024).toFixed(1)} MB` : "not created yet"}; from ${source})`;
  if (legacyPopulated && (!dbExists || dbSize === 0)) {
    return {
      name, level: "warn", required: false,
      detail: `${where} — but a populated legacy database exists at ${legacyDb}; this process would start EMPTY. Set ENGRAM_DATA_DIR=${legacyDir} or move the data dir (run \`engram update --plan\`)`,
    };
  }
  if (legacyPopulated) {
    return {
      name, level: "warn", required: false,
      detail: `${where}; a second database also exists at ${legacyDb} — two installs, or a leftover from an upgrade (run \`engram update --plan\`)`,
    };
  }
  return { name, level: "ok", required: false, detail: where };
}

export interface McpHealthProbe {
  status: number;
  body: string;
}

/** GET http://127.0.0.1:port/health with a short timeout. Rejects on any transport error. */
export function probeMcpHealth(port: number, timeoutMs = 1500): Promise<McpHealthProbe> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Is the HTTP MCP daemon (what the Hermes plugin and other HTTP clients talk
 * to) answering on its loopback port? Never required: stdio-only installs
 * have no daemon. The port follows ENGRAM_MCP_PORT like the server does (#28).
 */
export async function checkMcpDaemon(
  port: number = parseMcpPort(process.env.ENGRAM_MCP_PORT),
  probe: (port: number) => Promise<McpHealthProbe> = probeMcpHealth,
): Promise<DoctorCheck> {
  const name = "mcp daemon";
  const url = `http://127.0.0.1:${port}/health`;
  const hint =
    "install it with scripts/install-mcp-daemon.sh (Windows: scripts\\install-mcp-daemon.ps1) or run `node dist/interfaces/mcp/server.js --http`; stdio clients (.mcp.json) are unaffected";
  try {
    const { status, body } = await probe(port);
    let parsed: { status?: unknown; workers?: { size?: unknown; ready?: unknown } } = {};
    try { parsed = JSON.parse(body); } catch { /* non-JSON body handled below */ }
    if (status === 200 && parsed.status === "ok") {
      const w = parsed.workers;
      const workers = w && typeof w.size === "number" ? ` (workers: ${w.size}${typeof w.ready === "number" ? `, ready: ${w.ready}` : ""})` : "";
      return { name, level: "ok", required: false, detail: `answering at ${url}${workers}` };
    }
    return {
      name, level: "warn", required: false,
      detail: `something answers at ${url} but not like the engram daemon (HTTP ${status}${parsed.status ? `, status ${String(parsed.status)}` : ""}) — another process on the port? see scripts/install-mcp-daemon.sh status`,
    };
  } catch (err) {
    return { name, level: "warn", required: false, detail: `not answering at ${url} (${errMsg(err)}) — ${hint}` };
  }
}

/** Run every probe. Never throws; failures are reported as checks. */
export async function runDoctor(
  config: EngramConfig = loadConfig(),
): Promise<DoctorReport> {
  const [betterSqlite, sqliteVec] = await checkNativeSqlite();
  const transformers = await checkTransformers();
  const modelCache = checkModelCache(describeModelCacheDir(config));
  const ollama = await checkOllama(config);
  const mcpDaemon = await checkMcpDaemon();
  const checks: DoctorCheck[] = [
    checkNode(),
    checkPlatform(),
    betterSqlite,
    sqliteVec,
    transformers,
    modelCache,
    ollama,
    checkLlmProviders(config),
    checkDataDir(config),
    mcpDaemon,
  ];
  return {
    node: process.version,
    platform: currentTarget(),
    checks,
    ok: checks.every((c) => !(c.required && c.level === "fail")),
  };
}

/** One line per check plus a blank line and a verdict, in `engram health` style. */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines = report.checks.map(
    (c) => `${LINE_PREFIX[c.level]} ${c.name}: ${c.detail}`,
  );
  const failed = report.checks.filter(
    (c) => c.required && c.level === "fail",
  ).length;
  lines.push("");
  lines.push(
    report.ok
      ? "Doctor: all checks passed"
      : `Doctor: ${failed} required check(s) failed`,
  );
  return lines;
}
