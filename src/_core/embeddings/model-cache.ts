import { loadConfig } from "../config/index.js";

/** The slice of `@xenova/transformers`' `env` object that engram touches. */
export interface ModelCacheEnv {
  cacheDir: string;
}

/**
 * Resolve the directory transformers.js will use for downloaded model weights.
 *
 * An explicit engram override (`ENGRAM_MODEL_CACHE_DIR` / `config.modelCacheDir`)
 * wins; otherwise the library default applies, which is
 * `node_modules/@xenova/transformers/.cache` and therefore disappears on every
 * reinstall. Pure — never mutates `env`.
 */
export function resolveModelCacheDir(
  env: ModelCacheEnv,
  override?: string,
): string {
  return override && override.trim() !== "" ? override : env.cacheDir;
}

/**
 * Point transformers.js at engram's configured model cache.
 *
 * Must run before any `pipeline()` / `from_pretrained()` call. Every model
 * loader in engram (embeddings, reranker, NLI) goes through this so a single
 * env var relocates all downloads. Returns the effective directory.
 */
export function applyModelCacheDir(
  env: ModelCacheEnv,
  override: string | undefined = loadConfig().modelCacheDir,
): string {
  const dir = resolveModelCacheDir(env, override);
  if (env.cacheDir !== dir) env.cacheDir = dir;
  return dir;
}
