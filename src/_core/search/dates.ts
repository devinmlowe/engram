/**
 * Temporal recall helpers — natural-language date hints and SQL date filters.
 *
 * Two temporal semantics are supported everywhere a date filter applies:
 *
 *   - "filed"  — when the memory was recorded (memories.created_at, or
 *                exchanges.timestamp for episodic rows).
 *   - "event"  — when the events it describes happened. For semantic
 *                memories this is the earliest source exchange timestamp,
 *                denormalized into memories.event_ts (NULL → created_at).
 *                For episodic rows the exchange timestamp IS the event time,
 *                so both bases behave identically.
 *
 * Edge semantics (shared by every surface, mirroring the original episodic
 * buildDateFilter): `after` is inclusive of the named day's start (00:00:00Z)
 * and `before` is a start-of-day bound as well — a row dated any time on the
 * `before` day is excluded. All boundaries are UTC. The hint parser therefore
 * emits `before` as the day AFTER the last day of the window.
 *
 * `parseDateHint` is deterministic: `now` is a parameter, never Date.now().
 */

// ─── Types ───────────────────────────────────────────────────────

import type { DateBasis, Anniversary, DateFilterMeta } from "../types/index.js";

export type { DateBasis, Anniversary, DateFilterMeta };

export interface ParsedDateHint {
  after?: string; // YYYY-MM-DD, inclusive
  before?: string; // YYYY-MM-DD, exclusive (start of that day)
  anniversary?: Anniversary;
  note?: string;
}

// ─── Calendar arithmetic (UTC) ───────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a UTC Date as YYYY-MM-DD. */
export function toIsoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Start of the UTC day containing `d`. */
function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Shift by whole months, clamping the day (Jan 31 → Feb 28). */
function addMonthsClamped(d: Date, n: number): Date {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month0 + 1));
  return new Date(Date.UTC(year, month0, day));
}

/** Shift by whole years, clamping Feb 29 → Feb 28. */
function addYearsClamped(d: Date, n: number): Date {
  return addMonthsClamped(d, n * 12);
}

