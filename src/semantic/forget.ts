/**
 * Memory lifecycle: forget, edit, restore, purge (#55).
 *
 * Decision #56 — forget is a SOFT delete with a retention purge: the memories
 * row stays (`is_active = 0`, `deleted_at`, `deleted_by`) so the change log
 * can show `before` and the user has an undo window, while the sqlite-vec and
 * FTS5 rows are removed immediately so no recall path can surface the row.
 * The dream prune phase hard-deletes rows older than
 * `ENGRAM_FORGET_RETENTION_DAYS`; `hard: true` / `engram memories purge`
 * bypass retention.
 *
 * Decision #57 — forget never deletes graph rows. It removes the memory from
 * every relationship's `source_memories` evidence, decrements the endpoint
 * entities' `mention_count` (once per entity, mirroring the bump
 * `linkMemoryToEntities` applied) and stamps `stale_since` on rows whose
 * evidence reached zero. `pruneOrphanEntities` (graph/reflection.ts) deletes
 * flagged rows with no remaining evidence on the next dream run.
 *
 * Every forget also records the content hash in `memory_suppressions` so the
 * next dream extract does not re-extract the same statement from the same
 * exchanges (see `filterSuppressedFacts`). An explicit `remember` of the same
 * content lifts the suppression (`clearSuppression`).
 *
 * Scope (#25): callers pass the scopes the actor may see (`readScopes`); a
 * memory outside them is refused unless `scope: "global"` was passed
 * explicitly, which acts across every tenant.
 */

import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { deleteVector, deleteFtsRow, insertFtsRow, insertVector } from "../_core/db/index.js";
import { GLOBAL_SCOPE, scopeVisible } from "../_core/db/scope.js";
import { normalizeContent } from "./collapse.js";
import type { ExtractedFact } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────

export type MemoryChangeOp = "forget" | "edit" | "purge" | "restore";

export interface MemoryChange {
  id: string;
  memoryId: string;
  op: MemoryChangeOp;
  before: string | null;
  after: string | null;
  actor: string;
  /** ISO-8601 UTC. */
  at: string;
}

/** Who performed a change: the MCP client's `clientInfo.name`, or `cli`. */
export const CLI_ACTOR = "cli";
export const UNKNOWN_MCP_ACTOR = "mcp";
export const DREAM_ACTOR = "dream";

export interface ScopeGate {
  /**
   * Scopes the caller may act on. Undefined/empty = every scope (single-tenant
   * behaviour, the CLI default).
   */
  readScopes?: readonly string[];
  /**
   * Explicit per-call scope. `"global"` is the documented override: it acts
   * on a memory in any scope even when `readScopes` would hide it.
   */
  scope?: string;
}

export interface ForgetOptions extends ScopeGate {
  memoryId: string;
  actor: string;
  /** Delete the memories row outright after the soft-delete bookkeeping. */
  hard?: boolean;
  /** Injectable clock (ISO string) for tests. */
  now?: Date;
}

export interface GraphTouch {
  /** Entities whose mention_count was decremented. */
  entities: Array<{ id: string; name: string; mentionCount: number; stale: boolean }>;
  /** Relationships whose evidence list lost this memory. */
  relationships: Array<{ id: string; remainingEvidence: number; stale: boolean }>;
}

export interface ForgetResult {
  memoryId: string;
  content: string;
  scope: string;
  hard: boolean;
  deletedAt: string;
  graph: GraphTouch;
}

export interface EditOptions extends ScopeGate {
  memoryId: string;
  content: string;
  /** Embedding of the new content (callers own the embedding model). */
  embedding: number[];
  actor: string;
  now?: Date;
}

export interface RestoreOptions extends ScopeGate {
  memoryId: string;
  /** Embedding of the memory's content (re-indexed on restore). */
  embedding: number[];
  actor: string;
  now?: Date;
}

export interface PurgeConversationOptions extends ScopeGate {
  conversationId: string;
  actor: string;
  hard?: boolean;
  now?: Date;
}

