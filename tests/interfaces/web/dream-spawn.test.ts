import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveEngramCli, dreamSpawnCommand } from "../../../src/interfaces/web/routes/dream.js";

// The web UI's "start dream" used to spawn `npx tsx <src>/cli/index.ts`, which
// fails on Windows (npx is npx.cmd, needs a shell) and on any install without
// the tsx devDependency. It must now run the CLI with the current node binary.

describe("dream route spawn command", () => {
  it("runs a built CLI directly with the current node binary, no npx/tsx/shell", () => {
    const { command, args } = dreamSpawnCommand("/pkg/dist/interfaces/cli/index.js");
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["/pkg/dist/interfaces/cli/index.js", "dream", "--verbose"]);
    expect(args.join(" ")).not.toMatch(/npx|tsx/);
  });

  it("falls back to the tsx loader only for a TypeScript entry point", () => {
    const { command, args } = dreamSpawnCommand("/pkg/src/interfaces/cli/index.ts");
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(["--import", "tsx"]);
    expect(args.at(-3)).toBe("/pkg/src/interfaces/cli/index.ts");
  });

  it("resolves an entry point that exists on disk", () => {
    expect(existsSync(resolveEngramCli())).toBe(true);
  });
});
