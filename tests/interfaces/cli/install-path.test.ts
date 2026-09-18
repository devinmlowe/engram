/**
 * Issue #65: doctor's `install path` check and the matching `update --plan`
 * warning. Two global trees (Homebrew's node and nvm's node each with a
 * `bin/engram`) must be listed with the fix; one tree that is this install
 * is `[ok]`; a checkout run by path with nothing on PATH is `[ok]` too.
 * Everything is staged in a temp dir through the injectable context.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { checkInstallPath, DOCTOR_CHECK_NAMES, formatDoctorReport } from "../../../src/interfaces/cli/doctor.js";
import { defaultInstallPathContext, findEngramBinaries, installPathReport, type InstallPathContext } from "../../../src/interfaces/cli/install-path.js";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "engram-install-path-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A global npm tree: `<prefix>/lib/node_modules/@devinmlowe/engram/dist/interfaces/cli/index.js` + `<prefix>/bin/engram` symlink. */
function globalTree(prefix: string): { bin: string; pkg: string; cli: string } {
  const pkg = join(prefix, "lib", "node_modules", "@devinmlowe", "engram");
  const cli = join(pkg, "dist", "interfaces", "cli", "index.js");
  mkdirSync(join(pkg, "dist", "interfaces", "cli"), { recursive: true });
  writeFileSync(cli, "#!/usr/bin/env node\n");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  const bin = join(prefix, "bin", "engram");
  symlinkSync(cli, bin);
  return { bin, pkg, cli };
}

function ctx(overrides: Partial<InstallPathContext>): InstallPathContext {
  return defaultInstallPathContext({ platform: "darwin", exists: existsSync, realpath: realpathSync, packageName: "@devinmlowe/engram", ...overrides });
}