export interface PurgeConversationResult {
  conversationId: string;
  forgotten: ForgetResult[];
  /** Memories from that conversation that were already forgotten. */
  alreadyForgotten: number;
}

export interface RetentionPurgeResult {
  purged: string[];
  cutoff: string;
}

// ─── Errors ─────────────────────────────────────────────────────

export class MemoryNotFoundError extends Error {
  constructor(public readonly memoryId: string) {
    super(`Memory not found: ${memoryId}`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryScopeError extends Error {
  constructor(public readonly memoryId: string, public readonly memoryScope: string, readScopes: readonly string[]) {
    super(
      `Memory ${memoryId} is in scope "${memoryScope}", outside read_scopes [${readScopes.join(", ")}]; ` +
        `pass scope: "global" to act across scopes`,
    );
    this.name = "MemoryScopeError";
  }
}

export class MemoryAlreadyForgottenError extends Error {
  constructor(public readonly memoryId: string, public readonly deletedAt: string, public readonly deletedBy: string | null) {
    super(`Memory ${memoryId} was already forgotten at ${deletedAt}${deletedBy ? ` by ${deletedBy}` : ""}`);
    this.name = "MemoryAlreadyForgottenError";
  }
}

// ─── Content hash / suppression ─────────────────────────────────

/**
 * Stable hash of a memory's content, computed over the same normalisation the
 * dedup path uses (`normalizeContent`: lowercase, punctuation stripped,
 * whitespace collapsed), so a re-extraction that differs only in case or
 * punctuation still matches.
 */
export function contentHash(content: string): string {
  const normalized = normalizeContent(content) || content.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Remove the suppression of this content in one scope (an explicit remember
 * wins). #106: keyed by tenant, so a remember in `hermes:personal` never
 * lifts a `hermes:career` (or global) forget. Returns true when one existed.
 */
export function clearSuppression(db: Database.Database, content: string, scope: string): boolean {
  const r = db
    .prepare("DELETE FROM memory_suppressions WHERE content_hash = ? AND scope = ?")
    .run(contentHash(content), scope);
  return r.changes > 0;
}

/**
 * Split extracted facts into the ones to keep and the ones whose content
 * hash is suppressed (a forgotten statement re-extracted from the same
 * exchanges). #106: a suppression applies to its own scope; only a global one
 * applies to every tenant. Used by dream extract; the count feeds the phase
 * summary.
 */
export function filterSuppressedFacts<T extends Pick<ExtractedFact, "content">>(
  db: Database.Database,
  facts: readonly T[],
  scope: string,
): { kept: T[]; suppressed: T[] } {
  if (facts.length === 0) return { kept: [], suppressed: [] };
  const lookup = db.prepare(
    "SELECT 1 FROM memory_suppressions WHERE content_hash = ? AND scope IN (?, 'global')",
  );
  const kept: T[] = [];
  const suppressed: T[] = [];
  for (const fact of facts) {
    if (lookup.get(contentHash(fact.content), scope)) suppressed.push(fact);
    else kept.push(fact);
  }
  return { kept, suppressed };
}

// ─── Internals ──────────────────────────────────────────────────

interface MemoryRow {
  rowid: number;
  id: string;
  content: string;
  context: string | null;
  scope: string | null;
  is_active: number;
  deleted_at: string | null;
  deleted_by: string | null;
  source_exchanges: string | null;
}

function iso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function loadRow(db: Database.Database, memoryId: string): MemoryRow | undefined {
  return db
    .prepare(
      "SELECT rowid, id, content, context, scope, is_active, deleted_at, deleted_by, source_exchanges FROM memories WHERE id = ?",
    )
    .get(memoryId) as MemoryRow | undefined;
}

/** Throw unless the row is visible to the caller's scopes (or scope "global" was passed). */
function assertScope(row: MemoryRow, gate: ScopeGate): void {
  if (gate.scope === GLOBAL_SCOPE) return;
  const scopes = gate.readScopes;
  if (!scopes || scopes.length === 0) return;
  if (!scopeVisible(row.scope, scopes)) {
    throw new MemoryScopeError(row.id, row.scope ?? GLOBAL_SCOPE, scopes);
  }
}

function logChange(
  db: Database.Database,
  change: Omit<MemoryChange, "id">,
): MemoryChange {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO memory_changes (id, memory_id, op, before, after, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, change.memoryId, change.op, change.before, change.after, change.actor, change.at);
  return { id, ...change };
}

/** Flatten `relationships.source_memories` (flat strings or nested one-element arrays). */
export function parseEvidence(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item)) for (const inner of item) if (typeof inner === "string") out.push(inner);
  }
  return out;
}

/**
 * #57: remove `memoryId` from every relationship's evidence, decrement the
 * endpoint entities' mention_count once each, and stamp `stale_since` on
 * rows whose evidence reached zero. Never deletes. Runs inside the caller's
 * transaction.
 */
export function detachMemoryEvidence(db: Database.Database, memoryId: string, now: string): GraphTouch {
  const touch: GraphTouch = { entities: [], relationships: [] };
  const rels = db
    .prepare(
      `SELECT id, source_entity_id, target_entity_id, source_memories, weight
       FROM relationships WHERE source_memories LIKE ?`,
    )
    .all(`%"${memoryId}"%`) as Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    source_memories: string | null;
    weight: number;
  }>;

