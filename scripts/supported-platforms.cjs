#!/usr/bin/env node
"use strict";
/**
 * Renders the README "Supported platform/arch set" table from
 * scripts/preflight.cjs (NATIVE_DEPS, NODE_ABI_MAJORS, MIN_NODE_MAJOR) so the
 * documentation can never drift from what the preflight actually checks (#63).
 * The block lives between `<!-- supported-platforms:start -->` and
 * `<!-- supported-platforms:end -->` in README.md.
 *
 *   node scripts/supported-platforms.cjs          # print the block
 *   node scripts/supported-platforms.cjs --check  # exit 1 unless README.md matches (CI, tests)
 *   node scripts/supported-platforms.cjs --write  # rewrite the block in README.md
 *
 * Only prose lives here (machine descriptions, which CI job covers a target);
 * every verdict comes from the preflight tables.
 */

const fs = require("node:fs");
const path = require("node:path");
const { NATIVE_DEPS, NODE_ABI_MAJORS, MIN_NODE_MAJOR } = require("./preflight.cjs");

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

/** The LTS (even) Node majors ≥ MIN_NODE_MAJOR the table has a column for. */
function documentedMajors() {
  return Object.values(NODE_ABI_MAJORS).filter((m) => m >= MIN_NODE_MAJOR && m % 2 === 0).sort((a, b) => a - b);
}

function abiOf(major) {
  return Number(Object.keys(NODE_ABI_MAJORS).find((abi) => NODE_ABI_MAJORS[abi] === major));
}

/** `prebuilt` | `compiles` | `—` for one dependency on one target and Node major. */
function cell(dep, target, major) {
  const onTarget = target !== null && dep.targets.includes(target);
  const abiOk = !dep.abis || dep.abis.includes(abiOf(major));
  if (onTarget && abiOk) return "prebuilt";
  return dep.compiles ? "compiles" : "—";
}

function verdictFor(target, majors) {
  const cells = NATIVE_DEPS.flatMap((dep) => majors.map((m) => cell(dep, target, m)));
  if (cells.every((c) => c === "prebuilt")) return "**supported**";
  if (cells.some((c) => c === "—")) return "**not supported**";
  return "needs a C++ toolchain";
}

function row(target, majors) {
  const label = target === null ? "any other target" : `\`${target}\``;
  const machines = target === null ? "FreeBSD, 32-bit x86, …" : MACHINES[target] || "";
  const cells = NATIVE_DEPS.map((dep) => majors.map((m) => cell(dep, target, m)));
  // A Node-independent dependency has the same cell for every major: print it once.
  const rendered = cells.map((c, i) => (NATIVE_DEPS[i].abis ? c.join(" · ") : c[0]));
  const ci = target !== null && CI[target] ? ` (${CI[target]})` : "";
  return `| ${label} | ${machines} | ${rendered.join(" | ")} | ${verdictFor(target, majors)}${ci} |`;
}

/** The markdown block (without the markers). */
function render() {
  const majors = documentedMajors();
  const targets = [...new Set(NATIVE_DEPS.flatMap((d) => d.targets))].sort();
  const header = NATIVE_DEPS.map((d) => (d.abis ? `${d.name} (Node ${majors.join(" · ")})` : d.name));
  const lines = [
    `| Target | Machines | ${header.join(" | ")} | Engram |`,
    `|---|---|${NATIVE_DEPS.map(() => "---").join("|")}|---|`,
    ...targets.map((t) => row(t, majors)),
    row(null, majors),
  ];
  const odd = Object.values(NODE_ABI_MAJORS)
    .filter((m) => m > MIN_NODE_MAJOR && m % 2 === 1)
    .sort((a, b) => a - b)
    .map((m) => `Node ${m}: ${NATIVE_DEPS.filter((d) => d.abis).map((d) => `${d.name} ${d.abis.includes(abiOf(m)) ? "prebuilt" : "compiles"}`).join(", ")}`);
  const abiDeps = NATIVE_DEPS.filter((d) => d.abis);
  lines.push("");
  lines.push(
    `Node ABIs with prebuilts: ${abiDeps.map((d) => `${d.name} node-v${d.abis.join("/")} (Node ${d.abis.map((a) => NODE_ABI_MAJORS[a]).join(", ")})`).join("; ")}. ` +
      `Odd (non-LTS) majors — ${odd.join("; ")}. ` +
      `${NATIVE_DEPS.filter((d) => !d.abis).map((d) => d.name).join(" and ")} are Node-version independent. ` +
      "Generated from `scripts/preflight.cjs` by `node scripts/supported-platforms.cjs --write`; `--check` runs in the test suite.",
  );
  return lines.join("\n");
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

module.exports = { render, check, write, readBlock, documentedMajors, START, END };

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
