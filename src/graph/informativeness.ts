/**
 * Entity-IDF and composite informativeness scoring.
 *
 * Replaces raw mention_count as the primary entity importance metric.
 * Uses smoothed IDF to penalize omnipresent entities (stop-entities)
 * and reward discriminative, structurally important ones.
 */

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
 * Formula: informativeness = log(1 + mention_count) * entity_idf * (1 + normalized_bridge)
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

  // Compute median conversation_count for entities that have links.
  // Entities with conversation_count=0 (unlinked) get median IDF instead of max IDF.
  const linkedCounts = entities
    .filter(e => e.conversation_count > 0)
    .map(e => e.conversation_count)
    .sort((a, b) => a - b);
  const medianConvCount = linkedCounts.length > 0
    ? linkedCounts[Math.floor(linkedCounts.length / 2)]
    : 1;

  db.transaction(() => {
    for (const e of entities) {
      const logMentions = Math.log(1 + e.mention_count);
      // Unlinked entities (conversation_count=0) get median IDF, not max IDF
      const effectiveConvCount = e.conversation_count > 0 ? e.conversation_count : medianConvCount;
      const idf = computeEntityIdf(totalConversations, effectiveConvCount);
      const normalizedBridge = maxBridge > 0 ? e.bridge_score / maxBridge : 0;
      const score = logMentions * idf * (1 + normalizedBridge);
      update.run(score, e.id);
    }
  })();
}
