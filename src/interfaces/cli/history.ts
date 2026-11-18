/**
 * `engram history` — read-side operations on the memory_history audit trail
 * (docs/memory-history.md, SPEC-010).
 *
 * This command is a custody export hook: it writes ONLY to the path the
 * caller provides (`--out`) or to stdout. Engram tooling never picks a
 * destination on its own and never touches the receiving store — the durable
 * copy lives under separate profile custody, and ingestion of the export is
 * that side's work. This module opens the Engram database read-only in
 * spirit: the only statements it runs are the trail reads in
 * `listMemoryHistory`.
 */

import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { getDatabase, closeDatabase, listMemoryHistory } from "../../_core/db/index.js";
import type { MemoryHistoryRow } from "../../_core/db/index.js";

/**
 * Format rows as JSONL: one JSON object per line whose keys are exactly the
 * table's column names (snake_case) — a faithful projection of each row so
 * the custody copy can be verified against the source with the same hash
 * discipline the trail itself uses.
 */
export function formatHistoryJsonl(rows: MemoryHistoryRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        id: r.id,
        memory_id: r.memoryId,
        mechanism: r.mechanism,
        before_content: r.beforeContent,
        after_content: r.afterContent,
        before_hash: r.beforeHash,
        after_hash: r.afterHash,
        actor: r.actor,
        at: r.at,
      }),
    )
    .join("\n");
}

/** One human-readable line per row (the default, non-`--json` output). */
function formatHistoryHuman(rows: MemoryHistoryRow[]): string {
  return rows
    .map((r) => {
      const before = r.beforeContent === null ? "∅" : JSON.stringify(r.beforeContent);
      const after = r.afterContent === null ? "∅" : JSON.stringify(r.afterContent);
      return [r.id, r.at, r.mechanism.padEnd(7), r.memoryId, `actor=${r.actor ?? "null"}`, `${before} → ${after}`].join("  ");
    })
    .join("\n");
}

/** Register the `history` command group (currently `history export`). */
export function registerHistoryCommand(program: Command): void {
  const history = program
    .command("history")
    .description("Read-side operations on the memory history audit trail");

  history
    .command("export")
    .description(
      "Export history rows for custody: id-ascending, optionally past an exclusive cursor, to --out or stdout",
    )
    .option("--since-id <id>", "Exclusive cursor: export rows with id strictly greater than this", "0")
    .option("--out <path>", "Write to this caller-provided path instead of stdout")
    .option("--json", "One JSON object per line (JSONL) keyed by the table column names")
    .action((opts: { sinceId?: string; out?: string; json?: boolean }) => {
      const sinceId = Number.parseInt(opts.sinceId ?? "0", 10);
      const rows = listMemoryHistory(getDatabase(), {
        sinceId: Number.isFinite(sinceId) && sinceId > 0 ? sinceId : undefined,
      });
      const output = opts.json ? formatHistoryJsonl(rows) : formatHistoryHuman(rows);
      if (opts.out) {
        writeFileSync(opts.out, output.length === 0 ? "" : output + "\n", "utf8");
      } else if (output.length > 0) {
        console.log(output);
      }
      closeDatabase();
    });
}
