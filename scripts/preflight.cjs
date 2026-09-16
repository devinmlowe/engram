#!/usr/bin/env node
"use strict";
/**
 * engram install preflight — wired to the package.json `postinstall` hook.
 *
 * Prints a platform verdict right after `npm install` so an unsupported
 * target (Windows on ARM, 32-bit ARM Linux, ...) learns *now* instead of at
 * the first `engram init`. It never fails the install: every probe is caught
 * and the exit code is always 0 unless `--strict` is passed (used by tests
 * and available for CI).
 *
 * Deliberately plain CommonJS with zero imports from the package: it runs
 * before `prepare` builds dist/, and must work even when a dependency is
 * broken. `ENGRAM_SKIP_PREFLIGHT=1` silences it (Docker layers, CI).
 *
 * `engram doctor` is the full, post-build version of these checks.
 */

const MIN_NODE_MAJOR = 22;

/** Targets where better-sqlite3, sqlite-vec and onnxruntime-node all ship prebuilts. */
const PREBUILT_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

function message(err) {
  return err instanceof Error ? err.message : String(err);
}

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

/** Build the report lines. Pure apart from the native probes. Exported for tests. */
function preflight() {
  const target = `${process.platform}-${process.arch}`;
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  const lines = [`engram preflight: node ${process.version} on ${target}`];
  let failed = 0;

  if (major >= MIN_NODE_MAJOR) {
    lines.push(`  [ok]   node >= ${MIN_NODE_MAJOR}`);
  } else {
    failed++;
    lines.push(`  [FAIL] node >= ${MIN_NODE_MAJOR} is required; engram will not start on ${process.version}`);
  }

  if (PREBUILT_TARGETS.includes(target)) {
    lines.push(`  [ok]   ${target}: prebuilt native modules available`);
  } else {
    lines.push(
      `  [--]   ${target}: no prebuilt native modules. npm needs a C++ toolchain here ` +
        `(MSVC Build Tools on Windows, gcc/g++ + make + python3 elsewhere), and sqlite-vec ` +
        `ships no build for this target at all. See README "Supported platforms".`,
    );
  }

  for (const [name, probe] of [
    ["better-sqlite3", probeBetterSqlite],
    ["sqlite-vec", probeSqliteVec],
  ]) {
    try {
      probe();
      lines.push(`  [ok]   ${name} loads`);
    } catch (err) {
      failed++;
      lines.push(`  [FAIL] ${name} failed to load on ${target}: ${message(err)}`);
    }
  }

  lines.push(
    failed === 0
      ? "engram preflight: OK (run `engram doctor` after the build for the full report)"
      : `engram preflight: ${failed} check(s) FAILED — engram will not run on this machine as installed. ` +
          "See README \"Supported platforms\"; `engram doctor` prints details.",
  );
  return { lines, failed };
}

function main(argv) {
  if (process.env.ENGRAM_SKIP_PREFLIGHT === "1") return 0;
  const strict = argv.includes("--strict");
  let result;
  try {
    result = preflight();
  } catch (err) {
    // A bug in the preflight itself must never break `npm install`.
    console.log(`engram preflight: skipped (${message(err)})`);
    return 0;
  }
  console.log(result.lines.join("\n"));
  return strict && result.failed > 0 ? 1 : 0;
}

module.exports = { preflight, PREBUILT_TARGETS, MIN_NODE_MAJOR };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
