/**
 * eval/src/comparability/adapter.ts — external-comparability fixture adapter
 * (SPEC-005). Loads and validates sample fixtures whose shape is derived from
 * the LongMemEval (arXiv:2410.10813) and MemoryAgentBench (arXiv:2507.05257)
 * public formats. Shape-derived, not official data — see
 * eval/docs/adapter-format.md for the canonical schema.
 */

import { readFileSync } from "node:fs";

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface AdapterCase {
  id: string;
  session: string[];
  operations: Array<Record<string, unknown>>;
  query: string;
  expected: string;
  axis: "knowledge-update" | "temporal-reasoning" | "delete-supersede";
}

export interface ExternalFixture {
  benchmark: "longmem-eval" | "memoryagentbench";
  /** Always flags that the fixture is shape-derived, not official data. */
  label: string;
  source: { citation: string; note?: string };
  cases: AdapterCase[];
}

const ARXIV_RE = /^arXiv:\d{4}\.\d{4,5}(v\d+)?$/;
const BENCHMARKS = new Set(["longmem-eval", "memoryagentbench"]);
const AXES = new Set(["knowledge-update", "temporal-reasoning", "delete-supersede"]);

/** Load and validate an external-comparability fixture file. */
export function loadExternalFixture(path: string): ExternalFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AdapterError(`fixture not readable JSON: ${path} (${String(err)})`);
  }
  const f = parsed as Partial<ExternalFixture>;
  if (!f || typeof f !== "object") {
    throw new AdapterError(`fixture is not an object: ${path}`);
  }
  if (typeof f.benchmark !== "string" || !BENCHMARKS.has(f.benchmark)) {
    throw new AdapterError(
      `fixture benchmark must be one of ${[...BENCHMARKS].join(" | ")}: ${path}`,
    );
  }
  if (!f.source || typeof f.source.citation !== "string" || !ARXIV_RE.test(f.source.citation)) {
    throw new AdapterError(`fixture missing a valid arXiv citation: ${path}`);
  }
  if (typeof f.label !== "string" || !/shape-derived/i.test(f.label)) {
    throw new AdapterError(
      `fixture label must declare it is shape-derived, not official data: ${path}`,
    );
  }
  if (!Array.isArray(f.cases) || f.cases.length === 0) {
    throw new AdapterError(`fixture must carry a non-empty cases array: ${path}`);
  }
  for (const c of f.cases) {
    if (!c || typeof c.id !== "string" || typeof c.query !== "string") {
      throw new AdapterError(`case missing id/query in ${path}`);
    }
    if (typeof c.axis !== "string" || !AXES.has(c.axis)) {
      throw new AdapterError(`case ${c.id} has an unknown axis in ${path}`);
    }
  }
  return f as ExternalFixture;
}
