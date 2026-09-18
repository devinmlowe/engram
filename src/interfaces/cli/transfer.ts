/**
 * `engram export` / `engram import` — portable JSONL transfer of the
 * semantic layer (memories, entities, relationships, commitments).
 *
 * Format v1: one JSON object per line.
 *   line 1: {"kind":"header","v":1,"exported_at":...,"schema_version":[...],
 *            "counts":{...},"scopes":[...]|null,"include_inactive":bool,
 *            "embeddings":"not exported; regenerated on import from content"}
 *   then:   {"kind":"memory"|"entity"|"relationship"|"commitment","v":1,
 *            "data":{...every column of the row, JSON columns decoded,
 *                    booleans as true/false}}
 *
 * Embeddings are deliberately NOT in the file: they are model-specific and
 * large, and the importing database regenerates them from content through
 * the same insert helpers the rest of engram uses (so memories_fts,
 * entities_fts — both external-content FTS5 tables — and the vec0 tables
 * are always consistent with the row).
 *
 * Import is idempotent by id: an existing id is updated in place only when
 * the incoming record is newer (per-kind version column, see `versionOf`),
 * otherwise skipped. The whole file is parsed and validated before the
 * first write, so a malformed line aborts with nothing changed.
 */

import type Database from "better-sqlite3";
import { embedDocumentBatch } from "../../_core/embeddings/index.js";
import {
  insertFtsRow,
  deleteFtsRow,
  insertVector,
  deleteVector,
} from "../../_core/db/index.js";
import { insertMemory } from "../../semantic/memory.js";
import { insertEntity } from "../../graph/entity.js";
import { insertRelationship } from "../../graph/relationship.js";
import type { Memory, MemoryType, MemorySource } from "../../semantic/types.js";
import type { Entity, EntityType, Relationship, RelationshipType } from "../../graph/types.js";

// ─── Format ──────────────────────────────────────────────────────

export const EXPORT_FORMAT_VERSION = 1 as const;

/** Exportable tables, in the order they are written and imported. */
export const ALL_KINDS = ["memories", "entities", "relationships", "commitments"] as const;
export type ExportKind = (typeof ALL_KINDS)[number];

export type RecordKind = "memory" | "entity" | "relationship" | "commitment";

const KIND_TO_TABLE: Record<RecordKind, ExportKind> = {
  memory: "memories",
  entity: "entities",
  relationship: "relationships",
  commitment: "commitments",
};

const TABLE_TO_KIND: Record<ExportKind, RecordKind> = {
  memories: "memory",
  entities: "entity",
  relationships: "relationship",
  commitments: "commitment",
};

/** Entity types that never take part in vector search (see file-indexer). */
const STRUCTURAL_ENTITY_TYPES = new Set(["file", "function", "class", "module"]);

export type ExportRow = Record<string, unknown> & { id: string };

export interface ExportHeader {
  kind: "header";
  v: typeof EXPORT_FORMAT_VERSION;
  exported_at: string;
  /** Applied `schema_migrations` names of the source database, sorted. */
  schema_version: string[];
  counts: Partial<Record<ExportKind, number>>;
  /** Memory scopes filtered on, or null for all scopes. */
  scopes: string[] | null;
  include_inactive: boolean;
  /** Human-readable statement that vectors are not in the file. */
  embeddings: string;
}

export interface ExportRecord {
  kind: RecordKind;
  v: typeof EXPORT_FORMAT_VERSION;
  data: ExportRow;
}

export type ExportLine = ExportHeader | ExportRecord;

export interface ExportOptions {
  /** Only memories whose scope is in this list. Other kinds are unscoped. */
  scopes?: string[];
  /** Include memories with is_active = 0 (default: active only). */
  includeInactive?: boolean;
  /** Which tables to export (default: all). */
  kinds?: readonly ExportKind[];
}

// ─── Export ──────────────────────────────────────────────────────

