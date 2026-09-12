/**
 * Drill into a search result to expand context.
 *
 * Behavior varies by result source:
 * - Episodic: returns surrounding exchanges from the same conversation
 * - Semantic: returns the source conversation segment that generated the memory
 * - Graph: returns entity with full relationship neighborhood (depth 1)
 *
 * Phase 6B implementation.
 */

import type Database from "better-sqlite3";
import type { SearchResult } from "../types/index.js";
import type { DrillResult, EntitySummary } from "./session.js";

// ─── Row Types ──────────────────────────────────────────────────

interface ExchangeRow {
  id: string;
  conversation_id: string;
  user_message: string;
  assistant_message: string;
  exchange_index: number;
  timestamp: string;
  project: string;
}

interface MemoryRow {
  id: string;
  content: string;
  context: string | null;
  source_exchanges: string | null;
  type: string;
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface RelRow {
  source_entity_id: string;
  target_entity_id: string;
  type: string;
  weight: number;
  context: string | null;
}

// ─── Drill ──────────────────────────────────────────────────────

/**
 * Drill into a search result to get expanded context.
 */
export async function drillIntoResult(
  result: SearchResult,
  db: Database.Database,
): Promise<DrillResult> {
  switch (result.source) {
    case "episodic":
      return drillEpisodic(result, db);
    case "semantic":
      return drillSemantic(result, db);
    case "graph":
      return drillGraph(result, db);
    default:
      return {
        content: result.content,
        before: [],
        after: [],
        relatedEntities: [],
        suggestions: [],
      };
  }
}

// ─── Episodic Drill ─────────────────────────────────────────────

function drillEpisodic(result: SearchResult, db: Database.Database): DrillResult {
  const meta = result.metadata as Record<string, unknown>;
  const conversationId = meta.conversationId as string | undefined;

  if (!conversationId) {
    return {
      content: result.content,
      before: [],
      after: [],
      relatedEntities: [],
      suggestions: generateSuggestions(result),
    };
  }

  // Get the exchange itself
  const exchange = db.prepare(
    "SELECT * FROM exchanges WHERE id = ?",
  ).get(result.id) as ExchangeRow | undefined;

  if (!exchange) {
    return {
      content: result.content,
      before: [],
      after: [],
      relatedEntities: [],
      suggestions: generateSuggestions(result),
    };
  }

  // 5 before, 5 after — fetch just the window, not the whole conversation
  const windowRows = db.prepare(
    `SELECT * FROM exchanges
     WHERE conversation_id = ?
       AND exchange_index BETWEEN ? AND ?
       AND id != ?
     ORDER BY exchange_index ASC`,
  ).all(
    conversationId,
    exchange.exchange_index - 5,
    exchange.exchange_index + 5,
    exchange.id,
  ) as ExchangeRow[];

  const beforeExchanges = windowRows.filter((e) => e.exchange_index < exchange.exchange_index);
  const afterExchanges = windowRows.filter((e) => e.exchange_index > exchange.exchange_index);

  const fullContent = formatExchange(exchange);

  return {
    content: fullContent,
    before: beforeExchanges.map(formatExchange),
    after: afterExchanges.map(formatExchange),
    relatedEntities: [],
    suggestions: generateSuggestions(result),
  };
}

// ─── Semantic Drill ─────────────────────────────────────────────

function drillSemantic(result: SearchResult, db: Database.Database): DrillResult {
  // Get the full memory record
  const memory = db.prepare(
    "SELECT * FROM memories WHERE id = ?",
  ).get(result.id) as MemoryRow | undefined;

  if (!memory) {
    return {
      content: result.content,
      before: [],
      after: [],
      relatedEntities: [],
      suggestions: generateSuggestions(result),
    };
  }

  const fullContent = memory.content;
  const context = memory.context ?? "";

  // Try to get source exchanges
  const before: string[] = [];
  const after: string[] = [];

  if (memory.source_exchanges) {
    try {
      const sourceIds: string[] = JSON.parse(memory.source_exchanges);
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => "?").join(",");
        const exchanges = db.prepare(
          `SELECT * FROM exchanges WHERE id IN (${placeholders}) ORDER BY exchange_index ASC`,
        ).all(...sourceIds) as ExchangeRow[];

        // Put source exchanges in the "before" context (they preceded the memory)
        for (const exch of exchanges) {
          before.push(formatExchange(exch));
        }
      }
    } catch {
      // Skip malformed JSON
    }
  }

  return {
    content: context ? `${fullContent}\n\nContext: ${context}` : fullContent,
    before,
    after,
    relatedEntities: [],
    suggestions: generateSuggestions(result),
  };
}

