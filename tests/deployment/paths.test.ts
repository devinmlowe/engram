import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Repo root = cwd for vitest runs (vitest.config at root).
const ROOT = process.cwd();

const PLISTS = ["com.engram.visualizer.plist", "com.engram.dreamstate.plist", "com.engram.mcp.plist"] as const;
const INSTALLERS: Record<(typeof PLISTS)[number], string> = {
  "com.engram.visualizer.plist": "scripts/install-visualizer.sh",
  "com.engram.dreamstate.plist": "scripts/install-daemon.sh",
  "com.engram.mcp.plist": "scripts/install-mcp-daemon.sh",
};
const PLACEHOLDER = /__[A-Z_]+__/g;

function plistStrings(xml: string): string[] {
  return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

/** Mirror what the install scripts do with sed, using this machine's real values. */
function render(xml: string): string {
  return xml
    .replaceAll("__ENGRAM_DIR__", ROOT)
    .replaceAll("__NODE_BIN__", process.execPath)
    .replaceAll("__LOG_DIR__", join(ROOT, "tmp-logs"))
    .replaceAll("__DATA_DIR__", join(ROOT, "tmp-data"));
}

describe("deployment path integrity (ADR-010 Phase 0)", () => {
  for (const name of PLISTS) {
    const xml = readFileSync(join(ROOT, "launchd", name), "utf-8");

    it(`${name}: template carries no personal or installer-specific paths`, () => {
      // The template must not bake in one developer's home, clone location, or node manager.
      expect(xml).not.toMatch(/\/Users\/[A-Za-z]/);
      expect(xml, "no node-manager-specific binary path").not.toMatch(/\/fnm\//);
      const wd = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      expect(wd, "WorkingDirectory is the checkout placeholder").toBe("__ENGRAM_DIR__");
      const node = plistStrings(xml).find((s) => s.includes("NODE_BIN"));
      expect(node, "node binary is a placeholder, not a hardcoded path").toBe("__NODE_BIN__");
    });

    it(`${name}: entry-point script resolves inside this checkout once rendered`, () => {
      const rendered = render(xml);
      expect(rendered.match(PLACEHOLDER), "every placeholder is substituted").toBeNull();
      const wd = rendered.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/)![1];
      expect(wd).toBe(ROOT);
      const args = plistStrings(rendered).filter((s) => !s.startsWith("--"));
      // The entry point is either a node script or a shell launcher (run-dream.sh --daemon).
      const script = args.filter((s) => /\.(ts|js|sh)$/.test(s)).at(-1);
      expect(script, "entry-point script present").toBeTruthy();
      const resolved = isAbsolute(script!) ? script! : join(wd, script!);
      // dist/ may not be built in CI; the source counterpart must exist.
      const srcCounterpart = resolved.replace(`${ROOT}/dist/`, `${ROOT}/src/`).replace(/\.js$/, ".ts");
      expect(existsSync(resolved) || existsSync(srcCounterpart), `script ${resolved} exists (or its src/ source)`).toBe(true);
    });

    it(`${name}: its install script substitutes every placeholder the template uses`, () => {
      const script = readFileSync(join(ROOT, INSTALLERS[name]), "utf-8");
      const used = new Set(xml.match(PLACEHOLDER) ?? []);
      expect(used.size, "template uses at least one placeholder").toBeGreaterThan(0);
      for (const ph of used) {
        expect(script, `${INSTALLERS[name]} substitutes ${ph}`).toContain(`s|${ph}|`);
      }
    });
  }

  it("no launchd template carries API keys (issue #10)", () => {
    for (const name of PLISTS) {
      const xml = readFileSync(join(ROOT, "launchd", name), "utf-8");
      expect(xml, `${name} must not embed *_API_KEY`).not.toMatch(/API_KEY/);
    }
  });

  it("dreamstate runs the launcher, and the launcher sources the XDG env file before exec'ing node", () => {
    const xml = readFileSync(join(ROOT, "launchd", "com.engram.dreamstate.plist"), "utf-8");
    const args = plistStrings(xml);
    expect(args).toContain("__ENGRAM_DIR__/scripts/run-dream.sh");
    expect(args).toContain("--daemon");
    const launcher = readFileSync(join(ROOT, "scripts/run-dream.sh"), "utf-8");
    expect(launcher, "sources ${XDG_CONFIG_HOME:-$HOME/.config}/engram/env").toMatch(
      /\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/engram\/env/,
    );
    expect(launcher, "daemon mode execs the resolved node binary").toMatch(/exec "\$NODE_BIN"/);
  });

  it("install-daemon.sh never edits the rendered plist to inject secrets", () => {
    const script = readFileSync(join(ROOT, "scripts/install-daemon.sh"), "utf-8");
    expect(script).not.toMatch(/PlistBuddy/);
    expect(script).not.toMatch(/EnvironmentVariables:(ANTHROPIC|OPENROUTER)/);
    expect(script, "creates the env file with mode 600").toMatch(/chmod 600 "\$ENV_FILE"/);
  });

  // The root .mcp.json is for developing inside the checkout. Since #58 the Claude
  // Code plugin no longer references it (plugin.json runs the npm binary via npx);
  // that manifest is pinned by tests/deployment/manifests.test.ts.
  it(".mcp.json: server entry point resolves relative to the repo (no absolute cwd)", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf-8"));
    const engram = cfg.mcpServers.engram;
    // A committed absolute cwd would pin the config to one machine; it must be absent or relative.
    if (engram.cwd !== undefined) expect(isAbsolute(engram.cwd), "cwd must not be absolute").toBe(false);
    const base = engram.cwd ? join(ROOT, engram.cwd) : ROOT;
    const script = engram.args.find((a: string) => /\.(js|ts)$/.test(a));
    expect(script, "server script arg present").toBeTruthy();
    const srcCounterpart = join(base, script).replace(`${ROOT}/dist/`, `${ROOT}/src/`).replace(/\.js$/, ".ts");
    expect(existsSync(join(base, script)) || existsSync(srcCounterpart), `server script resolves`).toBe(true);
  });

  it("dream route spawns in a cwd derived from the repo, not a hardcoded home path", () => {
    const src = readFileSync(join(ROOT, "src/interfaces/web/routes/dream.ts"), "utf-8");
    expect(src.includes('"Documents"'), "no stale ~/Documents path").toBe(false);
  });

  it("dream route resolves an existing CLI entry point to spawn", async () => {
    const { resolveEngramCli } = await import("../../src/interfaces/web/routes/dream.js");
    const cli = resolveEngramCli();
    expect(existsSync(cli), `CLI entry ${cli} exists`).toBe(true);
  });
});

