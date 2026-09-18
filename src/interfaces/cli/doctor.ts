/**
 * `engram doctor` — runtime diagnostics for the native/prebuilt dependency
 * chain. Answers "will this install work on this machine?" before `engram
 * init` gets far enough to crash.
 *
 * Every probe is isolated in its own try/catch; a failing probe becomes a
 * `fail` check, never an exception. Only `required` checks at level `fail`
 * make the report not-ok (and the CLI exit non-zero).
 *
 * `engram doctor --fix` (#61): a check with a known remediation carries a
 * `fix` — the manual equivalent (always printed, so users learn what
 * happened), whether it needs confirmation (large download), and `apply()`,
 * which performs it and re-runs the check. `applyDoctorFixes` walks every
 * non-ok check that has one; a second run finds nothing to fix. Everything a
 * fix touches (shell, supervisor, host configs, env file, probes) comes from
 * an injectable `DoctorContext`, so tests run against a temp home.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { describeModelCacheDir, loadConfig, type ModelCacheResolution } from "../../_core/config/index.js";
import { isInsideNodeModules } from "../../_core/embeddings/model-cache.js";
import { buildIntelligenceConfig, describeProviders, resolveOllamaModel } from "../../_core/llm/index.js";
import type { EngramConfig } from "../../_core/types/index.js";
import { PACKAGE_ROOT } from "../../_core/version/index.js";
import { applyModelCachePlan, ensureServiceEnvFile, fileMode, modelCacheSourceLabel, planModelCache, serviceEnvFile } from "./data-migration.js";
import { MIN_NODE_MAJOR, PREBUILT_TARGETS, describePrebuild, loadPreflight, type PrebuildProbe } from "./preflight.js";
import { parseMcpPort, probeMcpHealth, type McpHealthProbe } from "../mcp/port.js";
import { HOST_IDS, defaultHostContext, hostPresent, runMcpInstall, summariseHostsForDoctor, type HealthProbe, type HostContext } from "./hosts.js";
import { defaultInstallPathContext, installPathReport, type InstallPathContext } from "./install-path.js";
import { defaultServiceDeps, realExec, serviceStatus, startService, waitForPort, type Exec, type ServiceDeps, type ServicePlatform } from "./services.js";
import { runExtractionSmoke, skippedSmoke, type SmokeDeps, type SmokeOutcome } from "./smoke.js";

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
  "env file",
  "install path",
  "mcp daemon",
  "hosts",
  "extraction smoke",
] as const;
export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];

/** A known remediation for a non-ok check (`engram doctor --fix`, #61). */
export interface DoctorFix {
  /** The manual equivalent — the command a user would run by hand. Always printed. */
  describe: string;
  /** Large download or privileged: ask on a terminal, require `--yes` otherwise. */
  needsConfirm?: boolean;
  /** Apply the remediation, then re-run the check and return its new verdict. */
  apply: () => Promise<DoctorCheck>;
}

export interface DoctorCheck {
  /** Stable identifier; also the label printed on the line. */
  name: DoctorCheckName;
  level: DoctorLevel;
  /** A required check at level `fail` makes the whole report fail. */
  required: boolean;
  detail: string;
  /** Present when `--fix` knows how to remediate this verdict. */
  fix?: DoctorFix;
}

export interface DoctorReport {
  node: string;
  platform: string;
  checks: DoctorCheck[];
  /** True when no required check failed. */
  ok: boolean;
  /** The `extraction smoke` outcome in full (the check line is its summary). */
  smoke?: SmokeOutcome;
  /** What `--fix` did, when it ran. */
  fixes?: FixOutcome[];
}

/**
 * Everything the checks and their fixes touch outside the process, so
 * `engram setup` and the tests can substitute a temp home, a fake shell and
 * fake probes. `defaultDoctorContext()` is the real machine.
 */
export interface DoctorContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  packageRoot: string;
  /** Shell for `ollama pull`. */
  exec: Exec;
  /** The Ollama `/api/tags` probe (default: the real one). */
  ollamaProbe?: typeof resolveOllamaModel;
  /** Supervisor adapters for the `mcp daemon` fix (start an installed, stopped daemon). */
  services: ServiceDeps;
  /** Host configs for the `hosts` check and its `engram mcp install` fix. */
  hosts: HostContext;
  /** `/health` probe `mcp install` uses to pick HTTP vs stdio (default: the real one). */
  hostProbe?: HealthProbe;
  /** `/health` probe for the `mcp daemon` check. */
  mcpProbe: (port: number) => Promise<McpHealthProbe>;
  mcpPort: number;
  /** How long the `mcp daemon` fix waits for `/health` after `launchctl load` (the MCP cold-start budget). */
  mcpStartWaitMs: number;
  installPath?: Partial<InstallPathContext>;
  /** `extraction smoke` collaborators (test seams, budget). */
  smoke: SmokeDeps;
}

