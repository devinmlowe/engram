import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Repo root = cwd for vitest runs (vitest.config at root).
const ROOT = process.cwd();

function plistStrings(path: string): string[] {
  const xml = readFileSync(path, "utf-8");
  return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

describe("deployment path integrity (ADR-010 Phase 0)", () => {
  for (const name of ["com.engram.visualizer.plist", "com.engram.dreamstate.plist"]) {
    it(`${name}: WorkingDirectory exists and script arg resolves under it`, () => {
      const path = join(ROOT, "launchd", name);
      const xml = readFileSync(path, "utf-8");
      const wd = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      expect(wd, "WorkingDirectory present").toBeTruthy();
      expect(existsSync(wd!), `WorkingDirectory ${wd} exists`).toBe(true);
      // Last non-flag ProgramArguments entry is the entry-point script.
      const args = plistStrings(path).filter((s) => !s.startsWith("--"));
      const script = args.filter((s) => /\.(ts|js)$/.test(s)).at(-1);
      expect(script, "entry-point script present").toBeTruthy();
      const resolved = isAbsolute(script!) ? script! : join(wd!, script!);
      expect(existsSync(resolved), `script ${resolved} exists`).toBe(true);
    });
  }

  it(".mcp.json: cwd exists and server entry point resolves under it", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf-8"));
    const engram = cfg.mcpServers.engram;
    expect(existsSync(engram.cwd), `cwd ${engram.cwd} exists`).toBe(true);
    const script = engram.args.find((a: string) => /\.(js|ts)$/.test(a));
    expect(existsSync(join(engram.cwd, script)), `server script resolves`).toBe(true);
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