  const entityIds = new Set<string>();
  const updateRel = db.prepare(
    "UPDATE relationships SET source_memories = ?, weight = ?, stale_since = ?, updated_at = unixepoch() WHERE id = ?",
  );
  for (const rel of rels) {
    const evidence = parseEvidence(rel.source_memories);
    if (!evidence.includes(memoryId)) continue;
    const remaining = evidence.filter((e) => e !== memoryId);
    const stale = remaining.length === 0;
    // linkMemoryToEntities adds 0.5 per extra memory on an existing edge;
    // undo that, never below the initial 1.0.
    const weight = Math.max(1.0, (rel.weight ?? 1.0) - 0.5);
    updateRel.run(JSON.stringify(remaining), weight, stale ? now : null, rel.id);
    touch.relationships.push({ id: rel.id, remainingEvidence: remaining.length, stale });
    entityIds.add(rel.source_entity_id);
    entityIds.add(rel.target_entity_id);
  }

  const readEntity = db.prepare("SELECT id, name, mention_count FROM entities WHERE id = ?");
  const updateEntity = db.prepare("UPDATE entities SET mention_count = ?, stale_since = ? WHERE id = ?");
  for (const id of entityIds) {
    const row = readEntity.get(id) as { id: string; name: string; mention_count: number } | undefined;
    if (!row) continue;
    const mentionCount = Math.max(0, (row.mention_count ?? 0) - 1);
    const stale = mentionCount === 0;
    updateEntity.run(mentionCount, stale ? now : null, id);
    touch.entities.push({ id, name: row.name, mentionCount, stale });
  }
  return touch;
}

/**
 * Drop the vector + FTS rows for a memory. The FTS5 'delete' command must be
 * given exactly the values that were indexed and must run at most once per
 * indexed row (a second delete corrupts the index), so callers only unindex
 * rows that are currently indexed: active rows, never already-forgotten ones.
 */
export function unindexMemory(
  db: Database.Database,
  row: { id: string; rowid: number; content: string; context: string | null },
): void {
  deleteVector(db, "vec_memories", row.id);
  deleteFtsRow(db, "memories_fts", row.rowid, { content: row.content, context: row.context });
}

/** Re-create the vector + FTS rows for a memory that is currently unindexed. */
function reindex(db: Database.Database, row: MemoryRow, embedding: number[]): void {
  insertVector(db, "vec_memories", row.id, embedding);
  insertFtsRow(db, "memories_fts", row.rowid, { content: row.content, context: row.context });
}

// ─── Forget ─────────────────────────────────────────────────────

/**
 * Forget one memory in a single transaction (see module doc). Throws
 * `MemoryNotFoundError`, `MemoryScopeError`, or `MemoryAlreadyForgottenError`
 * (the last only for a soft forget; `hard: true` on an already-forgotten
 * memory purges it).
 */
