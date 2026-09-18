import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Issue #63: the README "Supported platform/arch set" table is generated from
// scripts/preflight.cjs (NATIVE_DEPS), the single source of truth the
// preflight and `engram doctor` consult. This pins the two together; when it
// fails, run `node scripts/supported-platforms.cjs --write`.

const generator = fileURLToPath(new URL("../../scripts/supported-platforms.cjs", import.meta.url));
const readme = fileURLToPath(new URL("../../README.md", import.meta.url));
const gen = createRequire(import.meta.url)(generator) as {
  render(): string;
  check(readmeText?: string): string | null;
  readBlock(text: string): string | null;
  documentedMajors(): number[];
  START: string;
  END: string;
};

describe("README supported-platforms table", () => {
  it("matches the table rendered from scripts/preflight.cjs", () => {
    expect(gen.check(readFileSync(readme, "utf8"))).toBeNull();
  });

  it("has one row per prebuild target plus the catch-all, and a column per documented Node major", () => {
    const table = gen.render();
    const majors = gen.documentedMajors();
    expect(majors).toContain(22);
    expect(majors).toContain(24);
    expect(table).toContain(`better-sqlite3 (Node ${majors.join(" · ")})`);
    for (const target of ["darwin-arm64", "linux-x64", "linuxmusl-x64", "win32-arm64", "linux-arm"]) {
      expect(table).toMatch(new RegExp(`^\\| \`${target}\` \\|`, "m"));
    }
    expect(table).toMatch(/^\| any other target \|.*\*\*not supported\*\*/m);
    expect(table).toMatch(/^\| `linuxmusl-x64` \|.*\*\*not supported\*\*/m);
    expect(table).toMatch(/^\| `darwin-arm64` \|.*\*\*supported\*\*/m);
  });

  it("reports drift instead of passing silently", () => {
    const stale = `${gen.START}\n| old |\n${gen.END}`;
    expect(gen.check(stale)).toMatch(/out of date/);
    expect(gen.check("no markers here")).toMatch(/has no/);
    expect(gen.readBlock(`x ${gen.START}\nbody\n${gen.END} y`)).toBe("body");
  });
});
