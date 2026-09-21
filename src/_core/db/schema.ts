import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EngramConfig } from "../types/index.js";

/**
 * Initialize the Engram database with all tables, indexes, and virtual tables.
 * Idempotent — safe to call on every startup.
 */
export function initDatabase(config: EngramConfig): Database.Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);

  // Performance: WAL mode for concurrent reads + single writer
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Several connections share this file (MCP main thread + worker threads,
  // CLI, dream pipeline). Wait for a busy writer instead of failing instantly.
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
  db.pragma("cache_size = -64000"); // 64MB page cache

  // Load sqlite-vec extension for vector similarity search. It ships prebuilt
  // binaries for a fixed set of platforms (darwin/linux x64+arm64, windows x64);
  // anywhere else the load throws an opaque error, so translate it.
  try {
    sqliteVec.load(db);
  } catch (err) {
    db.close();
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `engram: failed to load the sqlite-vec extension for ${process.platform}-${process.arch} ` +
        `(node ${process.version}). Vector search requires a sqlite-vec prebuilt for this platform; ` +
        `see https://github.com/asg017/sqlite-vec/releases. Underlying error: ${detail}`,
    );
  }

  // Run schema migrations
  createSchema(db, config);

  return db;
}

function createSchema(db: Database.Database, config: EngramConfig): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- LAYER 1: EPISODIC STORE
    -- Raw conversation exchanges — what happened
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT,
      assistant_message TEXT,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      model_version TEXT,
      exchange_index INTEGER,
      token_estimate INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      last_accessed INTEGER,
      author_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_exchanges_project ON exchanges(project);
    CREATE INDEX IF NOT EXISTS idx_exchanges_session ON exchanges(session_id);
    CREATE INDEX IF NOT EXISTS idx_exchanges_conversation ON exchanges(conversation_id);

    -- Tool calls within exchanges
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result_summary TEXT,
      is_error BOOLEAN DEFAULT FALSE,
      timestamp TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_exchange ON tool_calls(exchange_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

    -- Conversation-level metadata
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exchange_count INTEGER,
      summary TEXT,
      primary_topics TEXT,
      archive_path TEXT,
      last_indexed INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project);

    -- ═══════════════════════════════════════════════════════════════
    -- LAYER 2: SEMANTIC STORE
    -- Extracted knowledge — what it means
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (
        'preference', 'decision', 'pattern', 'fact', 'solution', 'convention'
      )),
      content TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 0.5,
      importance REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER,
      source_exchanges TEXT,
      superseded_by TEXT,
      is_active BOOLEAN DEFAULT TRUE
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_active);

    -- Conflict tracking between memories
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id),
      conflicting_memory_id TEXT NOT NULL REFERENCES memories(id),
      description TEXT,
      resolution TEXT,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- ═══════════════════════════════════════════════════════════════
    -- LAYER 3: KNOWLEDGE GRAPH
    -- Entity relationships — how things connect
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'project', 'tool', 'technology', 'person', 'concept', 'file', 'repo'
      )),
      description TEXT,
      aliases TEXT,
      first_seen INTEGER,
      last_seen INTEGER,
      mention_count INTEGER DEFAULT 1,
      conversation_count INTEGER DEFAULT 0,
      informativeness REAL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

    -- Entity-to-conversation junction: tracks which conversations each entity appeared in.
    -- Used for Entity-IDF computation (informativeness scoring).
    CREATE TABLE IF NOT EXISTS entity_conversations (
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      first_mentioned INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (entity_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ec_entity ON entity_conversations(entity_id);
    CREATE INDEX IF NOT EXISTS idx_ec_conversation ON entity_conversations(conversation_id);

    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entities(id),
      target_entity_id TEXT NOT NULL REFERENCES entities(id),
      type TEXT NOT NULL CHECK(type IN (
        'uses', 'depends_on', 'related_to', 'part_of', 'configured_by', 'solved_by'
      )),
      weight REAL DEFAULT 1.0,
      context TEXT,
      source_memories TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);

    -- Unique constraint: prevent duplicate edges (same source, target, type)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique_edge
      ON relationships(source_entity_id, target_entity_id, type);

    -- Composite indexes for bidirectional traversal
    CREATE INDEX IF NOT EXISTS idx_rel_source_target
      ON relationships(source_entity_id, target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target_source
      ON relationships(target_entity_id, source_entity_id);

    -- Case-insensitive name index
    CREATE INDEX IF NOT EXISTS idx_entities_name_lower
      ON entities(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS topic_clusters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      entity_ids TEXT,
      memory_ids TEXT,
      coherence_score REAL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER,
      generation INTEGER DEFAULT 1
    );

    -- ═══════════════════════════════════════════════════════════════
    -- DREAM STATE TRACKING
    -- Processing checkpoints and reports
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      phases_completed TEXT,
      new_memories INTEGER DEFAULT 0,
      updated_memories INTEGER DEFAULT 0,
      new_entities INTEGER DEFAULT 0,
      new_relationships INTEGER DEFAULT 0,
      conflicts_detected INTEGER DEFAULT 0,
      memories_pruned INTEGER DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS dream_checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES dream_runs(id),
      phase TEXT NOT NULL,
      item_id TEXT NOT NULL,
      processed_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_dream_checkpoints_run ON dream_checkpoints(run_id, phase);

    -- Chunk metadata for adaptive chunking diagnostics
    CREATE TABLE IF NOT EXISTS chunk_metadata (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_exchange INTEGER NOT NULL,
      end_exchange INTEGER NOT NULL,
      exchange_count INTEGER NOT NULL,
      avg_density REAL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_metadata_conversation
      ON chunk_metadata(conversation_id);

    -- ═══════════════════════════════════════════════════════════════
    -- PHASE 6: REFLECTION & EMERGENCE
    -- Bridge scores, temporal patterns, reflection observations
    -- ═══════════════════════════════════════════════════════════════

    -- Bridge entity scores per dream generation
    CREATE TABLE IF NOT EXISTS bridge_scores (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      betweenness REAL NOT NULL,
      community_span INTEGER NOT NULL,
      bridge_score REAL NOT NULL,
      narrative TEXT,
      generation INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (entity_id, generation)
    );

    CREATE INDEX IF NOT EXISTS idx_bridge_scores_generation
      ON bridge_scores(generation);
    CREATE INDEX IF NOT EXISTS idx_bridge_scores_score
      ON bridge_scores(bridge_score DESC);

    -- Detected temporal patterns
    CREATE TABLE IF NOT EXISTS temporal_patterns (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (
        'entity_burst', 'community_shift', 'phase_transition',
        'topic_emergence', 'topic_decay', 'bridge_formation'
      )),
      description TEXT NOT NULL,
      entity_ids TEXT,
      time_start INTEGER,
      time_end INTEGER,
      confidence REAL DEFAULT 0.5,
      metadata TEXT,
      generation INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_temporal_patterns_generation
      ON temporal_patterns(generation);
    CREATE INDEX IF NOT EXISTS idx_temporal_patterns_type
      ON temporal_patterns(type);

    -- Higher-order observations from reflection
    CREATE TABLE IF NOT EXISTS reflection_observations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (
        'community_summary', 'bridge_narrative', 'temporal_insight',
        'growth_observation', 'quality_assessment'
      )),
      content TEXT NOT NULL,
      related_entity_ids TEXT,
      confidence REAL DEFAULT 0.7,
      generation INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_reflection_obs_generation
      ON reflection_observations(generation);
  `);

  // ─── Phase 7B.1: Expand entity/relationship type constraints ───
  migrateExpandedTypes(db);

  // ─── Schema Migrations (idempotent ALTER TABLE) ────────────────
  // Add checkpoint status tracking for retry logic
  idempotentAlter(db, "dream_checkpoints", "status", "ALTER TABLE dream_checkpoints ADD COLUMN status TEXT DEFAULT 'success'");
  idempotentAlter(db, "dream_checkpoints", "provider", "ALTER TABLE dream_checkpoints ADD COLUMN provider TEXT");
  idempotentAlter(db, "dream_checkpoints", "error_class", "ALTER TABLE dream_checkpoints ADD COLUMN error_class TEXT");
  idempotentAlter(db, "dream_checkpoints", "error_message", "ALTER TABLE dream_checkpoints ADD COLUMN error_message TEXT");
  idempotentAlter(db, "dream_checkpoints", "attempt_count", "ALTER TABLE dream_checkpoints ADD COLUMN attempt_count INTEGER DEFAULT 1");

  // W12: fingerprint of the conversation's exchanges at extract time, so
  // later runs skip conversations that have not changed (NULL = legacy
  // checkpoint, extracted once more and then fingerprinted).
  idempotentAlter(db, "dream_checkpoints", "fingerprint", "ALTER TABLE dream_checkpoints ADD COLUMN fingerprint TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_dream_checkpoints_item ON dream_checkpoints(phase, item_id)");

  // Add extraction_basis metadata to memories
  idempotentAlter(db, "memories", "extraction_basis", "ALTER TABLE memories ADD COLUMN extraction_basis TEXT DEFAULT 'observed'");

  // Phase 6D: Add source tracking to memories (user, dream, rlm, import)
  idempotentAlter(db, "memories", "source", "ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");

  // ADR-010: per-tenant scoping for Hermes integration.
  // 'global' = Claude Code / dream derived; 'hermes:<profile>' = Hermes-originated.
  idempotentAlter(db, "memories", "scope", "ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");

  // ADR-010 upgrade: persist FSRS stability (NULL = derive from type constant)
  idempotentAlter(db, "memories", "stability", "ALTER TABLE memories ADD COLUMN stability REAL");

  // Temporal recall: "filed" basis filters need created_at indexed; the
  // "event" basis reads the denormalized earliest-source-exchange timestamp
  // (NULL = unresolvable → falls back to created_at at query time).
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)");
  const addedEventTs = idempotentAlter(
    db, "memories", "event_ts", "ALTER TABLE memories ADD COLUMN event_ts INTEGER",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_event_ts ON memories(event_ts)");
  if (addedEventTs) {
    // One-time backfill on the open that introduced the column. Idempotent
    // (only NULL rows are touched) and content-neutral; re-runnable via
    // backfillEventTs() for rows that gain resolvable sources later.
    backfillEventTs(db);
  }

  // Commitments ledger ("mention once, never dropped"): first-person promises,
  // intentions, and follow-ups owed by others, extracted by the dream EXTRACT
  // phase (semantic/commitments.ts). Idempotent, and checkpointed in
  // schema_migrations so a re-open is a provable no-op.
  migrateCommitments(db);

  // #25: tenant scope on exchanges/entities/relationships/commitments (after the
  // entity/relationship rebuild and after the commitments table exists).
  migrateGraphScope(db);

  // W2: conversations.scope — tenant scope of a conversation's origin
  // ('global' for Claude Code transcripts, 'hermes:<profile>' for turns pushed
  // via the ingest_turn tool). The dream consolidate phase stamps every memory
  // extracted from a conversation with this scope (ADR-010 inheritance).
  migrateConversationScope(db);

  // #18: exchanges.author_json — who authored the user side of a turn pushed
  // via ingest_turn ({id, name, is_bot} as JSON). NULL for Claude Code
  // transcripts and for turns sent without an author.
  migrateExchangeAuthor(db);

  // #55: forget tool + memory inspection surface — soft-delete columns on
  // memories, the memory change log, the content-hash suppression table and
  // the graph `stale_since` flags (#56/#57). Must run AFTER
  // migrateExpandedTypes (entities/relationships rebuild).
  migrateForget(db);
  migrateSuppressionScope(db);

  // FTS5 virtual tables (created separately — can't use IF NOT EXISTS)
  createFtsIfNeeded(db, "exchanges_fts", `
    CREATE VIRTUAL TABLE exchanges_fts USING fts5(
      user_message,
      assistant_message,
      content='exchanges',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  createFtsIfNeeded(db, "memories_fts", `
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content,
      context,
      content='memories',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  createFtsIfNeeded(db, "entities_fts", `
    CREATE VIRTUAL TABLE entities_fts USING fts5(
      name,
      description,
      content='entities',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  // Vector virtual tables
  const dims = config.embedding.dimensions;
  createVecIfNeeded(db, "vec_exchanges", dims);
  createVecIfNeeded(db, "vec_memories", dims);
  createVecIfNeeded(db, "vec_entities", dims);

  pruneZeroEntityVectors(db);
}

/**
 * Remove all-zero vectors that file-structure indexing used to write for
 * file/symbol entities. A zero vector is not neutral in an L2 vec0 table —
 * it sits at distance 1.0 from every unit query and out-ranks real
 * entities. Only structural entity types are inspected; only rows whose
 * embedding is entirely zero are deleted; re-indexing the file restores
 * nothing because structural entities no longer get vectors at all.
 * Idempotent: after the first pass there is nothing to read or delete.
 */
export function pruneZeroEntityVectors(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT v.id, v.embedding FROM vec_entities v
       JOIN entities e ON e.id = v.id
       WHERE e.type IN ('file', 'function', 'class', 'module')`,
    )
    .all() as Array<{ id: string; embedding: Buffer }>;

  const zeroIds = rows
    .filter((r) => {
      const f = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      return f.every((x) => x === 0);
    })
    .map((r) => r.id);

  if (zeroIds.length === 0) return 0;

  const del = db.prepare("DELETE FROM vec_entities WHERE id = ?");
  db.transaction(() => {
    for (const id of zeroIds) del.run(id);
  })();
  return zeroIds.length;
}

/**
 * Phase 7B.1: Expand CHECK constraints on entities and relationships tables
 * to support new types (function, class, module, contains).
 *
 * SQLite CHECK constraints can't be altered in-place, so we recreate the
 * tables if the new types aren't already supported.
 */
function migrateExpandedTypes(db: Database.Database): void {
  // Fast path: the CHECK constraint text is in sqlite_master, so migrated
  // databases are recognized without a probe write on every startup
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entities'")
    .get() as { sql: string } | undefined;
  if (ddl?.sql.includes("'function'")) return;

  // Test if new types are already supported
  const testId = '__type_migration_test__';
  try {
    db.exec('SAVEPOINT type_test');
    db.prepare("INSERT INTO entities (id, name, type) VALUES (?, ?, ?)").run(testId, '__test__', 'function');
    // Worked — new types already supported, clean up
    db.prepare("DELETE FROM entities WHERE id = ?").run(testId);
    db.exec('RELEASE type_test');
    return;
  } catch {
    db.exec('ROLLBACK TO type_test');
    db.exec('RELEASE type_test');
  }

  // Need to recreate tables with expanded CHECK constraints
  // Entities table
  db.exec(`
    CREATE TABLE entities_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'project', 'tool', 'technology', 'person', 'concept', 'file', 'repo',
        'function', 'class', 'module'
      )),
      description TEXT,
      aliases TEXT,
      first_seen INTEGER,
      last_seen INTEGER,
      mention_count INTEGER DEFAULT 1,
      conversation_count INTEGER DEFAULT 0,
      informativeness REAL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    INSERT INTO entities_new (id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at)
      SELECT id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at FROM entities;
    DROP TABLE entities;
    ALTER TABLE entities_new RENAME TO entities;

    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_name_lower ON entities(name COLLATE NOCASE);
  `);

  // Relationships table
  db.exec(`
    CREATE TABLE relationships_new (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entities(id),
      target_entity_id TEXT NOT NULL REFERENCES entities(id),
      type TEXT NOT NULL CHECK(type IN (
        'uses', 'depends_on', 'related_to', 'part_of', 'configured_by', 'solved_by',
        'contains'
      )),
      weight REAL DEFAULT 1.0,
      context TEXT,
      source_memories TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER
    );
    INSERT INTO relationships_new SELECT * FROM relationships;
    DROP TABLE relationships;
    ALTER TABLE relationships_new RENAME TO relationships;

    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique_edge ON relationships(source_entity_id, target_entity_id, type);
    CREATE INDEX IF NOT EXISTS idx_rel_source_target ON relationships(source_entity_id, target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target_source ON relationships(target_entity_id, source_entity_id);
  `);
}

function createFtsIfNeeded(
  db: Database.Database,
  tableName: string,
  createSql: string,
): void {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(tableName);
  if (!exists) {
    db.exec(createSql);
  }
}

/**
 * Idempotent ALTER TABLE — adds a column only if it doesn't already exist.
 * Uses PRAGMA table_info to check for the column's presence.
 * Returns true when the column was added by this call.
 */
function idempotentAlter(
  db: Database.Database,
  table: string,
  column: string,
  alterSql: string,
): boolean {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    db.exec(alterSql);
    return true;
  }
  return false;
}

/** Checkpoint name recorded in schema_migrations when the commitments table is created. */
export const COMMITMENTS_MIGRATION = "commitments_v1";

/** Checkpoint name recorded in schema_migrations when conversations.scope is added. */
export const CONVERSATIONS_SCOPE_MIGRATION = "conversations_scope_v1";

/**
 * Add `conversations.scope` (nullable, default 'global') plus its index and
 * record the checkpoint. Mirrors the memories.scope migration but is also
 * checkpointed in schema_migrations so a re-open is a provable no-op.
 * Existing rows take the column default, so pre-existing Claude Code
 * conversations keep 'global' semantics. Returns `true` only on the open
 * that introduced the column.
 */
export function migrateConversationScope(db: Database.Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);
  const added = idempotentAlter(
    db, "conversations", "scope", "ALTER TABLE conversations ADD COLUMN scope TEXT DEFAULT 'global'",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(scope)");
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(CONVERSATIONS_SCOPE_MIGRATION);
  return added;
}

/** Checkpoint name recorded in schema_migrations when scope lands on exchanges, entities, relationships, commitments. */
export const GRAPH_SCOPE_MIGRATION = "graph_scope_v1";

/** Tables that carry a tenant `scope` column since #25 (memories and conversations had one before). */
export const SCOPED_TABLES = ["exchanges", "entities", "relationships", "commitments"] as const;

/**
 * #25: `scope TEXT DEFAULT 'global'` + index on exchanges, entities,
 * relationships and commitments, so episodic recall, explore and the
 * commitments ledger can honour read_scopes like the semantic layer does.
 * Existing rows take the default. Must run AFTER migrateExpandedTypes (which
 * rebuilds entities/relationships with `INSERT ... SELECT *`) and AFTER
 * migrateCommitments (which creates the table). Returns `true` only on the
 * open that added at least one column.
 */
export function migrateGraphScope(db: Database.Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);
  let added = false;
  for (const table of SCOPED_TABLES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) continue;
    if (idempotentAlter(db, table, "scope", `ALTER TABLE ${table} ADD COLUMN scope TEXT DEFAULT 'global'`)) added = true;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_scope ON ${table}(scope)`);
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(GRAPH_SCOPE_MIGRATION);
  return added;
}

/** Checkpoint name recorded in schema_migrations when exchanges.author_json is added. */
export const EXCHANGES_AUTHOR_MIGRATION = "exchanges_author_v1";

/**
 * Add the nullable `exchanges.author_json` column and record the checkpoint.
 * Same shape as migrateConversationScope; existing rows stay NULL. Returns
 * `true` only on the open that introduced the column.
 */
export function migrateExchangeAuthor(db: Database.Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);
  const added = idempotentAlter(db, "exchanges", "author_json", "ALTER TABLE exchanges ADD COLUMN author_json TEXT");
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(EXCHANGES_AUTHOR_MIGRATION);
  return added;
}

/**
 * Create the commitments ledger (table + (status, due_at) index) and record
 * the checkpoint. Safe to call on every open: when the table and its
 * checkpoint row both exist nothing is executed and `false` is returned.
 * Returns `true` only on the open that introduced the table.
 */
export function migrateCommitments(db: Database.Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);
  const checkpointed = db
    .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
    .get(COMMITMENTS_MIGRATION);
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'commitments'")
    .get();
  if (checkpointed && tableExists) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending', 'done', 'dropped', 'superseded')) DEFAULT 'pending',
      origin TEXT CHECK(origin IN ('stated', 'inferred')) DEFAULT 'stated',
      subject TEXT DEFAULT 'devin',
      source_exchanges TEXT,
      due_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      resolved_at INTEGER,
      superseded_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_commitments_status_due ON commitments(status, due_at);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(COMMITMENTS_MIGRATION);
  return true;
}