export function forgetMemory(db: Database.Database, options: ForgetOptions): ForgetResult {
  const now = iso(options.now);
  const run = db.transaction((): ForgetResult => {
    const row = loadRow(db, options.memoryId);
    if (!row) throw new MemoryNotFoundError(options.memoryId);
    assertScope(row, options);

    const alreadyForgotten = row.is_active === 0 && row.deleted_at !== null;
    if (alreadyForgotten && !options.hard) {
      throw new MemoryAlreadyForgottenError(row.id, row.deleted_at!, row.deleted_by);
    }

    let graph: GraphTouch = { entities: [], relationships: [] };
    if (!alreadyForgotten) {
      db.prepare(
        "UPDATE memories SET is_active = 0, deleted_at = ?, deleted_by = ?, updated_at = unixepoch() WHERE id = ?",
      ).run(now, options.actor, row.id);
      // A superseded/pruned row (is_active = 0, no deleted_at) is still
      // indexed — the dream pipeline only flips the flag — so unindex it too.
      unindexMemory(db, row);
      logChange(db, { memoryId: row.id, op: "forget", before: row.content, after: null, actor: options.actor, at: now });
      db.prepare(
        "INSERT OR REPLACE INTO memory_suppressions (content_hash, memory_id, scope, created_at) VALUES (?, ?, ?, ?)",
      ).run(contentHash(row.content), row.id, row.scope ?? GLOBAL_SCOPE, now);
      graph = detachMemoryEvidence(db, row.id, now);
    }

    if (options.hard) {
      hardDeleteRow(db, row, options.actor, now);
    }

    return {
      memoryId: row.id,
      content: row.content,
      scope: row.scope ?? GLOBAL_SCOPE,
      hard: options.hard === true,
      deletedAt: alreadyForgotten ? row.deleted_at! : now,
      graph,
    };
  });
  return run.immediate();
}

/**
 * Delete the memories row (and its conflicts) and log a `purge`. The row's
 * vector/FTS entries were already removed when it was forgotten (soft or in
 * this same call), so nothing is unindexed here.
 */