describe("Windows visualizer supervision scripts (issue #3)", () => {
  const installer = join(ROOT, "scripts", "install-visualizer.ps1");
  const runner = join(ROOT, "scripts", "run-visualizer.ps1");

  it("both PowerShell scripts ship and the installer invokes the runner it expects", () => {
    expect(existsSync(installer)).toBe(true);
    expect(existsSync(runner)).toBe(true);
    const src = readFileSync(installer, "utf-8");
    expect(src).toContain("run-visualizer.ps1");
    expect(src).toContain("/api/health"); // liveness contract shared with the launchd path
  });

  it("scripts resolve paths from their own location and env, never a personal layout", () => {
    for (const p of [installer, runner]) {
      const src = readFileSync(p, "utf-8");
      expect(src, `${p} derives RepoRoot from the script location`).toContain("$MyInvocation.MyCommand.Path");
      expect(src).not.toMatch(/C:\\Users\\[A-Za-z]/);
      expect(src).not.toMatch(/\/Users\/[A-Za-z]/);
      expect(src, "honors ENGRAM_DATA_DIR like the CLI").toContain("ENGRAM_DATA_DIR");
    }
    const runnerSrc = readFileSync(runner, "utf-8");
    expect(runnerSrc, "binds loopback unless told otherwise").toMatch(/\$Bind = '127\.0\.0\.1'/);
  });

  it("README documents the Windows path", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(readme).toContain("install-visualizer.ps1");
  });
});

