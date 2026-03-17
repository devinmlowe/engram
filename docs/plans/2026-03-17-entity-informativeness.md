# Entity Informativeness Scoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace raw `mention_count` as the primary entity importance metric with a composite informativeness score that penalizes noise entities (`---`, `claude`) and rewards discriminative, structurally important entities.

**Architecture:** Four-phase approach: (1) extraction-time blocklist prevents artifacts from entering the graph, (2) entity-conversation junction table + Entity-IDF computation identifies stop-entities, (3) composite informativeness score combines IDF with bridge scores and log-mentions, (4) terminal visualizations consume informativeness instead of mention_count. Schema changes are added as idempotent ALTER TABLE migrations in the existing `migrate` CLI. A one-time backfill populates historical entity→conversation links via FTS search on exchanges.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), FTS5, vitest

---

## Parallel Execution Strategy

```
          main (clean, 5da1cde)
            │
   ┌────────┼────────┐
   ▼        ▼        │
 Branch A  Branch B  │  (parallel worktrees)
 blocklist  entity-idf│
   │        │        │
   ▼        ▼        │
  merge    merge     │
   │        │        │
   ▼────────▼        │
   main (merged)     │
      │              │
      ▼──────────────┘
    Branch C          (sequential — depends on A+B)
    informativeness
    + visualization
      │
      ▼
    merge → main
```

**Branch A** (`feature/extraction-blocklist`): Tasks 1–3
**Branch B** (`feature/entity-idf`): Tasks 4–8
**Branch C** (`feature/informativeness-viz`): Tasks 9–12

Branches A and B are fully parallel (disjoint file sets).
Branch C depends on both A and B being merged to main.

---

## Branch A: Extraction Blocklist

### Task 1: Add entity name blocklist to extractor