const JSON_COLUMNS: Record<ExportKind, string[]> = {
  memories: ["source_exchanges"],
  entities: ["aliases"],
  relationships: ["source_memories"],
  commitments: ["source_exchanges"],
};

const BOOLEAN_COLUMNS: Record<ExportKind, string[]> = {
  memories: ["is_active"],
  entities: [],
  relationships: [],
  commitments: [],
};

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeRow(kind: ExportKind, row: Record<string, unknown>): ExportRow {
  const out: Record<string, unknown> = { ...row };
  for (const col of JSON_COLUMNS[kind]) {
    if (col in out) out[col] = decodeJson(out[col]);
  }
  for (const col of BOOLEAN_COLUMNS[kind]) {
    if (col in out && out[col] !== null && out[col] !== undefined) out[col] = Boolean(out[col]);
  }
  return out as ExportRow;
}

function readRows(db: Database.Database, kind: ExportKind, opts: ExportOptions): ExportRow[] {
  let sql = `SELECT * FROM ${kind}`;
  const params: unknown[] = [];
  if (kind === "memories") {
    // Forgotten memories (#55) are never exported, even with includeInactive:
    // importing them elsewhere would resurrect what the user deleted.
    const where: string[] = ["deleted_at IS NULL"];
    if (!opts.includeInactive) where.push("is_active = 1");
    if (opts.scopes && opts.scopes.length > 0) {
      where.push(`scope IN (${opts.scopes.map(() => "?").join(", ")})`);
      params.push(...opts.scopes);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  }
  sql += " ORDER BY created_at, id";
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => decodeRow(kind, r));
}

