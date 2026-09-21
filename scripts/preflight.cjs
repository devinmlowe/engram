#!/usr/bin/env node
"use strict";
/**
 * engram install preflight — wired to the package.json `postinstall` hook and
 * exposed as `engram preflight [--strict] [--json]` (#63).
 *
 * Prints a platform verdict right after `npm install` so an unsupported
 * target (Windows on ARM, Alpine/musl, 32-bit ARM Linux, ...) learns *now*
 * instead of at the first `engram init`. It never fails the install: every
 * probe is caught and the exit code is always 0 unless `--strict` is passed
 * (CI) — then any `[FAIL]` line exits 1. `--expect <status>` /
 * `--expect <dep>=<status>,...` additionally exits 1 when a dependency's
 * prebuild verdict differs from the one given (CI uses it to fail a
 * dependency bump that drops a prebuild for a matrix target).
 *
 * Per native dependency it decides `prebuilt | compiled | will-compile |
 * unsupported | unknown` for platform + arch + libc. Every native dependency
 * is N-API, so the Node ABI (`process.versions.modules`) is printed but never
 * decides. The NATIVE_DEPS table below says what the pinned ranges publish;
 * when the package is on disk the probe also checks that the binary for this
 * target really shipped (better-sqlite3 reports `compiled` when node-gyp
 * built it instead), otherwise the table alone answers.
 *
 * `npm_config_platform` / `npm_config_arch` / `npm_config_target_arch` /
 * `npm_config_libc` override the target like they do for npm itself.
 *
 * Deliberately plain CommonJS with zero imports from the package: it runs
 * before `prepare` builds dist/, and must work even when a dependency is
 * broken. `ENGRAM_SKIP_PREFLIGHT=1` silences the postinstall run (Docker
 * layers, CI); `engram preflight` and `engram doctor` (which reuse these
 * probes through src/interfaces/cli/preflight.ts) always run.
 */

const fs = require("node:fs");
const path = require("node:path");

const MIN_NODE_MAJOR = 22;

/** Directory holding package.json — node_modules lookups start here. */
const PACKAGE_ROOT = path.join(__dirname, "..");

/**
 * What each native dependency publishes for the range pinned in package.json.
 * Single source of truth: the README "Supported platform/arch set" table is
 * rendered from it (`node scripts/supported-platforms.cjs --check` /
 * tests/deployment/supported-platforms.test.ts), and `engram doctor` imports
 * PREBUILT_TARGETS from here.
 *
 * Target strings follow prebuild-install: `<platform>[musl]-<arch>`.
 *
 * - better-sqlite3 `^13.0.3`: N-API since 13.0.0, so the binaries are
 *   Node-version independent and ship inside the npm tarball as
 *   `prebuilds/<platform>[musl]-<arch>.node` for eight targets (13.x dropped
 *   the 32-bit `linux-arm` / `linuxmusl-arm` prebuilds that 12.x published
 *   through prebuild-install). Anything else falls back to `node-gyp
 *   rebuild`, which needs python3 + a C++ toolchain. npm 10 still runs
 *   `node-gyp rebuild` at install even on a prebuilt target (the lockfile
 *   does not carry the package's `gypfile: false`): binding.gyp then compiles
 *   nothing, but `node-gyp configure` needs python3 and the Node headers
 *   (downloaded from nodejs.org unless cached under ~/.cache/node-gyp).
 * - sqlite-vec `^0.1.7-alpha.2`: a SQLite loadable extension delivered as
 *   optional platform packages `sqlite-vec-<os>-<arch>` (os = darwin | linux |
 *   windows). Node-version independent; no source fallback; the Linux builds
 *   are glibc-only (they need ld-linux and `__memcpy_chk`, so they do not load
 *   on musl — verified on node:22-alpine).
 * - onnxruntime-node 1.14.0 (via @xenova/transformers ^2.17.2): N-API, every
 *   binary is inside the npm tarball under `bin/napi-v3/<platform>/<arch>/`.
 *   Node-version independent; no source fallback; Linux builds are glibc-only.
 */
