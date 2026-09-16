import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Repo root = cwd for vitest runs (vitest.config at root).
const ROOT = process.cwd();

const PLISTS = ["com.engram.visualizer.plist", "com.engram.dreamstate.plist"] as const;
const INSTALLERS: Record<(typeof PLISTS)[number], string> = {
  "com.engram.visualizer.plist": "scripts/install-visualizer.sh",
  "com.engram.dreamstate.plist": "scripts/install-daemon.sh",
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
    .replaceAll("__LOG_DIR__", join(ROOT, "tmp-logs"));
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