/** Checkpoint name recorded in schema_migrations when the forget surface lands (#55). */
export const FORGET_MIGRATION = "forget_v1";

/** Operations recorded in `memory_changes.op`. */
export const MEMORY_CHANGE_OPS = ["forget", "edit", "purge", "restore"] as const;

/**
 * #55: the memory lifecycle surface behind the `forget` tool and
 * `engram memories`.
 *
 * - `memories.deleted_at` / `memories.deleted_by` — soft delete (#56): a
 *   forgotten memory keeps its row (with `is_active = 0`) until the dream
 *   prune phase purges it after `ENGRAM_FORGET_RETENTION_DAYS`; its vector
 *   and FTS rows are removed immediately.
 * - `memory_changes` — append-only audit log: one row per forget / edit /
 *   purge / restore with the content before and after and the actor (MCP
 *   client name or `cli`).
 * - `memory_suppressions` — content hashes of forgotten memories, consulted
 *   by dream extract so the same fact is not re-extracted from the same
 *   exchanges on the next run.
 * - `entities.stale_since` / `relationships.stale_since` (#57) — stamped by
 *   forget when a row loses its last evidence; dream prune deletes flagged
 *   rows with zero remaining evidence regardless of age. Forget itself never
 *   deletes graph rows.
 *
 * Idempotent and checkpointed in schema_migrations. Returns `true` only on
 * the open that added something.
 */