/** Monday 00:00Z of the ISO week containing `d`. */
function weekStart(d: Date): Date {
  const s = dayStart(d);
  const dow = (s.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(s, -dow);
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function yearStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

function dayWindow(d: Date): ParsedDateHint {
  const s = dayStart(d);
  return { after: toIsoDay(s), before: toIsoDay(addDays(s, 1)) };
}

function weekWindow(d: Date): ParsedDateHint {
  const s = weekStart(d);
  return { after: toIsoDay(s), before: toIsoDay(addDays(s, 7)) };
}

function monthWindow(d: Date): ParsedDateHint {
  const s = monthStart(d);
  return { after: toIsoDay(s), before: toIsoDay(addMonthsClamped(s, 1)) };
}

function yearWindow(d: Date): ParsedDateHint {
  const s = yearStart(d);
  return { after: toIsoDay(s), before: toIsoDay(addYearsClamped(s, 1)) };
}

function isValidDay(year: number, month1: number, day: number): boolean {
  return month1 >= 1 && month1 <= 12 && day >= 1 && day <= daysInMonth(year, month1);
}

function parseCount(word: string): number | undefined {
  if (/^\d+$/.test(word)) return Number(word);
  return WORDS[word];
}

// ─── Hint parser ─────────────────────────────────────────────────

/**
 * Parse a natural-language date hint into an after/before window (or an
 * anniversary marker for "on this day" style hints).
 *
 * Unknown hints return `{ note }` with no filter so callers degrade
 * gracefully. All calendar math is UTC; `now` supplies "today".
 */
export function parseDateHint(hint: string, now: Date): ParsedDateHint {
  const raw = hint.trim();
  const text = raw
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return { note: "empty date hint" };

  const core = parseCore(text, now);
  if (core) return core;

  return { note: `unrecognized date hint: "${raw}"` };
}

function parseCore(text: string, now: Date): ParsedDateHint | undefined {
  // ── Open-ended modifiers: since / before / after / until ──
  let m = text.match(/^(since|from|after|before|until|till|up to|prior to) (.+)$/);
  if (m) {
    const inner = parseCore(m[2], now);
    if (!inner || inner.anniversary) return undefined;
    const kind = m[1];
    if (kind === "since" || kind === "from") return { after: inner.after };
    if (kind === "after") return { after: inner.before ?? inner.after };
    // before / until / till / up to / prior to
    return { before: inner.after ?? inner.before };
  }

  // ── Anniversaries ──
  if (
    /^(on this day|this day in history|today in history|on this date|this date in history)( in (history|past years|previous years|prior years))?$/.test(text) ||
    /^(every|any) year on this (day|date)$/.test(text)
  ) {
    return { anniversary: { month: now.getUTCMonth() + 1, day: now.getUTCDate() } };
  }

  // ── Single days ──
  if (text === "today") return dayWindow(now);
  if (text === "yesterday") return dayWindow(addDays(dayStart(now), -1));
  if (text === "day before yesterday" || text === "the day before yesterday") {
    return dayWindow(addDays(dayStart(now), -2));
  }
  if (/^(this day|today|this date) (last|a|one|1) year( ago)?$/.test(text) ||
      text === "a year ago today" || text === "one year ago today" ||
      text === "same day last year") {
    return dayWindow(addYearsClamped(dayStart(now), -1));
  }
  m = text.match(/^(?:this day|today|this date) (\d+|two|three|four|five|six|seven|eight|nine|ten) years ago$/);
  if (m) {
    const n = parseCount(m[1])!;
    return dayWindow(addYearsClamped(dayStart(now), -n));
  }

  // ── this / last <unit> ──
  m = text.match(/^(this|last|past|previous|current) (week|month|year)$/);
  if (m) {
    const back = m[1] === "this" || m[1] === "current" ? 0 : 1;
    const unit = m[2];
    if (unit === "week") return weekWindow(addDays(now, -7 * back));
    if (unit === "month") return monthWindow(addMonthsClamped(monthStart(now), -back));
    return yearWindow(addYearsClamped(yearStart(now), -back));
  }

  // ── N <unit>s ago → the calendar unit containing that point ──
  m = text.match(/^(a|an|one|\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (day|week|month|year)s? ago$/);
  if (m) {
    const n = parseCount(m[1]);
    if (n === undefined || n < 0) return undefined;
    const unit = m[2];
    if (unit === "day") return dayWindow(addDays(dayStart(now), -n));
    if (unit === "week") return weekWindow(addDays(dayStart(now), -7 * n));
    if (unit === "month") return monthWindow(addMonthsClamped(monthStart(now), -n));
    return yearWindow(addYearsClamped(yearStart(now), -n));
  }

  // ── last/past N <unit>s → rolling window ending today (inclusive) ──
  m = text.match(/^(?:last|past|previous|the last|the past) (\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (day|week|month|year)s?$/);
  if (m) {
    const n = parseCount(m[1]);
    if (n === undefined || n <= 0) return undefined;
    const unit = m[2];
    const end = addDays(dayStart(now), 1);
    let start: Date;
    if (unit === "day") start = addDays(dayStart(now), -(n - 1));
    else if (unit === "week") start = addDays(dayStart(now), -(7 * n - 1));
    else if (unit === "month") start = addDays(addMonthsClamped(dayStart(now), -n), 1);
    else start = addDays(addYearsClamped(dayStart(now), -n), 1);
    return { after: toIsoDay(start), before: toIsoDay(end) };
  }

  // ── ISO passthrough: YYYY-MM-DD, YYYY-MM, YYYY ──
  m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isValidDay(y, mo, d)) return undefined;
    return dayWindow(new Date(Date.UTC(y, mo - 1, d)));
  }
  m = text.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12) return undefined;
    return monthWindow(new Date(Date.UTC(y, mo - 1, 1)));
  }
  m = text.match(/^(?:in |year )?(\d{4})$/);
  if (m) {
    const y = Number(m[1]);
    if (y < 1970 || y > 2999) return undefined;
    return yearWindow(new Date(Date.UTC(y, 0, 1)));
  }

  // ── Month names: "in march", "march", "march 2026", "in march 2026",
  //    "march 10", "march 10 2026", "10 march 2026" ──
  m = text.match(/^(?:in |during )?([a-z]+)(?: (\d{1,2})(?:st|nd|rd|th)?)?(?: (\d{4}))?$/);
  if (m && MONTHS[m[1]] !== undefined) {
    const month1 = MONTHS[m[1]];
    const day = m[2] !== undefined ? Number(m[2]) : undefined;
    const year = m[3] !== undefined
      ? Number(m[3])
      : mostRecentYearFor(month1, day ?? 1, now);
    if (day !== undefined) {
      if (!isValidDay(year, month1, day)) return undefined;
      return dayWindow(new Date(Date.UTC(year, month1 - 1, day)));
    }
    return monthWindow(new Date(Date.UTC(year, month1 - 1, 1)));
  }
  m = text.match(/^(?:on |in )?(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/);
  if (m && MONTHS[m[2]] !== undefined) {
    const month1 = MONTHS[m[2]];
    const day = Number(m[1]);
    const year = m[3] !== undefined ? Number(m[3]) : mostRecentYearFor(month1, day, now);
    if (!isValidDay(year, month1, day)) return undefined;
    return dayWindow(new Date(Date.UTC(year, month1 - 1, day)));
  }

  return undefined;
}

/**
 * Bare month names resolve to the most recent occurrence that is not in the
 * future: "in March" asked in September → March of this year; asked in
 * January → March of last year.
 */
function mostRecentYearFor(month1: number, day: number, now: Date): number {
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, month1 - 1, Math.min(day, daysInMonth(y, month1)));
  return candidate <= dayStart(now).getTime() ? y : y - 1;
}