// ─── Graph Drill ────────────────────────────────────────────────

function drillGraph(result: SearchResult, db: Database.Database): DrillResult {
  const meta = result.metadata as Record<string, unknown>;
  const entityName = meta.entityName as string | undefined;

  // Get entity
  const entity = db.prepare(
    "SELECT * FROM entities WHERE id = ?",
  ).get(result.id) as EntityRow | undefined;

  if (!entity) {
    return {
      content: result.content,
      before: [],
      after: [],
      relatedEntities: [],
      suggestions: generateSuggestions(result),
    };
  }

  // Get all relationships
  const rels = db.prepare(
    `SELECT * FROM relationships
     WHERE source_entity_id = ? OR target_entity_id = ?
     ORDER BY weight DESC`,
  ).all(entity.id, entity.id) as RelRow[];

  // One batched lookup for every counterpart entity (was two prepared
  // statements per relationship)
  const otherIdOf = (rel: RelRow) =>
    rel.source_entity_id === entity.id ? rel.target_entity_id : rel.source_entity_id;
  const otherIds = [...new Set(rels.map(otherIdOf))];
  const entityById = new Map<string, EntityRow>();
  for (let i = 0; i < otherIds.length; i += 400) {
    const chunk = otherIds.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT * FROM entities WHERE id IN (${chunk.map(() => "?").join(", ")})`,
    ).all(...chunk) as EntityRow[];
    for (const row of rows) entityById.set(row.id, row);
  }

  // Build related entities list
  const relatedEntities: EntitySummary[] = [];
  const seenIds = new Set<string>();

  for (const rel of rels) {
    const otherId = otherIdOf(rel);

    if (seenIds.has(otherId)) continue;
    seenIds.add(otherId);

    const other = entityById.get(otherId);

    if (other) {
      relatedEntities.push({
        name: other.name,
        type: other.type,
        description: other.description ?? undefined,
      });
    }
  }

  // Build full content with relationship details
  const parts: string[] = [];
  parts.push(`${entity.name} (${entity.type})`);
  if (entity.description) {
    parts.push(entity.description);
  }

  for (const rel of rels.slice(0, 15)) {
    const isSource = rel.source_entity_id === entity.id;
    const otherId = isSource ? rel.target_entity_id : rel.source_entity_id;
    const otherName = entityById.get(otherId)?.name ?? otherId;
    const dir = isSource ? "->" : "<-";
    const relStr = rel.context
      ? `${dir} ${rel.type} ${otherName}: ${rel.context}`
      : `${dir} ${rel.type} ${otherName}`;
    parts.push(relStr);
  }

  return {
    content: parts.join("\n"),
    before: [],
    after: [],
    relatedEntities,
    suggestions: generateSuggestions(result),
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function formatExchange(exch: ExchangeRow): string {
  const user = exch.user_message?.substring(0, 500) ?? "";
  const assistant = exch.assistant_message?.substring(0, 500) ?? "";
  return `User: ${user}\nAssistant: ${assistant}`;
}

function generateSuggestions(result: SearchResult): string[] {
  const suggestions: string[] = [];
  const meta = result.metadata as Record<string, unknown>;

  if (result.source === "episodic") {
    const project = meta.project as string | undefined;
    if (project) {
      suggestions.push(`More from project "${project}"`);
    }
    suggestions.push("Related conversations");
  } else if (result.source === "semantic") {
    const type = meta.type as string | undefined;
    if (type) {
      suggestions.push(`Other ${type} memories`);
    }
    suggestions.push("Related facts");
  } else if (result.source === "graph") {
    const entityName = meta.entityName as string | undefined;
    if (entityName) {
      suggestions.push(`Explore "${entityName}" connections`);
    }
    suggestions.push("Related entities");
  }

  return suggestions;
}
