/**
 * `engram doctor` — runtime diagnostics for the native/prebuilt dependency
 * chain. Answers "will this install work on this machine?" before `engram
 * init` gets far enough to crash.
 *
 * Every probe is isolated in its own try/catch; a failing probe becomes a
 * `fail` check, never an exception. Only `required` checks at level `fail`
 * make the report not-ok (and the CLI exit non-zero).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { loadConfig } from "../../_core/config/index.js";
import { resolveModelCacheDir } from "../../_core/embeddings/model-cache.js";
import { buildIntelligenceConfig, resolveOllamaModel } from "../../_core/llm/index.js";
import type { EngramConfig } from "../../_core/types/index.js";

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

export const MIN_NODE_MAJOR = 22;

/**
 * `${process.platform}-${process.arch}` targets for which better-sqlite3,
 * sqlite-vec, and onnxruntime-node all ship prebuilt binaries. Anything else
 * needs a C++ toolchain at `npm install` time, and sqlite-vec has no build at
 * all (notably Windows on ARM and 32-bit ARM Linux).
 */
export const PREBUILT_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;

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
  const prebuilt = (PREBUILT_TARGETS as readonly string[]).includes(target);
  return {
    name: "platform/arch",
    level: prebuilt ? "ok" : "warn",
    required: false,
    detail: prebuilt
      ? `${target} (prebuilt native modules available)`
      : `${target} (no prebuilt native modules; sqlite-vec has no build for this target — see README "Supported platforms")`,
  };
}

/** better-sqlite3 and sqlite-vec share one throwaway in-memory database. */
async function checkNativeSqlite(): Promise<[DoctorCheck, DoctorCheck]> {
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
      detail: `loaded (SQLite ${v})`,
    };
  } catch (err) {
    return [
      {
        name: "better-sqlite3",
        level: "fail",
        required: true,
        detail: `failed to load for ${currentTarget()}: ${errMsg(err)}`,
      },
      {
        name: "sqlite-vec",
        level: "fail",
        required: true,
        detail: "skipped (better-sqlite3 unavailable)",
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
      detail: `loaded (${v})`,
    };
  } catch (err) {
    sqliteVec = {
      name: "sqlite-vec",
      level: "fail",
      required: true,
      detail: `failed to load for ${currentTarget()}: ${errMsg(err)}`,
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
 * Report where transformers.js will put model weights and whether it can.
 * Exported for tests. `defaultDir` is what `@xenova/transformers` reports as
 * `env.cacheDir`, or undefined if the library itself failed to load.
 */
export function checkModelCache(
  override: string | undefined,
  defaultDir: string | undefined,
): DoctorCheck {
  const name = "model cache";
  const source = override
    ? "from ENGRAM_MODEL_CACHE_DIR"
    : "default; set ENGRAM_MODEL_CACHE_DIR to relocate";
  const dir =
    defaultDir !== undefined
      ? resolveModelCacheDir({ cacheDir: defaultDir }, override)
      : override && override.trim() !== ""
        ? override
        : undefined;

  if (!dir) {
    return {
      name,
      level: "fail",
      required: true,
      detail:
        "unknown (transformers.js failed to load and ENGRAM_MODEL_CACHE_DIR is not set)",
    };
  }

  const writable = probeWritable(dir);
  if (writable === true) {
    return { name, level: "ok", required: true, detail: `${dir} (writable; ${source})` };
  }

  // A read-only but already-populated cache still works offline.
  const populated = existsSync(dir) && readdirSync(dir).length > 0;
  return populated
    ? {
        name,
        level: "warn",
        required: true,
        detail: `${dir} (read-only: ${writable}; cached models will load but new downloads will fail; ${source})`,
      }
    : {
        name,
        level: "fail",
        required: true,
        detail: `${dir} (not writable: ${writable}; ${source})`,
      };
}

async function checkTransformersAndCache(
  config: EngramConfig,
): Promise<[DoctorCheck, DoctorCheck]> {
  let defaultDir: string | undefined;
  let transformers: DoctorCheck;
  try {
    const { env } = await import("@xenova/transformers");
    defaultDir = env.cacheDir;
    transformers = {
      name: "transformers.js",
      level: "ok",
      required: true,
      detail: `loaded (@xenova/transformers ${env.version})`,
    };
  } catch (err) {
    transformers = {
      name: "transformers.js",
      level: "fail",
      required: true,
      detail: `failed to load for ${currentTarget()}: ${errMsg(err)}`,
    };
  }
  return [transformers, checkModelCache(config.modelCacheDir, defaultDir)];
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

/** Run every probe. Never throws; failures are reported as checks. */
export async function runDoctor(
  config: EngramConfig = loadConfig(),
): Promise<DoctorReport> {
  const [betterSqlite, sqliteVec] = await checkNativeSqlite();
  const [transformers, modelCache] = await checkTransformersAndCache(config);
  const ollama = await checkOllama(config);
  const checks: DoctorCheck[] = [
    checkNode(),
    checkPlatform(),
    betterSqlite,
    sqliteVec,
    transformers,
    modelCache,
    ollama,
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
