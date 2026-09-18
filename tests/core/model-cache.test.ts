/**
 * Issue #53: durable model cache by default. The pre-0.4.0 cache lived in
 * node_modules/@xenova/transformers/.cache and vanished on every npm ci; the
 * first model load (or `engram init` / `engram migrate model-cache`) now moves
 * it into the resolved cache dir exactly once. These tests stage a fake legacy
 * cache in a temp dir and pin the move, the no-op second run, the guards, and
 * the once-per-process behaviour of applyModelCacheDir().
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  applyModelCacheDir,
  countModelFiles,
  describeLegacyCacheMigration,
  isInsideNodeModules,
  libraryModelCacheDir,
  migrateLegacyModelCache,
  resetLegacyMigrationForTests,
} from "../../src/_core/embeddings/model-cache.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engram-model-cache-"));
  resetLegacyMigrationForTests();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetLegacyMigrationForTests();
});

/** A fake pre-0.4.0 cache with the layout transformers.js writes: <org>/<model>/{config.json,onnx/model.onnx}. */
function legacyCache(pkg = join(root, "pkg")): string {
  const legacy = libraryModelCacheDir(pkg);
  mkdirSync(join(legacy, "nomic-ai", "nomic-embed-text-v1.5", "onnx"), { recursive: true });
  writeFileSync(join(legacy, "nomic-ai", "nomic-embed-text-v1.5", "config.json"), "{}");
  writeFileSync(join(legacy, "nomic-ai", "nomic-embed-text-v1.5", "onnx", "model_quantized.onnx"), "weights-weights");
  mkdirSync(join(legacy, "Xenova", "bge-reranker-base"), { recursive: true });
  writeFileSync(join(legacy, "Xenova", "bge-reranker-base", "tokenizer.json"), "tok");
  return legacy;
}

describe("path helpers", () => {
  it("libraryModelCacheDir is the transformers.js default inside the package's node_modules", () => {
    const dir = libraryModelCacheDir(join(root, "pkg"));
    expect(dir).toBe(join(root, "pkg", "node_modules", "@xenova", "transformers", ".cache"));
    expect(isInsideNodeModules(dir)).toBe(true);
  });

  it("isInsideNodeModules matches a path segment, not a substring", () => {
    expect(isInsideNodeModules(join(root, "node_modules", "x"))).toBe(true);
    expect(isInsideNodeModules(join(root, "a", "node_modules"))).toBe(true);
    expect(isInsideNodeModules(join(root, "data", "models"))).toBe(false);
    expect(isInsideNodeModules(join(root, "my_node_modules_backup", "models"))).toBe(false);
    expect(isInsideNodeModules(`${root}${sep}pkg${sep}node_modules${sep}@xenova${sep}transformers${sep}.cache${sep}`)).toBe(true);
  });

  it("countModelFiles walks the tree and treats a missing dir as empty", () => {
    expect(countModelFiles(join(root, "nope"))).toEqual({ files: 0, bytes: 0 });
    mkdirSync(join(root, "empty", "sub"), { recursive: true });
    expect(countModelFiles(join(root, "empty"))).toEqual({ files: 0, bytes: 0 });
    const legacy = legacyCache();
    expect(countModelFiles(legacy)).toEqual({ files: 3, bytes: 2 + 15 + 3 });
  });
});