**Files:**
- Modify: `src/graph/extractor.ts:267-328`
- Create: `tests/graph/extractor-blocklist.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/graph/extractor-blocklist.test.ts
import { describe, it, expect } from "vitest";
import { isBlockedEntityName } from "../src/graph/extractor.js";

describe("entity name blocklist", () => {
  it("blocks markdown artifacts", () => {
    expect(isBlockedEntityName("---")).toBe(true);
    expect(isBlockedEntityName("##")).toBe(true);
    expect(isBlockedEntityName("**")).toBe(true);
    expect(isBlockedEntityName("```")).toBe(true);
    expect(isBlockedEntityName("###")).toBe(true);
    expect(isBlockedEntityName("|")).toBe(true);
    expect(isBlockedEntityName("- [ ]")).toBe(true);
  });

  it("blocks single-character and empty names", () => {
    expect(isBlockedEntityName("")).toBe(true);
    expect(isBlockedEntityName(" ")).toBe(true);
    expect(isBlockedEntityName("-")).toBe(true);
    expect(isBlockedEntityName("*")).toBe(true);
  });

  it("blocks pure-punctuation strings", () => {
    expect(isBlockedEntityName("===")).toBe(true);
    expect(isBlockedEntityName(">>>")).toBe(true);
    expect(isBlockedEntityName("...")).toBe(true);
  });

  it("allows legitimate entity names", () => {
    expect(isBlockedEntityName("Claude")).toBe(false);
    expect(isBlockedEntityName("KiCad")).toBe(false);
    expect(isBlockedEntityName("engram")).toBe(false);
    expect(isBlockedEntityName("Node.js")).toBe(false);
    expect(isBlockedEntityName("C++")).toBe(false);
    expect(isBlockedEntityName("n8n")).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/extractor-blocklist.test.ts`
Expected: FAIL — `isBlockedEntityName` not exported

**Step 3: Implement blocklist function in extractor.ts**

Add near line 265 (before `parseEntityExtractionResponse`):

```typescript
/**
 * Regex matching strings that are pure punctuation/markdown structure.
 * These should never become entities.
 */
const BLOCKED_NAME_PATTERN = /^[\s\-#*`|=>~_!@$%^&()[\]{}<>\\/.,:;'"+=]+$/;

/**
 * Explicit blocklist for names that pass the regex but are still noise.
 */
const BLOCKED_NAMES: ReadonlySet<string> = new Set([
  "- [ ]", "- [x]", "todo", "n/a", "none", "null", "undefined",
  "true", "false", "yes", "no", "ok", "error", "warning",
]);

/**
 * Returns true if the entity name is a known artifact or noise pattern.
 */
export function isBlockedEntityName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length <= 1) return true;
  if (BLOCKED_NAME_PATTERN.test(trimmed)) return true;
  if (BLOCKED_NAMES.has(trimmed.toLowerCase())) return true;
  return false;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/extractor-blocklist.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/graph/extractor.ts tests/graph/extractor-blocklist.test.ts
git commit -m "feat: add entity name blocklist function for extraction filtering"
```

---

### Task 2: Integrate blocklist into entity parsing pipeline

**Files:**
- Modify: `src/graph/extractor.ts:299-325` (inside `parseEntityExtractionResponse`)

**Step 1: Write the failing test**

```typescript
// Add to tests/graph/extractor-blocklist.test.ts
import { parseEntityExtractionResponse } from "../src/graph/extractor.js";

describe("parseEntityExtractionResponse with blocklist", () => {
  it("filters blocked entity names from extraction results", () => {
    const mockResponse = {
      entities: [
        { name: "KiCad", type: "tool", description: "PCB design software" },
        { name: "---", type: "concept", description: "separator" },
        { name: "engram", type: "project", description: "memory system" },
        { name: "##", type: "concept", description: "heading" },
        { name: "**", type: "concept", description: "bold" },
      ],
    };

    const result = parseEntityExtractionResponse(mockResponse);
    const names = result.map(e => e.name);

    expect(names).toContain("KiCad");
    expect(names).toContain("engram");
    expect(names).not.toContain("---");
    expect(names).not.toContain("##");
    expect(names).not.toContain("**");
    expect(result).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/extractor-blocklist.test.ts`
Expected: FAIL — blocked names still pass through

**Step 3: Add blocklist check to parseEntityExtractionResponse**

In the per-entity validation loop (around line 301, after the name emptiness check), add:

```typescript
// After: if (!name) continue;
if (isBlockedEntityName(name)) continue;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/extractor-blocklist.test.ts`
Expected: PASS

**Step 5: Run existing extractor tests to verify no regressions**

Run: `npx vitest run tests/graph/extractor.test.ts`
Expected: All existing tests PASS

**Step 6: Commit**

```bash
git add src/graph/extractor.ts tests/graph/extractor-blocklist.test.ts
git commit -m "feat: integrate entity blocklist into extraction parsing pipeline"
```

---

### Task 3: Clean existing blocked entities from database

**Files:**
- Create: `src/graph/cleanup.ts`
- Create: `tests/graph/cleanup.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/graph/cleanup.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/_core/db/schema.js";
import { cleanBlockedEntities } from "../src/graph/cleanup.js";

describe("cleanBlockedEntities", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    // Insert test entities
    const insert = db.prepare(
      "INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)"
    );
    insert.run("e1", "KiCad", "tool", 50);
    insert.run("e2", "---", "concept", 200);
    insert.run("e3", "engram", "project", 100);
    insert.run("e4", "##", "concept", 150);
    insert.run("e5", "**bold**", "concept", 10);
  });

  it("removes entities matching the blocklist", () => {
    const removed = cleanBlockedEntities(db);
    expect(removed).toBeGreaterThanOrEqual(2);

    const remaining = db.prepare("SELECT name FROM entities").all();
    const names = remaining.map((r: any) => r.name);
    expect(names).toContain("KiCad");
    expect(names).toContain("engram");
    expect(names).not.toContain("---");
    expect(names).not.toContain("##");
  });

  it("cleans up orphaned relationships", () => {
    // Create a relationship involving a blocked entity
    db.prepare(
      "INSERT INTO relationships (id, source_entity_id, target_entity_id, type) VALUES (?, ?, ?, ?)"
    ).run("r1", "e1", "e2", "related_to");
    db.prepare(
      "INSERT INTO relationships (id, source_entity_id, target_entity_id, type) VALUES (?, ?, ?, ?)"
    ).run("r2", "e1", "e3", "related_to");

    cleanBlockedEntities(db);

    const rels = db.prepare("SELECT id FROM relationships").all();
    expect(rels).toHaveLength(1); // only r2 survives
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/cleanup.test.ts`
Expected: FAIL — `cleanBlockedEntities` does not exist

**Step 3: Implement cleanup function**

```typescript
// src/graph/cleanup.ts
import type Database from "better-sqlite3";
import { isBlockedEntityName } from "./extractor.js";

/**
 * Remove all entities whose names match the blocklist, along with
 * their relationships, FTS entries, and vector embeddings.
 * Returns the number of entities removed.
 */
export function cleanBlockedEntities(db: Database.Database): number {
  // Find all blocked entity IDs
  const allEntities = db.prepare("SELECT id, name FROM entities").all() as Array<{ id: string; name: string }>;
  const blockedIds = allEntities
    .filter(e => isBlockedEntityName(e.name))
    .map(e => e.id);

  if (blockedIds.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const id of blockedIds) {
      // Remove relationships referencing this entity
      db.prepare("DELETE FROM relationships WHERE source_entity_id = ? OR target_entity_id = ?").run(id, id);
      // Remove from entity_conversations if table exists
      try { db.prepare("DELETE FROM entity_conversations WHERE entity_id = ?").run(id); } catch {}
      // Remove from bridge_scores
      try { db.prepare("DELETE FROM bridge_scores WHERE entity_id = ?").run(id); } catch {}
      // Remove entity
      db.prepare("DELETE FROM entities WHERE id = ?").run(id);
    }
  });

  tx();
  return blockedIds.length;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/cleanup.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/graph/cleanup.ts tests/graph/cleanup.test.ts
git commit -m "feat: add cleanBlockedEntities utility for retroactive noise removal"
```

---

## Branch B: Entity-IDF Infrastructure

### Task 4: Add entity_conversations junction table to schema

**Files:**
- Modify: `src/_core/db/schema.ts` (add table after entities table definition)
- Modify: `tests/contracts/db-schema.test.ts` (add schema assertion)

**Step 1: Write the failing test**

```typescript
// Add to tests/contracts/db-schema.test.ts
it("creates entity_conversations junction table", () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_conversations'"
  ).all();
  expect(tables).toHaveLength(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contracts/db-schema.test.ts`
Expected: FAIL — table not found

**Step 3: Add table to schema.ts**

After the entities table definition and indexes (around line 153), add:

```sql
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contracts/db-schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/_core/db/schema.ts tests/contracts/db-schema.test.ts
git commit -m "feat: add entity_conversations junction table for IDF tracking"
```

---

### Task 5: Add conversation_count and informativeness columns to entities

**Files:**
- Modify: `src/_core/db/schema.ts`
- Create: `src/migration/add-informativeness-columns.ts`
- Modify: `src/migration/migrate.ts` (add migration phase)

**Step 1: Write the failing test**

```typescript
// tests/migration/informativeness-columns.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/_core/db/schema.js";
import { migrateInformativenessColumns } from "../src/migration/add-informativeness-columns.js";

describe("informativeness columns migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
  });

  it("adds conversation_count column to entities", () => {
    migrateInformativenessColumns(db);
    const info = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    const cols = info.map(c => c.name);
    expect(cols).toContain("conversation_count");
  });

  it("adds informativeness column to entities", () => {
    migrateInformativenessColumns(db);
    const info = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    const cols = info.map(c => c.name);
    expect(cols).toContain("informativeness");
  });

  it("is idempotent — can run twice safely", () => {
    migrateInformativenessColumns(db);
    migrateInformativenessColumns(db); // should not throw
    const info = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    expect(info.map(c => c.name)).toContain("informativeness");
  });

  it("defaults conversation_count to 0 and informativeness to 0", () => {
    db.prepare("INSERT INTO entities (id, name, type) VALUES ('e1', 'test', 'tool')").run();
    migrateInformativenessColumns(db);
    const row = db.prepare("SELECT conversation_count, informativeness FROM entities WHERE id = 'e1'").get() as any;
    expect(row.conversation_count).toBe(0);
    expect(row.informativeness).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migration/informativeness-columns.test.ts`
Expected: FAIL — module not found

**Step 3: Implement migration module**

```typescript
// src/migration/add-informativeness-columns.ts
import type Database from "better-sqlite3";

/**
 * Idempotent migration: adds conversation_count and informativeness
 * columns to the entities table for Entity-IDF scoring.
 */
export function migrateInformativenessColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  db.transaction(() => {
    if (!colNames.has("conversation_count")) {
      db.exec("ALTER TABLE entities ADD COLUMN conversation_count INTEGER DEFAULT 0");
    }
    if (!colNames.has("informativeness")) {
      db.exec("ALTER TABLE entities ADD COLUMN informativeness REAL DEFAULT 0");
    }
  })();
}
```

**Step 4: Add to schema.ts CREATE TABLE**

Update the entities CREATE TABLE to include the new columns (so fresh databases get them):

```sql
-- Add after mention_count line:
conversation_count INTEGER DEFAULT 0,
informativeness REAL DEFAULT 0,
```

**Step 5: Wire into migrate CLI**

In `src/migration/migrate.ts`, import and call `migrateInformativenessColumns(db)` early in `runMigration()` (before other phases, since it's idempotent ALTER TABLE).

**Step 6: Run test to verify it passes**

Run: `npx vitest run tests/migration/informativeness-columns.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/_core/db/schema.ts src/migration/add-informativeness-columns.ts src/migration/migrate.ts tests/migration/informativeness-columns.test.ts
git commit -m "feat: add conversation_count and informativeness columns to entities"
```

---

### Task 6: Thread conversationId through entity resolution

**Files:**
- Modify: `src/graph/resolver.ts:33-108` (add conversationId parameter)
- Modify: `src/graph/entity.ts:298-305` (extend recordEntityMention)
- Modify: `src/dream/daemon.ts:743` (pass conversationId to resolveEntities)
- Modify: `tests/graph/resolver.test.ts`

**Step 1: Write the failing test**

```typescript
// Add to tests/graph/resolver.test.ts (or create tests/graph/resolver-conversation.test.ts)
describe("entity resolution with conversation tracking", () => {
  it("records entity_conversations link on entity mention", async () => {
    // Setup: insert an entity, then resolve it again with a conversationId
    const entity = insertEntity(db, { /* ... test entity ... */ }, embedding);

    await resolveEntity(db, { name: entity.name, type: "tool", description: "" }, "conv-123");

    const links = db.prepare(
      "SELECT * FROM entity_conversations WHERE entity_id = ? AND conversation_id = ?"
    ).all(entity.id, "conv-123");
    expect(links).toHaveLength(1);
  });

  it("deduplicates conversation links (idempotent)", async () => {
    await resolveEntity(db, extractedEntity, "conv-123");
    await resolveEntity(db, extractedEntity, "conv-123"); // same conv

    const links = db.prepare(
      "SELECT * FROM entity_conversations WHERE entity_id = ?"
    ).all(entityId);
    expect(links).toHaveLength(1); // not 2
  });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — resolveEntity doesn't accept conversationId

**Step 3: Modify resolver.ts signatures**

```typescript
// resolver.ts — add optional conversationId parameter
export async function resolveEntity(
  db: Database.Database,
  extracted: ExtractedEntity,
  conversationId?: string,
): Promise<EntityResolution> {
  // ... existing stages unchanged ...
  // After each recordEntityMention call, add:
  if (conversationId) {
    recordEntityConversation(db, entityId, conversationId);
  }
}

export async function resolveEntities(
  db: Database.Database,
  extractedEntities: ExtractedEntity[],
  conversationId?: string,
): Promise<Array<{ extracted: ExtractedEntity; resolution: EntityResolution }>> {
  // pass conversationId to each resolveEntity call
}
```

**Step 4: Add recordEntityConversation to entity.ts**

```typescript
/**
 * Record that an entity appeared in a conversation.
 * Idempotent — INSERT OR IGNORE on the composite primary key.
 */
export function recordEntityConversation(
  db: Database.Database,
  entityId: string,
  conversationId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)"
  ).run(entityId, conversationId);
}
```

**Step 5: Update daemon.ts call site**

```typescript
// daemon.ts line 743 — pass conversationId
const resolved = await resolveEntities(db, entityResult.entities, conversationId);
```

**Step 6: Run tests**

Run: `npx vitest run tests/graph/resolver.test.ts tests/graph/entity.test.ts`
Expected: PASS (existing tests use no conversationId — optional param is backward-compatible)

**Step 7: Commit**

```bash
git add src/graph/resolver.ts src/graph/entity.ts src/dream/daemon.ts tests/graph/resolver*.test.ts
git commit -m "feat: thread conversationId through entity resolution for IDF tracking"
```

---

### Task 7: Implement Entity-IDF computation

**Files:**
- Create: `src/graph/informativeness.ts`
- Create: `tests/graph/informativeness.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/graph/informativeness.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/_core/db/schema.js";
import { migrateInformativenessColumns } from "../src/migration/add-informativeness-columns.js";
import {
  computeConversationCounts,
  computeEntityIdf,
  computeInformativeness,
} from "../src/graph/informativeness.js";

describe("informativeness scoring", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    migrateInformativenessColumns(db);

    // Setup: 10 conversations
    for (let i = 1; i <= 10; i++) {
      db.prepare("INSERT INTO conversations (id, project) VALUES (?, ?)").run(`conv-${i}`, "test");
    }

    // Entity A: appears in all 10 conversations (stop-entity)
    db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("eA", "claude", "tool", 500);
    for (let i = 1; i <= 10; i++) {
      db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eA", `conv-${i}`);
    }

    // Entity B: appears in 2 conversations (discriminative)
    db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("eB", "KiCad", "tool", 50);
    db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eB", "conv-1");
    db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eB", "conv-2");

    // Entity C: appears in 5 conversations (moderate)
    db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("eC", "engram", "project", 200);
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eC", `conv-${i}`);
    }
  });

  it("computes conversation counts from junction table", () => {
    computeConversationCounts(db);
    const eA = db.prepare("SELECT conversation_count FROM entities WHERE id = 'eA'").get() as any;
    const eB = db.prepare("SELECT conversation_count FROM entities WHERE id = 'eB'").get() as any;
    expect(eA.conversation_count).toBe(10);
    expect(eB.conversation_count).toBe(2);
  });

  it("computes Entity-IDF with correct relative ordering", () => {
    computeConversationCounts(db);
    const idfA = computeEntityIdf(10, 10); // claude: in all convos
    const idfB = computeEntityIdf(10, 2);  // KiCad: in 2 convos
    const idfC = computeEntityIdf(10, 5);  // engram: in 5 convos

    // KiCad should have highest IDF (most discriminative)
    expect(idfB).toBeGreaterThan(idfC);
    expect(idfC).toBeGreaterThan(idfA);
    // claude's IDF should be near zero
    expect(idfA).toBeLessThan(0.1);
  });

  it("computes composite informativeness score", () => {
    computeConversationCounts(db);
    computeInformativeness(db);

    const eA = db.prepare("SELECT informativeness FROM entities WHERE id = 'eA'").get() as any;
    const eB = db.prepare("SELECT informativeness FROM entities WHERE id = 'eB'").get() as any;
    const eC = db.prepare("SELECT informativeness FROM entities WHERE id = 'eC'").get() as any;

    // KiCad should score higher than claude despite fewer mentions
    expect(eB.informativeness).toBeGreaterThan(eA.informativeness);
    // engram should score higher than claude
    expect(eC.informativeness).toBeGreaterThan(eA.informativeness);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph/informativeness.test.ts`
Expected: FAIL — module not found

**Step 3: Implement informativeness module**

```typescript
// src/graph/informativeness.ts
import type Database from "better-sqlite3";

/**
 * Compute IDF for an entity given total conversations and entity frequency.
 * Uses smoothed IDF: log((N + 1) / (df + 1)) to avoid division by zero
 * and to ensure entities in ALL conversations still get a small positive value.
 */
export function computeEntityIdf(totalConversations: number, entityConversationCount: number): number {
  if (totalConversations === 0) return 0;
  return Math.log((totalConversations + 1) / (entityConversationCount + 1));
}

/**
 * Update conversation_count column for all entities from entity_conversations table.
 */
export function computeConversationCounts(db: Database.Database): void {
  db.exec(`
    UPDATE entities SET conversation_count = (
      SELECT COUNT(*) FROM entity_conversations ec WHERE ec.entity_id = entities.id
    )
  `);
}

/**
 * Compute composite informativeness score for all entities.
 *
 * Formula: informativeness = log(1 + mention_count) × entity_idf × (1 + normalized_bridge)
 *
 * Where:
 *   - log(1 + mention_count): compresses mention frequency (diminishing returns)
 *   - entity_idf: log((N+1) / (df+1)) penalizes omnipresent entities
 *   - normalized_bridge: 0-1 scaled bridge_score for structural importance boost
 */
export function computeInformativeness(db: Database.Database): void {
  const totalConversations = (
    db.prepare("SELECT COUNT(*) as c FROM conversations").get() as { c: number }
  ).c;

  // Get max bridge score for normalization
  const maxBridge = (
    db.prepare(`
      SELECT COALESCE(MAX(bridge_score), 1) as m FROM bridge_scores
      WHERE generation = (SELECT MAX(generation) FROM bridge_scores)
    `).get() as { m: number }
  ).m;

  // Batch compute for all entities
  const entities = db.prepare(`
    SELECT e.id, e.mention_count, e.conversation_count,
           COALESCE(bs.bridge_score, 0) as bridge_score
    FROM entities e
    LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
      AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
  `).all() as Array<{
    id: string;
    mention_count: number;
    conversation_count: number;
    bridge_score: number;
  }>;

  const update = db.prepare("UPDATE entities SET informativeness = ? WHERE id = ?");

  db.transaction(() => {
    for (const e of entities) {
      const logMentions = Math.log(1 + e.mention_count);
      const idf = computeEntityIdf(totalConversations, e.conversation_count);
      const normalizedBridge = maxBridge > 0 ? e.bridge_score / maxBridge : 0;
      const score = logMentions * idf * (1 + normalizedBridge);
      update.run(score, e.id);
    }
  })();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph/informativeness.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/graph/informativeness.ts tests/graph/informativeness.test.ts
git commit -m "feat: implement Entity-IDF and composite informativeness scoring"
```

---

### Task 8: Backfill entity_conversations from historical data

**Files:**
- Create: `src/migration/backfill-entity-conversations.ts`
- Create: `tests/migration/backfill-entity-conversations.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/migration/backfill-entity-conversations.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/_core/db/schema.js";
import { migrateInformativenessColumns } from "../src/migration/add-informativeness-columns.js";
import { backfillEntityConversations } from "../src/migration/backfill-entity-conversations.js";

describe("backfillEntityConversations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    migrateInformativenessColumns(db);

    // Insert conversations with exchanges mentioning entity names
    db.prepare("INSERT INTO conversations (id, project) VALUES (?, ?)").run("conv-1", "test");
    db.prepare("INSERT INTO conversations (id, project) VALUES (?, ?)").run("conv-2", "test");

    db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message)
      VALUES (?, ?, ?, ?, ?)`).run("x1", "conv-1", "test", "2026-01-01", "Let me open KiCad");
    db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, assistant_message)
      VALUES (?, ?, ?, ?, ?)`).run("x2", "conv-1", "test", "2026-01-01", "Working on engram now");
    db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message)
      VALUES (?, ?, ?, ?, ?)`).run("x3", "conv-2", "test", "2026-01-02", "engram search results");

    // Insert entities
    db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("e1", "KiCad", "tool", 10);
    db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("e2", "engram", "project", 20);
  });

  it("populates entity_conversations from exchange text search", () => {
    const result = backfillEntityConversations(db);
    expect(result.linked).toBeGreaterThan(0);

    // KiCad mentioned in conv-1 only
    const kicadLinks = db.prepare(
      "SELECT conversation_id FROM entity_conversations WHERE entity_id = 'e1'"
    ).all() as Array<{ conversation_id: string }>;
    expect(kicadLinks.map(l => l.conversation_id)).toContain("conv-1");
    expect(kicadLinks.map(l => l.conversation_id)).not.toContain("conv-2");

    // engram mentioned in both
    const engramLinks = db.prepare(
      "SELECT conversation_id FROM entity_conversations WHERE entity_id = 'e2'"
    ).all() as Array<{ conversation_id: string }>;
    expect(engramLinks).toHaveLength(2);
  });

  it("is idempotent", () => {
    backfillEntityConversations(db);
    const count1 = (db.prepare("SELECT COUNT(*) as c FROM entity_conversations").get() as any).c;
    backfillEntityConversations(db);
    const count2 = (db.prepare("SELECT COUNT(*) as c FROM entity_conversations").get() as any).c;
    expect(count2).toBe(count1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migration/backfill-entity-conversations.test.ts`
Expected: FAIL — module not found

**Step 3: Implement backfill**

```typescript
// src/migration/backfill-entity-conversations.ts
import type Database from "better-sqlite3";

/**
 * Backfill entity_conversations junction table from historical exchange data.
 *
 * Strategy: For each entity, use FTS5 search on exchanges to find conversations
 * that mention the entity name. Falls back to LIKE search if FTS is unavailable.
 *
 * This is idempotent — uses INSERT OR IGNORE.
 */
export function backfillEntityConversations(
  db: Database.Database,
): { linked: number; entities: number; skipped: number } {
  const entities = db.prepare(
    "SELECT id, name FROM entities WHERE length(name) > 2 ORDER BY mention_count DESC"
  ).all() as Array<{ id: string; name: string }>;

  // Check if FTS table exists
  const hasFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='exchanges_fts'"
  ).get();

  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)"
  );

  let linked = 0;
  let skipped = 0;

  // Use FTS5 MATCH for speed, falling back to LIKE
  const searchFts = hasFts
    ? db.prepare(`
        SELECT DISTINCT e.conversation_id
        FROM exchanges_fts fts
        JOIN exchanges e ON e.rowid = fts.rowid
        WHERE exchanges_fts MATCH ?
      `)
    : null;

  const searchLike = db.prepare(`
    SELECT DISTINCT conversation_id
    FROM exchanges
    WHERE user_message LIKE ? OR assistant_message LIKE ?
  `);

  db.transaction(() => {
    for (const entity of entities) {
      try {
        let conversations: Array<{ conversation_id: string }>;

        if (searchFts) {
          // FTS5 query — quote the name to handle special chars
          const ftsQuery = '"' + entity.name.replace(/"/g, '""') + '"';
          conversations = searchFts.all(ftsQuery) as Array<{ conversation_id: string }>;
        } else {
          const pattern = '%' + entity.name + '%';
          conversations = searchLike.all(pattern, pattern) as Array<{ conversation_id: string }>;
        }

        for (const conv of conversations) {
          if (conv.conversation_id) {
            insert.run(entity.id, conv.conversation_id);
            linked++;
          }
        }
      } catch {
        skipped++;
      }
    }
  })();

  return { linked, entities: entities.length, skipped };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/migration/backfill-entity-conversations.test.ts`
Expected: PASS

**Step 5: Wire backfill into migrate CLI**

Add to `runMigration()` in `src/migration/migrate.ts`:

```typescript
import { backfillEntityConversations } from "./backfill-entity-conversations.js";

// After migrateInformativenessColumns(db):
console.log("Backfilling entity-conversation links...");
const backfillResult = backfillEntityConversations(db);
console.log(`  Linked ${backfillResult.linked} entity-conversation pairs (${backfillResult.entities} entities, ${backfillResult.skipped} skipped)`);
```

**Step 6: Commit**

```bash
git add src/migration/backfill-entity-conversations.ts tests/migration/backfill-entity-conversations.test.ts src/migration/migrate.ts
git commit -m "feat: backfill entity_conversations from historical exchange data via FTS"
```

---

## Branch C: Informativeness Integration (Sequential — after A+B merge)

### Task 9: Wire informativeness into dream REFLECT phase

**Files:**
- Modify: `src/graph/reflection.ts` (call computeInformativeness after bridge scores)
- Modify: `tests/graph/reflection.test.ts`

**Step 1:** Add import and call `computeConversationCounts(db)` + `computeInformativeness(db)` at the end of the REFLECT phase, after bridge score persistence.

**Step 2:** Write test asserting informativeness column is populated after a reflect run.

**Step 3:** Run existing reflection tests to verify no regressions.

**Step 4:** Commit.

---

### Task 10: Add informativeness to graph API responses

**Files:**
- Modify: `src/interfaces/web/data/graph-queries.ts` (add informativeness to SELECT)
- Modify: `tests/contracts/db-schema.test.ts` (if needed)

**Step 1:** In `getGraphData()`, `getDepthGraphData()`, and `getCommunityData()`, add `informativeness` to the SELECT columns and return types.

**Step 2:** Verify API responses include informativeness field via curl test.

**Step 3:** Commit.

---

### Task 11: Update terminal graph view to sort by informativeness

**Files:**
- Modify: `src/interfaces/web/pages/terminal/graph.html.ts`

**Step 1:** Change the node filtering logic from:
```js
const sorted = [...data.nodes].sort((a, b) => b.mentionCount - a.mentionCount);
```
To:
```js
const sorted = [...data.nodes].sort((a, b) =>
  (b.informativeness || 0) - (a.informativeness || 0)
);
```

**Step 2:** Update stats bar to show "by informativeness" indicator.

**Step 3:** Visual verification in carbonyl — `---` and `claude` should NOT appear as major nodes.

**Step 4:** Commit.

---

### Task 12: Update terminal treemaps to sort by informativeness

**Files:**
- Modify: `src/interfaces/web/pages/terminal/words.html.ts`
- Modify: `src/interfaces/web/pages/terminal/communities.html.ts`

**Step 1:** Where treemaps build their D3 hierarchy `.sum(d => d.count)` or `.sum(d => d.entityCount)`, use informativeness as the size metric where available.

**Step 2:** Visual verification in carbonyl.

**Step 3:** Commit.

---

## Verification & Validation Criteria

### Phase Gate: Branch A (Blocklist)

| # | Criterion | Command | Expected |
|---|-----------|---------|----------|
| 1 | Blocklist tests pass | `npx vitest run tests/graph/extractor-blocklist.test.ts` | All PASS |
| 2 | Cleanup tests pass | `npx vitest run tests/graph/cleanup.test.ts` | All PASS |
| 3 | Existing extractor tests pass | `npx vitest run tests/graph/extractor.test.ts` | All PASS |
| 4 | Full test suite — no regressions | `npx vitest run` | All PASS |
| 5 | Spot check: `---` blocked | `isBlockedEntityName("---") === true` | true |
| 6 | Spot check: `KiCad` allowed | `isBlockedEntityName("KiCad") === false` | false |

### Phase Gate: Branch B (Entity-IDF)

| # | Criterion | Command | Expected |
|---|-----------|---------|----------|
| 1 | Schema tests pass | `npx vitest run tests/contracts/db-schema.test.ts` | All PASS |
| 2 | Migration tests pass | `npx vitest run tests/migration/` | All PASS |
| 3 | Informativeness tests pass | `npx vitest run tests/graph/informativeness.test.ts` | All PASS |
| 4 | Backfill tests pass | `npx vitest run tests/migration/backfill-entity-conversations.test.ts` | All PASS |
| 5 | Full test suite — no regressions | `npx vitest run` | All PASS |
| 6 | Entity-IDF ordering correct | `claude` IDF < `engram` IDF < `KiCad` IDF | Verified |
| 7 | Backfill populates junction table | `SELECT COUNT(*) FROM entity_conversations` > 0 on real DB | > 0 |

### Phase Gate: Branch C (Visualization)

| # | Criterion | Command | Expected |
|---|-----------|---------|----------|
| 1 | Full test suite passes | `npx vitest run` | All PASS |
| 2 | API includes informativeness | `curl -s localhost:3000/api/graph \| jq '.nodes[0].informativeness'` | number |
| 3 | Terminal graph shows meaningful nodes | Visual: top nodes are projects/tools, not `---`/`claude` | Confirmed |
| 4 | TypeScript compiles cleanly | `npm run lint` | No errors |

### Final V&V: Production Database

| # | Criterion | Method | Expected |
|---|-----------|--------|----------|
| 1 | Run migration on real DB | `npx tsx src/cli.ts migrate` | Completes without error |
| 2 | Backfill completes | Check `entity_conversations` row count | > 1000 rows |
| 3 | Informativeness computed | `SELECT name, informativeness FROM entities ORDER BY informativeness DESC LIMIT 10` | Meaningful project/tool names at top |
| 4 | `claude` demoted | `SELECT informativeness FROM entities WHERE name = 'claude'` | Low relative score |
| 5 | `---` removed | `SELECT COUNT(*) FROM entities WHERE name = '---'` | 0 |
| 6 | Terminal viz reflects changes | Carbonyl visual inspection | No noise nodes prominent |
| 7 | Engram server restarts cleanly | `curl localhost:3000/terminal/graph` | 200 OK |

---

## Failure Protocol

If any V&V criterion fails:

1. **Capture evidence** — test output, error message, SQL query results
2. **Root cause analysis** — identify which assumption was wrong
3. **Re-plan** — adjust the specific task, not the entire branch
4. **Re-execute** — implement the fix
5. **Re-verify** — run the failed criterion again + full regression suite
6. **Repeat** until all criteria pass

---

## Post-Completion Cleanup

1. Delete all worktrees
2. Verify main is clean: `git status`, `git log --oneline -10`
3. Push final state to origin
4. Restart engram server with new code
5. Visual verification in carbonyl