function readSchemaVersion(db: Database.Database): string[] {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return [];
  const rows = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Build the JSONL export as an array of lines (header first). Rows are read
 * eagerly so the header can carry exact counts.
 */
export function exportLines(db: Database.Database, opts: ExportOptions = {}): string[] {
  const kinds = opts.kinds ?? ALL_KINDS;
  const rowsByKind = new Map<ExportKind, ExportRow[]>();
  const counts: Partial<Record<ExportKind, number>> = {};
  for (const kind of ALL_KINDS) {
    if (!kinds.includes(kind)) continue;
    const rows = readRows(db, kind, opts);
    rowsByKind.set(kind, rows);
    counts[kind] = rows.length;
  }

  const header: ExportHeader = {
    kind: "header",
    v: EXPORT_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    schema_version: readSchemaVersion(db),
    counts,
    scopes: opts.scopes && opts.scopes.length > 0 ? [...opts.scopes] : null,
    include_inactive: Boolean(opts.includeInactive),
    embeddings: "not exported; regenerated on import from content",
  };

  const lines = [JSON.stringify(header)];
  for (const kind of ALL_KINDS) {
    const rows = rowsByKind.get(kind);
    if (!rows) continue;
    const recordKind = TABLE_TO_KIND[kind];
    for (const data of rows) {
      const record: ExportRecord = { kind: recordKind, v: EXPORT_FORMAT_VERSION, data };
      lines.push(JSON.stringify(record));
    }
  }
  return lines;
}

// ─── Parsing ─────────────────────────────────────────────────────

export class ImportFormatError extends Error {
  constructor(
    public readonly line: number,
    detail: string,
  ) {
    super(`import: malformed line ${line}: ${detail}`);
    this.name = "ImportFormatError";
  }
}

const REQUIRED_STRING_FIELDS: Record<RecordKind, string[]> = {
  memory: ["id", "type", "content"],
  entity: ["id", "name", "type"],
  relationship: ["id", "source_entity_id", "target_entity_id", "type"],
  commitment: ["id", "content"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse and validate one JSONL line. Throws ImportFormatError (with the
 * 1-based line number) on invalid JSON, unknown kind, unsupported version,
 * or a record missing its required fields.
 */
export function parseExportLine(line: string, lineNo: number): ExportLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new ImportFormatError(lineNo, `invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(parsed)) throw new ImportFormatError(lineNo, "expected a JSON object");
  if (parsed.v !== EXPORT_FORMAT_VERSION) {
    throw new ImportFormatError(lineNo, `unsupported format version ${JSON.stringify(parsed.v)} (expected ${EXPORT_FORMAT_VERSION})`);
  }
  const kind = parsed.kind;
  if (kind === "header") return parsed as unknown as ExportHeader;
  if (typeof kind !== "string" || !(kind in KIND_TO_TABLE)) {
    throw new ImportFormatError(lineNo, `unknown kind ${JSON.stringify(kind)}`);
  }
  const data = parsed.data;
  if (!isRecord(data)) throw new ImportFormatError(lineNo, "missing data object");
  for (const field of REQUIRED_STRING_FIELDS[kind as RecordKind]) {
    if (typeof data[field] !== "string" || data[field] === "") {
      throw new ImportFormatError(lineNo, `${kind}.${field} must be a non-empty string`);
    }
  }
  return { kind: kind as RecordKind, v: EXPORT_FORMAT_VERSION, data: data as ExportRow };
}

// ─── Import ──────────────────────────────────────────────────────

export interface KindSummary {
  inserted: number;
  updated: number;
  skipped: number;
}

export interface ImportSummary {
  dryRun: boolean;
  /** Records considered (header lines excluded). */
  total: number;
  memories: KindSummary;
  entities: KindSummary;
  relationships: KindSummary & { missingEndpoint: number };
  commitments: KindSummary;
}

export interface ImportOptions {
  /** Override the scope on every imported memory. */
  scope?: string;
  /** Validate and plan, but write nothing (no embeddings computed either). */
  dryRun?: boolean;
  /** Records per embed+write batch (default 100). */
  batchSize?: number;
  /** Called after each batch with (records done, total records). */
  onProgress?: (done: number, total: number) => void;
}

type Action = "insert" | "update" | "skip" | "missing";

const DEFAULT_BATCH = 100;

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function nullNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function nullStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    const decoded = decodeJson(v);
    return Array.isArray(decoded) ? decoded.filter((x): x is string => typeof x === "string") : [];
  }
  return [];
}

/**
 * The per-kind "version" used for newer-wins: memories/relationships use
 * updated_at, entities last_seen, commitments resolved_at — each falling
 * back to created_at. Missing everywhere → 0 (never newer than a real row).
 */
function versionOf(kind: RecordKind, row: Record<string, unknown>): number {
  const created = num(row.created_at, 0);
  switch (kind) {
    case "memory":
    case "relationship":
      return num(row.updated_at, created);
    case "entity":
      return num(row.last_seen, created);
    case "commitment":
      return num(row.resolved_at, created);
  }
}

function toMemory(data: ExportRow, now: number): Memory {
  return {
    id: data.id,
    type: data.type as MemoryType,
    content: data.content as string,
    context: optStr(data.context),
    confidence: num(data.confidence, 0.5),
    importance: num(data.importance, 0.5),
    accessCount: num(data.access_count, 0),
    lastAccessed: optNum(data.last_accessed),
    createdAt: num(data.created_at, now),
    updatedAt: optNum(data.updated_at),
    sourceExchanges: strArray(data.source_exchanges),
    supersededBy: optStr(data.superseded_by),
    isActive: data.is_active === undefined || data.is_active === null ? true : Boolean(data.is_active),
    source: (optStr(data.source) as MemorySource | undefined) ?? "import",
    scope: optStr(data.scope) ?? "global",
    stability: optNum(data.stability),
    eventTs: optNum(data.event_ts),
    extractionBasis: optStr(data.extraction_basis) as Memory["extractionBasis"],
  };
}

function toEntity(data: ExportRow, now: number): Entity {
  const created = num(data.created_at, now);
  return {
    id: data.id,
    name: data.name as string,
    type: data.type as EntityType,
    description: optStr(data.description),
    aliases: strArray(data.aliases),
    firstSeen: num(data.first_seen, created),
    lastSeen: num(data.last_seen, created),
    mentionCount: num(data.mention_count, 1),
    createdAt: created,
  };
}

function toRelationship(data: ExportRow, now: number): Relationship {
  return {
    id: data.id,
    sourceEntityId: data.source_entity_id as string,
    targetEntityId: data.target_entity_id as string,
    type: data.type as RelationshipType,
    weight: num(data.weight, 1),
    context: optStr(data.context),
    sourceMemories: strArray(data.source_memories),
    createdAt: num(data.created_at, now),
    updatedAt: optNum(data.updated_at),
  };
}

interface Planned {
  record: ExportRecord;
  action: Action;
}

/**
 * Import parsed JSONL lines into `db`. See module docs for semantics.
 * Throws ImportFormatError before touching the database if any line is
 * malformed.
 */
export async function importLines(
  db: Database.Database,
  lines: readonly string[],
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  // Phase 1: parse + validate everything up front (no writes yet).
  const records: ExportRecord[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const parsed = parseExportLine(line, i + 1);
    if (parsed.kind === "header") return;
    records.push(parsed);
  });

  if (opts.scope !== undefined) {
    for (const r of records) if (r.kind === "memory") r.data.scope = opts.scope;
  }

  // Apply in dependency order regardless of file order.
  const order: RecordKind[] = ["entity", "memory", "relationship", "commitment"];
  records.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  const summary: ImportSummary = {
    dryRun: Boolean(opts.dryRun),
    total: records.length,
    memories: { inserted: 0, updated: 0, skipped: 0 },
    entities: { inserted: 0, updated: 0, skipped: 0 },
    relationships: { inserted: 0, updated: 0, skipped: 0, missingEndpoint: 0 },
    commitments: { inserted: 0, updated: 0, skipped: 0 },
  };

  const dryRun = Boolean(opts.dryRun);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const now = Math.floor(Date.now() / 1000);
  const hasEntityFts = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entities_fts'").get(),
  );

  const existingStmt: Record<RecordKind, Database.Statement> = {
    memory: db.prepare("SELECT * FROM memories WHERE id = ?"),
    entity: db.prepare("SELECT * FROM entities WHERE id = ?"),
    relationship: db.prepare("SELECT * FROM relationships WHERE id = ?"),
    commitment: db.prepare("SELECT * FROM commitments WHERE id = ?"),
  };
  const entityExists = db.prepare("SELECT 1 FROM entities WHERE id = ?");
  const relByIdExists = db.prepare("SELECT 1 FROM relationships WHERE id = ?");

  // Entity ids that will exist once this run completes (dry-run never
  // writes, so the DB alone cannot answer endpoint checks).
  const pendingEntityIds = new Set<string>();

  function decide(record: ExportRecord): Action {
    const existing = existingStmt[record.kind].get(record.data.id) as Record<string, unknown> | undefined;
    if (record.kind === "relationship") {
      const src = record.data.source_entity_id as string;
      const dst = record.data.target_entity_id as string;
      const has = (id: string) => pendingEntityIds.has(id) || Boolean(entityExists.get(id));
      if (!has(src) || !has(dst)) return "missing";
    }
    if (!existing) return "insert";
    return versionOf(record.kind, record.data) > versionOf(record.kind, existing) ? "update" : "skip";
  }

  function tally(kind: RecordKind, action: Action): void {
    const bucket = summary[KIND_TO_TABLE[kind]];
    if (action === "insert") bucket.inserted++;
    else if (action === "update") bucket.updated++;
    else {
      bucket.skipped++;
      if (action === "missing") summary.relationships.missingEndpoint++;
    }
  }

  let done = 0;
  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const planned: Planned[] = [];
    for (const record of batch) {
      const action = decide(record);
      if (record.kind === "entity" && action !== "skip") pendingEntityIds.add(record.data.id);
      planned.push({ record, action });
      tally(record.kind, action);
    }

    if (!dryRun) {
      // Embeddings first (async, outside the transaction), then one
      // synchronous transaction for the batch.
      const memTexts: string[] = [];
      const entTexts: string[] = [];
      for (const { record, action } of planned) {
        if (action !== "insert" && action !== "update") continue;
        if (record.kind === "memory") memTexts.push(record.data.content as string);
        else if (record.kind === "entity" && !STRUCTURAL_ENTITY_TYPES.has(record.data.type as string)) {
          entTexts.push(record.data.name as string);
        }
      }
      const memVecs = await embedDocumentBatch(memTexts);
      const entVecs = await embedDocumentBatch(entTexts);
      let mi = 0;
      let ei = 0;

      db.transaction(() => {
        for (const { record, action } of planned) {
          if (action !== "insert" && action !== "update") continue;
          switch (record.kind) {
            case "memory":
              applyMemory(db, record.data, action, memVecs[mi++], now);
              break;
            case "entity": {
              const structural = STRUCTURAL_ENTITY_TYPES.has(record.data.type as string);
              applyEntity(db, record.data, action, structural ? null : entVecs[ei++], now, hasEntityFts);
              break;
            }
            case "relationship":
              applyRelationship(db, record.data, action, now, relByIdExists, summary);
              break;
            case "commitment":
              applyCommitment(db, record.data, action, now);
              break;
          }
        }
      })();
    }

    done += batch.length;
    opts.onProgress?.(done, records.length);
  }

  return summary;
}

// ─── Per-kind writers ────────────────────────────────────────────

function applyMemory(
  db: Database.Database,
  data: ExportRow,
  action: "insert" | "update",
  embedding: number[],
  now: number,
): void {
  const memory = toMemory(data, now);
  if (action === "insert") {
    insertMemory(db, memory, embedding);
    return;
  }
  // Update in place: keep memories_fts (external-content) in step via the
  // FTS helpers, overwrite every column, regenerate the vector.
  const existing = db
    .prepare("SELECT rowid, content, context FROM memories WHERE id = ?")
    .get(memory.id) as { rowid: number; content: string; context: string | null };
  deleteFtsRow(db, "memories_fts", existing.rowid, { content: existing.content, context: existing.context });
  db.prepare(
    `UPDATE memories SET
       type = ?, content = ?, context = ?, confidence = ?, importance = ?,
       access_count = ?, last_accessed = ?, created_at = ?, updated_at = ?,
       source_exchanges = ?, superseded_by = ?, is_active = ?, source = ?,
       scope = ?, stability = ?, event_ts = ?, extraction_basis = ?
     WHERE id = ?`,
  ).run(
    memory.type,
    memory.content,
    memory.context ?? null,
    memory.confidence,
    memory.importance,
    memory.accessCount,
    memory.lastAccessed ?? null,
    memory.createdAt,
    memory.updatedAt ?? null,
    JSON.stringify(memory.sourceExchanges),
    memory.supersededBy ?? null,
    memory.isActive ? 1 : 0,
    memory.source ?? "import",
    memory.scope ?? "global",
    memory.stability ?? null,
    memory.eventTs ?? null,
    memory.extractionBasis ?? "observed",
    memory.id,
  );
  insertFtsRow(db, "memories_fts", existing.rowid, { content: memory.content, context: memory.context ?? null });
  insertVector(db, "vec_memories", memory.id, embedding);
}

function applyEntity(
  db: Database.Database,
  data: ExportRow,
  action: "insert" | "update",
  embedding: number[] | null,
  now: number,
  hasFts: boolean,
): void {
  const entity = toEntity(data, now);
  if (action === "insert") {
    insertEntity(db, entity, embedding);
  } else {
    const existing = db
      .prepare("SELECT rowid, name, description FROM entities WHERE id = ?")
      .get(entity.id) as { rowid: number; name: string; description: string | null };
    if (hasFts) {
      deleteFtsRow(db, "entities_fts", existing.rowid, { name: existing.name, description: existing.description });
    }
    db.prepare(
      `UPDATE entities SET
         name = ?, type = ?, description = ?, aliases = ?, first_seen = ?,
         last_seen = ?, mention_count = ?, created_at = ?
       WHERE id = ?`,
    ).run(
      entity.name,
      entity.type,
      entity.description ?? null,
      JSON.stringify(entity.aliases),
      entity.firstSeen,
      entity.lastSeen,
      entity.mentionCount,
      entity.createdAt,
      entity.id,
    );
    if (hasFts) {
      insertFtsRow(db, "entities_fts", existing.rowid, { name: entity.name, description: entity.description ?? null });
    }
    if (embedding) insertVector(db, "vec_entities", entity.id, embedding);
    else deleteVector(db, "vec_entities", entity.id);
  }
  // Columns the Entity type does not carry (IDF bookkeeping) — plain
  // columns, no FTS/vector involvement.
  db.prepare("UPDATE entities SET conversation_count = ?, informativeness = ? WHERE id = ?").run(
    num(data.conversation_count, 0),
    num(data.informativeness, 0),
    entity.id,
  );
}

function applyRelationship(
  db: Database.Database,
  data: ExportRow,
  action: "insert" | "update",
  now: number,
  relByIdExists: Database.Statement,
  summary: ImportSummary,
): void {
  const rel = toRelationship(data, now);
  if (action === "insert") {
    // INSERT OR IGNORE: a different id for the same (source, target, type)
    // edge is silently ignored by the unique index — report it as skipped.
    insertRelationship(db, rel);
    if (!relByIdExists.get(rel.id)) {
      summary.relationships.inserted--;
      summary.relationships.skipped++;
    }
    return;
  }
  db.prepare(
    `UPDATE relationships SET
       source_entity_id = ?, target_entity_id = ?, type = ?, weight = ?,
       context = ?, source_memories = ?, created_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    rel.sourceEntityId,
    rel.targetEntityId,
    rel.type,
    rel.weight,
    rel.context ?? null,
    JSON.stringify(rel.sourceMemories),
    rel.createdAt,
    rel.updatedAt ?? null,
    rel.id,
  );
}

function applyCommitment(
  db: Database.Database,
  data: ExportRow,
  action: "insert" | "update",
  now: number,
): void {
  const values = [
    data.content as string,
    optStr(data.status) ?? "pending",
    optStr(data.origin) ?? "stated",
    optStr(data.subject) ?? "devin",
    JSON.stringify(strArray(data.source_exchanges)),
    nullNum(data.due_at),
    num(data.created_at, now),
    nullNum(data.resolved_at),
    nullStr(data.superseded_by),
  ];
  if (action === "insert") {
    db.prepare(
      `INSERT INTO commitments
         (id, content, status, origin, subject, source_exchanges, due_at, created_at, resolved_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(data.id, ...values);
    return;
  }
  db.prepare(
    `UPDATE commitments SET
       content = ?, status = ?, origin = ?, subject = ?, source_exchanges = ?,
       due_at = ?, created_at = ?, resolved_at = ?, superseded_by = ?
     WHERE id = ?`,
  ).run(...values, data.id);
}

/** Human-readable import summary lines for the CLI. */
export function formatImportSummary(summary: ImportSummary): string[] {
  const lines: string[] = [];
  lines.push(summary.dryRun ? `Dry run — nothing written (${summary.total} records):` : `Import complete (${summary.total} records):`);
  for (const kind of ALL_KINDS) {
    const s = summary[kind];
    let line = `  ${kind.padEnd(14)} inserted ${s.inserted}, updated ${s.updated}, skipped ${s.skipped}`;
    if (kind === "relationships" && summary.relationships.missingEndpoint > 0) {
      line += ` (${summary.relationships.missingEndpoint} missing endpoint)`;
    }
    lines.push(line);
  }
  return lines;
}
