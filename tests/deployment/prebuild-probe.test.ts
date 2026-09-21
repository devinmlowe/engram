import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreflightModule, PrebuildProbe } from "../../src/interfaces/cli/preflight.js";

// Issue #63: scripts/preflight.cjs decides prebuilt | compiled | will-compile |
// unsupported | unknown per native dependency from its static target table,
// confirming against the shipped binary when the package is on disk. These
// tests build fake node_modules trees under a temp root and point the probe at
// them, so they hold on every CI target regardless of the real verdict there.

const script = fileURLToPath(new URL("../../scripts/preflight.cjs", import.meta.url));
const cjs = createRequire(import.meta.url)(script) as PreflightModule & {
  detectLibc(env: Record<string, string | undefined>, platform: string): string;
  locatePackage(name: string, root: string): string | null;
};

type BetterSqliteShape = "bundled" | "compiled" | "missing-binary";
type VecShape = "prebuilt" | "no-platform-pkg";
type OnnxShape = "prebuilt" | "other-arch";

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
    if (spec.betterSqlite === "bundled") file(join(dir, "prebuilds", `${platform}-${arch}.node`));
    if (spec.betterSqlite === "compiled") file(join(dir, "build", "Release", "better_sqlite3.node"));
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
    if (spec.onnx === "prebuilt") file(join(dir, "bin", "napi-v3", platform, arch, "onnxruntime_binding.node"));
    else file(join(dir, "bin", "napi-v3", "linux", "x64", "onnxruntime_binding.node"));
  }
  return root;
}

function probe(dep: string, root: string, opts: Record<string, unknown> = {}): PrebuildProbe {
  return cjs.probePrebuild(dep, { root, platform: "darwin", arch: "arm64", libc: "", abi: 127, ...opts });
}

describe("prebuild probe: installed packages", () => {
  it("recognises the 13.x bundled prebuilds/ layout", () => {
    const p = probe("better-sqlite3", tree("bs3-bundled", { betterSqlite: "bundled" }));
    expect(p.status).toBe("prebuilt");
    expect(p.level).toBe("ok");
    expect(p.source).toBe("installed");
    expect(p.label).toBe("prebuilt");
    expect(p.detail).toContain(join("prebuilds", "darwin-arm64.node"));
    expect(p.fix).toEqual([]);
  });

  it("reports compiled locally when node-gyp built the binary instead of the bundled prebuilt being used", () => {
    const p = probe("better-sqlite3", tree("bs3-compiled", { betterSqlite: "compiled" }));
    expect(p.status).toBe("compiled");
    expect(p.level).toBe("warn");
    expect(p.label).toBe("compiled locally");
    expect(p.detail).toMatch(/build\/Release\/better_sqlite3\.node came from node-gyp/);
    expect(p.detail).toMatch(/ships a prebuilt for darwin-arm64/);
    expect(p.fix).toEqual([]);
  });

  it("is unknown (never a false verdict) when the binary is missing", () => {
    const p = probe("better-sqlite3", tree("bs3-missing", { betterSqlite: "missing-binary" }));
    expect(p.status).toBe("unknown");
    expect(p.level).toBe("skip");
    expect(p.detail).toMatch(/darwin-arm64\.node is missing/);
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
    expect(p.detail).toMatch(/sqlite-vec-darwin-arm64\/vec0\.dylib is missing/);
    expect(p.fix).toEqual([expect.stringContaining("npm install sqlite-vec-darwin-arm64")]);
  });

  it("is unsupported for a target sqlite-vec never publishes, even with the package installed", () => {
    const root = tree("vec-winarm", { sqliteVec: "no-platform-pkg" });
    const p = probe("sqlite-vec", root, { platform: "win32", arch: "arm64" });
    expect(p.status).toBe("unsupported");
    expect(p.level).toBe("fail");
    expect(p.source).toBe("installed");
    expect(p.detail).toMatch(/ships no build for win32-arm64/);
    expect(p.fix).toEqual([expect.stringMatching(/^fix: install the x64 Node\.js build/)]);
  });

  it("finds onnxruntime-node nested under @xenova/transformers and its napi binary", () => {
    const p = probe("onnxruntime-node", tree("onnx-prebuilt", { onnx: "prebuilt" }));
    expect(p.status).toBe("prebuilt");
    expect(p.detail).toBe(join("bin", "napi-v3", "darwin", "arm64", "onnxruntime_binding.node"));
  });

  it("is unknown when a listed onnxruntime-node binary is not in the package", () => {
    const p = probe("onnxruntime-node", tree("onnx-other", { onnx: "other-arch" }));
    expect(p.status).toBe("unknown");
    expect(p.detail).toMatch(/onnxruntime_binding\.node is missing/);
  });

  it("calls glibc-only Linux builds unsupported on musl even though the files are there", () => {
    const root = tree("musl-installed", { betterSqlite: "bundled", sqliteVec: "prebuilt", onnx: "prebuilt", platform: "linux", arch: "x64" });
    const musl = { platform: "linux", arch: "x64", libc: "musl" };
    // better-sqlite3 ships linuxmusl-* prebuilds; the fake tree has none, so the verdict is honest
    expect(probe("better-sqlite3", root, musl).status).toBe("unknown");
    const vec = probe("sqlite-vec", root, musl);
    expect(vec.status).toBe("unsupported");
    expect(vec.detail).toMatch(/ships no build for linuxmusl-x64/);
    expect(vec.fix[0]).toMatch(/glibc-based image/);
    expect(probe("onnxruntime-node", root, musl).status).toBe("unsupported");
    // the same tree on glibc is fully prebuilt
    const glibc = { platform: "linux", arch: "x64", libc: "glibc" };
    expect(probe("better-sqlite3", root, glibc).status).toBe("prebuilt");
    expect(probe("sqlite-vec", root, glibc).status).toBe("prebuilt");
    expect(probe("onnxruntime-node", root, glibc).status).toBe("prebuilt");
  });

  it("walks up node_modules chains the way npm hoists", () => {
    const root = tree("hoisted", { betterSqlite: "bundled" });
    const nested = join(root, "node_modules", "@devinmlowe", "engram");
    mkdirSync(nested, { recursive: true });
    expect(cjs.locatePackage("better-sqlite3", nested)).toBe(join(root, "node_modules", "better-sqlite3"));
    expect(cjs.locatePackage("sqlite-vec", nested)).toBeNull();
  });

  it("rejects a dependency that is not in the table", () => {
    expect(() => cjs.probePrebuild("nope", { root: scratch })).toThrow(/unknown native dependency: nope/);
  });
});

