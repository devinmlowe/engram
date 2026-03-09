import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../src/_core/db/index.js";
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
