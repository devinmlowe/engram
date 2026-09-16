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

const defaults: EngramConfig = {
  // Path fields are placeholders: loadConfig() always recomputes them from
  // ENGRAM_DATA_DIR / resolveDefaultDataDir() so env changes after import apply.
  dataDir: resolveDefaultDataDir(),
  dbPath: join(resolveDefaultDataDir(), "engram.db"),
  archiveDir: join(resolveDefaultDataDir(), "archive"),
  logsDir: join(resolveDefaultDataDir(), "logs"),
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
    chunkingStrategy: "fixed" as const,
  },

  decay: {
    preference: 0.01,
    decision: 0.02,
    fact: 0.05,
    pattern: 0.005,
    solution: 0.03,
    convention: 0.015,
  },
};

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
      openrouterModel:
        env.ENGRAM_OPENROUTER_MODEL ?? overrides?.dream?.openrouterModel ?? undefined,
      chunkingStrategy:
        (env.ENGRAM_CHUNKING_STRATEGY === "adaptive" ? "adaptive" : undefined) ??
        overrides?.dream?.chunkingStrategy ??
        defaults.dream.chunkingStrategy,
    },

    decay: {
      ...defaults.decay,
      ...overrides?.decay,
    },
  };
}
