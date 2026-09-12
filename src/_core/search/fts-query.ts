/**
 * Free text → FTS5 MATCH expression.
 *
 * Why this exists: the episodic and semantic searches used to OR every
 * whitespace token of the query into the MATCH expression. Callers such as
 * the Hermes memory-provider prefetch pass whole user messages as the query,
 * and an 80-word message becomes an 80-term OR that unions the posting lists
 * of every common English word in the corpus — measured at 134s on the live
 * database versus 1.7s for a three-word query. That single behaviour was the
 * "recall blocks /health" complaint and the source of worker-pool kills.
 *
 * The builder keeps the original semantics for short, specific queries and
 * bounds the cost of long ones:
 *   1. strip quote characters (FTS5 syntax), split on whitespace;
 *   2. drop duplicates (case-insensitive), tokens shorter than `minLength`,
 *      and English stop words — none of which discriminate between documents;
 *   3. keep at most `maxTerms` of the remaining tokens in order of appearance;
 *   4. if the filter removed everything, fall back to the original tokens so
 *      a query like "the" still matches something.
 * Every kept token is quoted, so FTS5 operators inside the text stay literal.
 */

export interface FtsQueryOptions {
  /** Maximum number of OR-ed terms. Default 24. */
  maxTerms?: number;
  /** Tokens shorter than this (after stripping punctuation) are dropped. Default 2. */
  minLength?: number;
}

export const DEFAULT_MAX_FTS_TERMS = 24;
const DEFAULT_MIN_LENGTH = 2;

/** Compact English stop-word list: function words that appear in most documents. */
export const FTS_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "can",
  "could", "did", "do", "does", "doing", "done", "for", "from", "had", "has",
  "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "just", "me", "my", "no", "nor", "not", "now",
  "of", "off", "on", "or", "our", "ours", "out", "over", "own", "please", "she",
  "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
  "them", "then", "there", "these", "they", "this", "those", "through", "to",
  "too", "under", "until", "up", "us", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours", "again", "any", "all", "also", "am", "about",
  "after", "before", "because", "both", "each", "few", "more", "most", "other",
  "only", "same", "still", "even", "ever", "get", "got", "let", "like", "one",
  "onto", "per", "via", "yet",
]);

/** Split free text into raw FTS-safe tokens (quotes removed, whitespace split). */
export function tokenizeForFts(query: string): string[] {
  return query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Build an FTS5 MATCH expression from free text. Returns "" when the query
 * has no usable tokens (callers treat that as "no FTS results").
 */
export function buildFtsMatchQuery(query: string, options: FtsQueryOptions = {}): string {
  const maxTerms = options.maxTerms ?? DEFAULT_MAX_FTS_TERMS;
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const tokens = tokenizeForFts(query);
  if (tokens.length === 0) return "";

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const word = key.replace(/[^\p{L}\p{N}]/gu, "");
    if (word.length < minLength) continue;
    if (FTS_STOP_WORDS.has(word)) continue;
    kept.push(token);
    if (kept.length >= maxTerms) break;
  }

  const terms = kept.length > 0 ? kept : tokens.slice(0, maxTerms);
  return terms.map((t) => `"${t}"`).join(" OR ");
}
