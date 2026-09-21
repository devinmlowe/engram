import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase, insertFtsRow } from "../src/_core/db/index.js";
import { loadConfig } from "../src/_core/config/index.js";
import type Database from "better-sqlite3";
import type { EngramConfig } from "../src/_core/types/index.js";
import type { Exchange, ToolCall } from "../src/episodic/types.js";
import type { Entity, Relationship } from "../src/graph/types.js";

export interface TestDb {
  db: Database.Database;
  config: EngramConfig;
  tmpDir: string;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const tmpDir = mkdtempSync(join(tmpdir(), "engram-test-"));
  const config = loadConfig({
    dataDir: tmpDir,
    dbPath: join(tmpDir, "test.db"),
  });
  const db = initDatabase(config);
  return {
    db,
    config,
    tmpDir,
    cleanup: () => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export function createTestFixture(jsonlContent: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "engram-fixture-"));
  const filePath = join(tmpDir, "test-conversation.jsonl");
  writeFileSync(filePath, jsonlContent, "utf-8");
  return filePath;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createSyntheticExchange(
  overrides: Partial<Exchange> = {},
): Exchange {
  const id = overrides.id ?? `exch-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    conversationId: "conv-001",
    project: "test-project",
    timestamp: new Date().toISOString(),
    userMessage: "How do I use SQLite?",
    assistantMessage: "SQLite is a lightweight database...",
    exchangeIndex: 0,
    tokenEstimate: 50,
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

export function createSyntheticToolCall(
  overrides: Partial<ToolCall> = {},
): ToolCall {
  return {
    id: `tc-${Math.random().toString(36).slice(2, 10)}`,
    exchangeId: "exch-001",
    toolName: "Read",
    isError: false,
    ...overrides,
  };
}

export function createTestEntity(overrides: Partial<Entity> = {}): Entity {
  const id = overrides.id ?? `ent-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name: "TypeScript",
    type: "technology",
    description: "A typed superset of JavaScript",
    aliases: [],
    firstSeen: Math.floor(Date.now() / 1000),
    lastSeen: Math.floor(Date.now() / 1000),
    mentionCount: 1,
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ─── Raw row inserts (#126) ──────────────────────────────────────
// Seed tables directly, bypassing embeddings and the domain modules under
// test. Timestamps default to now (unix seconds); ids are the caller's.

const now = () => Math.floor(Date.now() / 1000);

export function insertEntity(
  db: Database.Database,
  id: string,
  name: string,
  type: string = "concept",
  opts: { description?: string; firstSeen?: number; lastSeen?: number; mentionCount?: number } = {},
): void {
  db.prepare(
    `INSERT INTO entities (id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(id, name, type, opts.description ?? null, opts.firstSeen ?? now(), opts.lastSeen ?? now(), opts.mentionCount ?? 1, now());
  // Mirror production insertEntity: entities_fts is external-content, so the
  // row must be indexed before a later delete/merge touches its tokens.
  const { rowid } = db.prepare("SELECT rowid FROM entities WHERE id = ?").get(id) as { rowid: number };
  insertFtsRow(db, "entities_fts", rowid, { name, description: opts.description ?? null });
}

export function insertRelationship(
  db: Database.Database,
  id: string,
  sourceId: string,
  targetId: string,
  type: string = "related_to",
  weight: number = 1.0,
  // `source_memories` stores conversation ids; production data mixes flat
  // strings and nested one-element arrays, so both shapes are accepted.
  opts: { createdAt?: number; sourceMemories?: Array<string | string[]> } = {},
): void {
  db.prepare(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceId, targetId, type, weight, JSON.stringify(opts.sourceMemories ?? []), opts.createdAt ?? now());
}

export function insertCluster(
  db: Database.Database,
  id: string,
  name: string,
  entityIds: string[],
  generation: number,
  opts: { memoryIds?: string[]; coherenceScore?: number } = {},
): void {
  db.prepare(
    `INSERT INTO topic_clusters (id, name, description, entity_ids, memory_ids, coherence_score, created_at, updated_at, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, `Description of ${name}`, JSON.stringify(entityIds), JSON.stringify(opts.memoryIds ?? []), opts.coherenceScore ?? 0.8, now(), now(), generation);
}

export function insertBridgeScore(
  db: Database.Database,
  entityId: string,
  generation: number,
  opts: { betweenness?: number; communitySpan?: number; bridgeScore?: number; narrative?: string } = {},
): void {
  db.prepare(
    `INSERT INTO bridge_scores (entity_id, betweenness, community_span, bridge_score, narrative, generation)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entityId, opts.betweenness ?? 0.5, opts.communitySpan ?? 2, opts.bridgeScore ?? 1.0, opts.narrative ?? null, generation);
}

export function insertConversation(
  db: Database.Database,
  id: string,
  opts: { project?: string; lastIndexed?: number | null; exchangeCount?: number } = {},
): void {
  db.prepare("INSERT INTO conversations (id, project, last_indexed, exchange_count) VALUES (?, ?, ?, ?)").run(
    id,
    opts.project ?? "test-project",
    opts.lastIndexed ?? null,
    opts.exchangeCount ?? 0,
  );
}

export function insertExchange(
  db: Database.Database,
  id: string,
  conversationId: string,
  opts: { index?: number; project?: string; timestamp?: string; userMessage?: string; assistantMessage?: string } = {},
): void {
  const index = opts.index ?? 0;
  db.prepare(
    `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?, 50)`,
  ).run(
    id,
    conversationId,
    opts.project ?? "test-project",
    opts.timestamp ?? new Date().toISOString(),
    opts.userMessage ?? `User message ${index}`,
    opts.assistantMessage ?? `Assistant response ${index}`,
    index,
  );
}

export function insertMemory(
  db: Database.Database,
  id: string,
  opts: { type?: string; content?: string; confidence?: number; importance?: number; isActive?: number; sourceExchanges?: string[] } = {},
): void {
  db.prepare(
    `INSERT INTO memories (id, type, content, confidence, importance, access_count, is_active, created_at, source_exchanges)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    opts.type ?? "fact",
    opts.content ?? "Test memory content",
    opts.confidence ?? 0.8,
    opts.importance ?? 0.7,
    opts.isActive ?? 1,
    now(),
    JSON.stringify(opts.sourceExchanges ?? []),
  );
}

export function createTestRelationship(
  overrides: Partial<Relationship> = {},
): Relationship {
  return {
    id: `rel-${Math.random().toString(36).slice(2, 10)}`,
    sourceEntityId: "ent-source",
    targetEntityId: "ent-target",
    type: "uses",
    weight: 1.0,
    sourceMemories: [],
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}
