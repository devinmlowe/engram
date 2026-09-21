/**
 * `engram migrate` — install/data migration (#44). Idempotent, safe to re-run,
 * every action plannable with `--dry-run`:
 *
 *   data-dir     0.2.0 moved the default data directory (Windows:
 *                `%LOCALAPPDATA%\engram`; Linux/macOS: `$XDG_DATA_HOME/engram`,
 *                both falling back to the pre-0.2.0 `~/.local/share/engram`).
 *                An upgraded install silently opens a NEW EMPTY database at
 *                the new path. Detect the split, move the data into the
 *                resolved dir, refuse when two dirs both hold a database.
 *   model-cache  Since 0.4.0 the cache defaults to `<data dir>/models` (#53);
 *                move a pre-0.4.0 node_modules/@xenova/transformers/.cache into
 *                the resolved dir, and relocate an explicit ENGRAM_MODEL_CACHE_DIR
 *                that still points inside node_modules.
 *   schema       Open the database once so schema migrations run, and report
 *                the `schema_migrations` checkpoints.
 *
 * Pure planning functions take the config/env/platform explicitly so tests can
 * stage every layout in a temp dir.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { defaultModelCacheDir, resolveDefaultDataDir, type ModelCacheSource } from "../../_core/config/index.js";
import {
  countModelFiles, describeLegacyCacheMigration, isInsideNodeModules, libraryModelCacheDir, migrateLegacyModelCache,
} from "../../_core/embeddings/model-cache.js";
import { PACKAGE_ROOT } from "../../_core/version/index.js";
import type { EngramConfig } from "../../_core/types/index.js";

export { libraryModelCacheDir };

// ─── data dir ────────────────────────────────────────────────────────

export type CandidateReason = "effective" | "legacy-default" | "platform-default";

export interface DataDirCandidate {
  dir: string;
  dbPath: string;
  reasons: CandidateReason[];
  exists: boolean;
  /** engram.db present with a SQLite header. */
  populated: boolean;
  sizeBytes: number;
}

/** Files and directories that move with the data dir. */
export const DATA_DIR_ITEMS = ["engram.db", "engram.db-wal", "engram.db-shm", "archive", "logs", "tmp"] as const;

export type DataDirAction =
  | { kind: "none"; reason: string }
  | { kind: "move"; from: string; to: string; items: string[] }
  | { kind: "refuse"; reason: string; populated: string[] };

export interface DataDirPlan {
  effective: string;
  effectiveDb: string;
  /** How the effective dir was chosen. */
  source: "ENGRAM_DB_PATH" | "ENGRAM_DATA_DIR" | "default";
  candidates: DataDirCandidate[];
  action: DataDirAction;
}

export function legacyDataDir(home: string = homedir()): string {
  return join(home, ".local", "share", "engram");
}

export function isSqliteFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    if (!st.isFile() || st.size < 100) return false;
    const fd = readFileSync(path).subarray(0, 16).toString("latin1");
    return fd.startsWith("SQLite format 3");
  } catch {
    return false;
  }
}

function candidate(dir: string, reasons: CandidateReason[], dbPath = join(dir, "engram.db")): DataDirCandidate {
  const populated = isSqliteFile(dbPath);
  return {
    dir, dbPath, reasons,
    exists: existsSync(dir),
    populated,
    sizeBytes: populated ? statSync(dbPath).size : 0,
  };
}

export interface PlanEnv {
  config: EngramConfig;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}

