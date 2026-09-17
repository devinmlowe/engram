/**
 * Commitments ledger — "mention once, never dropped".
 *
 * First-person promises ("I'll send Alan the timeline"), self-directed
 * intentions ("we need to revisit this next week") and follow-ups owed to the
 * user by others ("Alan will confirm the return date") are extracted from
 * conversations by the dream EXTRACT phase (see dream/commitments-pass.ts)
 * and stored as structured, actionable rows that the Hermes heartbeats can
 * surface via the `commitments` MCP tool and resolve via `commitments_update`.
 *
 * This module owns: the LLM tool schema + prompt, response validation, due-date
 * resolution, dedupe against the ledger (lexical overlap OR embedding cosine
 * ≥ 0.85, same subject), the row store, the lifecycle API and the XML format.
 */

import { randomUUID } from "node:crypto";
import { scopeInClause } from "../_core/db/scope.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { escapeXml } from "../_core/search/format.js";
import { estimateTokens } from "../_core/search/budget.js";
import { parseDateHint, isoDayToEpochSeconds, toIsoDay } from "../_core/search/dates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────

export type CommitmentStatus = "pending" | "done" | "dropped" | "superseded";
export type CommitmentOrigin = "stated" | "inferred";
export type CommitmentQueryStatus = CommitmentStatus | "all";

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ["pending", "done", "dropped", "superseded"];
export const COMMITMENT_RESOLUTIONS: readonly CommitmentStatus[] = ["done", "dropped", "superseded"];

export interface Commitment {
  id: string;
  content: string;
  status: CommitmentStatus;
  origin: CommitmentOrigin;
  subject: string;
  sourceExchanges: string[];
  dueAt: number | null;
  createdAt: number;
  resolvedAt: number | null;
  supersededBy: string | null;
  /** Tenant scope of the source conversation (#25). */
  scope: string;
}

/** A validated extraction result before it is deduped and stored. */
export interface CommitmentCandidate {
  content: string;
  subject: string;
  origin: CommitmentOrigin;
  dueHint: string | null;
  sourceExchangeIds: string[];
}

export interface CommitmentExchange {
  id: string;
  index: number;
  timestamp?: string;
  userMessage: string;
  assistantMessage: string;
}

export interface CommitmentMetadata {
  project: string;
  dateRange: string;
}

/** Signature of the LLM call: prompt in, raw tool payload + model name out. */
export type CommitmentsLlm = (prompt: string) => Promise<{ raw: unknown; model: string }>;

/** Signature of the embedding call used for cosine dedupe. */
export type CommitmentsEmbed = (texts: string[]) => Promise<number[][]>;

// ─── LLM tool schema ────────────────────────────────────────────

export const EXTRACT_COMMITMENTS_TOOL = {
  name: "extract_commitments",
  description:
    "Record the commitments, intentions and follow-ups actually stated in the conversation. " +
    "Return an empty list when nothing qualifies.",
  parameters: {
    type: "object",
    properties: {
      commitments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative, pronoun-free action (under 20 words)" },
            subject: { type: "string", description: "'devin' when the user owes it, else the other party's lowercase first name" },
            origin: { type: "string", enum: ["stated", "inferred"] },
            due_hint: { type: ["string", "null"], description: "Literal time expression from the text, or null" },
            source_exchange_indexes: { type: "array", items: { type: "integer" } },
          },
          required: ["content", "subject", "origin", "source_exchange_indexes"],
        },
      },
    },
    required: ["commitments"],
  } as Record<string, unknown>,
};

// ─── Prompt ─────────────────────────────────────────────────────

const USER_MESSAGE_CAP = 4000;
const ASSISTANT_MESSAGE_CAP = 500;

