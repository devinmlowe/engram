/**
 * Memory inspection surface (#55): list memories with filters, full
 * provenance for one memory, and the change log written by forget.ts.
 *
 * Read-only; the CLI (`engram memories …`) and the `forget` tool's
 * query mode are the consumers. Everything here is plain SQL over the
 * memories / exchanges / conversations / memory_changes tables — no
 * embeddings, no LLM.
 */

import type Database from "better-sqlite3";
import { scopeInClause } from "../_core/db/scope.js";
import { getMemoryHealth } from "./decay.js";
import type { Memory, MemoryType, MemorySource, MemoryHealth } from "./types.js";
import type { MemoryChange, MemoryChangeOp } from "./forget.js";
import { getMemoryEmbedding, rowToMemory, type MemoryRow } from "./memory.js";

// ─── List ───────────────────────────────────────────────────────

export interface ListMemoriesOptions {
  type?: MemoryType;
  /** Restrict to these tenant scopes (undefined = every scope). */
  scopes?: readonly string[];
  /** Only memories created at/after this time (ISO date or datetime). */
  since?: string;
  /** Case-insensitive substring match on content. */
  query?: string;
  /** Include forgotten (soft-deleted) memories; default false. */
  includeDeleted?: boolean;
  /** Include superseded / pruned (inactive but not forgotten) memories; default false. */
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryListItem {
  id: string;
  type: MemoryType;
  content: string;
  scope: string;
  source: MemorySource;
  confidence: number;
  importance: number;
  createdAt: number;
  isActive: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

interface ListRow {
  id: string;
  type: string;
  content: string;
  scope: string | null;
  source: string | null;
  confidence: number;
  importance: number;
  created_at: number;
  is_active: number;
  deleted_at: string | null;
  deleted_by: string | null;
}

function parseSince(since: string): number {
  const ms = new Date(since).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid --since value: ${since} (expected an ISO date such as 2026-09-01)`);
  return Math.floor(ms / 1000);
}

export function listMemories(db: Database.Database, options: ListMemoriesOptions = {}): MemoryListItem[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!options.includeDeleted) where.push("deleted_at IS NULL");
  if (!options.includeInactive) where.push(options.includeDeleted ? "(is_active = 1 OR deleted_at IS NOT NULL)" : "is_active = 1");
  if (options.type) {
    where.push("type = ?");
    params.push(options.type);
  }
  const scope = scopeInClause("scope", options.scopes);
  if (scope) {
    where.push(scope.sql);
    params.push(...scope.params);
  }
  if (options.since) {
    where.push("created_at >= ?");
    params.push(parseSince(options.since));
  }
  if (options.query && options.query.trim().length > 0) {
    where.push("content LIKE ? ESCAPE '\\'");
    params.push(`%${options.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 1000));
  const offset = Math.max(0, options.offset ?? 0);
  params.push(limit, offset);

  const rows = db
    .prepare(
      `SELECT id, type, content, scope, source, confidence, importance, created_at, is_active, deleted_at, deleted_by
       FROM memories
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as ListRow[];

  return rows.map((r) => ({
    id: r.id,
    type: r.type as MemoryType,
    content: r.content,
    scope: r.scope ?? "global",
    source: (r.source as MemorySource) ?? "user",
    confidence: r.confidence,
    importance: r.importance,
    createdAt: r.created_at,
    isActive: Boolean(r.is_active),
    deletedAt: r.deleted_at ?? undefined,
    deletedBy: r.deleted_by ?? undefined,
  }));
}

// ─── Provenance ─────────────────────────────────────────────────

export interface SourceExchangeInfo {
  id: string;
  conversationId: string;
  exchangeIndex: number | null;
  timestamp: string;
  project: string;
  /** First 160 chars of the user message. */
  userPreview: string;
}

export interface SourceConversationInfo {
  id: string;
  project: string;
  /** Conversation summary (the closest thing to a title); undefined until the dream pipeline writes one. */
  title?: string;
  startedAt?: string;
  archivePath?: string;
  scope: string;
  /** How many of this memory's source exchanges belong to the conversation. */
  exchangeCount: number;
}

export interface EvidencedEntity {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  staleSince?: string;
}

export interface MemoryProvenance {
  memory: Memory;
  /** FSRS view: retrievability, stability, composite confidence, prune eligibility. */
  health: MemoryHealth;
  hasEmbedding: boolean;
  sourceExchanges: SourceExchangeInfo[];
  /** Source exchange ids that resolved to no row (legacy index strings, purged exchanges). */
  unresolvedSources: string[];
  conversations: SourceConversationInfo[];
  /** Graph entities this memory evidences (endpoints of relationships listing it). */
  entities: EvidencedEntity[];
  changes: MemoryChange[];
}

function parseSources(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Everything known about one memory. Returns null when the id is unknown.
 * Accepts a unique id prefix of at least 6 characters (like commitments).
 */
export function getMemoryProvenance(db: Database.Database, idOrPrefix: string): MemoryProvenance | null {
  const id = resolveMemoryId(db, idOrPrefix);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  if (!row) return null;

  const sourceIds = parseSources(row.source_exchanges);
  const memory: Memory = { ...rowToMemory(row), sourceExchanges: sourceIds };

  // Source exchanges + their conversations
  const sourceExchanges: SourceExchangeInfo[] = [];
  const unresolvedSources: string[] = [];
  const convCounts = new Map<string, number>();
  if (sourceIds.length > 0) {
    const lookup = db.prepare(
      "SELECT id, conversation_id, exchange_index, timestamp, project, user_message FROM exchanges WHERE id = ?",
    );
    for (const sid of sourceIds.slice(0, 500)) {
      const e = lookup.get(sid) as
        | { id: string; conversation_id: string; exchange_index: number | null; timestamp: string; project: string; user_message: string | null }
        | undefined;
      if (!e) {
        unresolvedSources.push(sid);
        continue;
      }
      sourceExchanges.push({
        id: e.id,
        conversationId: e.conversation_id,
        exchangeIndex: e.exchange_index,
        timestamp: e.timestamp,
        project: e.project,
        userPreview: (e.user_message ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      });
      convCounts.set(e.conversation_id, (convCounts.get(e.conversation_id) ?? 0) + 1);
    }
  }
  sourceExchanges.sort((a, b) => (a.exchangeIndex ?? 0) - (b.exchangeIndex ?? 0));

  const conversations: SourceConversationInfo[] = [];
  const convLookup = db.prepare("SELECT id, project, summary, started_at, archive_path, scope FROM conversations WHERE id = ?");
  for (const [convId, count] of convCounts) {
    const c = convLookup.get(convId) as
      | { id: string; project: string; summary: string | null; started_at: string | null; archive_path: string | null; scope: string | null }
      | undefined;
    conversations.push({
      id: convId,
      project: c?.project ?? sourceExchanges.find((e) => e.conversationId === convId)?.project ?? "unknown",
      title: c?.summary ?? undefined,
      startedAt: c?.started_at ?? undefined,
      archivePath: c?.archive_path ?? undefined,
      scope: c?.scope ?? "global",
      exchangeCount: count,
    });
  }

  // Graph evidence: relationships whose source_memories lists this memory
  const rels = db
    .prepare("SELECT source_entity_id, target_entity_id FROM relationships WHERE source_memories LIKE ?")
    .all(`%"${row.id}"%`) as Array<{ source_entity_id: string; target_entity_id: string }>;
  const entityIds = [...new Set(rels.flatMap((r) => [r.source_entity_id, r.target_entity_id]))];
  const entities: EvidencedEntity[] = [];
  if (entityIds.length > 0) {
    const entLookup = db.prepare("SELECT id, name, type, mention_count, stale_since FROM entities WHERE id = ?");
    for (const eid of entityIds) {
      const e = entLookup.get(eid) as
        | { id: string; name: string; type: string; mention_count: number; stale_since: string | null }
        | undefined;
      if (e) entities.push({ id: e.id, name: e.name, type: e.type, mentionCount: e.mention_count, staleSince: e.stale_since ?? undefined });
    }
  }

  return {
    memory,
    health: getMemoryHealth(memory),
    hasEmbedding: getMemoryEmbedding(db, row.id) !== null,
    sourceExchanges,
    unresolvedSources,
    conversations,
    entities,
    changes: listMemoryChanges(db, { memoryId: row.id, limit: 100 }),
  };
}

/**
 * Resolve a full memory id or a unique prefix (≥ 6 chars). Returns null when
 * nothing matches; throws when a prefix is ambiguous.
 */
export function resolveMemoryId(db: Database.Database, idOrPrefix: string): string | null {
  const exact = db.prepare("SELECT id FROM memories WHERE id = ?").get(idOrPrefix) as { id: string } | undefined;
  if (exact) return exact.id;
  if (idOrPrefix.length < 6) return null;
  const rows = db
    .prepare("SELECT id FROM memories WHERE id LIKE ? ESCAPE '\\' LIMIT 3")
    .all(`${idOrPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as Array<{ id: string }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`Memory id prefix "${idOrPrefix}" is ambiguous (${rows.map((r) => r.id).join(", ")}…)`);
  }
  return rows[0].id;
}

// ─── Change log ─────────────────────────────────────────────────

export interface ListChangesOptions {
  memoryId?: string;
  op?: MemoryChangeOp;
  limit?: number;
}

interface ChangeRow {
  id: string;
  memory_id: string;
  op: string;
  before: string | null;
  after: string | null;
  actor: string;
  at: string;
}

/** Newest first. */
export function listMemoryChanges(db: Database.Database, options: ListChangesOptions = {}): MemoryChange[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.memoryId) {
    where.push("memory_id = ?");
    params.push(options.memoryId);
  }
  if (options.op) {
    where.push("op = ?");
    params.push(options.op);
  }
  params.push(Math.max(1, Math.min(options.limit ?? 50, 1000)));
  const rows = db
    .prepare(
      `SELECT id, memory_id, op, before, after, actor, at FROM memory_changes
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params) as ChangeRow[];
  return rows.map((r) => ({
    id: r.id,
    memoryId: r.memory_id,
    op: r.op as MemoryChangeOp,
    before: r.before,
    after: r.after,
    actor: r.actor,
    at: r.at,
  }));
}