export function planDataDir({ config, env, platform, home }: PlanEnv): DataDirPlan {
  const source = env.ENGRAM_DB_PATH?.trim() ? "ENGRAM_DB_PATH" : env.ENGRAM_DATA_DIR?.trim() ? "ENGRAM_DATA_DIR" : "default";
  const byDir = new Map<string, DataDirCandidate>();
  const add = (dir: string, reason: CandidateReason, dbPath?: string) => {
    const key = resolve(dir);
    const existing = byDir.get(key);
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
    byDir.set(key, candidate(dir, [reason], dbPath));
  };
  add(config.dataDir, "effective", config.dbPath);
  add(legacyDataDir(home), "legacy-default");
  add(resolveDefaultDataDir(env, platform, home), "platform-default");
  const candidates = [...byDir.values()];
  const effective = candidates.find((c) => c.reasons.includes("effective"))!;
  const others = candidates.filter((c) => c !== effective && c.populated);

  let action: DataDirAction;
  if (others.length === 0) {
    action = { kind: "none", reason: effective.populated ? "the effective data dir holds the only database" : "no database anywhere yet (fresh install)" };
  } else if (effective.populated) {
    action = {
      kind: "refuse",
      reason: "two directories both hold a database; pick the canonical one (set ENGRAM_DATA_DIR to it, or rename the other) and re-run",
      populated: [effective.dbPath, ...others.map((o) => o.dbPath)],
    };
  } else if (others.length > 1) {
    action = {
      kind: "refuse",
      reason: "more than one legacy directory holds a database; pick the canonical one and re-run",
      populated: others.map((o) => o.dbPath),
    };
  } else if (source === "ENGRAM_DB_PATH") {
    action = { kind: "none", reason: `ENGRAM_DB_PATH points at ${effective.dbPath}; a populated database at ${others[0].dbPath} is ignored on purpose` };
  } else {
    const from = others[0].dir;
    const items = DATA_DIR_ITEMS.filter((i) => existsSync(join(from, i)));
    action = { kind: "move", from, to: effective.dir, items };
  }
  return { effective: effective.dir, effectiveDb: effective.dbPath, source, candidates, action };
}

/** Move one item, falling back to copy+delete across filesystems. */
function moveItem(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, errorOnExist: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Execute a `move` plan. Returns the lines describing what happened. Never touches a `refuse`/`none` plan. */
export function applyDataDirPlan(plan: DataDirPlan, opts: { dryRun: boolean }): string[] {
  const lines: string[] = [];
  if (plan.action.kind !== "move") {
    lines.push(`data-dir: nothing to do (${plan.action.kind === "none" ? plan.action.reason : plan.action.reason})`);
    return lines;
  }
  const { from, to, items } = plan.action;
  for (const item of items) {
    const src = join(from, item);
    const dst = join(to, item);
    if (existsSync(dst)) {
      // Only the empty new-default dir may hold pre-existing entries (an empty logs/ or a 0-byte db).
      const st = statSync(dst);
      if (st.isFile() && st.size > 0) throw new Error(`refusing to overwrite ${dst}`);
      if (st.isDirectory()) {
        if (opts.dryRun) { lines.push(`would merge ${src} -> ${dst}`); continue; }
        cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
        rmSync(src, { recursive: true, force: true });
        lines.push(`merged ${src} -> ${dst}`);
        continue;
      }
      if (!opts.dryRun) rmSync(dst, { force: true });
    }
    if (opts.dryRun) { lines.push(`would move ${src} -> ${dst}`); continue; }
    moveItem(src, dst);
    lines.push(`moved ${src} -> ${dst}`);
  }
  if (!opts.dryRun) {
    const note = join(from, "MOVED-TO.txt");
    writeFileSync(note, `engram data moved to ${to} on ${new Date().toISOString()} by 'engram migrate data-dir'.\nThis directory can be deleted once the new location is confirmed (engram stats).\n`);
    lines.push(`left a note at ${note}`);
  }
  return lines;
}

// ─── model cache ─────────────────────────────────────────────────────

export interface ModelCachePlan {
  /** False only when the resolved dir sits inside node_modules, where npm wipes it. */
  durable: boolean;
  /** The resolved cache dir: ENGRAM_MODEL_CACHE_DIR → $HF_HOME/hub → <data dir>/models (#53). */
  current: string;
  source: ModelCacheSource;
  /** Where the models should live. Equal to `current` when durable, else `<data dir>/models`. */
  proposed: string;
  /** The pre-0.4.0 default for this install: node_modules/@xenova/transformers/.cache. */
  legacy: string;
  /** True when the legacy (or non-durable current) dir holds downloaded models and `proposed` holds none: they get moved, not re-downloaded. */
  hasModels: boolean;
  envLine: string;
  /** Service env file to append the setting to, when it exists. */
  envFile: string | null;
}

/** Human label for how the cache dir was chosen. */
export function modelCacheSourceLabel(source: ModelCacheSource): string {
  switch (source) {
    case "ENGRAM_MODEL_CACHE_DIR": return "from ENGRAM_MODEL_CACHE_DIR";
    case "HF_HOME": return "from HF_HOME";
    case "override": return "from config override";
    default: return "default; set ENGRAM_MODEL_CACHE_DIR to relocate";
  }
}

export function serviceEnvFile(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env.ENGRAM_ENV_FILE?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "engram", "env");
}

