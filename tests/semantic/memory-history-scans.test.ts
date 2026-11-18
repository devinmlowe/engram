/**
 * memory_history — negative scans, trust-boundary doc checks, traceability.
 * Acceptance suite SPEC-009 and SPEC-011 (docs/memory-history.md).
 *
 * RED against main @ abf0c28: SPEC-009 fails on its subject guard (schema.ts
 * does not mention memory_history yet) and SPEC-011 fails on the schema doc
 * comment requirement; the verbatim-clause checks guard against regression
 * once the doc (shipped with this suite) drifts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Recursive walk; collects files with one of `exts`, skipping VCS/build dirs. */
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".claude") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => f.slice(repoRoot.length + 1);
const srcFiles = walk(join(repoRoot, "src"), [".ts"]);

// ─── SPEC-009: negative scans ────────────────────────────────────

describe("SPEC-009 negative scans — no app writes to the trail, no archivist.db write path", () => {
  it("has a subject: the migration exists in src/ (guards a vacuous pass on main)", () => {
    expect(srcFiles.length).toBeGreaterThan(50); // src tree actually collected
    const schema = readFileSync(join(repoRoot, "src/_core/db/schema.ts"), "utf-8");
    expect(schema).toMatch(/memory_history/);
  });

  it("no application code UPDATEs memory_history rows", () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const src = readFileSync(f, "utf-8");
      if (/\bUPDATE\s+(?:main\.)?memory_history\b/i.test(src)) offenders.push(`${rel(f)}: UPDATE memory_history`);
    }
    expect(offenders).toEqual([]);
  });

  it("no application code DELETEs from memory_history", () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const src = readFileSync(f, "utf-8");
      if (/\bDELETE\s+FROM\s+(?:main\.)?memory_history\b/i.test(src)) offenders.push(`${rel(f)}: DELETE FROM memory_history`);
    }
    expect(offenders).toEqual([]);
  });

  it("no Engram tooling references archivist.db (custody boundary: archivist-profile custody only)", () => {
    const offenders = srcFiles
      .filter((f) => /archivist\.db/.test(readFileSync(f, "utf-8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

// ─── SPEC-011: trust-boundary clause verbatim; no unqualified "immutable" ──

const docPath = join(repoRoot, "docs", "memory-history.md");

describe("SPEC-011 trust boundary stated explicitly; never an unqualified 'immutable'", () => {
  it("docs/memory-history.md carries the lead-researcher clause VERBATIM", () => {
    const doc = readFileSync(docPath, "utf-8");
    expect(doc).toContain(
      "Trust boundary: the append-only triggers on `memory_history` are enforced against application code paths only; any actor with direct write access to `engram.db` can drop the triggers or edit rows. The trail's evidentiary guarantee therefore rests on the combination of (a) triggers — no in-band edit path; (b) content hashes on before/after values — tampering is detectable, not prevented; (c) custody export to `archivist.db` — a durable copy exists outside the engine's write reach. The spec must state this boundary explicitly and must not describe the table as immutable without qualification.",
    );
  });

  it("docs/memory-history.md carries archivist's five spec lines VERBATIM", () => {
    const doc = readFileSync(docPath, "utf-8");
    const lines = [
      "**Append-only, enforced.** No update/delete paths on history rows — the table's integrity *is* the audit trail's integrity. If a history row can be edited, the trail is testimony, not evidence.",
      "**Before/after hashes, not just text.** Storing a content hash alongside the text lets a future verifier prove a replay corpus row is unmodified — the same principle as my PDF MD5 earlier in this thread. Cheap now, load-bearing later.",
      "**Actor + mechanism fields distinct.** `actor` (which agent) and `mechanism` (edit/forget/purge/restore) as separate columns, so the harness can slice the temporal suite by correction type instead of re-parsing prose.",
      "**A retention decision for the history table itself.** The un-chosen-retention trap applies to the audit trail too — `memory_history` grows unboundedly and nobody notices until it's a problem. One line in the spec: history rows are retained indefinitely (they're tiny), *or* Devin names a horizon. Indefinite is my recommendation; an audit trail that expires is an audit trail with amnesia.",
      "**A custody export hook.** Periodic export of `memory_history` into `archivist.db` (or a JSON append) makes the audit trail part of household record custody — which concretely delivers the engine-decoupling I argued for last round: the trail survives any future backend swap, including a hypothetical Dolt one, because the durable copy lives outside the engine.",
    ];
    for (const line of lines) expect(doc).toContain(line);
  });

  it("docs/memory-history.md carries archivist's custody-boundary note (verbatim intent)", () => {
    const doc = readFileSync(docPath, "utf-8");
    expect(doc).toContain(
      "the `archivist.db` copy lives under archivist-profile custody exclusively — Engram tooling, dream jobs, and future migrations never gain a write path to it; the export is append-only with the same hash discipline on the receiving end. Two separately-controlled stores = two-key tamper arrangement.",
    );
  });

  it("the schema itself documents indefinite retention and Devin as sole override authority", () => {
    const schema = readFileSync(join(repoRoot, "src/_core/db/schema.ts"), "utf-8");
    // The retention decision must sit in the migration's doc comment — i.e.
    // within a small window of some memory_history occurrence in schema.ts
    const found = [...schema.matchAll(/memory_history/g)].some((m) => {
      const around = schema.slice(Math.max(0, m.index - 2500), m.index + 1500);
      return /retained indefinitely/i.test(around) && /Devin/i.test(around);
    });
    expect(found).toBe(true);
  });

  it("no line describing memory_history calls it immutable without qualification", () => {
    const docFiles = [
      ...walk(join(repoRoot, "docs"), [".md"]),
      join(repoRoot, "README.md"),
      join(repoRoot, "SPEC.md"),
      ...srcFiles,
    ];
    const offenders: string[] = [];
    for (const f of docFiles) {
      const src = readFileSync(f, "utf-8");
      if (!src.includes("memory_history")) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (/immutable/i.test(line) && /memory_history/i.test(line)) {
          if (!/\b(not|never|only|boundary|qualification|except|outside)\b/i.test(line)) {
            offenders.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ─── traceability meta-test ──────────────────────────────────────

describe("traceability — the suite is the spec", () => {
  const suiteFiles = [
    join(repoRoot, "tests/semantic/memory-history.test.ts"),
    join(repoRoot, "tests/semantic/memory-history-scans.test.ts"),
    join(repoRoot, "tests/interfaces/cli/history-export.test.ts"),
  ];

  it("every SPEC-001…012 appears in the doc and in the suite, and the suite knows no other ids", () => {
    const doc = readFileSync(docPath, "utf-8");
    const suite = suiteFiles.map((f) => readFileSync(f, "utf-8")).join("\n");
    const ids = Array.from({ length: 12 }, (_, i) => `SPEC-${String(i + 1).padStart(3, "0")}`);
    for (const id of ids) {
      expect(doc).toContain(id);
      expect(suite).toContain(id);
    }
    const stray = new Set((suite.match(/SPEC-\d{3}/g) ?? []).filter((x) => !ids.includes(x)));
    expect([...stray]).toEqual([]);
  });
});