describe("systemd nightly dream units (issue #6)", () => {
  const SERVICE = "engram-dream.service";
  const TIMER = "engram-dream.timer";
  const INSTALLER = "scripts/install-daemon.sh";
  const service = readFileSync(join(ROOT, "systemd", SERVICE), "utf-8");
  const timer = readFileSync(join(ROOT, "systemd", TIMER), "utf-8");
  const installer = readFileSync(join(ROOT, INSTALLER), "utf-8");

  const directive = (unit: string, key: string) => unit.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

  it(`${SERVICE}: template carries no personal or installer-specific paths`, () => {
    // Same contract as the plists: no developer home, clone location, or node manager.
    expect(service).not.toMatch(/\/Users\/[A-Za-z]/);
    expect(service).not.toMatch(/\/home\/[A-Za-z]/);
    expect(service, "no node-manager-specific binary path").not.toMatch(/\/fnm\//);
    expect(directive(service, "WorkingDirectory"), "WorkingDirectory is the checkout placeholder").toBe("__ENGRAM_DIR__");
    const execStart = directive(service, "ExecStart")!.split(/\s+/);
    expect(execStart[0], "node binary is a placeholder, not a hardcoded path").toBe("__NODE_BIN__");
    expect(directive(service, "StandardOutput"), "stdout log lives under the log placeholder").toContain("__LOG_DIR__");
    expect(directive(service, "StandardError"), "stderr log lives under the log placeholder").toContain("__LOG_DIR__");
  });

  it(`${SERVICE}: entry-point script resolves inside this checkout once rendered`, () => {
    const rendered = render(service);
    expect(rendered.match(PLACEHOLDER), "every placeholder is substituted").toBeNull();
    const wd = directive(rendered, "WorkingDirectory")!;
    expect(wd).toBe(ROOT);
    const execStart = directive(rendered, "ExecStart")!.split(/\s+/);
    expect(execStart[0]).toBe(process.execPath);
    expect(execStart.at(-1), "runs the dream subcommand").toBe("dream");
    const script = execStart.filter((s) => !s.startsWith("--")).find((s) => /\.(ts|js)$/.test(s));
    expect(script, "entry-point script present").toBeTruthy();
    const resolved = isAbsolute(script!) ? script! : join(wd, script!);
    const srcCounterpart = resolved.replace(`${ROOT}/dist/`, `${ROOT}/src/`).replace(/\.js$/, ".ts");
    expect(existsSync(resolved) || existsSync(srcCounterpart), `script ${resolved} exists (or its src/ source)`).toBe(true);
  });

  it(`${SERVICE}: its install script substitutes every placeholder the template uses`, () => {
    const used = new Set(service.match(PLACEHOLDER) ?? []);
    expect(used.size, "template uses at least one placeholder").toBeGreaterThan(0);
    for (const ph of used) {
      expect(installer, `${INSTALLER} substitutes ${ph}`).toContain(`s|${ph}|`);
    }
  });

  it(`${TIMER}: daily 02:00 with catch-up, no placeholders, bound to the service`, () => {
    expect(timer.match(PLACEHOLDER), "timer needs no rendering").toBeNull();
    expect(directive(timer, "OnCalendar")).toMatch(/02:00/);
    expect(directive(timer, "Persistent")).toBe("true");
    expect(directive(timer, "Unit")).toBe(SERVICE);
    expect(directive(timer, "WantedBy")).toBe("timers.target");
  });

  it(`${INSTALLER}: Linux branch enables the timer as a user unit and keeps the launchd path`, () => {
    expect(installer, "OS detection").toContain("uname -s");
    expect(installer).toContain("systemctl --user daemon-reload");
    expect(installer).toContain(`systemctl --user enable --now "$TIMER_NAME"`);
    expect(installer).toContain(`TIMER_NAME="${TIMER}"`);
    expect(installer, "run-now starts the service directly").toContain(`systemctl --user start "$SERVICE_NAME"`);
    expect(installer, "renders into the XDG user unit dir").toContain("${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user");
    expect(installer, "macOS launchd path still present").toContain("launchctl load");
    expect(installer, "macOS kickstart still present").toContain("launchctl kickstart");
    expect(installer).not.toMatch(/\/Users\/[A-Za-z]/);
    expect(installer).not.toMatch(/\/home\/[A-Za-z]/);
  });
});

describe("Windows nightly dream Task Scheduler script (issue #6)", () => {
  const installer = join(ROOT, "scripts", "install-daemon.ps1");

  it("ships and registers a daily task running the compiled CLI with the resolved node", () => {
    expect(existsSync(installer)).toBe(true);
    const src = readFileSync(installer, "utf-8");
    expect(src).toContain("Register-ScheduledTask");
    expect(src, "daily trigger").toMatch(/New-ScheduledTaskTrigger\s+-Daily/);
    expect(src, "02:00 default").toMatch(/\$At = '02:00'/);
    expect(src, "compiled CLI entry point").toContain("dist\\interfaces\\cli\\index.js");
    expect(src, "runs the dream subcommand").toMatch(/'dream'/);
    expect(src, "resolves node from PATH unless overridden").toContain("Get-Command node.exe");
    for (const verb of ["install", "uninstall", "status", "run-now"]) {
      expect(src, `verb ${verb}`).toContain(`'${verb}'`);
    }
  });

  it("resolves paths from its own location and env, never a personal layout", () => {
    const src = readFileSync(installer, "utf-8");
    expect(src, "derives RepoRoot from the script location").toContain("$MyInvocation.MyCommand.Path");
    expect(src).not.toMatch(/C:\\Users\\[A-Za-z]/);
    expect(src).not.toMatch(/\/Users\/[A-Za-z]/);
    expect(src, "no node-manager-specific binary path").not.toMatch(/\\fnm\\|\/fnm\//);
    expect(src, "honors ENGRAM_DATA_DIR like the CLI").toContain("ENGRAM_DATA_DIR");
    expect(src, "honors ENGRAM_LOGS_DIR like the CLI").toContain("ENGRAM_LOGS_DIR");
  });

  it("README platform matrix names the Linux timer and the Windows installer", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    const row = readme.split("\n").find((l) => l.startsWith("| Nightly dream daemon"));
    expect(row, "platform matrix row present").toBeTruthy();
    expect(row).toContain("install-daemon.sh");
    expect(row).toContain("engram-dream.timer");
    expect(row).toContain("install-daemon.ps1");
  });
});

describe("Windows MCP daemon supervision scripts (issue #12)", () => {
  const installer = join(ROOT, "scripts", "install-mcp-daemon.ps1");
  const runner = join(ROOT, "scripts", "run-mcp-daemon.ps1");

  it("both PowerShell scripts ship and the installer invokes the runner it expects", () => {
    expect(existsSync(installer)).toBe(true);
    expect(existsSync(runner)).toBe(true);
    const src = readFileSync(installer, "utf-8");
    expect(src).toContain("run-mcp-daemon.ps1");
    expect(src).toContain("/health"); // liveness contract shared with the other installers
  });

  it("registers a per-user MCP task at logon with all six control verbs", () => {
    const src = readFileSync(installer, "utf-8");
    expect(src, "MCP task name default").toContain("$TaskName = 'MCP'");
    expect(src, "logon trigger").toContain("-AtLogOn");
    expect(src, "registers the scheduled task").toContain("Register-ScheduledTask");
    for (const verb of ["install", "uninstall", "start", "stop", "restart", "status"]) {
      expect(src, `verb ${verb}`).toContain(`'${verb}'`);
    }
  });

  it("stays on loopback: no bind parameter, no 0.0.0.0, 127.0.0.1 in both scripts", () => {
    const installerSrc = readFileSync(installer, "utf-8");
    const runnerSrc = readFileSync(runner, "utf-8");
    expect(installerSrc).toContain("127.0.0.1");
    expect(runnerSrc).toContain("127.0.0.1");
    expect(installerSrc).not.toContain("0.0.0.0");
    expect(runnerSrc).not.toContain("0.0.0.0");
    expect(installerSrc, "MCP has no configurable bind address").not.toMatch(/\$Bind\b/);
  });

  it("runner launches the compiled MCP server over HTTP with bounded restart-on-failure", () => {
    const src = readFileSync(runner, "utf-8");
    expect(src, "compiled MCP entry point").toContain("dist\\interfaces\\mcp\\server.js");
    expect(src).toContain("'--http'");
    expect(src).toContain("'--port'");
    expect(src, "bounded restart window").toContain("MaxRestarts");
    expect(src, "bounded restart window").toContain("RestartWindowSeconds");
  });

  it("installer reaps orphaned MCP processes via taskkill and a CIM process sweep", () => {
    const src = readFileSync(installer, "utf-8");
    expect(src).toContain("taskkill.exe");
    expect(src, "tree kill").toContain("/T /F");
    expect(src, "leftover-process sweep").toContain("Win32_Process");
  });

  it("resolves paths from their own location and env, never a personal layout or embedded credentials", () => {
    for (const p of [installer, runner]) {
      const src = readFileSync(p, "utf-8");
      expect(src, `${p} derives RepoRoot from the script location`).toContain("$MyInvocation.MyCommand.Path");
      expect(src, "honors ENGRAM_DATA_DIR like the CLI").toContain("ENGRAM_DATA_DIR");
      expect(src).not.toMatch(/C:\\Users\\[A-Za-z]/);
      expect(src).not.toMatch(/\/Users\/[A-Za-z]/);
      expect(src, "no credential names in the task surface").not.toMatch(/API_KEY/);
    }
  });

  it("README documents the Windows MCP daemon path and platform matrix row", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(readme).toContain("install-mcp-daemon.ps1");
    const row = readme.split("\n").find((l) => l.startsWith("| MCP HTTP daemon keep-alive"));
    expect(row, "platform matrix row present").toBeTruthy();
    expect(row).toContain("install-mcp-daemon.ps1");
  });
});

