import { homedir } from "node:os";
import { join } from "node:path";
import type { EngramConfig } from "./types.js";

const HOME = homedir();

const defaults: EngramConfig = {
  dataDir: join(HOME, ".local", "share", "engram"),
  dbPath: join(HOME, ".local", "share", "engram", "engram.db"),
  archiveDir: join(HOME, ".local", "share", "engram", "archive"),
  logsDir: join(HOME, ".local", "share", "engram", "logs"),
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
};

/**
 * Build configuration by merging defaults with environment overrides.
 * Environment variables take precedence over defaults.
 */
export function loadConfig(overrides?: Partial<EngramConfig>): EngramConfig {
  const env = process.env;

  const dataDir =
    env.ENGRAM_DATA_DIR ?? overrides?.dataDir ?? defaults.dataDir;

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
    },

    decay: {
      ...defaults.decay,
      ...overrides?.decay,
    },
  };
}