export function migrateForget(db: Database.Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);
  let added = false;
  if (idempotentAlter(db, "memories", "deleted_at", "ALTER TABLE memories ADD COLUMN deleted_at TEXT")) added = true;
  if (idempotentAlter(db, "memories", "deleted_by", "ALTER TABLE memories ADD COLUMN deleted_by TEXT")) added = true;
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_deleted_at ON memories(deleted_at)");

  for (const table of ["entities", "relationships"] as const) {
    if (idempotentAlter(db, table, "stale_since", `ALTER TABLE ${table} ADD COLUMN stale_since TEXT`)) added = true;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_stale_since ON ${table}(stale_since)`);
  }

  const hadChanges = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_changes'")
    .get();
  const hadSuppressions = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_suppressions'")
    .get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_changes (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('forget', 'edit', 'purge', 'restore')),
      before TEXT,
      after TEXT,
      actor TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_changes_memory ON memory_changes(memory_id, at);
    CREATE INDEX IF NOT EXISTS idx_memory_changes_at ON memory_changes(at);

    CREATE TABLE IF NOT EXISTS memory_suppressions (
      content_hash TEXT NOT NULL,
      memory_id TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, scope)
    );
  `);
  if (!hadChanges || !hadSuppressions) added = true;
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(FORGET_MIGRATION);
  return added;
}

