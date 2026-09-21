#!/usr/bin/env node
"use strict";
/**
 * Renders the README "Supported platform/arch set" table from
 * scripts/preflight.cjs (NATIVE_DEPS, MIN_NODE_MAJOR) so the documentation
 * can never drift from what the preflight actually checks (#63). The block
 * lives between `<!-- supported-platforms:start -->` and
 * `<!-- supported-platforms:end -->` in README.md.
 *
 *   node scripts/supported-platforms.cjs          # print the block
 *   node scripts/supported-platforms.cjs --check  # exit 1 unless README.md matches (CI, tests)
 *   node scripts/supported-platforms.cjs --write  # rewrite the block in README.md
 *
 * Only prose lives here (machine descriptions, which CI job covers a target);
 * every verdict comes from the preflight table.
 */

const fs = require("node:fs");
const path = require("node:path");
const { NATIVE_DEPS, MIN_NODE_MAJOR } = require("./preflight.cjs");

const README = path.join(__dirname, "..", "README.md");
const START = "<!-- supported-platforms:start -->";
const END = "<!-- supported-platforms:end -->";

/** What kind of machine each prebuild target is. */
const MACHINES = {
  "darwin-arm64": "Apple silicon Macs",
  "darwin-x64": "Intel Macs",
  "linux-x64": "x86-64 Linux (glibc: Debian, Ubuntu, Fedora, …)",
  "linux-arm64": "64-bit ARM Linux (glibc): Graviton, Raspberry Pi OS 64-bit, Apple-silicon VMs",
  "linux-arm": "32-bit ARM Linux (armv7: Raspberry Pi OS 32-bit, older SBCs)",
  "linuxmusl-x64": "x86-64 Alpine / musl (`node:*-alpine` images)",
  "linuxmusl-arm64": "64-bit ARM Alpine / musl",
  "linuxmusl-arm": "32-bit ARM Alpine / musl",
  "win32-x64": "x86-64 Windows 10/11",
  "win32-arm64": "Windows on ARM (Snapdragon, Apple-silicon VMs running Windows 11 ARM)",
};

/** Which CI job exercises a target (see .github/workflows/ci.yml). */
const CI = {
  "darwin-arm64": "CI: macos-latest",
  "linux-x64": "CI: ubuntu-latest",
  "linux-arm64": "CI: ubuntu-24.04-arm",
  "win32-x64": "CI: windows-latest, experimental",
  "win32-arm64": "CI: windows-11-arm asserts this verdict",
  "linuxmusl-x64": "CI: node:22-alpine container asserts this verdict",
};

/** `prebuilt` | `compiles` | `—` for one dependency on one target (null = the catch-all row). */
function cell(dep, target) {
  if (target !== null && dep.targets.includes(target)) return "prebuilt";
  return dep.compiles ? "compiles" : "—";
}

function verdictFor(cells) {
  if (cells.every((c) => c === "prebuilt")) return "**supported**";
  if (cells.some((c) => c === "—")) return "**not supported**";
  return "needs a C++ toolchain";
}

function row(target) {
  const label = target === null ? "any other target" : `\`${target}\``;
  const machines = target === null ? "FreeBSD, 32-bit x86, …" : MACHINES[target] || "";
  const cells = NATIVE_DEPS.map((dep) => cell(dep, target));
  const ci = target !== null && CI[target] ? ` (${CI[target]})` : "";
  return `| ${label} | ${machines} | ${cells.join(" | ")} | ${verdictFor(cells)}${ci} |`;
}

/** The markdown block (without the markers). */
function render() {
  const targets = [...new Set(NATIVE_DEPS.flatMap((d) => d.targets))].sort();
  const names = NATIVE_DEPS.map((d) => d.name);
  return [
    `| Target | Machines | ${names.join(" | ")} | Engram |`,
    `|---|---|${NATIVE_DEPS.map(() => "---").join("|")}|---|`,
    ...targets.map(row),
    row(null),
    "",
    `Every native dependency (${names.join(", ")}) is N-API / Node-version independent: the same binaries serve every Node major ≥ ${MIN_NODE_MAJOR}, odd (non-LTS) majors included. ` +
      "Generated from `scripts/preflight.cjs` by `node scripts/supported-platforms.cjs --write`; `--check` runs in the test suite.",
  ].join("\n");
}

function readBlock(rawText) {
  // A Windows checkout with core.autocrlf=true hands us CRLF; compare on LF.
  const text = rawText.replace(/\r\n/g, "\n");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start + START.length, end).replace(/^\n/, "").replace(/\n$/, "");
}

/** Null when README matches the rendered block, else a message describing the drift. */
function check(readmeText = fs.readFileSync(README, "utf8")) {
  const current = readBlock(readmeText);
  if (current === null) return `README.md has no ${START} … ${END} block`;
  const expected = render();
  if (current === expected) return null;
  return `README.md "Supported platform/arch set" table is out of date — run: node scripts/supported-platforms.cjs --write\n--- expected ---\n${expected}\n--- README ---\n${current}`;
}

function write() {
  const text = fs.readFileSync(README, "utf8");
  if (readBlock(text) === null) throw new Error(`README.md has no ${START} … ${END} block`);
  const start = text.indexOf(START) + START.length;
  const end = text.indexOf(END);
  fs.writeFileSync(README, `${text.slice(0, start)}\n${render()}\n${text.slice(end)}`);
}

module.exports = { render, check, write, readBlock, START, END };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes("--check")) {
    const problem = check();
    if (problem) {
      console.error(problem);
      process.exitCode = 1;
    } else {
      console.log("README.md supported-platforms table matches scripts/preflight.cjs");
    }
  } else if (argv.includes("--write")) {
    write();
    console.log("README.md supported-platforms table updated");
  } else {
    console.log(render());
  }
}
