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
 *   server.json                       version + packages[<npm identifier>].version
 *   package.json                      mcpName === server.json name (registry ownership check)
 *
 *   node scripts/sync-manifests.cjs           rewrite the manifests from package.json
 *   node scripts/sync-manifests.cjs --check   exit 1 and list every mismatch (CI, release)
 *
 * `--check` also asserts the shape each consumer requires (the fields Claude
 * Code's `claude plugin validate` and the MCP registry's publisher validate),
 * so CI catches a broken manifest on runners where the `claude` CLI is not
 * installed. Dependency-free CommonJS on purpose: it runs from `npm version`
 * hooks and the release workflow before `npm ci` has necessarily happened.
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
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  if (plugin.name !== PLUGIN_NAME) problem(FILES.plugin, `name must be "${PLUGIN_NAME}" (got ${JSON.stringify(plugin.name)})`);
  if (!KEBAB.test(String(plugin.name))) problem(FILES.plugin, `name "${plugin.name}" is not kebab-case`);
  if (plugin.version !== version) {
    problem(FILES.plugin, `version ${JSON.stringify(plugin.version)} != package.json ${version}`);
    fixed.plugin.version = version;
  }
  const servers = plugin.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    problem(FILES.plugin, "mcpServers must be an inline object (a path such as ../.mcp.json escapes the plugin root and only works inside the checkout)");
  } else {
    const entry = servers[MCP_SERVER_KEY];
    if (!entry) problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY} missing`);
    else {
      if (entry.command !== "npx") problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.command must be "npx" (got ${JSON.stringify(entry.command)})`);
      const idx = pinnedSpecIndex(entry.args, pkgName);
      if (idx < 0) problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.args must contain "${pkgName}@<version>"`);
      else if (entry.args[idx] !== `${pkgName}@${version}`) {
        problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.args pins ${entry.args[idx]}, expected ${pkgName}@${version}`);
        fixed.plugin.mcpServers[MCP_SERVER_KEY].args[idx] = `${pkgName}@${version}`;
      }
      if (!Array.isArray(entry.args) || entry.args[0] !== "-y") problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.args must start with "-y" (non-interactive npx)`);
      if (!Array.isArray(entry.args) || entry.args[entry.args.length - 1] !== "mcp") problem(FILES.plugin, `mcpServers.${MCP_SERVER_KEY}.args must end with the "mcp" subcommand`);
    }
  }

  // ── marketplace.json ───────────────────────────────────────────
  if (typeof marketplace.name !== "string" || !KEBAB.test(marketplace.name)) problem(FILES.marketplace, `name must be kebab-case (got ${JSON.stringify(marketplace.name)})`);
  if (!marketplace.owner || typeof marketplace.owner.name !== "string") problem(FILES.marketplace, "owner.name is required");
  if (marketplace.metadata && marketplace.metadata.version !== undefined && marketplace.metadata.version !== version) {
    problem(FILES.marketplace, `metadata.version ${JSON.stringify(marketplace.metadata.version)} != ${version}`);
    fixed.marketplace.metadata.version = version;
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) problem(FILES.marketplace, "plugins[] is required");
  else {
    const i = marketplace.plugins.findIndex((p) => p && p.name === PLUGIN_NAME);
    if (i < 0) problem(FILES.marketplace, `plugins[] has no entry named "${PLUGIN_NAME}"`);
    else {
      const p = marketplace.plugins[i];
      if (p.source !== "./" && p.source !== ".") problem(FILES.marketplace, `plugins[${PLUGIN_NAME}].source must be "./" (the plugin is this repo)`);
      if (p.version !== version) {
        problem(FILES.marketplace, `plugins[${PLUGIN_NAME}].version ${JSON.stringify(p.version)} != ${version}`);
        fixed.marketplace.plugins[i].version = version;
      }
    }
  }

  // ── server.json ────────────────────────────────────────────────
  if (typeof server.$schema !== "string" || !server.$schema.includes("modelcontextprotocol.io/schemas/")) problem(FILES.server, "$schema must point at a static.modelcontextprotocol.io server schema");
  if (typeof server.name !== "string" || !/^io\.github\.[^/]+\/[^/]+$/.test(server.name)) problem(FILES.server, `name ${JSON.stringify(server.name)} must be io.github.<user>/<server> (GitHub-authenticated namespace)`);
  if (pkg.mcpName !== server.name) problem(FILES.pkg, `mcpName ${JSON.stringify(pkg.mcpName)} must equal server.json name ${JSON.stringify(server.name)} (registry npm ownership check)`);
  if (typeof server.description !== "string" || !server.description) problem(FILES.server, "description is required");
  // registry.modelcontextprotocol.io rejects the entry with 422 "expected length <= 100" (seen on v0.4.0).
  else if (server.description.length > 100) problem(FILES.server, `description is ${server.description.length} chars; the registry allows at most 100`);
  if (server.version !== version) {
    problem(FILES.server, `version ${JSON.stringify(server.version)} != ${version}`);
    fixed.server.version = version;
  }
  if (!Array.isArray(server.packages) || server.packages.length === 0) problem(FILES.server, "packages[] is required");
  else {
    server.packages.forEach((p, i) => {
      if (p.registryType !== "npm") return;
      if (p.identifier !== pkgName) problem(FILES.server, `packages[${i}].identifier ${JSON.stringify(p.identifier)} != package.json name ${pkgName}`);
      if (p.registryBaseUrl !== undefined && p.registryBaseUrl !== "https://registry.npmjs.org") problem(FILES.server, `packages[${i}].registryBaseUrl must be https://registry.npmjs.org (the only npm registry the official registry accepts)`);
      if (!p.transport || p.transport.type !== "stdio") problem(FILES.server, `packages[${i}].transport.type must be "stdio"`);
      if (p.version !== version) {
        problem(FILES.server, `packages[${i}].version ${JSON.stringify(p.version)} != ${version}`);
        fixed.server.packages[i].version = version;
      }
    });
    if (!server.packages.some((p) => p.registryType === "npm")) problem(FILES.server, "no npm package entry");
  }

  // ── package.json files[] must carry what the plugin and registry need ─
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  for (const required of [".claude-plugin", "commands", "server.json"]) {
    if (!files.includes(required)) problem(FILES.pkg, `files[] must include "${required}" so the npm tarball carries it`);
  }

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
    console.error("run `node scripts/sync-manifests.cjs` to rewrite the versions; shape problems need a manual edit");
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
  // Anything a rewrite cannot fix (shape, mcpName) is still reported.
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