/** Checkpoint name recorded when memory_suppressions becomes per-scope. */
export const SUPPRESSION_SCOPE_MIGRATION = "suppression_scope_v1";

/**
 * #106: `memory_suppressions` was keyed on `content_hash` alone, so one
 * tenant's forget suppressed dream re-extraction of the same sentence for
 * every tenant (and any tenant's remember lifted it). Rebuild the table with
 * `PRIMARY KEY (content_hash, scope)`, carrying the existing rows over.
 * Additive for an older build: the columns are unchanged.
 */
export function migrateSuppressionScope(db: Database.Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_suppressions'")
    .get() as { sql: string } | undefined;
  let added = false;
  if (ddl && !/PRIMARY KEY \(content_hash, scope\)/.test(ddl.sql)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE memory_suppressions_new (
          content_hash TEXT NOT NULL,
          memory_id TEXT,
          scope TEXT NOT NULL DEFAULT 'global',
          created_at TEXT NOT NULL,
          PRIMARY KEY (content_hash, scope)
        );
        INSERT OR REPLACE INTO memory_suppressions_new (content_hash, memory_id, scope, created_at)
          SELECT content_hash, memory_id, COALESCE(scope, 'global'), created_at FROM memory_suppressions;
        DROP TABLE memory_suppressions;
        ALTER TABLE memory_suppressions_new RENAME TO memory_suppressions;
      `);
    }).immediate();
    added = true;
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(SUPPRESSION_SCOPE_MIGRATION);
  return added;
}

// ─── schema version (#65) ────────────────────────────────────────────

/**
 * Every checkpoint `createSchema` records, in the order it applies them. This
 * list IS the schema version of a build: `SCHEMA_VERSION` is its length, and
 * a database's version is the checkpoints it has recorded (`schemaVersion`).
 * Append here whenever a new checkpointed migration lands.
 */
export const SCHEMA_MIGRATIONS = [
  COMMITMENTS_MIGRATION,
  GRAPH_SCOPE_MIGRATION,
  CONVERSATIONS_SCOPE_MIGRATION,
  EXCHANGES_AUTHOR_MIGRATION,
  FORGET_MIGRATION,
  SUPPRESSION_SCOPE_MIGRATION,
] as const;

/** Number of checkpointed migrations this build applies (6 as of `suppression_scope_v1`). */
export const SCHEMA_VERSION: number = SCHEMA_MIGRATIONS.length;

/**
 * Checkpoints an OLDER build cannot read past — a column dropped or renamed,
 * a table rewritten in a shape the previous release does not understand.
 * Empty today: every migration is additive (`ALTER TABLE … ADD COLUMN`,
 * `CREATE TABLE IF NOT EXISTS`), so a previous build opens a newer database
 * and simply ignores what it does not know. `engram update --rollback`
 * refuses a code-only rollback across any name listed here (decision #66);
 * add a checkpoint to this set in the same change that makes it breaking.
 */
export const BREAKING_MIGRATIONS: ReadonlySet<string> = new Set<string>();

export interface SchemaVersion {
  /** Number of checkpoints recorded in the database. */
  version: number;
  /** The recorded checkpoint names, sorted. Empty for a pre-checkpoint or fresh database. */
  applied: string[];
}

/** The checkpoints a database has recorded. Read-only; never runs a migration and never throws on an old schema. */
export function schemaVersion(db: Database.Database): SchemaVersion {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return { version: 0, applied: [] };
  const rows = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>;
  const applied = rows.map((r) => r.name);
  return { version: applied.length, applied };
}

/**
 * SQL that resolves a memory's event timestamp: the earliest `exchanges.timestamp`
 * among its `source_exchanges` ids, as unix seconds. NULL when nothing resolves.
 * Uses json_each over the stored JSON array; `memories` must be in scope.
 */
export const EVENT_TS_SUBQUERY = `(
  SELECT MIN(unixepoch(e.timestamp))
  FROM json_each(memories.source_exchanges) AS j
  JOIN exchanges AS e ON e.id = j.value
)`;

/**
 * Populate memories.event_ts from source exchanges where it is still NULL.
 *
 * Transactional, idempotent (rows already populated are never rewritten) and
 * content-neutral (only event_ts changes). Rows whose source_exchanges do
 * not resolve to real exchange ids stay NULL and fall back to created_at at
 * query time. Returns the number of rows updated.
 */
export function backfillEventTs(db: Database.Database): number {
  const run = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE memories SET event_ts = ${EVENT_TS_SUBQUERY}
         WHERE event_ts IS NULL
           AND source_exchanges IS NOT NULL
           AND json_valid(source_exchanges)
           AND json_type(source_exchanges) = 'array'
           AND ${EVENT_TS_SUBQUERY} IS NOT NULL`,
      )
      .run();
    return result.changes;
  });
  return run();
}

function createVecIfNeeded(
  db: Database.Database,
  tableName: string,
  dims: number,
): void {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(tableName);
  if (!exists) {
    db.exec(
      `CREATE VIRTUAL TABLE ${tableName} USING vec0(id TEXT PRIMARY KEY, embedding float[${dims}])`,
    );
  }
}
