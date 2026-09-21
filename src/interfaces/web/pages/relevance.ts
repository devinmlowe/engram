/**
 * Relevance scoring shared by the depth page and its terminal counterpart:
 * recency, creation age, mentions, degree and bridge score blended into one
 * 0..1 score per node.
 */

export function relevanceScoresJs(): string {
  return `
// ─── Relevance scoring ───────────────────────────────────────────
const DAY = 86400;
const RECENCY_HALF = 30 * DAY;   // 30-day half-life for access recency
const AGE_HALF = 90 * DAY;       // 90-day half-life for creation recency

function computeRelevanceScores(filtered, links) {
  const now = Math.floor(Date.now() / 1000);

  const degree = new Map();
  for (const n of filtered) degree.set(n.id, 0);
  for (const l of links) {
    const s = linkId(l.source), t = linkId(l.target);
    if (degree.has(s)) degree.set(s, degree.get(s) + 1);
    if (degree.has(t)) degree.set(t, degree.get(t) + 1);
  }

  let maxMentions = 1, maxDegree = 1, maxBridge = 0.001;
  for (const n of filtered) {
    if (n.mentionCount > maxMentions) maxMentions = n.mentionCount;
    if ((degree.get(n.id) || 0) > maxDegree) maxDegree = degree.get(n.id);
    if ((n.bridgeScore || 0) > maxBridge) maxBridge = n.bridgeScore;
  }

  const scores = new Map();
  for (const n of filtered) {
    const sinceActive = now - (n.lastActive || 0);
    const age = now - (n.firstSeen || n.lastActive || 0);
    const deg = degree.get(n.id) || 0;

    const recency  = Math.exp(-sinceActive / RECENCY_HALF);
    const creation = Math.exp(-age / AGE_HALF);
    const mentions = Math.log2((n.mentionCount || 0) + 1) / Math.log2(maxMentions + 1);
    const degScore = Math.log2(deg + 1) / Math.log2(maxDegree + 1);
    const bridge   = (n.bridgeScore || 0) / maxBridge;

    scores.set(n.id, 0.30 * recency + 0.10 * creation + 0.25 * mentions + 0.15 * degScore + 0.20 * bridge);
  }

  return { scores, degree };
}
`;
}
