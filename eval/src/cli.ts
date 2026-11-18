/**
 * eval/src/cli.ts — eval entry point (SPEC-006 / SPEC-007).
 *
 *   npm run eval            → hermetic run on the seeded mini-DB → eval/report.{json,md}
 *   npm run eval -- --live  → read-only smoke against the real store
 *   flags: --db <path> (override store path), --out <dir> (report dir), --live
 *
 * Exit 0 on success, nonzero on harness failure.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveStorePath,
  assertUsableStore,
  openStoreReadonly,
} from "./store.js";
import { buildMiniStore, cleanupMiniStore } from "./fixtures/mini-store.js";
import { runConflictSuite, conflictSlice } from "./suites/conflicts.js";
import { runTemporalSuite } from "./suites/temporal.js";
import { runRedactionSuite } from "./suites/redaction.js";
import { buildReport, renderMarkdown, type EvalRun } from "./report.js";

const evalRoot = resolve(join(fileURLToPath(import.meta.url), "..", ".."));

interface Args {
  db?: string;
  live: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { live: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") args.db = argv[++i];
    else if (argv[i] === "--live") args.live = true;
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: npm run eval [-- --db <path>] [--live] [--out <dir>]");
      process.exit(0);
    }
  }
  return args;
}

async function runHermetic(): Promise<EvalRun> {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "engram-eval-"));
  let dbPath: string | null = null;
  try {
    // Seed the hermetic store from the captured real conflict pair fixture
    // (redacted, cited) — the same fixture the acceptance suite uses.
    const captured = JSON.parse(
      readFileSync(join(evalRoot, "acceptance", "fixtures", "captured-conflict-pair.json"), "utf8"),
    );
    const mini = await buildMiniStore(dir, {
      conflictPairs: [
        {
          conflict: captured.conflict,
          surviving: captured.surviving,
          stale: captured.stale,
        },
      ],
      changes: [
        {
          id: "eval-chg-1",
          memoryId: captured.surviving.id,
          op: "edit",
          before: captured.stale.content,
          after: captured.surviving.content,
          at: new Date().toISOString(),
        },
      ],
      suppressions: [],
    });
    dbPath = mini.dbPath;
    const db = mini.db;
    const conflicts = await runConflictSuite(db, { k: 10 });
    const temporal = await runTemporalSuite(db);
    const redaction = await runRedactionSuite(db);
    db.close();
    return {
      mode: "hermetic",
      storePath: dbPath,
      conflicts,
      temporal,
      redaction,
      slice: conflictSlice(conflicts as never),
      startedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  } finally {
    if (dbPath) cleanupMiniStore(dbPath);
    try {
      // cleanupMiniStore removed the db files; drop the temp dir itself.
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
}

async function runLive(dbFlag?: string): Promise<EvalRun> {
  const started = Date.now();
  const path = resolveStorePath({ dbFlag });
  assertUsableStore(path);
  const db = openStoreReadonly(path);
  try {
    const conflicts = await runConflictSuite(db, { k: 10 });
    const temporal = await runTemporalSuite(db);
    const redaction = await runRedactionSuite(db);
    return {
      mode: "live",
      storePath: path,
      conflicts,
      temporal,
      redaction,
      slice: conflictSlice(conflicts as never),
      startedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  } finally {
    db.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  try {
    // Fail fast on an unusable explicit store, whatever the run mode.
    if (args.db) assertUsableStore(resolveStorePath({ dbFlag: args.db }));
    const run = args.live ? await runLive(args.db) : await runHermetic();
    const report = buildReport(run);
    const outDir = args.out ? resolve(args.out) : evalRoot;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(outDir, "report.md"), renderMarkdown(report));
    const v = report.conflictVerdict;
    console.log(
      `eval: mode=${run.mode} conflicts n=${run.conflicts.n} ` +
        `staleSurfacingRate=${v.staleSurfacingRate.toFixed(4)} ` +
        `temporal n=${run.temporal.n} redaction n=${run.redaction.n} ` +
        `→ ${outDir}/report.{json,md}`,
    );
    return 0;
  } catch (err) {
    console.error(`eval: harness failure: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Direct execution (tsx eval/src/cli.ts ...). Imported by tests → no side effects.
const isDirect =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = await main();
}