export function defaultDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? homedir();
  const platform = overrides.platform ?? process.platform;
  const packageRoot = overrides.packageRoot ?? PACKAGE_ROOT;
  const exec = overrides.exec ?? realExec;
  return {
    env,
    home,
    platform,
    packageRoot,
    exec,
    ollamaProbe: overrides.ollamaProbe,
    services: overrides.services ?? defaultServiceDeps({ platform: platform as ServicePlatform, exec, home, engramDir: packageRoot, env }),
    hosts: overrides.hosts ?? defaultHostContext({ home, env, platform, packageRoot }),
    hostProbe: overrides.hostProbe,
    mcpProbe: overrides.mcpProbe ?? probeMcpHealth,
    mcpPort: overrides.mcpPort ?? parseMcpPort(env.ENGRAM_MCP_PORT),
    mcpStartWaitMs: overrides.mcpStartWaitMs ?? 90_000,
    installPath: overrides.installPath,
    smoke: overrides.smoke ?? {},
  };
}

export interface DoctorOptions {
  /** `--no-smoke`: report the `extraction smoke` check as skipped instead of running an extraction. */
  noSmoke?: boolean;
  ctx?: Partial<DoctorContext>;
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
export function checkModelCache(resolution: ModelCacheResolution, fixCtx?: { config: EngramConfig } & Pick<DoctorContext, "env" | "home" | "platform" | "packageRoot">): DoctorCheck {
  const name = "model cache";
  const { dir, source } = resolution;
  const durable = !isInsideNodeModules(dir);
  const detail = (access: string): string =>
    `${dir} (${access}; durable: ${durable ? "yes" : "no — inside node_modules, wiped by npm ci"}; ${modelCacheSourceLabel(source)})`;

  const writable = probeWritable(dir);
  if (writable === true) {
    const check: DoctorCheck = { name, level: durable ? "ok" : "warn", required: true, detail: detail("writable") };
    if (!durable && fixCtx) return withModelCacheFix(check, fixCtx);
    return check;
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

/**
 * The `model cache` remediation (#61): give the models a durable home — the
 * default `<data dir>/models` — by writing `ENGRAM_MODEL_CACHE_DIR` into the
 * service env file (created if missing) and moving the weights already
 * downloaded into node_modules there (`engram migrate model-cache`). The
 * running process adopts the new value too, so the steps `engram setup` runs
 * afterwards (init, smoke) use the durable dir; other shells still export the
 * old path until they pick up the env file, which the re-run verdict says.
 * When the env file already carries the setting there is nothing left for
 * `--fix` to do: the line only tells the user to export it here.
 */
function withModelCacheFix(check: DoctorCheck, fixCtx: { config: EngramConfig } & Pick<DoctorContext, "env" | "home" | "platform" | "packageRoot">): DoctorCheck {
  const { config, env, home, platform, packageRoot } = fixCtx;
  const plan = planModelCache({ config, env, platform, home }, packageRoot);
  const envFile = plan.envFile;
  const alreadySet = envFile !== null && existsSync(envFile) && /^ENGRAM_MODEL_CACHE_DIR=/m.test(readFileSync(envFile, "utf-8"));
  if (alreadySet) {
    return { ...check, detail: `${check.detail}; ${envFile} already sets a durable dir — this shell still exports the node_modules path: export ${plan.envLine}` };
  }
  return {
    ...check,
    fix: {
      describe: `engram migrate model-cache   (${envFile ? `writes ${plan.envLine} to ${envFile}` : plan.envLine}${plan.hasModels ? `; moves the downloaded models to ${plan.proposed}` : ""})`,
      apply: async () => {
        if (envFile) ensureServiceEnvFile(envFile, config.dataDir, platform);
        applyModelCachePlan(plan, { dryRun: false });
        env.ENGRAM_MODEL_CACHE_DIR = plan.proposed;
        const next = checkModelCache({ dir: plan.proposed, source: "ENGRAM_MODEL_CACHE_DIR" });
        return { ...next, detail: `${next.detail}; ${envFile ? `written to ${envFile}` : "set for this process"} — other shells need: export ${plan.envLine}` };
      },
    },
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
export async function checkOllama(
  config: EngramConfig,
  fixCtx?: { exec: Exec; probe?: typeof resolveOllamaModel },
): Promise<DoctorCheck> {
  const name = "ollama";
  const intel = buildIntelligenceConfig(config);
  try {
    const probe = await (fixCtx?.probe ?? resolveOllamaModel)(intel);
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
    if (!probe.reachable) {
      return { name, level: "warn", required: false, detail: `ollama tier inactive: Ollama not reachable at ${intel.ollamaUrl}; extraction uses the cloud tiers` };
    }
    const check: DoctorCheck = {
      name,
      level: "warn",
      required: false,
      detail: `ollama tier inactive: ${intel.ollamaModel} not found at ${intel.ollamaUrl}; available: [${probe.available.join(", ")}] — \`ollama pull ${intel.ollamaModel}\` or set ENGRAM_LOCAL_MODEL / ENGRAM_LOCAL_MODEL_FALLBACKS`,
    };
    if (!fixCtx) return check;
    // Pulling a model is a multi-GB download: confirm-gated (#61).
    return {
      ...check,
      fix: {
        describe: `ollama pull ${intel.ollamaModel}`,
        needsConfirm: true,
        apply: async () => {
          const r = await fixCtx.exec("ollama", ["pull", intel.ollamaModel]);
          if (r.status !== 0) throw new Error(`ollama pull ${intel.ollamaModel} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? ""}`);
          return checkOllama(config, fixCtx);
        },
      },
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

/**
 * The service env file (`~/.config/engram/env`, `ENGRAM_ENV_FILE`): where API
 * keys and `ENGRAM_*` overrides for the daemons live, sourced by the launchers
 * (#10). `[--]` with a create fix when missing, `[--]` with a `chmod 600` fix
 * when group/other bits are set (keys must not be world-readable), `[ok]`
 * otherwise. Never required; on Windows only presence is judged.
 */
export function checkEnvFile(file: string, dataDir: string, platform: NodeJS.Platform = process.platform): DoctorCheck {
  const name = "env file";
  const mode = fileMode(file);
  const octal = (m: number) => m.toString(8).padStart(3, "0");
  if (mode === null) {
    const manual = platform === "win32"
      ? `New-Item -ItemType File -Force "${file}"`
      : `mkdir -p ${dirname(file)} && (umask 077; touch ${file})   # or: scripts/install-mcp-daemon.sh install`;
    return {
      name, level: "warn", required: false,
      detail: `${file} missing — the daemons source it for API keys and ENGRAM_* overrides; engram doctor --fix creates it (mode 600) with a commented template`,
      fix: {
        describe: manual,
        apply: async () => { ensureServiceEnvFile(file, dataDir, platform); return checkEnvFile(file, dataDir, platform); },
      },
    };
  }
  if (platform !== "win32" && (mode & 0o077) !== 0) {
    return {
      name, level: "warn", required: false,
      detail: `${file} is mode ${octal(mode)} — API keys live here; it should be 600`,
      fix: {
        describe: `chmod 600 ${file}`,
        apply: async () => { chmodSync(file, 0o600); return checkEnvFile(file, dataDir, platform); },
      },
    };
  }
  return { name, level: "ok", required: false, detail: platform === "win32" ? `${file} (present)` : `${file} (mode ${octal(mode)})` };
}

/**
 * Is the `engram` the shell runs this install (#65)? Lists every `engram` on
 * PATH; `[--]` when there is more than one distinct binary or the first one
 * is not under the root `engram update` upgrades, with the fix (uninstall
 * the other tree, or reorder PATH). Pure and never required; `[ok]` when
 * nothing is on PATH at all (a checkout run by path).
 */
export function checkInstallPath(ctx: InstallPathContext = defaultInstallPathContext()): DoctorCheck {
  const name = "install path";
  try {
    const r = installPathReport(ctx);
    return { name, level: r.ok ? "ok" : "warn", required: false, detail: r.detail };
  } catch (err) {
    return { name, level: "warn", required: false, detail: `could not resolve the engram on PATH: ${errMsg(err)}` };
  }
}

// The probe lives in ../mcp/port.ts since #58 so the stdio bridge can share it;
// re-exported here because `engram doctor` was its first home.
export { probeMcpHealth, type McpHealthProbe } from "../mcp/port.js";

/**
 * Is the HTTP MCP daemon (what the Hermes plugin and other HTTP clients talk
 * to) answering on its loopback port? Never required: stdio-only installs
 * have no daemon. The port follows ENGRAM_MCP_PORT like the server does (#28).
 */
export async function checkMcpDaemon(
  port: number = parseMcpPort(process.env.ENGRAM_MCP_PORT),
  probe: (port: number) => Promise<McpHealthProbe> = probeMcpHealth,
  fixCtx?: { services: ServiceDeps; startWaitMs?: number },
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
    const check: DoctorCheck = { name, level: "warn", required: false, detail: `not answering at ${url} (${errMsg(err)}) — ${hint}` };
    if (!fixCtx) return check;
    // A daemon that is installed but stopped can be started through its
    // supervisor (#61). Not installed is `engram setup`'s job: the hint stands.
    let svc: Awaited<ReturnType<typeof serviceStatus>>;
    try { svc = await serviceStatus("mcp", fixCtx.services); } catch { return check; }
    if (!svc.installed || svc.running) return check;
    const waitMs = fixCtx.startWaitMs ?? 90_000;
    return {
      ...check,
      detail: `not answering at ${url} (${errMsg(err)}) — ${svc.unit} is installed but not running (${svc.supervisor}); engram doctor --fix starts it`,
      fix: {
        describe: svc.startCommand,
        apply: async () => {
          await startService(svc, fixCtx.services);
          if (!(await waitForPort(svc, fixCtx.services, true, waitMs))) throw new Error(`${svc.unit} started but ${url} did not answer within ${Math.round(waitMs / 1000)}s`);
          return checkMcpDaemon(port, probe, fixCtx);
        },
      },
    };
  }
}

/**
 * Which MCP hosts are registered with this install (#50): `~/.claude.json`
 * or the Claude Code plugin, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
 * the deployed Hermes plugin. Reads files only (no probes); never required —
 * `[--]` with the `engram mcp install` hint when nothing points here.
 */
export async function checkHosts(ctx?: HostContext, fixCtx?: { probe?: HealthProbe; exec?: Exec }): Promise<DoctorCheck> {
  const name = "hosts";
  try {
    const { ok, detail, registered } = await summariseHostsForDoctor(ctx);
    const check: DoctorCheck = { name, level: ok ? "ok" : "warn", required: false, detail };
    if (ok || !fixCtx || registered > 0) return check;
    // Nothing registered: register the first host present on this machine —
    // Claude Code first (`~/.claude` or `~/.claude.json`), then Codex, Cursor,
    // Hermes. With the Claude plugin installed the hosts check is already ok,
    // and `mcp install claude` itself skips the user-scope entry (#60).
    const hctx = ctx ?? defaultHostContext();
    const target = HOST_IDS.find((id) => hostPresent(id, hctx));
    if (!target) return { ...check, detail: `${detail} (no host config dir found: ~/.claude, ~/.codex, ~/.cursor, ~/.hermes)` };
    return {
      ...check,
      fix: {
        describe: `engram mcp install ${target}`,
        apply: async () => {
          const [r] = await runMcpInstall({ hosts: [target], scope: "user" }, { ctx: hctx, probe: fixCtx.probe, exec: fixCtx.exec });
          if (!r || r.action === "error") throw new Error(`engram mcp install ${target}: ${r?.notes.join("; ") ?? "no result"}`);
          const next = await checkHosts(ctx, fixCtx);
          return r.action === "skipped" ? { ...next, detail: `${next.detail}; ${target}: skipped — ${r.notes[0] ?? ""}` } : next;
        },
      },
    };
  } catch (err) {
    return { name, level: "warn", required: false, detail: `could not read host configs: ${errMsg(err)}` };
  }
}

/**
 * The `extraction smoke` check (#61): one real extraction over the most recent
 * conversation (or the bundled fixture) under a 60 s budget, reporting which
 * tier answered and how many memories it produced, or every tier's reason.
 * Never required: an empty tier list is a warning, not a broken install.
 */
export async function checkSmoke(config: EngramConfig, deps: SmokeDeps = {}, skip = false): Promise<{ check: DoctorCheck; outcome: SmokeOutcome }> {
  const outcome = skip ? skippedSmoke() : await runExtractionSmoke(config, deps);
  return {
    check: { name: "extraction smoke", level: outcome.status === "ok" ? "ok" : "warn", required: false, detail: outcome.message },
    outcome,
  };
}

/** Run every probe. Never throws; failures are reported as checks. */
export async function runDoctor(
  config: EngramConfig = loadConfig(),
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const ctx = defaultDoctorContext(opts.ctx);
  const [betterSqlite, sqliteVec] = await checkNativeSqlite();
  const transformers = await checkTransformers();
  const modelCache = checkModelCache(describeModelCacheDir(config, ctx.env), { config, env: ctx.env, home: ctx.home, platform: ctx.platform, packageRoot: ctx.packageRoot });
  const ollama = await checkOllama(config, { exec: ctx.exec, probe: ctx.ollamaProbe });
  const mcpDaemon = await checkMcpDaemon(ctx.mcpPort, ctx.mcpProbe, { services: ctx.services, startWaitMs: ctx.mcpStartWaitMs });
  const hosts = await checkHosts(ctx.hosts, { probe: ctx.hostProbe, exec: ctx.exec });
  const smoke = await checkSmoke(config, ctx.smoke, Boolean(opts.noSmoke));
  const checks: DoctorCheck[] = [
    checkNode(),
    checkPlatform(),
    betterSqlite,
    sqliteVec,
    transformers,
    modelCache,
    ollama,
    checkLlmProviders(config, ctx.env),
    checkDataDir(config),
    checkEnvFile(serviceEnvFile(ctx.env, ctx.home), config.dataDir, ctx.platform),
    checkInstallPath(defaultInstallPathContext({ packageRoot: ctx.packageRoot, ...ctx.installPath })),
    mcpDaemon,
    hosts,
    smoke.check,
  ];
  return {
    node: process.version,
    platform: currentTarget(),
    checks,
    ok: reportOk(checks),
    smoke: smoke.outcome,
  };
}

function reportOk(checks: DoctorCheck[]): boolean {
  return checks.every((c) => !(c.required && c.level === "fail"));
}

// ─── --fix ───────────────────────────────────────────────────────────

export interface FixOutcome {
  name: DoctorCheckName;
  /** `fixed`: applied and the re-run check is ok; `applied`: applied, still not ok; `failed`: apply threw; `skipped`: needs confirmation. */
  status: "fixed" | "applied" | "failed" | "skipped";
  applied: boolean;
  level: DoctorLevel;
  detail: string;
  /** The manual equivalent, printed with every outcome. */
  manual: string;
}

export interface FixOptions {
  /** `--yes`: apply confirm-gated fixes without asking. */
  yes?: boolean;
  /** Ask on a terminal; absent when stdin is not a TTY (then only `--yes` applies confirm-gated fixes). */
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * Apply every fix a non-ok check carries and re-run those checks (#61).
 * Confirm-gated fixes ask on a terminal or require `--yes`; without either
 * they are skipped with the manual command. Returns the report with the
 * re-run verdicts swapped in and one outcome per candidate; a report with no
 * candidate returns an empty list ("nothing to fix").
 */
export async function applyDoctorFixes(report: DoctorReport, opts: FixOptions = {}): Promise<DoctorReport> {
  const fixes: FixOutcome[] = [];
  const checks = [...report.checks];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (c.level === "ok" || !c.fix) continue;
    const manual = c.fix.describe;
    if (c.fix.needsConfirm) {
      let go = Boolean(opts.yes);
      if (!go && opts.confirm) go = await opts.confirm(`${c.name}: apply \`${manual}\`? [y/N] `);
      if (!go) {
        fixes.push({ name: c.name, status: "skipped", applied: false, level: c.level, detail: opts.confirm ? "declined" : "needs confirmation (large download): re-run with --yes, or answer on a terminal", manual });
        continue;
      }
    }
    try {
      const next = await c.fix.apply();
      checks[i] = next;
      fixes.push({ name: c.name, status: next.level === "ok" ? "fixed" : "applied", applied: true, level: next.level, detail: next.detail, manual });
    } catch (err) {
      fixes.push({ name: c.name, status: "failed", applied: false, level: c.level, detail: errMsg(err), manual });
    }
  }
  return { ...report, checks, ok: reportOk(checks), fixes };
}

/** `[fixed] name: detail` + `  manual: …` per candidate, then one summary line. */
export function formatFixResults(fixes: FixOutcome[]): string[] {
  if (fixes.length === 0) return ["Doctor --fix: nothing to fix"];
  const lines: string[] = [];
  for (const f of fixes) {
    lines.push(`[${f.status}] ${f.name}: ${f.detail}`);
    lines.push(`  manual: ${f.manual}`);
  }
  const count = (s: FixOutcome["status"]) => fixes.filter((f) => f.status === s).length;
  const parts = (["fixed", "applied", "skipped", "failed"] as const).filter((s) => count(s) > 0).map((s) => `${count(s)} ${s}`);
  lines.push(`Doctor --fix: ${parts.join(", ")}`);
  return lines;
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