describe("MCP HTTP daemon supervision on macOS/Linux (issue #28)", () => {
  const SERVICE = "engram-mcp.service";
  const INSTALLER = "scripts/install-mcp-daemon.sh";
  const LAUNCHER = "scripts/run-mcp-daemon.sh";
  const plist = readFileSync(join(ROOT, "launchd", "com.engram.mcp.plist"), "utf-8");
  const service = readFileSync(join(ROOT, "systemd", SERVICE), "utf-8");
  const installer = readFileSync(join(ROOT, INSTALLER), "utf-8");
  const launcher = readFileSync(join(ROOT, LAUNCHER), "utf-8");
  const directive = (unit: string, key: string) => unit.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

  it("plist and unit both run the launcher, which sources the XDG env file and execs node in HTTP mode", () => {
    expect(plistStrings(plist)).toContain("__ENGRAM_DIR__/scripts/run-mcp-daemon.sh");
    expect(directive(service, "ExecStart")).toBe("/bin/bash __ENGRAM_DIR__/scripts/run-mcp-daemon.sh");
    expect(launcher).toMatch(/\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/engram\/env/);
    expect(launcher).toMatch(/exec "\$NODE_BIN" dist\/interfaces\/mcp\/server\.js --http --port "\$\{ENGRAM_MCP_PORT:-9907\}"/);
    expect(existsSync(join(ROOT, "src/interfaces/mcp/server.ts"))).toBe(true);
  });

  it("both templates carry the installer's data dir so the daemon and CLI share one database (#13)", () => {
    expect(plist).toMatch(/<key>ENGRAM_DATA_DIR<\/key>\s*<string>__DATA_DIR__<\/string>/);
    expect(service).toMatch(/^Environment=ENGRAM_DATA_DIR=__DATA_DIR__$/m);
    expect(directive(service, "EnvironmentFile"), "env file overrides the rendered value").toBe("-%E/engram/env");
  });

  it(`${SERVICE}: template carries no personal paths and every placeholder is substituted by the installer`, () => {
    expect(service).not.toMatch(/\/Users\/[A-Za-z]/);
    expect(service).not.toMatch(/\/home\/[A-Za-z]/);
    expect(service).not.toMatch(/\/fnm\//);
    expect(directive(service, "WorkingDirectory")).toBe("__ENGRAM_DIR__");
    expect(directive(service, "Restart")).toBe("always");
    expect(directive(service, "WantedBy")).toBe("default.target");
    for (const tpl of [plist, service]) {
      const used = new Set(tpl.match(PLACEHOLDER) ?? []);
      expect(used.size).toBeGreaterThan(0);
      for (const ph of used) expect(installer, `${INSTALLER} substitutes ${ph}`).toContain(`s|${ph}|`);
      expect(render(tpl).match(PLACEHOLDER)).toBeNull();
    }
    expect(plist, "no API keys in the plist (#10)").not.toMatch(/API_KEY/);
    expect(service).not.toMatch(/API_KEY=/);
  });

  it(`${INSTALLER}: six verbs mirroring the Windows installer, launchd on macOS, systemd user unit on Linux, /health contract`, () => {
    for (const verb of ["install", "uninstall", "start", "stop", "restart", "status"]) {
      expect(installer, `verb ${verb}`).toMatch(new RegExp(`^\\s+${verb}\\)`, "m"));
    }
    expect(installer).toContain('LABEL="com.engram.mcp"');
    expect(installer).toContain('SERVICE_NAME="engram-mcp.service"');
    expect(installer).toContain("systemctl --user enable --now");
    expect(installer).toContain("/health");
    expect(installer, "resolves the data dir like the CLI").toContain("${ENGRAM_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/engram}");
    expect(installer, "retires the hand-written 0.1.x agent on the same port").toContain("ai.hermes.engram-mcp");
    expect(installer).not.toMatch(/\/Users\/[A-Za-z]/);
    expect(installer, "creates the env file with mode 600").toMatch(/chmod 600 "\$ENV_FILE"/);
  });

  it("install-daemon.sh only requires launchctl on macOS (its Linux branch was unreachable before)", () => {
    const dream = readFileSync(join(ROOT, "scripts/install-daemon.sh"), "utf-8");
    expect(dream).toMatch(/if \[ "\$\(uname -s\)" != "Linux" \]; then\s*\n\s*need launchctl/);
  });

  it("README documents the macOS/Linux MCP daemon installer", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(readme).toContain("install-mcp-daemon.sh install");
    expect(readme).toContain("install-mcp-daemon.sh restart");
  });
});
