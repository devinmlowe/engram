import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreflightModule, PrebuildProbe } from "../../src/interfaces/cli/preflight.js";

// Issue #63: scripts/preflight.cjs decides prebuilt | compiled | will-compile |
// unsupported | unknown per native dependency, inspecting node_modules when the
// package is on disk and falling back to the static table otherwise. These
// tests build fake node_modules trees under a temp root and point the probe at
// them, so they hold on every CI target regardless of the real verdict there.

const script = fileURLToPath(new URL("../../scripts/preflight.cjs", import.meta.url));
const cjs = createRequire(import.meta.url)(script) as PreflightModule & {
  detectLibc(env: Record<string, string | undefined>, platform: string): string;
  locatePackage(name: string, root: string): string | null;
  nearestPrebuiltMajor(current: number): number | null;
  GYP_ARTEFACTS: string[];
  NODE_ABI_MAJORS: Record<string, number>;
};

type BetterSqliteShape = "prebuilt" | "compiled" | "missing-binary" | "bundled";
type VecShape = "prebuilt" | "no-platform-pkg";
type OnnxShape = "prebuilt" | "other-arch" | "no-bin" | "bin-is-a-file";

interface TreeSpec {
  betterSqlite?: BetterSqliteShape;
  sqliteVec?: VecShape;
  onnx?: OnnxShape;
  /** Which target the fake binaries are for (default: darwin-arm64). */
  platform?: string;
  arch?: string;
}

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "engram-prebuild-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function file(p: string, content = "x"): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

/** A project root with a fake node_modules for the requested shapes. */
function tree(name: string, spec: TreeSpec): string {
  const root = join(scratch, name);
  const nm = join(root, "node_modules");
  const platform = spec.platform ?? "darwin";
  const arch = spec.arch ?? "arm64";
  mkdirSync(nm, { recursive: true });

  if (spec.betterSqlite) {
    const dir = join(nm, "better-sqlite3");
    file(join(dir, "package.json"), '{"name":"better-sqlite3"}');
    if (spec.betterSqlite === "bundled") {
      file(join(dir, "prebuilds", `${platform}-${arch}.node`));
    } else if (spec.betterSqlite !== "missing-binary") {
      file(join(dir, "build", "Release", "better_sqlite3.node"));
    }
    if (spec.betterSqlite === "compiled") {
      file(join(dir, "build", "config.gypi"));
      file(join(dir, "build", "Makefile"));
      mkdirSync(join(dir, "build", "Release", "obj.target"), { recursive: true });
    }
  }

  if (spec.sqliteVec) {
    file(join(nm, "sqlite-vec", "package.json"), '{"name":"sqlite-vec"}');
    if (spec.sqliteVec === "prebuilt") {
      const os = platform === "win32" ? "windows" : platform;
      const ext = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
      file(join(nm, `sqlite-vec-${os}-${arch}`, `vec0.${ext}`));
    }
  }

  if (spec.onnx) {
    // Nested under @xenova/transformers like a non-hoisted install.
    const dir = join(nm, "@xenova", "transformers", "node_modules", "onnxruntime-node");
    file(join(dir, "package.json"), '{"name":"onnxruntime-node"}');
    if (spec.onnx === "prebuilt") {
      file(join(dir, "bin", "napi-v3", platform, arch, "onnxruntime_binding.node"));
    } else if (spec.onnx === "other-arch") {
      file(join(dir, "bin", "napi-v3", "linux", "x64", "onnxruntime_binding.node"));
    } else if (spec.onnx === "bin-is-a-file") {
      file(join(dir, "bin"));
    }
  }
  return root;
}

function probe(dep: string, root: string, opts: Record<string, unknown> = {}): PrebuildProbe {
  return cjs.probePrebuild(dep, { root, platform: "darwin", arch: "arm64", libc: "", abi: 127, ...opts });
}