// ─── Merging hints with explicit bounds ──────────────────────────

/**
 * Resolve the effective date filter for a recall: explicit after/before win
 * over values derived from the hint, and the result records what happened.
 * Returns `undefined` when nothing temporal was requested at all.
 */
export function resolveDateFilter(
  params: {
    after?: string;
    before?: string;
    dateHint?: string;
    dateBasis?: DateBasis;
    anniversary?: Anniversary;
  },
  now: Date,
): DateFilterMeta | undefined {
  const basis: DateBasis = params.dateBasis ?? "filed";
  const hasHint = typeof params.dateHint === "string" && params.dateHint.trim() !== "";

  if (!hasHint && !params.after && !params.before && !params.anniversary) {
    return undefined;
  }

  const meta: DateFilterMeta = { basis };
  if (params.anniversary) meta.anniversary = params.anniversary;
  if (params.after) meta.after = params.after;
  if (params.before) meta.before = params.before;

  if (hasHint) {
    const hint = params.dateHint!.trim();
    meta.hint = hint;
    const parsed = parseDateHint(hint, now);
    if (parsed.note) meta.note = parsed.note;
    if (parsed.anniversary && !meta.anniversary) meta.anniversary = parsed.anniversary;

    const overridden: Array<"after" | "before"> = [];
    if (parsed.after) {
      if (params.after) overridden.push("after");
      else meta.after = parsed.after;
    }
    if (parsed.before) {
      if (params.before) overridden.push("before");
      else meta.before = parsed.before;
    }
    if (overridden.length > 0) {
      meta.overridden = overridden;
      const which = overridden.join(" and ");
      meta.note = meta.note
        ? `${meta.note}; explicit ${which} overrode the hint`
        : `explicit ${which} overrode the hint`;
    }
  }

  return meta;
}

// ─── SQL filter builders ─────────────────────────────────────────

/** YYYY-MM-DD → unix seconds at 00:00:00Z. Returns undefined for bad input. */
export function isoDayToEpochSeconds(iso: string): number | undefined {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export interface DateFilterSql {
  /** Either "" or "AND <cond> [AND <cond>...]" — safe to splice after a WHERE. */
  clause: string;
  params: unknown[];
}

export interface DateFilterInput {
  after?: string;
  before?: string;
  anniversary?: Anniversary;
}

/**
 * Date filter for an ISO-8601 TEXT column (e.g. exchanges.timestamp). Plain
 * string comparison against YYYY-MM-DD gives inclusive-after / start-of-day
 * before semantics; strftime handles the anniversary predicate.
 */
export function buildIsoDateFilter(
  column: string,
  filter: DateFilterInput = {},
): DateFilterSql {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.after) {
    conditions.push(`${column} >= ?`);
    params.push(filter.after);
  }
  if (filter.before) {
    conditions.push(`${column} <= ?`);
    params.push(filter.before);
  }
  if (filter.anniversary) {
    conditions.push(`strftime('%m-%d', ${column}) = ?`);
    params.push(`${pad(filter.anniversary.month)}-${pad(filter.anniversary.day)}`);
  }

  return {
    clause: conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * Date filter for a unix-seconds INTEGER expression (e.g. memories.created_at
 * or COALESCE(event_ts, created_at)). Bounds are the same start-of-day
 * instants the ISO filter uses, so both stores agree on edges.
 */
export function buildEpochDateFilter(
  expr: string,
  filter: DateFilterInput = {},
): DateFilterSql {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.after) {
    const t = isoDayToEpochSeconds(filter.after);
    if (t !== undefined) {
      conditions.push(`${expr} >= ?`);
      params.push(t);
    }
  }
  if (filter.before) {
    const t = isoDayToEpochSeconds(filter.before);
    if (t !== undefined) {
      conditions.push(`${expr} <= ?`);
      params.push(t);
    }
  }
  if (filter.anniversary) {
    conditions.push(`strftime('%m-%d', ${expr}, 'unixepoch') = ?`);
    params.push(`${pad(filter.anniversary.month)}-${pad(filter.anniversary.day)}`);
  }

  return {
    clause: conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

/** SQL expression for a memory's timestamp under the given basis. */
export function memoryBasisExpr(basis: DateBasis | undefined, alias = "m"): string {
  const p = alias ? `${alias}.` : "";
  return basis === "event"
    ? `COALESCE(${p}event_ts, ${p}created_at)`
    : `${p}created_at`;
}

/** True when any temporal predicate is present. */
export function hasDateFilter(filter: DateFilterInput | undefined): boolean {
  return Boolean(filter && (filter.after || filter.before || filter.anniversary));
}
