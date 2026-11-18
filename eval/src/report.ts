/**
 * eval/src/report.ts — report assembly (SPEC-006).
 */

import type { ConflictSuiteResult, conflictSlice } from "./suites/conflicts.js";
import type { TemporalSuiteResult } from "./suites/temporal.js";
import type { RedactionSuiteResult } from "./suites/redaction.js";

export const MATERIALLY_WEAK_THRESHOLD = 0.3;

export interface EvalRun {
  mode: "hermetic" | "live";
  storePath: string;
  conflicts: ConflictSuiteResult;
  temporal: TemporalSuiteResult;
  redaction: RedactionSuiteResult;
  slice: ReturnType<typeof conflictSlice>;
  startedAt: string;
  durationMs: number;
}

export interface EvalReport {
  generatedAt: string;
  store: { mode: "hermetic" | "live"; path: string };
  suites: {
    conflicts: { n: number; staleSurfacingRate: number; recallAtK: Array<{ k: number; value: number }> };
    temporal: { n: number; orderingCorrectRate: number };
    redaction: { n: number; leakageRate: number };
  };
  conflictVerdict: {
    staleSurfacingRate: number;
    threshold: number;
    materiallyWeak: boolean;
  };
  queryConditionedSlice: {
    plain: { n: number; staleSurfacingRate: number; recallAt3: number };
    conditioned: { n: number; staleSurfacingRate: number; recallAt3: number };
  };
  durationMs: number;
}

/** Build the JSON report object from a completed run. */
export function buildReport(run: EvalRun): EvalReport {
  return {
    generatedAt: new Date().toISOString(),
    store: { mode: run.mode, path: run.storePath },
    suites: {
      conflicts: {
        n: run.conflicts.n,
        staleSurfacingRate: run.conflicts.staleSurfacingRate,
        recallAtK: run.conflicts.recallAtK,
      },
      temporal: { n: run.temporal.n, orderingCorrectRate: run.temporal.orderingCorrectRate },
      redaction: { n: run.redaction.n, leakageRate: run.redaction.leakageRate },
    },
    conflictVerdict: {
      staleSurfacingRate: run.conflicts.staleSurfacingRate,
      threshold: MATERIALLY_WEAK_THRESHOLD,
      materiallyWeak: run.conflicts.staleSurfacingRate >= MATERIALLY_WEAK_THRESHOLD,
    },
    queryConditionedSlice: run.slice,
    durationMs: run.durationMs,
  };
}

/** Render the report as markdown (mirrors the JSON verdict). */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("# Engram recall eval report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt} · store mode: ${report.store.mode} · path: \`${report.store.path}\``);
  lines.push("");
  lines.push("## Conflict verdict");
  lines.push("");
  lines.push(
    `Conflict-axis stale-surfacing rate: **${report.conflictVerdict.staleSurfacingRate.toFixed(4)}** ` +
      `(materially-weak threshold ≥ ${report.conflictVerdict.threshold}) → materiallyWeak: ` +
      `**${report.conflictVerdict.materiallyWeak}**. This number is the evidence, not a verdict on Engram.`,
  );
  lines.push("");
  lines.push("## Suites");
  lines.push("");
  lines.push("| suite | n | metric | value |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| conflicts | ${report.suites.conflicts.n} | stale-surfacing rate | ${report.suites.conflicts.staleSurfacingRate.toFixed(4)} |`,
  );
  for (const r of report.suites.conflicts.recallAtK) {
    lines.push(`| conflicts | ${report.suites.conflicts.n} | recall@${r.k} | ${r.value.toFixed(4)} |`);
  }
  lines.push(
    `| temporal | ${report.suites.temporal.n} | ordering-correct rate | ${report.suites.temporal.orderingCorrectRate.toFixed(4)} |`,
  );
  lines.push(
    `| redaction | ${report.suites.redaction.n} | hash-leakage rate | ${report.suites.redaction.leakageRate.toFixed(4)} |`,
  );
  lines.push("");
  lines.push("## Query-conditioned vs plain-query slice");
  lines.push("");
  lines.push("| slice | n | stale-surfacing rate | recall@3 |");
  lines.push("| --- | --- | --- | --- |");
  const s = report.queryConditionedSlice;
  lines.push(
    `| plain | ${s.plain.n} | ${s.plain.staleSurfacingRate.toFixed(4)} | ${s.plain.recallAt3.toFixed(4)} |`,
  );
  lines.push(
    `| conditioned | ${s.conditioned.n} | ${s.conditioned.staleSurfacingRate.toFixed(4)} | ${s.conditioned.recallAt3.toFixed(4)} |`,
  );
  lines.push("");
  lines.push(
    `Run duration: ${report.durationMs} ms. Read-only: the store was opened with \`readonly: true\`.`,
  );
  lines.push("");
  return lines.join("\n");
}