describe("prebuild probe: installed packages", () => {
  it("reports prebuilt when better-sqlite3 has only the prebuild-install binary", () => {
    const p = probe("better-sqlite3", tree("bs3-prebuilt", { betterSqlite: "prebuilt" }));
    expect(p.status).toBe("prebuilt");
    expect(p.level).toBe("ok");
    expect(p.source).toBe("installed");
    expect(p.label).toBe("prebuilt");
    expect(p.detail).toContain("build/Release/better_sqlite3.node");
    expect(p.detail).toContain("node-v127-darwin-arm64");
    expect(p.fix).toEqual([]);
  });

  it("reports compiled locally when node-gyp artefacts sit next to the binary", () => {
    const p = probe("better-sqlite3", tree("bs3-compiled", { betterSqlite: "compiled" }));
    expect(p.status).toBe("compiled");
    expect(p.level).toBe("warn");
    expect(p.label).toBe("compiled locally");
    expect(p.detail).toMatch(/config\.gypi/);
    expect(p.detail).toMatch(/obj\.target/);
    // prebuilt exists for this ABI/target: a local build means the download failed
    expect(p.detail).toMatch(/prebuild-install did not use it/);
    expect(p.fix).toEqual([]);
  });

  it("suggests the nearest LTS with prebuilds when a local build was forced by the Node major", () => {
    const p = probe("better-sqlite3", tree("bs3-compiled-abi", { betterSqlite: "compiled" }), { abi: 131 });
    expect(p.status).toBe("compiled");
    expect(p.detail).toMatch(/no prebuilt for node-v131-darwin-arm64/);
    expect(p.fix).toEqual([expect.stringMatching(/^fix: nvm use 24/)]);
  });

  it("recognises the 13.x bundled prebuilds/ layout", () => {
    const p = probe("better-sqlite3", tree("bs3-bundled", { betterSqlite: "bundled" }));
    expect(p.status).toBe("prebuilt");
    expect(p.detail).toContain("prebuilds/darwin-arm64.node");
  });

  it("is unknown (never a false verdict) when the binary is missing", () => {
    const p = probe("better-sqlite3", tree("bs3-missing", { betterSqlite: "missing-binary" }));
    expect(p.status).toBe("unknown");
    expect(p.level).toBe("skip");
    expect(p.detail).toMatch(/better_sqlite3\.node is missing/);
  });

  it("finds sqlite-vec's platform package next to it", () => {
    const p = probe("sqlite-vec", tree("vec-prebuilt", { sqliteVec: "prebuilt" }));
    expect(p.status).toBe("prebuilt");
    expect(p.detail).toBe("sqlite-vec-darwin-arm64/vec0.dylib");
    expect(p.location).toMatch(/sqlite-vec-darwin-arm64$/);
  });

  it("maps win32 to the `windows` platform package and .dll", () => {
    const root = tree("vec-win", { sqliteVec: "prebuilt", platform: "win32", arch: "x64" });
    const p = probe("sqlite-vec", root, { platform: "win32", arch: "x64" });
    expect(p.status).toBe("prebuilt");
    expect(p.detail).toBe("sqlite-vec-windows-x64/vec0.dll");
  });

  it("is unknown with a reinstall hint when a published platform package was skipped", () => {
    const p = probe("sqlite-vec", tree("vec-skipped", { sqliteVec: "no-platform-pkg" }));
    expect(p.status).toBe("unknown");
    expect(p.detail).toMatch(/sqlite-vec-darwin-arm64 is not installed/);
    expect(p.fix).toEqual([expect.stringContaining("npm install sqlite-vec-darwin-arm64")]);
  });

  it("is unsupported for a target sqlite-vec never publishes, even with the package installed", () => {
    const root = tree("vec-winarm", { sqliteVec: "no-platform-pkg" });
    const p = probe("sqlite-vec", root, { platform: "win32", arch: "arm64" });
    expect(p.status).toBe("unsupported");
    expect(p.level).toBe("fail");
    expect(p.detail).toMatch(/no sqlite-vec-windows-arm64 package/);
    expect(p.fix).toEqual([expect.stringMatching(/^fix: install the x64 Node\.js build/)]);
  });

  it("finds onnxruntime-node nested under @xenova/transformers and its napi binary", () => {
    const p = probe("onnxruntime-node", tree("onnx-prebuilt", { onnx: "prebuilt" }));
    expect(p.status).toBe("prebuilt");
    expect(p.detail).toBe(join("bin", "napi-v3", "darwin", "arm64", "onnxruntime_binding.node"));
  });

  it("is unsupported when onnxruntime-node bundles no binary for the target, listing what it has", () => {
    const p = probe("onnxruntime-node", tree("onnx-other", { onnx: "other-arch" }));
    expect(p.status).toBe("unsupported");
    expect(p.detail).toMatch(/bundled: linux\/x64/);
  });

  it("is unknown when the package layout is unrecognisable", () => {
    const p = probe("onnxruntime-node", tree("onnx-nobin", { onnx: "no-bin" }));
    expect(p.status).toBe("unknown");
    expect(p.detail).toMatch(/no bin\/ directory/);
  });

  it("turns a throwing probe into unknown (<reason>) instead of propagating", () => {
    const p = probe("onnxruntime-node", tree("onnx-throws", { onnx: "bin-is-a-file" }));
    expect(p.status).toBe("unknown");
    expect(p.level).toBe("skip");
    expect(p.detail).toMatch(/^probe threw: /);
    expect(p.fix).toEqual([]);
  });

  it("calls glibc-only Linux builds unsupported on musl even though the files are there", () => {
    const root = tree("musl-installed", { betterSqlite: "prebuilt", sqliteVec: "prebuilt", onnx: "prebuilt", platform: "linux", arch: "x64" });
    const musl = { platform: "linux", arch: "x64", libc: "musl" };
    expect(probe("better-sqlite3", root, musl).status).toBe("prebuilt");
    const vec = probe("sqlite-vec", root, musl);
    expect(vec.status).toBe("unsupported");
    expect(vec.detail).toMatch(/does not load on musl/);
    expect(vec.fix[0]).toMatch(/glibc-based image/);
    expect(probe("onnxruntime-node", root, musl).status).toBe("unsupported");
    // the same tree on glibc is fully prebuilt
    const glibc = { platform: "linux", arch: "x64", libc: "glibc" };
    expect(probe("sqlite-vec", root, glibc).status).toBe("prebuilt");
    expect(probe("onnxruntime-node", root, glibc).status).toBe("prebuilt");
  });

  it("walks up node_modules chains the way npm hoists", () => {
    const root = tree("hoisted", { betterSqlite: "prebuilt" });
    const nested = join(root, "node_modules", "@devinmlowe", "engram");
    mkdirSync(nested, { recursive: true });
    expect(cjs.locatePackage("better-sqlite3", nested)).toBe(join(root, "node_modules", "better-sqlite3"));
    expect(cjs.locatePackage("sqlite-vec", nested)).toBeNull();
  });
});