/**
 * The commented template `engram doctor --fix` / `engram setup` write into a
 * missing service env file (#61) — the same variables the shell installers
 * seed (`scripts/install-mcp-daemon.sh`, `scripts/install-daemon.sh`), every
 * line commented out so creating the file changes nothing until a value is
 * filled in. The daemons source it (`scripts/run-mcp-daemon.sh`,
 * `scripts/run-dream.sh`); the CLI reads the same variables from the shell.
 */
export function serviceEnvTemplate(dataDir: string): string {
  return [
    "# engram service environment — sourced by scripts/run-mcp-daemon.sh and scripts/run-dream.sh (the daemons);",
    "# the CLI and MCP hosts read the same variables from your shell. Created by `engram doctor --fix`.",
    "# One NAME=value per line (shell syntax, quote values with spaces). Keep this file mode 600: API keys live here.",
    "# MCP daemon settings (all optional):",
    `#ENGRAM_DATA_DIR=          # where engram.db lives (currently ${dataDir})`,
    "#ENGRAM_MODEL_CACHE_DIR=   # model weights; default <data dir>/models (or $HF_HOME/hub), already durable",
    "#ENGRAM_HTTP_WORKERS=2     # tool-call worker threads (0 = inline)",
    "#ENGRAM_MCP_PORT=9907      # loopback port for /mcp and /health",
    "#ENGRAM_MCP_TOKEN=         # bearer token for /mcp; hosts reference the variable, never the value (engram mcp status)",
    "#ENGRAM_WEB_TOKEN=         # visualizer token (falls back to ENGRAM_MCP_TOKEN); required before ENGRAM_BIND leaves loopback",
    "# LLM tiers for extraction and the nightly dream (see scripts/install-daemon.sh); order: ENGRAM_LLM_PROVIDERS",
    "#OLLAMA_HOST=http://localhost:11434",
    "#ENGRAM_LOCAL_MODEL=qwen2.5:7b",
    "#ENGRAM_LOCAL_MODEL_FALLBACKS=",
    "#OPENROUTER_API_KEY=",
    "#ENGRAM_OPENROUTER_MODEL=",
    "#ANTHROPIC_API_KEY=",
    "#ENGRAM_OPENAI_BASE_URL=   # generic OpenAI-compatible route; key read from the env var named by ENGRAM_OPENAI_API_KEY_ENV",
    "#ENGRAM_OPENAI_MODEL=",
    "#ENGRAM_OPENAI_API_KEY_ENV=OPENAI_API_KEY",
    "#ENGRAM_LLM_PROVIDERS=ollama,openai,openrouter,anthropic",
    "#ENGRAM_FORGET_RETENTION_DAYS=30",
    "",
  ].join("\n");
}

/** The permission bits of `file` (e.g. 0o600), or null when it does not exist. */
export function fileMode(file: string): number | null {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Create the service env file with the template, mode 600, its directory
 * mode 700 — never rewriting an existing file (only tightening its mode).
 * Returns what happened, for the doctor `[fixed]` line.
 */
export function ensureServiceEnvFile(file: string, dataDir: string, platform: NodeJS.Platform = process.platform): "created" | "chmod" | "unchanged" {
  if (existsSync(file)) {
    if (platform !== "win32" && fileMode(file) !== 0o600) { chmodSync(file, 0o600); return "chmod"; }
    return "unchanged";
  }
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, serviceEnvTemplate(dataDir), { mode: 0o600, flag: "wx" });
  if (platform !== "win32") chmodSync(file, 0o600); // `mode` is masked by umask; make 600 unconditional
  return "created";
}

