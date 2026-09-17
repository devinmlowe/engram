/**
 * Transient-status classifier (W9b).
 *
 * Dream extraction stores progress reports and point-in-time state as
 * durable `fact`/`solution` memories: "Phase 6A is complete, adding 23 new
 * tests", "The current run ID is …", "currently blocked on …". These carry
 * little future value yet accumulate at importance 0.5 with a 30–120 day
 * stability, crowding real knowledge out of recall.
 *
 * This is a conservative regex list — no LLM. Matches are never dropped;
 * `applyTransientPolicy` assigns the short stability tier and caps
 * importance so the memory decays on its own. Patterns are anchored to
 * status *phrasing* ("is complete", "added N tests", "run id") rather than
 * status vocabulary, so decisions and conventions that merely mention
 * completion, tests, or versions stay durable.
 */

import { TRANSIENT_IMPORTANCE_CAP, TRANSIENT_STABILITY } from "./types.js";

/** Status-report phrasings. Keep conservative: false negatives are cheap, false positives are not. */
export const TRANSIENT_STATUS_PATTERNS: ReadonlyArray<RegExp> = [
  // Completion announcements: "X is (now) complete/done/finished", "has been completed"
  /\b(?:is|are|was|were)\s+(?:now\s+)?(?:complete|completed|done|finished)\b/i,
  /\b(?:has|have)\s+been\s+(?:completed|finished)\b/i,
  // "Phase 2 … complete/done" within one sentence
  /\bphase\s+[\w.-]+\b[^.!?]*\b(?:complete|completed|done|finished)\b/i,
  // Test-count / suite-status announcements
  /\badd(?:ed|ing|s)?\s+\d+\s+(?:new\s+)?tests?\b/i,
  /\b\d+\+?\s+tests?\s+(?:are\s+)?(?:passing|pass|green)\b/i,
  /\ball\s+(?:\d+\s+)?tests\s+(?:are\s+)?(?:passing|pass|green)\b/i,
  // Point-in-time hedges
  /\bcurrently\b/i,
  /\bas of\s+(?:\d{4}|today|now|this)\b/i,
  /\bin progress\b/i,
  /\bWIP\b/,
  /\bTODO\b/,
  // Run / session bookkeeping (cron-agent transcripts)
  /\b(?:the\s+)?current\s+(?:date|time|run|session|branch|working\s+directory)\b/i,
  /\brun\s+id\b/i,
  // Operational status
  /\b(?:is|are)\s+(?:now\s+)?(?:fully\s+)?(?:operational|up and running|unblocked)\b/i,
  /\b(?:is|are|remains?)\s+(?:still\s+|currently\s+)?(?:blocked|outdated|pending)\b/i,
  // Version-bump announcements (not semver conventions)
  /\bbumped\s+(?:the\s+)?(?:\S+\s+)?version\s+to\s+v?\d/i,
  /\bversion\s+(?:was\s+|has\s+been\s+)?bumped\b/i,
  /\b(?:is|are)\s+now\s+(?:at|on)\s+v?\d+\.\d+/i,
];

/** True when `content` reads as a transient status report rather than durable knowledge. */
export function isTransientStatus(content: string): boolean {
  const text = content.trim();
  if (text === "") return false;
  return TRANSIENT_STATUS_PATTERNS.some((pattern) => pattern.test(text));
}

export interface TransientPolicy {
  transient: boolean;
  /** Importance after the cap (unchanged for durable facts). */
  importance: number;
  /** Stability override in days; undefined = use the type's initial stability. */
  stability?: number;
}

/**
 * Decide how a fact is stored: transient status facts get the short
 * stability tier and an importance ceiling; everything else passes through.
 */
export function applyTransientPolicy(fact: {
  content: string;
  importance: number;
}): TransientPolicy {
  if (!isTransientStatus(fact.content)) {
    return { transient: false, importance: fact.importance };
  }
  return {
    transient: true,
    importance: Math.min(fact.importance, TRANSIENT_IMPORTANCE_CAP),
    stability: TRANSIENT_STABILITY,
  };
}
