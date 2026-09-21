#!/usr/bin/env node
/**
 * Keep the distribution manifests in step with package.json (#58).
 *
 * package.json is the single source of truth for the version
 * (src/_core/version/index.ts reads it at runtime). Four other places must
 * agree, and every one of them has drifted silently before:
 *
 *   .claude-plugin/plugin.json        version + the pinned `npx -y @devinmlowe/engram@<v>` arg
 *   .claude-plugin/marketplace.json   metadata.version + plugins[engram].version
 *   server.json                       version + packages[<npm>].version
 *   package.json                      mcpName === server.json name (registry ownership check)
 *
 *   node scripts/sync-manifests.cjs           rewrite the manifests from package.json
 *   node scripts/sync-manifests.cjs --check   exit 1 and list every mismatch (CI, release)
 *
 * Manifest *shape* is not checked here: `claude plugin validate` and
 * `mcp-publisher validate` do that in the same CI and release jobs. The one
 * exception is the registry's 100-character description cap, which
 * `mcp-publisher validate` let through (v0.4.0 was rejected with 422).
 * Dependency-free CommonJS on purpose: it runs from `npm version` hooks and
 * the release workflow before `npm ci` has necessarily happened.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const FILES = {
  pkg: "package.json",
  plugin: ".claude-plugin/plugin.json",
  marketplace: ".claude-plugin/marketplace.json",
  server: "server.json",
};

const PLUGIN_NAME = "engram";
const MCP_SERVER_KEY = "engram";

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function writeJson(rel, value) {
  fs.writeFileSync(path.join(ROOT, rel), `${JSON.stringify(value, null, 2)}\n`);
}

/** The `npx` package spec arg (`@scope/name@version`) in a plugin mcpServers entry. */
function pinnedSpecIndex(args, pkgName) {
  return Array.isArray(args) ? args.findIndex((a) => typeof a === "string" && a.startsWith(`${pkgName}@`)) : -1;
}

/**
 * Compute the desired state and every difference from it. Pure: returns
 * `{ version, problems, fixed }` where `fixed` holds the corrected documents.
 */
function analyze(docs) {
  const { pkg, plugin, marketplace, server } = docs;
  const version = pkg.version;
  const pkgName = pkg.name;
  const problems = [];
  const fixed = {
    plugin: structuredClone(plugin),
    marketplace: structuredClone(marketplace),
    server: structuredClone(server),
  };
  const problem = (file, message) => problems.push(`${file}: ${message}`);

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    problem(FILES.pkg, `version "${version}" is not semver`);
  }

  // ── plugin.json ────────────────────────────────────────────────
  if (plugin.version !== version) {
    problem(FILES.plugin, `version ${JSON.stringify(plugin.version)} != package.json ${version}`);
    fixed.plugin.version = version;
  }
  const entry = plugin.mcpServers && typeof plugin.mcpServers === "object" ? plugin.mcpServers[MCP_SERVER_KEY] : undefined;
  const idx = entry ? pinnedSpecIndex(entry.args, pkgName) : -1;
  if (idx < 0) problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.args must contain "${pkgName}@<version>" (the pin this script keeps current)`);
  else if (entry.args[idx] !== `${pkgName}@${version}`) {
    problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.args pins ${entry.args[idx]}, expected ${pkgName}@${version}`);
    fixed.plugin.mcpServers[MCP_SERVER_KEY].args[idx] = `${pkgName}@${version}`;
  }

  // ── marketplace.json ───────────────────────────────────────────
  if (marketplace.metadata && marketplace.metadata.version !== undefined && marketplace.metadata.version !== version) {
    problem(FILES.marketplace, `metadata.version ${JSON.stringify(marketplace.metadata.version)} != ${version}`);
    fixed.marketplace.metadata.version = version;
  }
  const i = Array.isArray(marketplace.plugins) ? marketplace.plugins.findIndex((p) => p && p.name === PLUGIN_NAME) : -1;
  if (i < 0) problem(FILES.marketplace, `plugins[] has no entry named "${PLUGIN_NAME}"`);
  else if (marketplace.plugins[i].version !== version) {
    problem(FILES.marketplace, `plugins[${PLUGIN_NAME}].version ${JSON.stringify(marketplace.plugins[i].version)} != ${version}`);
    fixed.marketplace.plugins[i].version = version;
  }

  // ── server.json ────────────────────────────────────────────────
  if (pkg.mcpName !== server.name) problem(FILES.pkg, `mcpName ${JSON.stringify(pkg.mcpName)} must equal server.json name ${JSON.stringify(server.name)} (registry npm ownership check)`);
  // registry.modelcontextprotocol.io rejects the entry with 422 "expected length <= 100" (seen on v0.4.0).
  if (typeof server.description === "string" && server.description.length > 100) problem(FILES.server, `description is ${server.description.length} chars; the registry allows at most 100`);
  if (server.version !== version) {
    problem(FILES.server, `version ${JSON.stringify(server.version)} != ${version}`);
    fixed.server.version = version;
  }
  const packages = Array.isArray(server.packages) ? server.packages : [];
  if (!packages.some((p) => p && p.registryType === "npm")) problem(FILES.server, "packages[] has no npm entry to pin");
  packages.forEach((p, n) => {
    if (!p || p.registryType !== "npm" || p.version === version) return;
    problem(FILES.server, `packages[${n}].version ${JSON.stringify(p.version)} != ${version}`);
    fixed.server.packages[n].version = version;
  });

  return { version, problems, fixed };
}

function main(argv) {
  const check = argv.includes("--check");
  const docs = {
    pkg: readJson(FILES.pkg),
    plugin: readJson(FILES.plugin),
    marketplace: readJson(FILES.marketplace),
    server: readJson(FILES.server),
  };
  const { version, problems, fixed } = analyze(docs);

  if (check) {
    if (problems.length === 0) {
      console.log(`sync-manifests: plugin.json, marketplace.json, server.json and package.json agree on ${version}`);
      return 0;
    }
    console.error(`sync-manifests: ${problems.length} problem(s) against package.json ${version}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("run `node scripts/sync-manifests.cjs` to rewrite the versions; the rest needs a manual edit");
    return 1;
  }

  let wrote = 0;
  for (const key of ["plugin", "marketplace", "server"]) {
    const before = JSON.stringify(docs[key]);
    if (before !== JSON.stringify(fixed[key])) {
      writeJson(FILES[key], fixed[key]);
      console.log(`sync-manifests: updated ${FILES[key]} → ${version}`);
      wrote++;
    }
  }
  if (wrote === 0) console.log(`sync-manifests: manifests already at ${version}`);
  // Anything a rewrite cannot fix (mcpName, a missing pin) is still reported.
  const remaining = analyze({ ...docs, ...fixed }).problems;
  if (remaining.length > 0) {
    console.error("sync-manifests: remaining problems (not auto-fixable):");
    for (const p of remaining) console.error(`  - ${p}`);
    return 1;
  }
  return 0;
}

module.exports = { analyze, FILES, PLUGIN_NAME, MCP_SERVER_KEY, pinnedSpecIndex };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