describe("install path (#65)", () => {
  it("is a documented doctor check between data dir and mcp daemon, never required", () => {
    const i = DOCTOR_CHECK_NAMES.indexOf("install path");
    expect(i).toBeGreaterThan(DOCTOR_CHECK_NAMES.indexOf("data dir"));
    expect(i).toBeLessThan(DOCTOR_CHECK_NAMES.indexOf("mcp daemon"));
    expect(DOCTOR_CHECK_NAMES.at(-1)).toBe("hosts");
  });

  it("two global trees on PATH → [--] listing both, the running one first, with the uninstall / PATH fix", () => {
    const brew = globalTree(join(root, "homebrew"));
    const nvm = globalTree(join(root, "nvm", "versions", "node", "v22.0.0"));
    const c = ctx({ argv1: nvm.cli, packageRoot: nvm.pkg, path: [join(root, "nvm", "versions", "node", "v22.0.0", "bin"), join(root, "homebrew", "bin"), "/usr/bin"].join(delimiter) });
    const bins = findEngramBinaries(c);
    expect(bins.map((b) => [b.path, b.real, b.thisInstall])).toEqual([[nvm.bin, nvm.cli, true], [brew.bin, brew.cli, false]]);
    const r = installPathReport(c);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("2 engram binaries on PATH");
    expect(r.detail).toContain(`${nvm.bin} -> ${nvm.cli} (this install)`);
    expect(r.detail).toContain(`${brew.bin} -> ${brew.cli}`);
    expect(r.fix).toContain(`npm uninstall -g @devinmlowe/engram with the npm that owns ${brew.pkg}`);
    expect(r.fix).toContain("first on PATH");
    const check = checkInstallPath(c);
    expect(check).toMatchObject({ name: "install path", level: "warn", required: false });
    expect(check.detail).toContain(brew.bin);
    expect(check.detail).toContain(nvm.bin);
    const line = formatDoctorReport({ node: "v22", platform: "darwin-arm64", checks: [check], ok: true })[0];
    expect(line.startsWith("[--]   install path: ")).toBe(true);
  });

  it("the engram on PATH is a different tree than this install → [--] saying update will not upgrade what `engram` runs", () => {
    const brew = globalTree(join(root, "homebrew"));
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "dist", "interfaces", "cli"), { recursive: true });
    const running = join(checkout, "dist", "interfaces", "cli", "index.js");
    writeFileSync(running, "");
    const r = installPathReport(ctx({ argv1: running, packageRoot: checkout, path: [join(root, "homebrew", "bin")].join(delimiter) }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("`engram` on PATH is not this install");
    expect(r.detail).toContain(`${brew.bin} -> ${brew.cli}`);
    expect(r.detail).toContain(`running ${running}`);
    expect(r.detail).toContain(`\`engram update\` upgrades ${checkout}, which \`engram\` will not run`);
  });

  it("one tree that is this install → [ok]; the same tree reachable twice on PATH counts once", () => {
    const brew = globalTree(join(root, "homebrew"));
    mkdirSync(join(root, "alias"));
    symlinkSync(brew.bin, join(root, "alias", "engram"));
    const r = installPathReport(ctx({ argv1: brew.cli, packageRoot: brew.pkg, path: [join(root, "homebrew", "bin"), join(root, "alias")].join(delimiter) }));
    expect(r.binaries).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe(`${brew.bin} -> ${brew.cli} is this install (${brew.pkg})`);
    expect(checkInstallPath(ctx({ argv1: brew.cli, packageRoot: brew.pkg, path: join(root, "homebrew", "bin") })).level).toBe("ok");
  });

  it("nothing on PATH (a checkout run by path) → [ok]", () => {
    const r = installPathReport(ctx({ argv1: join(root, "x", "dist", "interfaces", "cli", "index.js"), packageRoot: join(root, "x"), path: "/usr/bin" }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no engram on PATH");
  });

  it("a wrapper script (`exec node <checkout>/dist/…/index.js`) and npm's engram.cmd shim resolve to the CLI they run", () => {
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "dist", "interfaces", "cli"), { recursive: true });
    const cli = join(checkout, "dist", "interfaces", "cli", "index.js");
    writeFileSync(cli, "");
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "engram"), `#!/bin/bash\nexec node ${cli} "$@"\n`);
    const r = installPathReport(ctx({ argv1: cli, packageRoot: checkout, path: join(root, "bin") }));
    expect(r.ok).toBe(true);
    expect(r.binaries[0]).toMatchObject({ path: join(root, "bin", "engram"), real: cli, thisInstall: true });
    // Windows: %APPDATA%\npm\engram.cmd → %~dp0\node_modules\@devinmlowe\engram\dist\interfaces\cli\index.js
    const prefix = join(root, "npm");
    const pkg = join(prefix, "node_modules", "@devinmlowe", "engram");
    mkdirSync(join(pkg, "dist", "interfaces", "cli"), { recursive: true });
    const wcli = join(pkg, "dist", "interfaces", "cli", "index.js");
    writeFileSync(wcli, "");
    writeFileSync(join(prefix, "engram.cmd"), `@ECHO off\r\n"%~dp0\\node_modules\\@devinmlowe\\engram\\dist\\interfaces\\cli\\index.js" %*\r\n`);
    const w = installPathReport(ctx({ platform: "win32", argv1: wcli, packageRoot: pkg, path: prefix }));
    expect(w.binaries[0]).toMatchObject({ path: join(prefix, "engram.cmd"), thisInstall: true });
    expect(w.ok).toBe(true);
  });

  it("a dangling symlink is not a binary; an unreadable shim or a broken realpath never throws", () => {
    mkdirSync(join(root, "bin"));
    symlinkSync(join(root, "gone"), join(root, "bin", "engram"));
    expect(installPathReport(ctx({ argv1: join(root, "x", "cli.js"), packageRoot: join(root, "x"), path: join(root, "bin") })).binaries).toEqual([]);
    rmSync(join(root, "bin", "engram"));
    writeFileSync(join(root, "bin", "engram"), "\0\0binary");
    const r = installPathReport(ctx({ argv1: join(root, "x", "cli.js"), packageRoot: join(root, "x"), path: join(root, "bin"), readHead: () => { throw new Error("EACCES"); } }));
    expect(r.ok).toBe(false);
    expect(r.binaries[0].real).toBe(join(root, "bin", "engram"));
    expect(checkInstallPath(ctx({ argv1: "", packageRoot: join(root, "elsewhere"), path: join(root, "bin"), realpath: () => { throw new Error("boom"); } })).level).toBe("warn");
  });
});