function loadPromptTemplate(): string {
  return readFileSync(join(__dirname, "..", "..", "prompts", "extract-commitments.md"), "utf-8");
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)} …[truncated]`;
}

/**
 * Build the extraction prompt. Assistant turns are abbreviated: commitments
 * come from the user's words, the assistant text is only context.
 */
export function buildCommitmentsPrompt(
  exchanges: CommitmentExchange[],
  metadata: CommitmentMetadata,
): string {
  const template = loadPromptTemplate();
  const header = `Project: ${metadata.project}, Date Range: ${metadata.dateRange}`;
  const body = exchanges
    .map(
      (ex) =>
        `[Exchange ${ex.index}]\nUser: ${clip(ex.userMessage, USER_MESSAGE_CAP)}\n` +
        `Assistant: ${clip(ex.assistantMessage, ASSISTANT_MESSAGE_CAP)}`,
    )
    .join("\n\n");
  return `${template}\n${header}\n\n${body}`;
}

// ─── Response validation ────────────────────────────────────────

interface RawCommitment {
  content?: unknown;
  subject?: unknown;
  origin?: unknown;
  due_hint?: unknown;
  source_exchange_indexes?: unknown;
  source_exchange_id?: unknown;
}

/** Strip a model-supplied subject down to a single lowercase token ("Alan B." → "alan"). */
export function normalizeSubject(raw: unknown): string {
  if (typeof raw !== "string") return "devin";
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9 _-]/g, " ").trim();
  if (!cleaned || cleaned === "user" || cleaned === "me" || cleaned === "i" || cleaned === "the user") return "devin";
  return cleaned.split(/\s+/)[0] || "devin";
}

/**
 * Validate the raw tool payload. Accepts either `{commitments: [...]}` or a
 * bare array. Items with empty content or no resolvable source exchange are
 * dropped — a commitment that cannot be traced back to an exchange must not
 * enter the ledger (the extractor is instructed never to invent one).
 */
export function parseCommitmentsResponse(
  raw: unknown,
  idByIndex: ReadonlyMap<number, string>,
): CommitmentCandidate[] {
  let items: RawCommitment[] = [];
  if (Array.isArray(raw)) items = raw as RawCommitment[];
  else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.commitments)) items = obj.commitments as RawCommitment[];
    else if (typeof obj.commitments === "string") {
      // Some OpenAI-compatible providers double-encode the arguments
      try {
        const inner = JSON.parse(obj.commitments);
        if (Array.isArray(inner)) items = inner as RawCommitment[];
      } catch { /* not JSON — treated as no items */ }
    }
  }

  const known = new Set(idByIndex.values());
  const out: CommitmentCandidate[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const content = typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "";
    if (content.length < 3) continue;

    const refs: unknown[] = Array.isArray(item.source_exchange_indexes)
      ? item.source_exchange_indexes
      : item.source_exchange_id !== undefined ? [item.source_exchange_id] : [];
    const sourceExchangeIds: string[] = [];
    for (const ref of refs) {
      const asId = typeof ref === "string" && known.has(ref) ? ref : undefined;
      const idx = typeof ref === "number" ? ref : typeof ref === "string" && /^\d+$/.test(ref) ? Number(ref) : NaN;
      const id = asId ?? idByIndex.get(idx);
      if (id && !sourceExchangeIds.includes(id)) sourceExchangeIds.push(id);
    }
    if (sourceExchangeIds.length === 0) continue;

    const origin: CommitmentOrigin = item.origin === "inferred" ? "inferred" : "stated";
    const dueHint = typeof item.due_hint === "string" && item.due_hint.trim() && item.due_hint.trim().toLowerCase() !== "null"
      ? item.due_hint.trim()
      : null;

    out.push({
      content: content.length > 240 ? `${content.slice(0, 237)}...` : content,
      subject: normalizeSubject(item.subject),
      origin,
      dueHint,
      sourceExchangeIds,
    });
  }
  return out;
}

// ─── Cue guard ──────────────────────────────────────────────────

/**
 * First-person obligation / third-party follow-up cues. A candidate is kept
 * only when the USER text of one of its source exchanges carries such a cue:
 * bare imperatives ("add a test", "close the browser") are instructions to
 * the assistant, not commitments, and the LLM alone does not reliably tell
 * them apart. This is the spec's definition made deterministic.
 */
const COMMITMENT_CUE =
  /\b(?:i(?:'ll| will| would| need to| needed to| should| ought to| have to| had to| must| owe| promised| plan to| intend to| am going to|'m going to| gotta| got to| still have to| have yet to| said i| told \w+ i)|remind me|don'?t (?:let me )?forget|let me not forget|not forget to|make a note to|note to self|todo for me|we (?:need|have|ought) to (?:revisit|follow up|circle back|remember|get back|come back|reconsider)|need to (?:remember|revisit|follow up|circle back|get back to)|follow[- ]up with|circle back|get back to (?:me|him|her|them|you)|(?:will|gonna|going to|said (?:he|she|they)(?:'d| would| will)?|supposed to) (?:send|confirm|get back|follow up|let me know|call|email|reply|deliver|share|review|sign)|owes? me|waiting (?:on|for) \w+ to)\b/i;

/** True when the text carries a commitment cue (see COMMITMENT_CUE). */
export function hasCommitmentCue(text: string): boolean {
  return COMMITMENT_CUE.test(text);
}

/**
 * Keep only candidates whose source exchanges' user text carries a cue. For a
 * third-party subject the name must also appear in the source text (guards
 * against invented counterparties).
 */
export function filterByCue(
  candidates: CommitmentCandidate[],
  userTextById: ReadonlyMap<string, string>,
  assistantTextById: ReadonlyMap<string, string> = new Map(),
): { kept: CommitmentCandidate[]; rejected: number } {
  const kept: CommitmentCandidate[] = [];
  let rejected = 0;
  for (const cand of candidates) {
    const userText = cand.sourceExchangeIds.map((id) => userTextById.get(id) ?? "").join("\n");
    const allText = `${userText}\n${cand.sourceExchangeIds.map((id) => assistantTextById.get(id) ?? "").join("\n")}`.toLowerCase();
    const cue = hasCommitmentCue(userText);
    const subjectOk = cand.subject === "devin" || allText.includes(cand.subject.toLowerCase());
    if (cue && subjectOk) kept.push(cand);
    else rejected++;
  }
  return { kept, rejected };
}

// ─── Due-date resolution ────────────────────────────────────────

const DAY = 86_400;
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, couple: 2, few: 3,
};

function utcDay(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/**
 * Turn a stated time expression into a unix timestamp (start of the due day,
 * UTC), relative to `base` — the moment the commitment was stated, not now.
 * Returns null when the hint is absent or unrecognized; a null due date is
 * always preferable to an invented one.
 */
export function resolveDueHint(hint: string | null | undefined, base: Date): number | null {
  if (!hint) return null;
  let text = hint.toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^(by|on|before|until|till|due|around|sometime|later|early)\s+/g, "").trim();
  text = text.replace(/\s+(morning|afternoon|evening|night|eod|at the latest|or so)$/g, "").trim();
  if (!text) return null;

  const day0 = utcDay(base);
  const dow = base.getUTCDay();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return isoDayToEpochSeconds(iso[0]) ?? null;

  if (/^(today|tonight|end of day|end of the day|eod|asap|now|right away)$/.test(text)) return day0;
  if (/^(tomorrow|tmrw)$/.test(text)) return day0 + DAY;
  if (/^(this week|end of week|end of the week|eow|later this week|by the end of the week)$/.test(text)) {
    const toSunday = (7 - dow) % 7;
    return day0 + toSunday * DAY;
  }
  if (/^(next week|early next week|sometime next week)$/.test(text)) return day0 + 7 * DAY;
  if (/^(end of month|end of the month|this month|later this month)$/.test(text)) {
    return Math.floor(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0) / 1000);
  }
  if (/^(next month)$/.test(text)) return day0 + 30 * DAY;
  if (/^(next year)$/.test(text)) return day0 + 365 * DAY;

  const rel = text.match(/^(?:in |within |after )?(\d+|[a-z]+) (day|days|week|weeks|month|months)(?: from now| or so)?$/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : NUMBER_WORDS[rel[1]];
    if (n !== undefined) {
      const unit = rel[2].startsWith("day") ? 1 : rel[2].startsWith("week") ? 7 : 30;
      return day0 + n * unit * DAY;
    }
  }

  const wd = text.match(/^(?:next |this |coming |on )?([a-z]+)$/);
  if (wd && WEEKDAYS[wd[1]] !== undefined) {
    let ahead = (WEEKDAYS[wd[1]] - dow + 7) % 7;
    if (ahead === 0) ahead = 7;
    return day0 + ahead * DAY;
  }

  // Fall back to the temporal-recall parser (month names, "sept 20", …):
  // the last day of the window it describes is the due date.
  const parsed = parseDateHint(text, base);
  if (parsed.before) {
    const b = isoDayToEpochSeconds(parsed.before);
    if (b !== undefined) return b - DAY;
  }
  if (parsed.after) return isoDayToEpochSeconds(parsed.after) ?? null;
  return null;
}

// ─── Dedupe ─────────────────────────────────────────────────────

export const DEDUPE_THRESHOLD = 0.85;

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "on", "in", "at", "with", "about", "that",
  "this", "it", "is", "be", "by", "from", "up", "out", "re", "will", "should", "need", "needs",
  "must", "get", "his", "her", "their", "our", "my", "your", "so", "then", "once", "when", "after",
]);

/** Lowercase, strip punctuation, drop stopwords, crude plural stemming. */
export function commitmentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const tok = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    out.add(tok);
  }
  return out;
}

/** Normalized token overlap: |A∩B| / min(|A|, |B|). 0 when either side is empty. */
export function lexicalOverlap(a: string, b: string): number {
  const ta = commitmentTokens(a);
  const tb = commitmentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Comparator {
  content: string;
  subject: string;
  embedding?: number[];
}

export interface DedupeOptions {
  embed?: CommitmentsEmbed;
  threshold?: number;
}

export interface DedupeResult {
  fresh: CommitmentCandidate[];
  duplicates: number;
  /** True when the embedding path was unavailable and only lexical overlap ran. */
  lexicalOnly: boolean;
}

function loadComparators(db: Database.Database, sourceIds: string[]): Comparator[] {
  const rows = db
    .prepare("SELECT content, subject FROM commitments WHERE status = 'pending'")
    .all() as Comparator[];
  // Any-status rows that were extracted from the same exchanges: a re-scan of
  // a conversation must not resurrect a commitment already marked done.
  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => "?").join(",");
    const shared = db
      .prepare(
        `SELECT content, subject FROM commitments c
         WHERE c.status != 'pending'
           AND EXISTS (SELECT 1 FROM json_each(c.source_exchanges) j WHERE j.value IN (${placeholders}))`,
      )
      .all(...sourceIds) as Comparator[];
    rows.push(...shared);
  }
  return rows;
}

/**
 * Drop candidates that duplicate a pending commitment (or any commitment from
 * the same exchanges) with the same subject and either lexical overlap or
 * embedding cosine ≥ threshold. Also dedupes within the batch. Embedding
 * failures degrade to lexical-only dedupe rather than aborting.
 */
export async function dedupeCandidates(
  db: Database.Database,
  candidates: CommitmentCandidate[],
  options: DedupeOptions = {},
): Promise<DedupeResult> {
  const threshold = options.threshold ?? DEDUPE_THRESHOLD;
  if (candidates.length === 0) return { fresh: [], duplicates: 0, lexicalOnly: false };

  const sourceIds = [...new Set(candidates.flatMap((c) => c.sourceExchangeIds))];
  const comparators = loadComparators(db, sourceIds);

  let lexicalOnly = false;
  let candidateVecs: number[][] | undefined;
  if (options.embed) {
    try {
      const texts = [...comparators.map((c) => c.content), ...candidates.map((c) => c.content)];
      const vecs = await options.embed(texts);
      if (vecs.length === texts.length) {
        comparators.forEach((c, i) => { c.embedding = vecs[i]; });
        candidateVecs = vecs.slice(comparators.length);
      } else {
        lexicalOnly = true;
      }
    } catch {
      lexicalOnly = true;
    }
  } else {
    lexicalOnly = true;
  }

  const fresh: CommitmentCandidate[] = [];
  let duplicates = 0;

  candidates.forEach((cand, i) => {
    const vec = candidateVecs?.[i];
    const isDup = comparators.some((cmp) => {
      if (cmp.subject !== cand.subject) return false;
      if (lexicalOverlap(cmp.content, cand.content) >= threshold) return true;
      if (vec && cmp.embedding && cosineSimilarity(vec, cmp.embedding) >= threshold) return true;
      return false;
    });
    if (isDup) {
      duplicates++;
      return;
    }
    fresh.push(cand);
    comparators.push({ content: cand.content, subject: cand.subject, embedding: vec });
  });

  return { fresh, duplicates, lexicalOnly };
}

// ─── Store ──────────────────────────────────────────────────────

interface CommitmentRow {
  id: string;
  content: string;
  status: CommitmentStatus;
  origin: CommitmentOrigin;
  subject: string;
  source_exchanges: string | null;
  due_at: number | null;
  created_at: number;
  resolved_at: number | null;
  superseded_by: string | null;
  scope?: string | null;
}

function rowToCommitment(row: CommitmentRow): Commitment {
  let sources: string[] = [];
  if (row.source_exchanges) {
    try {
      const parsed = JSON.parse(row.source_exchanges);
      if (Array.isArray(parsed)) sources = parsed.map(String);
    } catch { /* legacy / malformed → no sources */ }
  }
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    origin: row.origin,
    subject: row.subject,
    sourceExchanges: sources,
    dueAt: row.due_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    supersededBy: row.superseded_by,
    scope: row.scope ?? "global",
  };
}

/**
 * Insert candidates as pending commitments. The due date is resolved relative
 * to the earliest source exchange's timestamp (when the commitment was made).
 */
export function insertCommitments(
  db: Database.Database,
  candidates: CommitmentCandidate[],
  exchangeTimestamps: ReadonlyMap<string, string>,
  scope: string = "global",
): Commitment[] {
  if (candidates.length === 0) return [];
  const stmt = db.prepare(
    `INSERT INTO commitments (id, content, status, origin, subject, source_exchanges, due_at, created_at, scope)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  const inserted: Commitment[] = [];

  const run = db.transaction(() => {
    for (const cand of candidates) {
      const stamps = cand.sourceExchangeIds
        .map((id) => exchangeTimestamps.get(id))
        .filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)))
        .sort();
      const base = stamps.length > 0 ? new Date(stamps[0]) : new Date(now * 1000);
      const dueAt = resolveDueHint(cand.dueHint, base);
      const id = randomUUID();
      stmt.run(id, cand.content, cand.origin, cand.subject, JSON.stringify(cand.sourceExchangeIds), dueAt, now, scope);
      inserted.push({
        id,
        content: cand.content,
        status: "pending",
        origin: cand.origin,
        subject: cand.subject,
        sourceExchanges: [...cand.sourceExchangeIds],
        dueAt,
        createdAt: now,
        resolvedAt: null,
        supersededBy: null,
        scope,
      });
    }
  });
  run();
  return inserted;
}

