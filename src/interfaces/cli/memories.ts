/**
 * `engram memories` — inspect and curate the semantic store (#55).
 *
 *   memories list [--type] [--scope] [--since] [--query] [--deleted] [--limit] [--json]
 *   memories show <id>                 full provenance (source conversation, exchanges,
 *                                      source/extraction basis, scope, FSRS stats, graph
 *                                      evidence, change log, deletion)
 *   memories edit <id> --content <t>   replace the text (re-embedded, logged)
 *   memories delete <id> [--hard]      forget (soft delete + retention; --hard purges)
 *   memories restore <id>              undo a forget inside the retention window
 *   memories purge --conversation <id> forget everything derived from one conversation
 *   memories log [--memory <id>] [--op] [--limit] [--json]
 *
 * Every write records `cli` as the actor. The formatting functions are pure
 * and exported so tests can assert the output without spawning the CLI.
 */

import type { Command } from "commander";
import type Database from "better-sqlite3";
import { loadConfig } from "../../_core/config/index.js";
import { getDatabase, closeDatabase } from "../../_core/db/index.js";
import {
  CLI_ACTOR,
  editMemory,
  forgetMemory,
  purgeConversation,
  restoreMemory,
  type ForgetResult,
  type MemoryChange,
} from "../../semantic/forget.js";
import {
  getMemoryProvenance,
  listMemories,
  listMemoryChanges,
  resolveMemoryId,
  type MemoryListItem,
  type MemoryProvenance,
} from "../../semantic/inspect.js";
import type { MemoryChangeOp } from "../../semantic/forget.js";
import type { MemoryType } from "../../semantic/types.js";

const MEMORY_TYPES: readonly MemoryType[] = ["preference", "decision", "pattern", "fact", "solution", "convention"];
const CHANGE_OPS: readonly MemoryChangeOp[] = ["forget", "edit", "purge", "restore"];

// ─── Formatting (pure) ──────────────────────────────────────────

function isoDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatMemoryList(items: MemoryListItem[]): string[] {
  if (items.length === 0) return ["No memories match."];
  const lines: string[] = [];
  for (const m of items) {
    const flags = m.deletedAt ? ` [forgotten ${m.deletedAt.slice(0, 10)} by ${m.deletedBy ?? "?"}]` : m.isActive ? "" : " [inactive]";
    const scope = m.scope === "global" ? "" : ` (${m.scope})`;
    lines.push(`${m.id}  ${isoDay(m.createdAt)}  ${m.type.padEnd(10)} ${Math.round(m.confidence * 100)}%${scope}${flags}`);
    lines.push(`  ${truncate(m.content, 160)}`);
  }
  lines.push("");
  lines.push(`${items.length} memor${items.length === 1 ? "y" : "ies"}. \`engram memories show <id>\` for provenance.`);
  return lines;
}