describe("prebuild probe: static table (package absent)", () => {
  let absent: string;
  beforeAll(() => {
    absent = join(scratch, "absent");
    mkdirSync(absent, { recursive: true });
  });

  it("answers prebuilt from the table for a covered target and ABI", () => {
    for (const dep of ["better-sqlite3", "sqlite-vec", "onnxruntime-node"]) {
      const p = probe(dep, absent);
      expect(p.source).toBe("static");
      expect(p.status).toBe("prebuilt");
      expect(p.level).toBe("ok");
    }
  });

  it("predicts a source build with the toolchain fix and an LTS alternative for an uncovered Node major", () => {
    const p = probe("better-sqlite3", absent, { platform: "linux", arch: "x64", libc: "glibc", abi: 131 });
    expect(p.status).toBe("will-compile");
    expect(p.level).toBe("warn");
    expect(p.label).toBe("will compile (needs python3 + C++ toolchain)");
    expect(p.detail).toMatch(/no prebuilt for Node 23 \(node-v131\)/);
    expect(p.detail).toMatch(/cover Node 22, 24, 25, 26/);
    expect(p.fix[0]).toMatch(/^fix: /);
    expect(p.fix[0]).toMatch(/python3/);
    expect(p.fix[1]).toMatch(/^or: {2}nvm use 24/);
  });

  it("names the OS toolchain command", () => {
    expect(probe("better-sqlite3", absent, { abi: 131 }).fix[0]).toBe("fix: xcode-select --install");
    const win = probe("better-sqlite3", absent, { platform: "win32", arch: "x64", abi: 131 });
    expect(win.fix[0]).toMatch(/Visual Studio Build Tools.*Desktop development with C\+\+/);
    expect(win.fix[0]).toMatch(/windows-build-tools is deprecated/);
    const musl = probe("better-sqlite3", absent, { platform: "linux", arch: "x64", libc: "musl", abi: 131 });
    expect(musl.fix[0]).toBe("fix: apk add build-base python3");
  });

  it("is unsupported (not will-compile) for deps without a source fallback", () => {
    const vec = probe("sqlite-vec", absent, { platform: "linux", arch: "arm", libc: "glibc" });
    expect(vec.status).toBe("unsupported");
    expect(vec.level).toBe("fail");
    expect(vec.detail).toMatch(/ships no build for linux-arm/);
    expect(vec.fix[0]).toMatch(/64-bit OS image/);
    const onnx = probe("onnxruntime-node", absent, { platform: "linux", arch: "x64", libc: "musl" });
    expect(onnx.status).toBe("unsupported");
    expect(onnx.detail).toMatch(/linuxmusl-x64/);
  });

  it("will-compile for an unlisted platform where better-sqlite3 can still be built", () => {
    const p = probe("better-sqlite3", absent, { platform: "freebsd", arch: "x64" });
    expect(p.status).toBe("will-compile");
    expect(p.detail).toMatch(/no prebuilt for freebsd-x64/);
  });
});

