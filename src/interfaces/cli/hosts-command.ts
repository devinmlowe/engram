/**
 * Commander wiring for `engram mcp install|uninstall|status` (#50). The logic
 * lives in `hosts.ts` (pure apart from the injected probe/exec) so tests
 * drive it without a shell; this file only parses flags and prints.
 */
import type { Command } from "commander";
import {
  HOST_IDS, defaultHostContext, formatInstallResults, formatStatus, hostPresent, parseHostId, runMcpInstall, runMcpStatus, runMcpUninstall,
  type HostId, type Transport,
} from "./hosts.js";

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

export function registerMcpHostCommands(mcp: Command): void {
  mcp
    .command("install [host]")
    .description(
      `Register this install with an MCP host (${HOST_IDS.join(", ")}): HTTP daemon when /health answers, else stdio; the token is referenced by env var, never written. --all = every host whose config dir exists`,
    )
    .option("--all", "Every host present on this machine")
    .option("--project", "Project scope: .mcp.json / .codex/config.toml / .cursor/mcp.json in the current directory")
    .option("--transport <kind>", "Force http or stdio instead of probing the daemon")
    .option("--dry-run", "Print the target path and unified diff; write nothing")
    .option("--force", "Write the Claude user-scope entry even when the engram plugin is installed")
    .option("--inline-token", "Write the literal ENGRAM_MCP_TOKEN into the config (mode 600) instead of referencing the variable")
    .option("--json", "Print the results as JSON")
    .action(async (host: string | undefined, opts: { all?: boolean; project?: boolean; transport?: string; dryRun?: boolean; force?: boolean; inlineToken?: boolean; json?: boolean }) => {
      try {
        const ctx = defaultHostContext();
        let hosts: HostId[];
        if (opts.all) {
          hosts = HOST_IDS.filter((id) => hostPresent(id, ctx));
          if (host) hosts = [...new Set([parseHostId(host), ...hosts])];
          if (hosts.length === 0) throw new Error("--all found no host config directory (~/.claude, ~/.codex, ~/.cursor, ~/.hermes)");
        } else {
          if (!host) throw new Error(`missing <host>: one of ${HOST_IDS.join(", ")}, or --all`);
          hosts = [parseHostId(host)];
        }
        if (opts.transport !== undefined && opts.transport !== "http" && opts.transport !== "stdio") throw new Error(`--transport must be http or stdio, got "${opts.transport}"`);
        if (opts.project && hosts.includes("hermes") && !opts.all) throw new Error("hermes has no project scope");
        const scope = opts.project ? "project" : "user";
        const results = await runMcpInstall(
          { hosts: hosts.filter((h) => !(opts.project && h === "hermes")), scope, transport: opts.transport as Transport | undefined, dryRun: opts.dryRun, force: opts.force, inlineToken: opts.inlineToken },
          { ctx },
        );
        if (opts.json) console.log(JSON.stringify(results, null, 2));
        else for (const l of formatInstallResults(results)) console.log(l);
        if (results.some((r) => r.action === "error")) process.exit(1);
      } catch (err) {
        fail(err);
      }
    });

  mcp
    .command("uninstall <host>")
    .description("Remove the engram entry from a host's config (the previous content stays in <file>.bak); hermes removes the deployed plugin")
    .option("--project", "Project scope (see install --project)")
    .option("--dry-run", "Print what would change; write nothing")
    .option("--json", "Print the result as JSON")
    .action(async (host: string, opts: { project?: boolean; dryRun?: boolean; json?: boolean }) => {
      try {
        const id = parseHostId(host);
        if (opts.project && id === "hermes") throw new Error("hermes has no project scope");
        const result = await runMcpUninstall(id, opts.project ? "project" : "user", { ctx: defaultHostContext() }, Boolean(opts.dryRun));
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else for (const l of formatInstallResults([result])) console.log(l);
      } catch (err) {
        fail(err);
      }
    });

  mcp
    .command("status")
    .description("For every host: registered?, points at this install?, does its daemon answer /health?, does ENGRAM_MCP_TOKEN resolve here?")
    .option("--json", "Print the report as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const ctx = defaultHostContext();
        const report = await runMcpStatus({ ctx });
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else for (const l of formatStatus(report, ctx)) console.log(l);
      } catch (err) {
        fail(err);
      }
    });
}
