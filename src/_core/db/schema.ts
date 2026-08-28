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
  db.pragma("foreign_keys = ON");
  db.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
  db.pragma("cache_size = -64000"); // 64MB page cache

  // Load sqlite-vec extension for vector similarity search
  sqliteVec.load(db);

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
      last_accessed INTEGER
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
 */
function idempotentAlter(
  db: Database.Database,
  table: string,
  column: string,
  alterSql: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    db.exec(alterSql);
  }
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