export function formatMemoryShow(p: MemoryProvenance): string[] {
  const m = p.memory;
  const lines: string[] = [];
  lines.push(`Memory ${m.id}`);
  lines.push(`  ${m.content}`);
  if (m.context) lines.push(`  Context:          ${m.context}`);
  lines.push("");
  lines.push(`  Type:             ${m.type}`);
  lines.push(`  Scope:            ${m.scope ?? "global"}`);
  lines.push(`  Source:           ${m.source ?? "user"}${m.source === "dream" ? " (extracted by the dream pipeline)" : ""}`);
  lines.push(`  Extraction basis: ${m.extractionBasis ?? "observed"}`);
  lines.push(`  Created:          ${new Date(m.createdAt * 1000).toISOString()}`);
  if (m.updatedAt) lines.push(`  Updated:          ${new Date(m.updatedAt * 1000).toISOString()}`);
  if (m.eventTs) lines.push(`  Event time:       ${new Date(m.eventTs * 1000).toISOString()}`);
  lines.push(
    `  Status:           ${
      m.deletedAt
        ? `forgotten ${m.deletedAt} by ${m.deletedBy ?? "?"} (restore with \`engram memories restore ${m.id}\`)`
        : m.isActive
          ? "active"
          : m.supersededBy
            ? `superseded by ${m.supersededBy}`
            : "inactive (pruned)"
    }`,
  );
  lines.push("");
  lines.push("  Confidence / FSRS:");
  lines.push(`    Stored confidence:  ${Math.round(m.confidence * 100)}%   Composite: ${Math.round(p.health.confidence * 100)}%`);
  lines.push(`    Importance:         ${m.importance.toFixed(2)}`);
  lines.push(`    Stability:          ${p.health.stability.toFixed(1)} days${m.stability === undefined ? " (type default)" : ""}`);
  lines.push(`    Retrievability:     ${p.health.retrievability.toFixed(3)}${p.health.pruneEligible ? "  (prune-eligible)" : ""}`);
  lines.push(`    Accessed:           ${m.accessCount}×${m.lastAccessed ? `, last ${new Date(m.lastAccessed * 1000).toISOString()}` : ""}`);
  lines.push(`    Embedding:          ${p.hasEmbedding ? "indexed" : "none (not searchable by vector)"}`);
  lines.push("");

  if (p.conversations.length === 0) {
    lines.push(
      `  Provenance:       no source conversation${p.unresolvedSources.length > 0 ? ` (${p.unresolvedSources.length} unresolved source ref${p.unresolvedSources.length === 1 ? "" : "s"}: ${p.unresolvedSources.slice(0, 3).join(", ")})` : m.source === "user" ? " (stored directly via remember)" : ""}`,
    );
  } else {
    lines.push("  Provenance:");
    for (const c of p.conversations) {
      lines.push(`    Conversation ${c.id}`);
      lines.push(`      Title:      ${c.title ?? "(no summary yet)"}`);
      lines.push(`      Project:    ${c.project}${c.scope !== "global" ? `   Scope: ${c.scope}` : ""}${c.startedAt ? `   Started: ${c.startedAt}` : ""}`);
      if (c.archivePath) lines.push(`      Archive:    ${c.archivePath}  (MCP: show path=\"${c.archivePath}\")`);
      lines.push(`      Exchanges:  ${c.exchangeCount} of this memory's ${p.sourceExchanges.length} source exchange${p.sourceExchanges.length === 1 ? "" : "s"}`);
    }
    for (const e of p.sourceExchanges) {
      lines.push(`    #${e.exchangeIndex ?? "?"} ${e.id} (${e.timestamp.slice(0, 19)}): ${truncate(e.userPreview, 100)}`);
    }
    if (p.unresolvedSources.length > 0) {
      lines.push(`    ${p.unresolvedSources.length} unresolved source ref${p.unresolvedSources.length === 1 ? "" : "s"}: ${p.unresolvedSources.slice(0, 5).join(", ")}`);
    }
  }
  lines.push("");

  if (p.entities.length > 0) {
    lines.push("  Graph evidence for:");
    for (const e of p.entities) {
      lines.push(`    ${e.name} (${e.type}, ${e.mentionCount} mention${e.mentionCount === 1 ? "" : "s"})${e.staleSince ? `  stale since ${e.staleSince}` : ""}`);
    }
    lines.push("");
  }

  if (p.changes.length > 0) {
    lines.push("  Change log:");
    lines.push(...formatChangeLog(p.changes, { indent: "    " }));
  }
  return lines;
}

export function formatChangeLog(changes: MemoryChange[], options: { indent?: string } = {}): string[] {
  const indent = options.indent ?? "";
  if (changes.length === 0) return [`${indent}No changes recorded.`];
  const lines: string[] = [];
  for (const c of changes) {
    lines.push(`${indent}${c.at}  ${c.op.padEnd(7)} ${c.memoryId}  by ${c.actor}`);
    if (c.before !== null) lines.push(`${indent}  - ${truncate(c.before, 200)}`);
    if (c.after !== null) lines.push(`${indent}  + ${truncate(c.after, 200)}`);
  }
  return lines;
}

