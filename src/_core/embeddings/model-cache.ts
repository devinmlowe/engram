import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig } from "../config/index.js";
import { PACKAGE_ROOT } from "../version/index.js";

/** The slice of `@xenova/transformers`' `env` object that engram touches. */
export interface ModelCacheEnv {
  cacheDir: string;
}

/**
 * Resolve the directory transformers.js will use for downloaded model weights.
 *
 * A non-blank `override` (normally `config.modelCacheDir`, which loadConfig()
 * always resolves — #53) wins; only a blank one falls back to the library
 * default, `node_modules/@xenova/transformers/.cache`, which disappears on
 * every reinstall. Pure — never mutates `env`.
 */
export function resolveModelCacheDir(
  env: ModelCacheEnv,
  override?: string,
): string {
  return override && override.trim() !== "" ? override : env.cacheDir;
}

/** True when `dir` sits under any `node_modules` directory, i.e. npm will wipe it. */
export function isInsideNodeModules(dir: string): boolean {
  return resolve(dir).split(sep).includes("node_modules");
}

/**
 * Where `@xenova/transformers` 2.x caches by default: inside its own package
 * directory. This is the *legacy* location engram used before 0.4.0 and the
 * source of the one-time migration below.
 */
export function libraryModelCacheDir(packageRoot: string = PACKAGE_ROOT): string {
  return join(packageRoot, "node_modules", "@xenova", "transformers", ".cache");
}

/** Regular files under `dir` at any depth, with their total size. `{0, 0}` when absent. */
export function countModelFiles(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) { files += 1; bytes += statSync(p).size; }
    }
  };
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  } catch {
    /* unreadable trees count as empty */
  }
  return { files, bytes };
}

export interface LegacyCacheMigration {
  /** `moved`: the legacy cache now lives at `to`. `skipped`: nothing to do. `failed`: see `reason`. */
  outcome: "moved" | "skipped" | "failed";
  from: string;
  to: string;
  /** Files moved (0 unless `moved`). */
  files: number;
  /** `rename` on the same filesystem, else `copy` (copy, verify sizes, delete the source). */
  method?: "rename" | "copy";
  reason?: string;
}

const RACE_CODES = new Set(["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EBUSY"]);

/**
 * Adopt a legacy `node_modules/.../.cache` model cache into `to` (#53).
 *
 * Runs only when `from` sits inside `node_modules`, `to` does not, `from`
 * holds files and `to` holds none. Same filesystem: one `rename`. Otherwise
 * copy to a sibling temp dir, verify file count + total bytes, rename it into
 * place, then delete the source. Two processes racing on the same install are
 * tolerated: whichever loses sees the target populated and reports `skipped`.
 * Never throws for filesystem errors — a `failed` result leaves transformers
 * free to re-download.
 */
export function migrateLegacyModelCache(from: string, to: string): LegacyCacheMigration {
  const base = { from, to, files: 0 };
  const skipped = (reason: string): LegacyCacheMigration => ({ ...base, outcome: "skipped", reason });
  if (resolve(from) === resolve(to)) return skipped("the cache dir is the legacy location");
  if (!isInsideNodeModules(from)) return skipped("source is not a node_modules cache");
  if (isInsideNodeModules(to)) return skipped("target is inside node_modules");
  const source = countModelFiles(from);
  if (source.files === 0) return skipped("no legacy cache");
  if (countModelFiles(to).files > 0) return skipped("target already populated");

  const populatedByOther = (): LegacyCacheMigration | null =>
    countModelFiles(to).files > 0 ? skipped("another process populated the target") : null;
  try {
    mkdirSync(dirname(to), { recursive: true });
    // An empty (or file-less) target dir blocks rename on Windows and would
    // otherwise be merged; it holds nothing worth keeping.
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    try {
      renameSync(from, to);
      return { ...base, outcome: "moved", method: "rename", files: source.files };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") {
        if (code && RACE_CODES.has(code)) return populatedByOther() ?? skipped(`rename failed (${code})`);
        throw err;
      }
    }
    // Cross-device: copy + verify + swap in, so a half-copied tree is never the live cache.
    const tmp = `${to}.migrating-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    cpSync(from, tmp, { recursive: true, errorOnExist: true });
    const copied = countModelFiles(tmp);
    if (copied.files !== source.files || copied.bytes !== source.bytes) {
      rmSync(tmp, { recursive: true, force: true });
      return { ...base, outcome: "failed", reason: `copy verification failed (${copied.files}/${source.files} files, ${copied.bytes}/${source.bytes} bytes)` };
    }
    try {
      renameSync(tmp, to);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      const code = (err as NodeJS.ErrnoException).code;
      if (code && RACE_CODES.has(code)) return populatedByOther() ?? skipped(`rename failed (${code})`);
      throw err;
    }
    rmSync(from, { recursive: true, force: true });
    return { ...base, outcome: "moved", method: "copy", files: source.files };
  } catch (err) {
    return populatedByOther() ?? { ...base, outcome: "failed", reason: (err as Error).message };
  }
}

/** One human line for a migration result, or null when there is nothing worth saying. */
export function describeLegacyCacheMigration(r: LegacyCacheMigration): string | null {
  if (r.outcome === "moved") return `moved the model cache from ${r.from} to ${r.to} (${r.files} files; npm no longer wipes it)`;
  if (r.outcome === "failed") return `could not move the legacy model cache ${r.from} -> ${r.to}: ${r.reason}; models will be re-downloaded`;
  return null;
}

let legacyMigrationDone = false;

/** Test hook: let the next `applyModelCacheDir` run the legacy-cache migration again. */
export function resetLegacyMigrationForTests(): void {
  legacyMigrationDone = false;
}

/**
 * Point transformers.js at engram's configured model cache.
 *
 * Must run before any `pipeline()` / `from_pretrained()` call. Every model
 * loader in engram (embeddings, reranker, NLI) goes through this so one
 * config value relocates all downloads. The first call in a process also
 * adopts a legacy `node_modules` cache into the resolved dir (#53) and logs
 * exactly one line when it does. Returns the effective directory.
 */
export function applyModelCacheDir(
  env: ModelCacheEnv,
  override: string | undefined = loadConfig().modelCacheDir,
  opts: { log?: (line: string) => void } = {},
): string {
  const dir = resolveModelCacheDir(env, override);
  if (!legacyMigrationDone) {
    legacyMigrationDone = true;
    // `env.cacheDir` still holds the library default here: the legacy location for this install.
    const line = describeLegacyCacheMigration(migrateLegacyModelCache(env.cacheDir, dir));
    if (line) (opts.log ?? ((l) => console.warn(`[engram] ${l}`)))(line);
  }
  if (env.cacheDir !== dir) env.cacheDir = dir;
  return dir;
}
