import { homedir } from "node:os";
import { join } from "node:path";
import type { EngramConfig } from "../types/index.js";

const HOME = homedir();

/** A directory-valued env var counts as set only when non-blank (XDG semantics). */
function envDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Platform default for the engram data directory, used only when
 * ENGRAM_DATA_DIR is unset. This is the single place in the codebase that
 * knows where engram data lives by default; every other component must go
 * through loadConfig().
 *
 * - Windows: %LOCALAPPDATA%\engram
 * - Linux/macOS: $XDG_DATA_HOME/engram
 * - Fallback (var unset/blank): the historical ~/.local/share/engram, so
 *   existing installs never move. On macOS XDG_DATA_HOME is normally unset,
 *   so the default there stays ~/.local/share/engram.
 */
export function resolveDefaultDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = HOME,
): string {
  const base =
    platform === "win32" ? envDir(env.LOCALAPPDATA) : envDir(env.XDG_DATA_HOME);
  return base ? join(base, "engram") : join(home, ".local", "share", "engram");
}

/** How `modelCacheDir` was chosen, in precedence order (#53). */
export type ModelCacheSource = "ENGRAM_MODEL_CACHE_DIR" | "override" | "HF_HOME" | "default";

export interface ModelCacheResolution {
  dir: string;
  source: ModelCacheSource;
}

/** The durable default: `<data dir>/models`, so it lives with the database and survives `npm ci`. */
export function defaultModelCacheDir(dataDir: string): string {
  return join(dataDir, "models");
}

/**
 * Where transformers.js downloads model weights (#53). Precedence:
 *
 *   1. `ENGRAM_MODEL_CACHE_DIR`                (explicit, any path)
 *   2. a programmatic `loadConfig({ modelCacheDir })` override
 *   3. `$HF_HOME/hub`                          (Hugging Face hub-cache semantics)
 *   4. `<data dir>/models`                     (durable default)
 *
 * The library's own default (`node_modules/@xenova/transformers/.cache/`) is
 * never used: every `npm install` / `npm ci` / global upgrade wipes it. Pure.
 */
export function resolveModelCacheLocation(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  override?: string,
): ModelCacheResolution {
  const explicit = envDir(env.ENGRAM_MODEL_CACHE_DIR);
  if (explicit) return { dir: explicit, source: "ENGRAM_MODEL_CACHE_DIR" };
  const fromOverride = envDir(override);
  if (fromOverride) return { dir: fromOverride, source: "override" };
  const hfHome = envDir(env.HF_HOME);
  if (hfHome) return { dir: join(hfHome, "hub"), source: "HF_HOME" };
  return { dir: defaultModelCacheDir(dataDir), source: "default" };
}

/**
 * Recover how an already-loaded config's `modelCacheDir` was chosen, for
 * `engram doctor` / `engram migrate` output. Mirrors resolveModelCacheLocation().
 */
export function describeModelCacheDir(
  config: Pick<EngramConfig, "dataDir" | "modelCacheDir">,
  env: Record<string, string | undefined> = process.env,
): ModelCacheResolution {
  const dir = config.modelCacheDir;
  if (envDir(env.ENGRAM_MODEL_CACHE_DIR) === dir) return { dir, source: "ENGRAM_MODEL_CACHE_DIR" };
  if (dir === defaultModelCacheDir(config.dataDir)) return { dir, source: "default" };
  const hfHome = envDir(env.HF_HOME);
  if (hfHome && dir === join(hfHome, "hub")) return { dir, source: "HF_HOME" };
  return { dir, source: "override" };
}

// Snapshot of the platform default at import time. The path fields below are
// placeholders only: loadConfig() always recomputes them from ENGRAM_DATA_DIR /
// resolveDefaultDataDir(env) so environment changes after import still apply.
const IMPORT_TIME_DATA_DIR = resolveDefaultDataDir();

/** Default retention (days) for forgotten memories before dream prune hard-deletes them (#56). */
export const DEFAULT_FORGET_RETENTION_DAYS = 30;