function hardDeleteRow(db: Database.Database, row: MemoryRow, actor: string, now: string): void {
  db.prepare("DELETE FROM conflicts WHERE memory_id = ? OR conflicting_memory_id = ?").run(row.id, row.id);
  db.prepare("UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?").run(row.id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
  logChange(db, { memoryId: row.id, op: "purge", before: row.content, after: null, actor, at: now });
}

// ─── Edit ───────────────────────────────────────────────────────

/**
 * Replace a memory's content, re-embed and re-index it, and log the edit
 * with `before` / `after`. Only active memories can be edited.
 */
export function editMemory(db: Database.Database, options: EditOptions): MemoryChange {
  const content = options.content.trim();
  if (content.length === 0) throw new Error("New content must not be empty");
  const now = iso(options.now);
  const run = db.transaction((): MemoryChange => {
    const row = loadRow(db, options.memoryId);
    if (!row) throw new MemoryNotFoundError(options.memoryId);
    assertScope(row, options);
    if (row.is_active === 0) {
      throw new Error(
        row.deleted_at
          ? `Memory ${row.id} was forgotten at ${row.deleted_at}; restore it before editing`
          : `Memory ${row.id} is inactive (superseded or pruned) and cannot be edited`,
      );
    }
    if (row.content === content) {
      throw new Error(`Memory ${row.id} already has that content`);
    }
    unindexMemory(db, row);
    db.prepare("UPDATE memories SET content = ?, updated_at = unixepoch() WHERE id = ?").run(content, row.id);
    reindex(db, { ...row, content }, options.embedding);
    return logChange(db, { memoryId: row.id, op: "edit", before: row.content, after: content, actor: options.actor, at: now });
  });
  return run.immediate();
}

// ─── Restore ────────────────────────────────────────────────────

/**
 * Undo a forget inside the retention window: reactivate the row, re-index it,
 * lift the suppression and log a `restore`. Graph counts are NOT re-applied
 * (forget's decrement is a heuristic; the next dream run recomputes).
 */
export function restoreMemory(db: Database.Database, options: RestoreOptions): MemoryChange {
  const now = iso(options.now);
  const run = db.transaction((): MemoryChange => {
    const row = loadRow(db, options.memoryId);
    if (!row) throw new MemoryNotFoundError(options.memoryId);
    assertScope(row, options);
    if (row.deleted_at === null) {
      throw new Error(`Memory ${row.id} is not forgotten`);
    }
    db.prepare(
      "UPDATE memories SET is_active = 1, deleted_at = NULL, deleted_by = NULL, updated_at = unixepoch() WHERE id = ?",
    ).run(row.id);
    reindex(db, row, options.embedding);
    db
      .prepare("DELETE FROM memory_suppressions WHERE content_hash = ? AND scope = ?")
      .run(contentHash(row.content), row.scope ?? GLOBAL_SCOPE);
    return logChange(db, { memoryId: row.id, op: "restore", before: null, after: row.content, actor: options.actor, at: now });
  });
  return run.immediate();
}

// ─── Purge by conversation ──────────────────────────────────────

/**
 * Ids of memories derived from a conversation: any active-or-forgotten row
 * whose `source_exchanges` names an exchange of that conversation, or names
 * the conversation id itself (legacy references).
 */
export function memoriesFromConversation(db: Database.Database, conversationId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id FROM memories AS m
       WHERE m.source_exchanges IS NOT NULL
         AND json_valid(m.source_exchanges)
         AND json_type(m.source_exchanges) = 'array'
         AND EXISTS (
           SELECT 1 FROM json_each(m.source_exchanges) AS j
           LEFT JOIN exchanges AS e ON e.id = j.value
           WHERE e.conversation_id = ? OR j.value = ?
         )
       ORDER BY m.created_at ASC`,
    )
    .all(conversationId, conversationId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Forget every memory derived from one conversation (privacy purge). Each
 * memory is forgotten in its own transaction so a scope refusal on one does
 * not roll back the others; a refused memory aborts the run with the error.
 */
export function purgeConversation(db: Database.Database, options: PurgeConversationOptions): PurgeConversationResult {
  const ids = memoriesFromConversation(db, options.conversationId);
  const result: PurgeConversationResult = { conversationId: options.conversationId, forgotten: [], alreadyForgotten: 0 };
  for (const memoryId of ids) {
    try {
      result.forgotten.push(
        forgetMemory(db, {
          memoryId,
          actor: options.actor,
          hard: options.hard,
          readScopes: options.readScopes,
          scope: options.scope,
          now: options.now,
        }),
      );
    } catch (err) {
      if (err instanceof MemoryAlreadyForgottenError) {
        result.alreadyForgotten++;
        continue;
      }
      throw err;
    }
  }
  return result;
}

// ─── Retention purge (#56) ──────────────────────────────────────

/**
 * Hard-delete forgotten memories whose `deleted_at` is older than
 * `retentionDays` (0 = every forgotten memory). Run by dream prune; each row
 * gets a `purge` change-log entry. Suppressions are kept — the point of the
 * hash table is to survive the row.
 */
export function purgeForgottenMemories(
  db: Database.Database,
  options: { retentionDays: number; actor?: string; now?: Date },
): RetentionPurgeResult {
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = new Date(nowMs - Math.max(0, options.retentionDays) * 86_400_000).toISOString();
  const actor = options.actor ?? DREAM_ACTOR;
  const at = new Date(nowMs).toISOString();
  const run = db.transaction((): string[] => {
    const rows = db
      .prepare(
        `SELECT rowid, id, content, context, scope, is_active, deleted_at, deleted_by, source_exchanges
         FROM memories WHERE is_active = 0 AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      )
      .all(cutoff) as MemoryRow[];
    for (const row of rows) hardDeleteRow(db, row, actor, at);
    return rows.map((r) => r.id);
  });
  return { purged: run.immediate(), cutoff };
}
