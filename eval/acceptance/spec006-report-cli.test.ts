import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-006"];

const repoRoot = join(import.meta.dirname, "..", "..");
const reportJson = join(repoRoot, "eval", "report.json");
const reportMd = join(repoRoot, "eval", "report.md");

function runEval(args: string[] = []): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("npm", ["run", "eval", "--", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
  }
}

describe("SPEC-006 report + CLI entry points", () => {
  it("package.json wires the eval entry points", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.eval).toMatch(/eval/);
    expect(typeof pkg.scripts.eval).toBe("string");
  });

  it("npm run eval produces eval/report.json + eval/report.md and exits 0", () => {
    rmSync(reportJson, { force: true });
    rmSync(reportMd, { force: true });
    const run = runEval();
    expect(run.status, `npm run eval exit code; stdout: ${run.stdout.slice(0, 500)}`).toBe(0);
    expect(existsSync(reportJson), "eval/report.json must exist").toBe(true);
    expect(existsSync(reportMd), "eval/report.md must exist").toBe(true);
    const report = JSON.parse(readFileSync(reportJson, "utf8"));
    // per-suite metrics
    for (const suite of ["conflicts", "temporal", "redaction"]) {
      expect(report.suites[suite], `suites.${suite}`).toBeTruthy();
      expect(report.suites[suite].n).toBeTypeOf("number");
    }
    // numeric answer to "is recall materially weak on the conflict axis"
    expect(report.conflictVerdict).toBeTruthy();
    expect(report.conflictVerdict.staleSurfacingRate).toBeTypeOf("number");
    expect(report.conflictVerdict.materiallyWeak).toBeTypeOf("boolean");
    expect(report.conflictVerdict.threshold).toBe(0.3);
    // query-conditioned vs plain-query comparison slice
    expect(report.queryConditionedSlice).toBeTruthy();
    expect(report.queryConditionedSlice.plain).toBeTruthy();
    expect(report.queryConditionedSlice.conditioned).toBeTruthy();
    // markdown mirrors the same verdict
    const md = readFileSync(reportMd, "utf8");
    expect(md).toMatch(/conflict/i);
    expect(md).toMatch(/stale/i);
  }, 300_000);

  it("exits nonzero on harness failure (bad --db)", () => {
    const run = runEval(["--db", "/nonexistent/definitely-missing.db"]);
    expect(run.status).not.toBe(0);
  });
});