describe("prebuild probe: static table (package absent)", () => {
  let absent: string;
  beforeAll(() => {
    absent = join(scratch, "absent");
    mkdirSync(absent, { recursive: true });
  });

  it("answers prebuilt from the table for a covered target", () => {
    for (const dep of ["better-sqlite3", "sqlite-vec", "onnxruntime-node"]) {
      const p = probe(dep, absent);
      expect(p.source).toBe("static");
      expect(p.status).toBe("prebuilt");
      expect(p.level).toBe("ok");
      expect(p.fix).toEqual([]);
    }
  });

  it("13.x: N-API — the Node ABI never changes a verdict, armv7 compiles from source", () => {
    for (const abi of [127, 131, 137, 147]) {
      const p = probe("better-sqlite3", absent, { platform: "linux", arch: "x64", libc: "glibc", abi });
      expect(p.status).toBe("prebuilt");
      expect(p.abi).toBe(abi);
      expect(p.fix).toEqual([]);
    }
    const arm = probe("better-sqlite3", absent, { platform: "linux", arch: "arm", libc: "glibc" });
    expect(arm.status).toBe("will-compile");
    expect(arm.level).toBe("warn");
    expect(arm.label).toBe("will compile (needs python3 + C++ toolchain)");
    expect(arm.detail).toMatch(/bundles no prebuilt for linux-arm/);
    expect(arm.fix).toEqual([expect.stringMatching(/^fix: .*python3/)]);
  });

  it("names the OS toolchain command", () => {
    expect(probe("better-sqlite3", absent, { arch: "ppc64" }).fix[0]).toBe("fix: xcode-select --install");
    const win = probe("better-sqlite3", absent, { platform: "win32", arch: "ia32" });
    expect(win.fix[0]).toMatch(/Visual Studio Build Tools.*Desktop development with C\+\+/);
    expect(win.fix[0]).toMatch(/windows-build-tools is deprecated/);
    const musl = probe("better-sqlite3", absent, { platform: "linux", arch: "arm", libc: "musl" });
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
    expect(onnx.fix[0]).toMatch(/glibc-based image/);
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

  it("reports the running ABI", () => {
    expect(cjs.resolveTarget({ env: {} }).abi).toBe(Number(process.versions.modules));
    expect(cjs.resolveTarget({ env: {}, abi: 999 }).abi).toBe(999);
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