const defaults: EngramConfig = {
  dataDir: IMPORT_TIME_DATA_DIR,
  dbPath: join(IMPORT_TIME_DATA_DIR, "engram.db"),
  archiveDir: join(IMPORT_TIME_DATA_DIR, "archive"),
  logsDir: join(IMPORT_TIME_DATA_DIR, "logs"),
  modelCacheDir: defaultModelCacheDir(IMPORT_TIME_DATA_DIR),
  claudeProjectsDir: join(HOME, ".claude", "projects"),

  embedding: {
    model: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: 256,
    maxTokens: 8192,
  },

  search: {
    defaultLimit: 10,
    defaultBudget: 1500,
    rrfK: 60,
    rerankEnabled: true,
    reranker: {
      enabled: true,
      model: "Xenova/bge-reranker-base",
      topK: 5,
      blendWeight: 0.7,
    },
  },

  dream: {
    apiModel: "claude-haiku-4-5-20251001",
    apiFallbackModel: "claude-sonnet-4-6",
    concurrency: 1,
    scheduleHour: 2,
  },

  decay: {
    preference: 0.01,
    decision: 0.02,
    fact: 0.05,
    pattern: 0.005,
    solution: 0.03,
    convention: 0.015,
  },

  forget: {
    retentionDays: DEFAULT_FORGET_RETENTION_DAYS,
  },
};

/**
 * Parse ENGRAM_FORGET_RETENTION_DAYS: a non-negative integer number of days
 * (0 = purge on the next prune). Anything else falls back to `fallback`.
 */
export function parseRetentionDays(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Build configuration by merging defaults with environment overrides.
 * Environment variables take precedence over defaults.
 */
export function loadConfig(overrides?: Partial<EngramConfig>): EngramConfig {
  const env = process.env;

  const dataDir =
    envDir(env.ENGRAM_DATA_DIR) ?? overrides?.dataDir ?? resolveDefaultDataDir(env);

  return {
    ...defaults,
    ...overrides,
    dataDir,
    dbPath: env.ENGRAM_DB_PATH ?? join(dataDir, "engram.db"),
    archiveDir: env.ENGRAM_ARCHIVE_DIR ?? join(dataDir, "archive"),
    logsDir: env.ENGRAM_LOGS_DIR ?? join(dataDir, "logs"),
    claudeProjectsDir:
      env.ENGRAM_CLAUDE_PROJECTS_DIR ??
      overrides?.claudeProjectsDir ??
      defaults.claudeProjectsDir,
    modelCacheDir: resolveModelCacheLocation(dataDir, env, overrides?.modelCacheDir).dir,

    embedding: {
      ...defaults.embedding,
      ...overrides?.embedding,
      dimensions: env.ENGRAM_EMBEDDING_DIMS
        ? parseInt(env.ENGRAM_EMBEDDING_DIMS, 10)
        : (overrides?.embedding?.dimensions ?? defaults.embedding.dimensions),
    },

    search: {
      ...defaults.search,
      ...overrides?.search,
      rerankEnabled: env.ENGRAM_RERANK_ENABLED !== undefined
        ? env.ENGRAM_RERANK_ENABLED !== "false" && env.ENGRAM_RERANK_ENABLED !== "0"
        : (overrides?.search?.rerankEnabled ?? defaults.search.rerankEnabled),
      reranker: {
        ...defaults.search.reranker,
        ...overrides?.search?.reranker,
        enabled: env.ENGRAM_RERANK_ENABLED !== undefined
          ? env.ENGRAM_RERANK_ENABLED !== "false" && env.ENGRAM_RERANK_ENABLED !== "0"
          : (overrides?.search?.reranker?.enabled ?? defaults.search.reranker.enabled),
      },
    },

    dream: {
      ...defaults.dream,
      ...overrides?.dream,
      localModel:
        env.ENGRAM_LOCAL_MODEL ?? overrides?.dream?.localModel ?? undefined,
      localModelFallbacks:
        env.ENGRAM_LOCAL_MODEL_FALLBACKS !== undefined
          ? env.ENGRAM_LOCAL_MODEL_FALLBACKS.split(",").map((m) => m.trim()).filter(Boolean)
          : (overrides?.dream?.localModelFallbacks ?? []),
      openrouterModel:
        env.ENGRAM_OPENROUTER_MODEL ?? overrides?.dream?.openrouterModel ?? undefined,
    },

    decay: {
      ...defaults.decay,
      ...overrides?.decay,
    },

    forget: {
      ...defaults.forget,
      ...overrides?.forget,
      retentionDays: parseRetentionDays(
        env.ENGRAM_FORGET_RETENTION_DAYS,
        overrides?.forget?.retentionDays ?? defaults.forget.retentionDays,
      ),
    },
  };
}
