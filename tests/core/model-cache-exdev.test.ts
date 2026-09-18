/**
 * Issue #53: the legacy-cache move across filesystems (EXDEV) and the
 * two-processes race. Both need `renameSync` to misbehave on demand, so they
 * live apart from tests/core/model-cache.test.ts and mock node:fs partially.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Fs = typeof import("node:fs");

// `import * as realFs from "node:fs"` in this file resolves to the mock too, so
// the hooks receive the genuine module to avoid re-entering themselves.
const hooks = vi.hoisted(() => ({
  rename: null as ((fs: Fs, from: string, to: string) => void) | null,
  /** Runs after the real copy, so a test can corrupt the copied tree before verification. */
  afterCopy: null as ((fs: Fs, dst: string) => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Fs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (hooks.rename) return hooks.rename(actual, from, to);
      return actual.renameSync(from, to);
    },
    cpSync: (src: string, dst: string, opts?: import("node:fs").CopySyncOptions) => {
      actual.cpSync(src, dst, opts);
      hooks.afterCopy?.(actual, dst);
    },
  };
});

const { countModelFiles, libraryModelCacheDir, migrateLegacyModelCache } = await import("../../src/_core/embeddings/model-cache.js");

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

let root: string;
beforeEach(() => {
  root = realFs.mkdtempSync(join(tmpdir(), "engram-model-cache-exdev-"));
  hooks.rename = null;
  hooks.afterCopy = null;
});
afterEach(() => {
  hooks.rename = null;
  hooks.afterCopy = null;
  realFs.rmSync(root, { recursive: true, force: true });
});

function legacyCache(): string {
  const legacy = libraryModelCacheDir(join(root, "pkg"));
  realFs.mkdirSync(join(legacy, "Xenova", "m", "onnx"), { recursive: true });
  realFs.writeFileSync(join(legacy, "Xenova", "m", "config.json"), "{}");
  realFs.writeFileSync(join(legacy, "Xenova", "m", "onnx", "model.onnx"), "0123456789");
  return legacy;
}

describe("migrateLegacyModelCache across filesystems", () => {
  it("EXDEV: copies to a temp sibling, verifies count + bytes, swaps it in, deletes the source", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    const renames: Array<[string, string]> = [];
    hooks.rename = (fs, from, to) => {
      renames.push([from, to]);
      if (from === legacy) throw errno("EXDEV"); // the direct move fails: different device
      fs.renameSync(from, to);                    // the temp-dir swap on the target device works
    };
    const r = migrateLegacyModelCache(legacy, target);
    expect(r, JSON.stringify(r)).toMatchObject({ outcome: "moved", method: "copy", files: 2 });
    expect(renames).toHaveLength(2);
    expect(renames[1]![0]).toBe(`${target}.migrating-${process.pid}`);
    expect(renames[1]![1]).toBe(target);
    expect(realFs.readFileSync(join(target, "Xenova", "m", "onnx", "model.onnx"), "utf-8")).toBe("0123456789");
    expect(realFs.existsSync(legacy)).toBe(false);
    expect(realFs.existsSync(`${target}.migrating-${process.pid}`)).toBe(false);
  });

  it("EXDEV + a verification mismatch keeps the source, removes the temp copy and reports failed", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    const tmp = `${target}.migrating-${process.pid}`;
    hooks.rename = (fs, from, to) => {
      if (from === legacy) throw errno("EXDEV");
      fs.renameSync(from, to);
    };
    // a truncated file in the copied tree: same count, fewer bytes
    hooks.afterCopy = (fs, dst) => fs.writeFileSync(join(dst, "Xenova", "m", "onnx", "model.onnx"), "short");
    const r = migrateLegacyModelCache(legacy, target);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/copy verification failed \(2\/2 files, 7\/12 bytes\)/);
    expect(countModelFiles(legacy)).toEqual({ files: 2, bytes: 12 });
    expect(realFs.existsSync(target)).toBe(false);
    expect(realFs.existsSync(tmp)).toBe(false);
  });

  it("a race on the direct rename is tolerated when the other process populated the target", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    hooks.rename = (fs, from, to) => {
      if (from === legacy) {
        // the other process wins between our emptiness check and our rename
        fs.mkdirSync(join(target, "Xenova", "m"), { recursive: true });
        fs.writeFileSync(join(target, "Xenova", "m", "config.json"), "{}");
        throw errno("ENOTEMPTY");
      }
      fs.renameSync(from, to);
    };
    const r = migrateLegacyModelCache(legacy, target);
    expect(r).toMatchObject({ outcome: "skipped", reason: "another process populated the target" });
    expect(countModelFiles(legacy).files).toBe(2);
  });

  it("a race on the temp-dir swap cleans the temp dir up and reports skipped", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    const tmp = `${target}.migrating-${process.pid}`;
    hooks.rename = (fs, from) => {
      if (from === legacy) throw errno("EXDEV");
      if (from === tmp) {
        fs.mkdirSync(join(target, "Xenova", "m"), { recursive: true });
        fs.writeFileSync(join(target, "Xenova", "m", "config.json"), "{}");
        throw errno("EEXIST");
      }
      throw new Error(`unexpected rename ${from}`);
    };
    const r = migrateLegacyModelCache(legacy, target);
    expect(r).toMatchObject({ outcome: "skipped", reason: "another process populated the target" });
    expect(realFs.existsSync(tmp)).toBe(false);
    expect(countModelFiles(legacy).files).toBe(2); // the loser keeps its source; npm ci will drop it
  });

  it("an unexpected filesystem error is reported as failed, never thrown", () => {
    const legacy = legacyCache();
    const target = join(root, "data", "models");
    hooks.rename = () => { throw errno("EACCES"); };
    const r = migrateLegacyModelCache(legacy, target);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toContain("EACCES");
    expect(countModelFiles(legacy).files).toBe(2);
  });
});