export function formatForgetResult(r: ForgetResult): string[] {
  const g = r.graph;
  const lines: string[] = [];
  lines.push(`${r.hard ? "Deleted" : "Forgot"} ${r.memoryId}: ${truncate(r.content, 160)}`);
  if (g.entities.length > 0 || g.relationships.length > 0) {
    const stale = g.entities.filter((e) => e.stale).map((e) => e.name);
    lines.push(
      `  Graph: ${g.entities.length} entit${g.entities.length === 1 ? "y" : "ies"} decremented, ${g.relationships.length} relationship${g.relationships.length === 1 ? "" : "s"} lost this evidence` +
        (stale.length > 0 ? `; flagged stale (pruned on the next dream run): ${stale.join(", ")}` : ""),
    );
  }
  if (!r.hard) lines.push(`  Kept for the retention window; \`engram memories restore ${r.memoryId}\` undoes it.`);
  return lines;
}

// ─── Command ────────────────────────────────────────────────────

function parseScopes(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const scopes = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

function requireMemory(db: Database.Database, idOrPrefix: string): string {
  const id = resolveMemoryId(db, idOrPrefix);
  if (!id) {
    console.error(`Memory not found: ${idOrPrefix}`);
    process.exit(1);
  }
  return id;
}

function withDb<T>(fn: (db: Database.Database) => Promise<T> | T): Promise<T> {
  const db = getDatabase(loadConfig());
  return Promise.resolve()
    .then(() => fn(db))
    .finally(() => closeDatabase());
}

export function registerMemoriesCommand(program: Command): void {
  const memories = program
    .command("memories")
    .description("Inspect and curate semantic memories: list, show provenance, edit, delete (forget), restore, purge, log");

  memories
    .command("list")
    .description("List memories (newest first)")
    .option("-t, --type <type>", `Filter by type (${MEMORY_TYPES.join(", ")})`)
    .option("-s, --scope <scopes>", "Comma-separated tenant scopes to include (default: all)")
    .option("--since <date>", "Only memories created at/after this ISO date")
    .option("-q, --query <text>", "Case-insensitive substring match on content")
    .option("--deleted", "Include forgotten (soft-deleted) memories")
    .option("--inactive", "Include superseded / pruned memories")
    .option("-l, --limit <n>", "Max rows", "50")
    .option("--json", "Print JSON")
    .action(async (opts) => {
      if (opts.type && !MEMORY_TYPES.includes(opts.type)) {
        console.error(`Invalid type: ${opts.type}. Must be one of: ${MEMORY_TYPES.join(", ")}`);
        process.exit(1);
      }
      await withDb((db) => {
        const items = listMemories(db, {
          type: opts.type as MemoryType | undefined,
          scopes: parseScopes(opts.scope),
          since: opts.since,
          query: opts.query,
          includeDeleted: Boolean(opts.deleted),
          includeInactive: Boolean(opts.inactive),
          limit: parseInt(opts.limit, 10) || 50,
        });
        if (opts.json) console.log(JSON.stringify(items, null, 2));
        else for (const line of formatMemoryList(items)) console.log(line);
      });
    });

  memories
    .command("show <id>")
    .description("Show one memory with full provenance (accepts a unique id prefix of 6+ chars)")
    .option("--json", "Print JSON")
    .action(async (id: string, opts) => {
      await withDb((db) => {
        const p = getMemoryProvenance(db, id);
        if (!p) {
          console.error(`Memory not found: ${id}`);
          process.exit(1);
        }
        if (opts.json) console.log(JSON.stringify(p, null, 2));
        else for (const line of formatMemoryShow(p)) console.log(line);
      });
    });

  memories
    .command("edit <id>")
    .description("Replace a memory's text (re-embedded; before/after recorded in the change log)")
    .requiredOption("-c, --content <text>", "New content")
    .action(async (id: string, opts) => {
      const { initEmbeddings, embedDocument } = await import("../../_core/embeddings/index.js");
      const config = loadConfig();
      await withDb(async (db) => {
        const memoryId = requireMemory(db, id);
        await initEmbeddings(config);
        const embedding = await embedDocument(opts.content);
        const change = editMemory(db, { memoryId, content: opts.content, embedding, actor: CLI_ACTOR });
        console.log(`Edited ${memoryId}`);
        for (const line of formatChangeLog([change], { indent: "  " })) console.log(line);
      });
    });

  memories
    .command("delete <id>")
    .alias("forget")
    .description("Forget a memory: soft delete kept for ENGRAM_FORGET_RETENTION_DAYS, out of recall immediately")
    .option("--hard", "Delete the row outright (bypasses the retention window)")
    .action(async (id: string, opts) => {
      await withDb((db) => {
        const memoryId = requireMemory(db, id);
        const result = forgetMemory(db, { memoryId, actor: CLI_ACTOR, hard: Boolean(opts.hard) });
        for (const line of formatForgetResult(result)) console.log(line);
      });
    });

  memories
    .command("restore <id>")
    .description("Undo a forget inside the retention window (re-indexed; lifts the extraction suppression)")
    .action(async (id: string) => {
      const { initEmbeddings, embedDocument } = await import("../../_core/embeddings/index.js");
      const config = loadConfig();
      await withDb(async (db) => {
        const memoryId = requireMemory(db, id);
        const p = getMemoryProvenance(db, memoryId);
        if (!p?.memory.deletedAt) {
          console.error(`Memory ${memoryId} is not forgotten`);
          process.exit(1);
        }
        await initEmbeddings(config);
        const embedding = await embedDocument(p.memory.content);
        restoreMemory(db, { memoryId, embedding, actor: CLI_ACTOR });
        console.log(`Restored ${memoryId}: ${truncate(p.memory.content, 160)}`);
      });
    });

  memories
    .command("purge")
    .description("Forget every memory derived from one conversation (privacy purge)")
    .requiredOption("--conversation <id>", "Conversation id (see `engram memories show <id>` → Provenance)")
    .option("--hard", "Delete the rows outright instead of the soft delete + retention window")
    .action(async (opts) => {
      await withDb((db) => {
        const result = purgeConversation(db, { conversationId: opts.conversation, actor: CLI_ACTOR, hard: Boolean(opts.hard) });
        if (result.forgotten.length === 0 && result.alreadyForgotten === 0) {
          console.log(`No memories derive from conversation ${opts.conversation}.`);
          return;
        }
        for (const r of result.forgotten) for (const line of formatForgetResult(r)) console.log(line);
        console.log(
          `Purged ${result.forgotten.length} memor${result.forgotten.length === 1 ? "y" : "ies"} from ${opts.conversation}` +
            (result.alreadyForgotten > 0 ? ` (${result.alreadyForgotten} already forgotten)` : ""),
        );
      });
    });

  memories
    .command("log")
    .description("Change log: what was forgotten / edited / purged / restored, and by which client")
    .option("-m, --memory <id>", "Only changes to this memory")
    .option("--op <op>", `Only this operation (${CHANGE_OPS.join(", ")})`)
    .option("-l, --limit <n>", "Max rows", "50")
    .option("--json", "Print JSON")
    .action(async (opts) => {
      if (opts.op && !CHANGE_OPS.includes(opts.op)) {
        console.error(`Invalid op: ${opts.op}. Must be one of: ${CHANGE_OPS.join(", ")}`);
        process.exit(1);
      }
      await withDb((db) => {
        const memoryId = opts.memory ? (resolveMemoryId(db, opts.memory) ?? opts.memory) : undefined;
        const changes = listMemoryChanges(db, { memoryId, op: opts.op as MemoryChangeOp | undefined, limit: parseInt(opts.limit, 10) || 50 });
        if (opts.json) console.log(JSON.stringify(changes, null, 2));
        else for (const line of formatChangeLog(changes)) console.log(line);
      });
    });
}