// ─── Query + lifecycle ──────────────────────────────────────────

export interface ListCommitmentsOptions {
  status?: CommitmentQueryStatus;
  /** Only items due within N days of now — or already overdue. */
  dueWithinDays?: number;
  limit?: number;
  /** Unix seconds; defaults to Date.now(). */
  now?: number;
  /** Tenant read scopes (#25); unset = every scope. */
  scopes?: string[];
}

export interface ListCommitmentsResult {
  items: Commitment[];
  /** Matching rows before the limit was applied. */
  total: number;
  status: CommitmentQueryStatus;
  now: number;
}

/**
 * List commitments. Sort order: overdue first, then dated items by due date,
 * then undated items newest first.
 */
export function listCommitments(
  db: Database.Database,
  options: ListCommitmentsOptions = {},
): ListCommitmentsResult {
  const status = options.status ?? "pending";
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 20)));
  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== "all") {
    where.push("status = ?");
    params.push(status);
  }
  if (options.dueWithinDays !== undefined) {
    where.push("due_at IS NOT NULL AND due_at <= ?");
    params.push(now + Math.max(0, options.dueWithinDays) * DAY);
  }
  const scopeFilter = scopeInClause("scope", options.scopes);
  if (scopeFilter) {
    where.push(scopeFilter.sql);
    params.push(...scopeFilter.params);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT count(*) AS n FROM commitments ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT * FROM commitments ${clause}
       ORDER BY
         CASE WHEN due_at IS NOT NULL AND due_at < ? THEN 0 ELSE 1 END,
         CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
         due_at ASC,
         created_at DESC,
         id ASC
       LIMIT ?`,
    )
    .all(...params, now, limit) as CommitmentRow[];

  return { items: rows.map(rowToCommitment), total, status, now };
}

/** Fetch by exact id, or by a unique id prefix of at least 6 characters. */
export function getCommitment(db: Database.Database, idOrPrefix: string): Commitment | undefined {
  const exact = db.prepare("SELECT * FROM commitments WHERE id = ?").get(idOrPrefix) as CommitmentRow | undefined;
  if (exact) return rowToCommitment(exact);
  if (idOrPrefix.length < 6) return undefined;
  const matches = db
    .prepare("SELECT * FROM commitments WHERE id LIKE ? LIMIT 2")
    .all(`${idOrPrefix.replace(/[%_]/g, "")}%`) as CommitmentRow[];
  return matches.length === 1 ? rowToCommitment(matches[0]) : undefined;
}

export interface UpdateCommitmentOptions {
  supersededBy?: string;
  now?: number;
}

/**
 * Resolve a commitment: done, dropped, or superseded (by another commitment id).
 * Throws when the id is unknown or the status is not a resolution.
 */
export function updateCommitmentStatus(
  db: Database.Database,
  idOrPrefix: string,
  status: CommitmentStatus,
  options: UpdateCommitmentOptions = {},
): Commitment {
  if (!COMMITMENT_RESOLUTIONS.includes(status)) {
    throw new Error(`Invalid resolution status "${status}" (expected one of ${COMMITMENT_RESOLUTIONS.join(", ")})`);
  }
  const existing = getCommitment(db, idOrPrefix);
  if (!existing) throw new Error(`Commitment not found: ${idOrPrefix}`);
  if (status === "superseded" && !options.supersededBy) {
    throw new Error("superseded_by is required when marking a commitment superseded");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE commitments SET status = ?, resolved_at = ?, superseded_by = ? WHERE id = ?",
  ).run(status, now, options.supersededBy ?? null, existing.id);
  return getCommitment(db, existing.id)!;
}

// ─── XML format ─────────────────────────────────────────────────

export interface FormatCommitmentsOptions {
  /** Token budget for the whole document (default 1500). */
  budget?: number;
}

function ageLabel(createdAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - createdAt) / DAY));
  return `${days}d`;
}

/**
 * Token-budgeted XML in the house style of `formatRecallXml`. Items are
 * emitted in list order until the budget is exhausted; `truncated="true"`
 * marks a cut list.
 */
export function formatCommitmentsXml(
  result: ListCommitmentsResult,
  options: FormatCommitmentsOptions = {},
): string {
  const budget = options.budget ?? 1500;
  const asOf = toIsoDay(new Date(result.now * 1000));
  const itemLines: string[] = [];
  let used = 0;
  let truncated = false;

  for (const c of result.items) {
    const attrs = [
      `id="${escapeXml(c.id)}"`,
      `status="${c.status}"`,
      `subject="${escapeXml(c.subject)}"`,
      `origin="${c.origin}"`,
      `age="${ageLabel(c.createdAt, result.now)}"`,
    ];
    if (c.dueAt !== null) {
      attrs.push(`due="${toIsoDay(new Date(c.dueAt * 1000))}"`);
      attrs.push(`overdue="${c.dueAt < result.now ? "true" : "false"}"`);
    }
    if (c.resolvedAt !== null) attrs.push(`resolved="${toIsoDay(new Date(c.resolvedAt * 1000))}"`);
    if (c.supersededBy) attrs.push(`superseded_by="${escapeXml(c.supersededBy)}"`);
    if (c.sourceExchanges.length > 0) attrs.push(`sources="${escapeXml(c.sourceExchanges.join(","))}"`);
    const line = `  <commitment ${attrs.join(" ")}>${escapeXml(c.content)}</commitment>`;
    const cost = estimateTokens(line);
    if (used + cost > budget && itemLines.length > 0) {
      truncated = true;
      break;
    }
    itemLines.push(line);
    used += cost;
  }

  const head =
    `<engram_commitments status="${result.status}" count="${itemLines.length}" total="${result.total}" ` +
    `as_of="${asOf}"${truncated ? ' truncated="true"' : ""} tokens_used="${used}">`;
  return [head, ...itemLines, "</engram_commitments>"].join("\n");
}

// ─── Default LLM caller ─────────────────────────────────────────

const COMMITMENTS_SYSTEM_PROMPT =
  "You are a commitment extraction system. Return only the JSON object described.";
const COMMITMENTS_MAX_TOKENS = 2048;

/**
 * True when a cloud extraction provider or an explicit local model pin is
 * configured. Synchronous by design (CLI preflight); the dream pass
 * additionally probes Ollama reachability so a running local model counts
 * on its own (SPEC.md INV-3).
 */
export function hasCommitmentsProvider(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ENGRAM_LOCAL_MODEL);
}

/**
 * Route the extraction call through the _core/llm factory cascade
 * (Ollama → OpenRouter → Anthropic primary → fallback), exactly like the
 * fact extractor. Throws when every tier fails; callers log and skip — the
 * dream run never breaks on extraction errors.
 *
 * Imports lazily so the MCP server (which imports this module for the
 * ledger API) does not load LLM SDKs at startup.
 */
export const defaultCommitmentsLlm: CommitmentsLlm = async (prompt) => {
  const { generateStructured, buildIntelligenceConfig } = await import("../_core/llm/index.js");
  const { loadConfig } = await import("../_core/config/index.js");
  const result = await generateStructured<Record<string, unknown>>(
    COMMITMENTS_SYSTEM_PROMPT,
    prompt,
    EXTRACT_COMMITMENTS_TOOL.parameters,
    buildIntelligenceConfig(loadConfig()),
    {
      toolName: EXTRACT_COMMITMENTS_TOOL.name,
      toolDescription: EXTRACT_COMMITMENTS_TOOL.description,
      maxTokens: COMMITMENTS_MAX_TOKENS,
    },
  );
  return { raw: result.result, model: result.model };
};