describe("target resolution", () => {
  it("honours npm_config_platform / npm_config_arch / npm_config_target_arch / npm_config_libc", () => {
    const base = { npm_config_platform: "win32", npm_config_arch: "x64" };
    expect(cjs.resolveTarget({ env: base }).key).toBe("win32-x64");
    expect(cjs.resolveTarget({ env: { ...base, npm_config_target_arch: "arm64" } }).key).toBe("win32-arm64");
    expect(cjs.resolveTarget({ env: { npm_config_platform: "linux", npm_config_arch: "x64", npm_config_libc: "musl" } }).key).toBe("linuxmusl-x64");
    expect(cjs.resolveTarget({ env: {} }).key).toBe(`${process.platform}${cjs.detectLibc({}, process.platform) === "musl" ? "musl" : ""}-${process.arch}`);
  });

  it("reports the running ABI and its Node major", () => {
    const t = cjs.resolveTarget({ env: {} });
    expect(t.abi).toBe(Number(process.versions.modules));
    expect(t.nodeMajor).toBe(Number(process.versions.node.split(".")[0]));
    expect(cjs.resolveTarget({ env: {}, abi: 999 }).nodeMajor).toBeNull();
  });

  it("detects libc only on Linux and lets npm_config_libc win", () => {
    expect(cjs.detectLibc({}, "darwin")).toBe("");
    expect(cjs.detectLibc({}, "win32")).toBe("");
    expect(cjs.detectLibc({ npm_config_libc: "musl" }, "linux")).toBe("musl");
    expect(cjs.detectLibc({ npm_config_libc: "glibc" }, "linux")).toBe("glibc");
    const real = cjs.detectLibc({}, "linux");
    expect(["glibc", "musl"]).toContain(real);
    if (process.platform !== "linux") expect(real).toBe("glibc"); // cannot probe another OS's libc
  });

  it("probe env overrides apply to the installed inspection too", () => {
    const root = tree("env-override", { sqliteVec: "prebuilt", platform: "linux", arch: "x64" });
    const p = cjs.probePrebuild("sqlite-vec", { root, env: { npm_config_platform: "linux", npm_config_arch: "x64", npm_config_libc: "glibc" } });
    expect(p.status).toBe("prebuilt");
    expect(p.target).toBe("linux-x64");
  });
});

describe("derived tables", () => {
  it("PREBUILT_TARGETS is the intersection of every dependency's targets", () => {
    for (const t of cjs.PREBUILT_TARGETS) for (const d of cjs.NATIVE_DEPS) expect(d.targets).toContain(t);
    expect(cjs.PREBUILT_TARGETS).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  });

  it("PREBUILT_NODE_MAJORS covers Node 22 and 24 (the CI matrix) and picks the nearest LTS", () => {
    expect(cjs.PREBUILT_NODE_MAJORS).toContain(22);
    expect(cjs.PREBUILT_NODE_MAJORS).toContain(24);
    expect(Math.min(...cjs.PREBUILT_NODE_MAJORS)).toBeGreaterThanOrEqual(cjs.MIN_NODE_MAJOR);
    expect(cjs.nearestPrebuiltMajor(23)).toBe(24);
    expect(cjs.nearestPrebuiltMajor(20)).toBe(22);
    expect(cjs.nearestPrebuiltMajor(99)).toBe(Math.max(...cjs.PREBUILT_NODE_MAJORS.filter((m) => m % 2 === 0)));
  });

  it("every ABI in the table maps to a Node major", () => {
    for (const d of cjs.NATIVE_DEPS) for (const abi of d.abis ?? []) expect(cjs.NODE_ABI_MAJORS[abi]).toBeGreaterThanOrEqual(cjs.MIN_NODE_MAJOR);
  });
});

describe("--expect", () => {
  it("accepts one status for every dep or dep=status pairs and reports mismatches", () => {
    // A fixed, fully-prebuilt target so the assertion holds on every CI runner.
    const result = cjs.preflight({ root: join(scratch, "absent"), platform: "darwin", arch: "arm64", libc: "", abi: 127 });
    expect(cjs.checkExpectations(result, "prebuilt")).toEqual([]);
    expect(cjs.checkExpectations(result, "better-sqlite3=prebuilt, sqlite-vec=prebuilt")).toEqual([]);
    const problems = cjs.checkExpectations(result, "sqlite-vec=unsupported,nope=prebuilt");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/expected sqlite-vec to be unsupported .* but it is prebuilt/);
    expect(problems[1]).toMatch(/unknown dependency "nope"/);
  });
});