describe("migrateLegacyModelCache", () => {
  it("moves a legacy node_modules cache into a missing target and leaves the legacy dir gone", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    const r = migrateLegacyModelCache(legacy, target);
    expect(r).toMatchObject({ outcome: "moved", method: "rename", files: 3, from: legacy, to: target });
    expect(readFileSync(join(target, "nomic-ai", "nomic-embed-text-v1.5", "onnx", "model_quantized.onnx"), "utf-8")).toBe("weights-weights");
    expect(readFileSync(join(target, "Xenova", "bge-reranker-base", "tokenizer.json"), "utf-8")).toBe("tok");
    expect(existsSync(legacy)).toBe(false);
    expect(countModelFiles(legacy)).toEqual({ files: 0, bytes: 0 });
    expect(describeLegacyCacheMigration(r)).toBe(`moved the model cache from ${legacy} to ${target} (3 files; npm no longer wipes it)`);

    // second run: nothing left to move, and nothing to say
    const again = migrateLegacyModelCache(legacy, target);
    expect(again).toMatchObject({ outcome: "skipped", reason: "no legacy cache", files: 0 });
    expect(describeLegacyCacheMigration(again)).toBeNull();
    expect(countModelFiles(target).files).toBe(3);
  });

  it("an existing but empty target (e.g. created by doctor's write probe) does not block the move", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    mkdirSync(join(target, "leftover-empty-dir"), { recursive: true });
    const r = migrateLegacyModelCache(legacy, target);
    expect(r.outcome).toBe("moved");
    expect(existsSync(join(target, "Xenova", "bge-reranker-base", "tokenizer.json"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it("never touches a populated target (another process, or an earlier download, won)", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    mkdirSync(join(target, "Xenova", "other"), { recursive: true });
    writeFileSync(join(target, "Xenova", "other", "config.json"), "{}");
    const r = migrateLegacyModelCache(legacy, target);
    expect(r).toMatchObject({ outcome: "skipped", reason: "target already populated" });
    expect(countModelFiles(legacy).files).toBe(3);
    expect(countModelFiles(target).files).toBe(1);
  });

  it("only adopts a node_modules cache, and never into node_modules", () => {
    const target = join(root, "data", "models");
    // source outside node_modules: a user's own directory is never moved
    const userDir = join(root, "user-cache");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "model.onnx"), "w");
    expect(migrateLegacyModelCache(userDir, target)).toMatchObject({ outcome: "skipped", reason: "source is not a node_modules cache" });
    expect(existsSync(join(userDir, "model.onnx"))).toBe(true);
    // target inside node_modules: pointless, npm wipes it
    const legacy = legacyCache();
    const other = join(root, "pkg", "node_modules", "elsewhere");
    expect(migrateLegacyModelCache(legacy, other)).toMatchObject({ outcome: "skipped", reason: "target is inside node_modules" });
    // same dir
    expect(migrateLegacyModelCache(legacy, `${legacy}${sep}`)).toMatchObject({ outcome: "skipped" });
    expect(countModelFiles(legacy).files).toBe(3);
  });

  it("an empty legacy dir is nothing to move", () => {
    const legacy = libraryModelCacheDir(join(root, "pkg"));
    mkdirSync(legacy, { recursive: true });
    expect(migrateLegacyModelCache(legacy, join(root, "data", "models"))).toMatchObject({ outcome: "skipped", reason: "no legacy cache" });
    expect(existsSync(join(root, "data", "models"))).toBe(false);
  });

  it("describes a failure so the caller can log it once", () => {
    const line = describeLegacyCacheMigration({ outcome: "failed", from: "/a", to: "/b", files: 0, reason: "EACCES" });
    expect(line).toBe("could not move the legacy model cache /a -> /b: EACCES; models will be re-downloaded");
  });
});

describe("applyModelCacheDir (first call adopts the legacy cache, once per process)", () => {
  it("moves the library-default cache into the resolved dir, logs one line, and points env at it", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    const env = { cacheDir: `${legacy}${sep}` };
    const log: string[] = [];
    expect(applyModelCacheDir(env, target, { log: (l) => log.push(l) })).toBe(target);
    expect(env.cacheDir).toBe(target);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^moved the model cache from .* \(3 files; npm no longer wipes it\)$/);
    expect(existsSync(join(target, "Xenova", "bge-reranker-base", "tokenizer.json"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);

    // later loaders (reranker, NLI) in the same process: no second migration, even with a fresh legacy cache
    legacyCache();
    const env2 = { cacheDir: `${legacy}${sep}` };
    expect(applyModelCacheDir(env2, target, { log: (l) => log.push(l) })).toBe(target);
    expect(log).toHaveLength(1);
    expect(countModelFiles(legacy).files).toBe(3);

    // a new process (fresh guard, env back at the library default) checks again
    resetLegacyMigrationForTests();
    rmSync(target, { recursive: true, force: true });
    const env3 = { cacheDir: `${legacy}${sep}` };
    applyModelCacheDir(env3, target, { log: (l) => log.push(l) });
    expect(log).toHaveLength(2);
    expect(existsSync(legacy)).toBe(false);
    expect(env3.cacheDir).toBe(target);
  });

  it("stays silent when there is nothing legacy to adopt", () => {
    const target = join(root, "data", "models");
    const env = { cacheDir: `${libraryModelCacheDir(join(root, "pkg"))}${sep}` };
    const log: string[] = [];
    expect(applyModelCacheDir(env, target, { log: (l) => log.push(l) })).toBe(target);
    expect(env.cacheDir).toBe(target);
    expect(log).toEqual([]);
    expect(existsSync(target)).toBe(false); // transformers.js creates it on first download
  });
});
