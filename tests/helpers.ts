import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { initDatabase, insertFtsRow } from "../src/_core/db/index.js";
import { loadConfig } from "../src/_core/config/index.js";
import type Database from "better-sqlite3";
import type { EngramConfig } from "../src/_core/types/index.js";
import type { Exchange } from "../src/episodic/types.js";
import type { Entity, Relationship } from "../src/graph/types.js";
import type { Memory } from "../src/semantic/types.js";
import type { ConversationExchange } from "../src/semantic/extractor.js";

/** The compiled CLI entry point; suites that spawn it skip when `npm run build` has not run. */
export const builtCli = fileURLToPath(new URL("../dist/interfaces/cli/index.js", import.meta.url));
export const itBuilt = it.skipIf(!existsSync(builtCli));

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

export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`,
    type: "fact",
    content: "TypeScript uses structural typing",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: ["exch-001"],
    isActive: true,
    ...overrides,
  };
}

/** `count` numbered exchanges in the extractor's input shape. */
export function makeExchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    userMessage: `User message ${i}`,
    assistantMessage: `Assistant response ${i}`,
  }));
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