/** The directory whose models a plan moves into `proposed`. */
function modelCacheMoveSource(plan: Pick<ModelCachePlan, "durable" | "current" | "legacy">): string {
  return plan.durable ? plan.legacy : plan.current;
}

export function planModelCache({ config, env, platform, home }: PlanEnv, packageRoot: string = PACKAGE_ROOT): ModelCachePlan {
  const { modelCacheDir: current, modelCacheSource: source } = config;
  const durable = !isInsideNodeModules(current);
  const proposed = durable ? current : defaultModelCacheDir(config.dataDir);
  const legacy = libraryModelCacheDir(packageRoot);
  const from = modelCacheMoveSource({ durable, current, legacy });
  const hasModels = resolve(from) !== resolve(proposed)
    && countModelFiles(from).files > 0
    && countModelFiles(proposed).files === 0;
  const envLine = platform === "win32"
    ? `setx ENGRAM_MODEL_CACHE_DIR "${proposed}"`
    : `ENGRAM_MODEL_CACHE_DIR='${proposed}'`;
  const envFile = platform === "win32" ? null : serviceEnvFile(env, home);
  return { durable, current, source, proposed, legacy, hasModels, envLine, envFile };
}

export function applyModelCachePlan(plan: ModelCachePlan, opts: { dryRun: boolean }): string[] {
  const lines: string[] = [];
  if (!plan.durable) {
    // Explicit relocation: the configured dir sits inside node_modules, so npm
    // ci wipes it. Point the setting at the durable default instead.
    lines.push(opts.dryRun ? `would create ${plan.proposed}` : `created ${plan.proposed}`);
    if (!opts.dryRun) mkdirSync(plan.proposed, { recursive: true });
  }
  if (plan.hasModels) {
    const from = modelCacheMoveSource(plan);
    if (opts.dryRun) {
      lines.push(`would move the downloaded models from ${from} to ${plan.proposed}`);
    } else {
      const r = migrateLegacyModelCache(from, plan.proposed);
      lines.push(describeLegacyCacheMigration(r) ?? `nothing moved: ${r.reason}`);
    }
  }
  if (plan.durable) {
    if (!plan.hasModels) {
      lines.push(plan.source === "default"
        ? `nothing to do: the durable default ${plan.current} already applies and there is no legacy cache to move`
        : `nothing to do: already durable at ${plan.current} (${modelCacheSourceLabel(plan.source)})`);
    }
    return lines;
  }
  if (plan.envFile && existsSync(plan.envFile) && !readFileSync(plan.envFile, "utf-8").match(/^ENGRAM_MODEL_CACHE_DIR=/m)) {
    lines.push(opts.dryRun ? `would append ${plan.envLine} to ${plan.envFile}` : `appended ${plan.envLine} to ${plan.envFile}`);
    if (!opts.dryRun) appendFileSync(plan.envFile, `\n# added by 'engram migrate model-cache'\n${plan.envLine}\n`);
  }
  lines.push(`${plan.current} is inside node_modules (wiped by npm ci): unset ENGRAM_MODEL_CACHE_DIR to use ${plan.proposed}, or set ${plan.envLine}`);
  return lines;
}

// ─── schema ──────────────────────────────────────────────────────────

export interface SchemaReport {
  dbPath: string;
  applied: Array<{ name: string; applied_at: number | null }>;
}

/** Open the database once (which runs every schema migration) and list the checkpoints. */
export async function reportSchema(config: EngramConfig): Promise<SchemaReport> {
  const { initDatabase } = await import("../../_core/db/index.js");
  const db = initDatabase(config);
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const applied = exists
      ? (db.prepare("SELECT name, applied_at FROM schema_migrations ORDER BY applied_at, name").all() as Array<{ name: string; applied_at: number | null }>)
      : [];
    return { dbPath: config.dbPath, applied };
  } finally {
    db.close();
  }
}