const NATIVE_DEPS = [
  {
    name: "better-sqlite3",
    via: "N-API binaries bundled in the npm tarball under prebuilds/<platform>[musl]-<arch>.node (Node-version independent), node-gyp fallback",
    targets: [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "linuxmusl-arm64",
      "linuxmusl-x64",
      "win32-arm64",
      "win32-x64",
    ],
    compiles: true,
  },
  {
    name: "sqlite-vec",
    via: "optional platform package sqlite-vec-<os>-<arch> (SQLite extension, Node-version independent)",
    targets: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
    compiles: false,
  },
  {
    name: "onnxruntime-node",
    via: "binaries bundled in the npm tarball under bin/napi-v3/<platform>/<arch> (N-API, Node-version independent)",
    targets: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"],
    compiles: false,
  },
];

/** Targets where every native dependency ships a prebuilt (derived; used by doctor and the README). */
const PREBUILT_TARGETS = NATIVE_DEPS[0].targets.filter((t) => NATIVE_DEPS.every((d) => d.targets.includes(t)));

function message(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * glibc vs musl on Linux, dependency-free: `npm_config_libc` wins; then the
 * diagnostic report header (`glibcVersionRuntime` is only present on glibc);
 * then `/etc/alpine-release`. Empty off Linux. Detection only runs when the
 * platform is the real one — an overridden platform cannot be probed.
 */
function detectLibc(env, platform) {
  if (env.npm_config_libc) return env.npm_config_libc;
  if (platform !== "linux") return "";
  if (platform !== process.platform) return "glibc";
  try {
    const report = process.report && process.report.getReport && process.report.getReport();
    if (report && report.header) return report.header.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    /* fall through to the filesystem check */
  }
  return fs.existsSync("/etc/alpine-release") ? "musl" : "glibc";
}

/**
 * The install target: platform, arch, libc and Node ABI, honouring the
 * `npm_config_*` overrides npm sets for `--platform` / `--arch` / `--libc`.
 * `key` is the prebuild-install target string (`linuxmusl-x64`, `darwin-arm64`).
 */
function resolveTarget(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || env.npm_config_platform || process.platform;
  const arch = opts.arch || env.npm_config_target_arch || env.npm_config_arch || process.arch;
  const libc = opts.libc !== undefined ? opts.libc : detectLibc(env, platform);
  const abi = opts.abi !== undefined ? Number(opts.abi) : Number(process.versions.modules);
  const key = `${platform}${libc === "musl" ? "musl" : ""}-${arch}`;
  return { platform, arch, libc, abi, key };
}

/**
 * Where `name` is installed relative to `root`: `<dir>/node_modules/<name>`
 * walking up like Node's resolver (npm hoists dependencies above a nested or
 * npx-installed engram), plus the nested location under @xenova/transformers
 * for onnxruntime-node. Returns null when the package is not on disk.
 */
function locatePackage(name, root) {
  let dir = path.resolve(root);
  for (;;) {
    const candidates = [
      path.join(dir, "node_modules", name),
      path.join(dir, "node_modules", "@xenova", "transformers", "node_modules", name),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The C++ toolchain install command for this OS (Linux: by /etc/os-release ID / ID_LIKE). */
function toolchainFix(target) {
  switch (target.platform) {
    case "darwin":
      return "xcode-select --install";
    case "win32":
      return 'install "Visual Studio Build Tools" with the "Desktop development with C++" workload, plus Python 3 (npm install -g windows-build-tools is deprecated)';
    case "linux": {
      const family = target.libc === "musl" ? "alpine" : linuxFamily();
      if (family === "alpine") return "apk add build-base python3";
      if (family === "debian") return "sudo apt install build-essential python3";
      if (family === "fedora") return "sudo dnf install gcc-c++ make python3";
      if (family === "arch") return "sudo pacman -S base-devel python";
      return "install gcc/g++, make and python3 with your package manager (Debian/Ubuntu: sudo apt install build-essential python3; Fedora: sudo dnf install gcc-c++ make python3; Alpine: apk add build-base python3)";
    }
    default:
      return "install a C++ toolchain (gcc/g++ or clang, make) and python3";
  }
}

/** `alpine` | `debian` | `fedora` | `arch` | "" from /etc/os-release. */
function linuxFamily() {
  try {
    const text = fs.readFileSync("/etc/os-release", "utf8");
    const ids = [];
    for (const key of ["ID", "ID_LIKE"]) {
      const m = new RegExp(`^${key}=("?)(.*)\\1$`, "m").exec(text);
      if (m) ids.push(...m[2].split(/\s+/));
    }
    if (ids.includes("alpine")) return "alpine";
    if (ids.some((id) => ["debian", "ubuntu"].includes(id))) return "debian";
    if (ids.some((id) => ["fedora", "rhel", "centos"].includes(id))) return "fedora";
    if (ids.includes("arch")) return "arch";
  } catch {
    /* no os-release: generic hint */
  }
  return "";
}

/** Why a target has no build at all, and what to do instead. */
function unsupportedFix(target) {
  if (target.libc === "musl") return "use a glibc-based image (node:22-bookworm-slim, node:22-slim) — sqlite-vec and onnxruntime-node publish no musl builds";
  if (target.platform === "win32" && target.arch === "arm64") return "install the x64 Node.js build — Windows 11 runs it under emulation and the win32-x64 prebuilts load";
  if (target.platform === "linux" && target.arch === "arm") return "use a 64-bit OS image (linux-arm64)";
  return "no workaround: see README \"Supported platforms\"";
}

function verdict(spec, target, source, status, detail, extra = {}) {
  const level = { prebuilt: "ok", compiled: "warn", "will-compile": "warn", unsupported: "fail", unknown: "skip" }[status];
  const fix = [];
  if (status === "will-compile") fix.push(`fix: ${toolchainFix(target)}`);
  else if (status === "unsupported") fix.push(`fix: ${unsupportedFix(target)}`);
  return { dep: spec.name, status, label: describeStatus(status), level, source, target: target.key, abi: target.abi, detail, fix, ...extra };
}

/** Verdict from the static table alone (package not on disk, or offline). */
function staticVerdict(spec, target) {
  if (spec.targets.includes(target.key)) return verdict(spec, target, "static", "prebuilt", `${target.key} is in ${spec.name}'s platform list`);
  return spec.compiles
    ? verdict(spec, target, "static", "will-compile", `${spec.name} bundles no prebuilt for ${target.key} (it has: ${spec.targets.join(", ")})`)
    : verdict(spec, target, "static", "unsupported", `${spec.name} ships no build for ${target.key} (it has: ${spec.targets.join(", ")})`);
}

/**
 * The binary each dependency ships for a target: where it is under the package
 * dir (sqlite-vec: a sibling platform package, like its own loader resolves
 * it), how the verdict names it, and the fix when it is missing.
 */
const SHIPPED = {
  "better-sqlite3": (dir, target) => {
    const rel = path.join("prebuilds", `${target.key}.node`);
    return { file: path.join(dir, rel), name: rel, detail: `${rel} is bundled in the package`, location: dir };
  },
  "sqlite-vec": (dir, target) => {
    const os = target.platform === "win32" ? "windows" : target.platform;
    const ext = target.platform === "win32" ? "dll" : target.platform === "darwin" ? "dylib" : "so";
    const pkg = `sqlite-vec-${os}-${target.arch}`;
    const name = `${pkg}/vec0.${ext}`;
    return {
      file: path.join(path.dirname(dir), pkg, `vec0.${ext}`),
      name,
      detail: name,
      location: path.join(path.dirname(dir), pkg),
      fix: `fix: npm install ${pkg}   (or delete node_modules + package-lock.json and reinstall — a package-lock.json generated on another platform can drop the optional platform package)`,
    };
  },
  "onnxruntime-node": (dir, target) => {
    const rel = path.join("bin", "napi-v3", target.platform, target.arch, "onnxruntime_binding.node");
    return { file: path.join(dir, rel), name: rel, detail: rel, location: dir };
  },
};

/**
 * Verdict for a package on disk: the table's answer, confirmed against the
 * binary it should have shipped for this target. Off the table (or musl,
 * which the table already excludes) nothing on disk changes the answer.
 */
function installedVerdict(spec, dir, target) {
  const expected = staticVerdict(spec, target);
  if (expected.status !== "prebuilt") return { ...expected, source: "installed", location: dir };
  const shipped = SHIPPED[spec.name](dir, target);
  if (fs.existsSync(shipped.file)) return verdict(spec, target, "installed", "prebuilt", shipped.detail, { location: shipped.location });
  if (spec.name === "better-sqlite3" && fs.existsSync(path.join(dir, "build", "Release", "better_sqlite3.node"))) {
    return verdict(
      spec,
      target,
      "installed",
      "compiled",
      `build/Release/better_sqlite3.node came from node-gyp although ${spec.name} ships a prebuilt for ${target.key} (offline, proxy, npm_config_build_from_source?); every upgrade needs the toolchain until the prebuilt is used`,
      { location: dir },
    );
  }
  const v = verdict(spec, target, "installed", "unknown", `${shipped.name} is missing from ${dir}: the install failed, is still running, or skipped it`, { location: dir });
  if (shipped.fix) v.fix.push(shipped.fix);
  return v;
}

/**
 * Prebuild verdict for one native dependency. `opts.root` (default: this
 * package) is where the node_modules lookup starts; `opts.platform` / `arch`
 * / `libc` / `abi` / `env` override the target (tests, cross-target checks).
 */
function probePrebuild(dep, opts = {}) {
  const spec = NATIVE_DEPS.find((d) => d.name === dep);
  if (!spec) throw new Error(`unknown native dependency: ${dep}`);
  const target = opts.target || resolveTarget(opts);
  const dir = locatePackage(spec.name, opts.root || PACKAGE_ROOT);
  return dir ? installedVerdict(spec, dir, target) : staticVerdict(spec, target);
}

/** Human label for a verdict status; the report line reads `<dep>: <label> — <detail>`. */
function describeStatus(status) {
  return {
    prebuilt: "prebuilt",
    compiled: "compiled locally",
    "will-compile": "will compile (needs python3 + C++ toolchain)",
    unsupported: "unsupported",
    unknown: "unknown",
  }[status] || status;
}

// ─── runtime load probes ──────────────────────────────────────────────────────

function probeBetterSqlite() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.close();
}

function probeSqliteVec() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    require("sqlite-vec").load(db);
    db.prepare("SELECT vec_version()").get();
  } finally {
    db.close();
  }
}

const PREFIX = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[--]  " };

/**
 * Build the report. Pure apart from the filesystem and the native load probes.
 * Exported for tests and for `engram preflight` / `engram doctor`.
 */
function preflight(opts = {}) {
  const target = resolveTarget(opts);
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  const lines = [`engram preflight: node ${process.version} on ${target.key}`];
  let failed = 0;
  let warned = 0;

  if (major >= MIN_NODE_MAJOR) {
    lines.push(`  ${PREFIX.ok} node >= ${MIN_NODE_MAJOR}`);
  } else {
    failed++;
    lines.push(`  ${PREFIX.fail} node >= ${MIN_NODE_MAJOR} is required; engram will not start on ${process.version}`);
  }

  if (PREBUILT_TARGETS.includes(target.key)) {
    lines.push(`  ${PREFIX.ok} ${target.key}: every native module ships prebuilts for this target (node-v${target.abi}${target.libc ? `, ${target.libc}` : ""})`);
  } else {
    lines.push(`  ${PREFIX.skip} ${target.key}: not every native module ships a prebuilt for this target (node-v${target.abi}${target.libc ? `, ${target.libc}` : ""}); see the lines below and README "Supported platforms"`);
  }

  const deps = NATIVE_DEPS.map((spec) => probePrebuild(spec.name, { ...opts, target }));
  for (const d of deps) {
    if (d.level === "fail") failed++;
    if (d.level === "warn") warned++;
    lines.push(`  ${PREFIX[d.level]} ${d.dep}: ${d.label} — ${d.detail}`);
    for (const f of d.fix) lines.push(`         ${f}`);
  }

  const loads = [];
  for (const [name, probe] of [
    ["better-sqlite3", probeBetterSqlite],
    ["sqlite-vec", probeSqliteVec],
  ]) {
    try {
      probe();
      loads.push({ dep: name, ok: true });
      lines.push(`  ${PREFIX.ok} ${name} loads`);
    } catch (err) {
      failed++;
      const msg = message(err);
      loads.push({ dep: name, ok: false, error: msg });
      lines.push(`  ${PREFIX.fail} ${name} failed to load on ${target.key}: ${msg}`);
      if (/NODE_MODULE_VERSION/.test(msg)) lines.push(`         fix: npm rebuild ${name}   (the binary was built for another Node version)`);
    }
  }

  lines.push(
    failed === 0
      ? `engram preflight: OK${warned ? ` with ${warned} warning(s)` : ""} (run \`engram doctor\` after the build for the full report)`
      : `engram preflight: ${failed} check(s) FAILED — engram will not run on this machine as installed. ` +
          "See README \"Supported platforms\"; `engram doctor` prints details.",
  );
  return {
    node: process.version,
    minNodeMajor: MIN_NODE_MAJOR,
    target,
    deps,
    loads,
    failed,
    warned,
    ok: failed === 0,
    lines,
  };
}

/** The `--json` shape: everything but the rendered lines. */
function toJson(result) {
  const { lines, ...rest } = result;
  return rest;
}

/**
 * Parse `--expect <status>` (every dep) or `--expect dep=status,dep=status`.
 * Returns the mismatches as lines; empty when everything matches.
 */
function checkExpectations(result, spec) {
  const problems = [];
  const wanted = new Map();
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) for (const d of NATIVE_DEPS) wanted.set(d.name, part);
    else wanted.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const [dep, status] of wanted) {
    const probe = result.deps.find((d) => d.dep === dep);
    if (!probe) problems.push(`engram preflight: --expect names an unknown dependency "${dep}"`);
    else if (probe.status !== status) problems.push(`engram preflight: expected ${dep} to be ${status} on ${result.target.key} (node-v${result.target.abi}) but it is ${probe.status} — ${probe.detail}`);
  }
  return problems;
}

function main(argv) {
  if (process.env.ENGRAM_SKIP_PREFLIGHT === "1") return 0;
  const strict = argv.includes("--strict");
  const json = argv.includes("--json");
  const expectAt = argv.indexOf("--expect");
  const expect = expectAt === -1 ? null : argv[expectAt + 1];
  let result;
  try {
    result = preflight();
  } catch (err) {
    // A bug in the preflight itself must never break `npm install`.
    console.log(`engram preflight: skipped (${message(err)})`);
    return 0;
  }
  console.log(json ? JSON.stringify(toJson(result), null, 2) : result.lines.join("\n"));
  let code = strict && result.failed > 0 ? 1 : 0;
  if (expect) {
    const problems = checkExpectations(result, expect);
    for (const p of problems) console.error(p);
    if (problems.length > 0) code = 1;
  }
  return code;
}

module.exports = {
  preflight,
  toJson,
  probePrebuild,
  resolveTarget,
  detectLibc,
  locatePackage,
  describeStatus,
  checkExpectations,
  toolchainFix,
  NATIVE_DEPS,
  PREBUILT_TARGETS,
  MIN_NODE_MAJOR,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
