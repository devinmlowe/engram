/**
 * Temporal recall — natural-language date hint parser and shared SQL filters.
 *
 * Every case pins `now` so the matrix is deterministic. Boundaries are UTC;
 * `before` is the day AFTER the window's last day (start-of-day bound).
 */

import { describe, it, expect } from "vitest";
import {
  parseDateHint,
  resolveDateFilter,
  buildIsoDateFilter,
  buildEpochDateFilter,
  isoDayToEpochSeconds,
  memoryBasisExpr,
  hasDateFilter,
  toIsoDay,
} from "../../src/_core/search/dates.js";

// Sunday 2026-09-13 15:00Z — ISO week starts Monday 2026-09-07
const NOW = new Date("2026-09-13T15:00:00Z");

function win(after: string, before: string) {
  return { after, before };
}

describe("parseDateHint — window matrix", () => {
  const cases: Array<[string, { after?: string; before?: string }]> = [
    ["today", win("2026-09-13", "2026-09-14")],
    ["yesterday", win("2026-09-12", "2026-09-13")],
    ["this week", win("2026-09-07", "2026-09-14")],
    ["last week", win("2026-08-31", "2026-09-07")],
    ["this month", win("2026-09-01", "2026-10-01")],
    ["last month", win("2026-08-01", "2026-09-01")],
    ["this year", win("2026-01-01", "2027-01-01")],
    ["last year", win("2025-01-01", "2026-01-01")],
    ["this day last year", win("2025-09-13", "2025-09-14")],
    ["a year ago today", win("2025-09-13", "2025-09-14")],
    ["a year ago", win("2025-01-01", "2026-01-01")],
    ["3 days ago", win("2026-09-10", "2026-09-11")],
    ["three days ago", win("2026-09-10", "2026-09-11")],
    ["2 weeks ago", win("2026-08-24", "2026-08-31")],
    ["2 months ago", win("2026-07-01", "2026-08-01")],
    ["last 7 days", win("2026-09-07", "2026-09-14")],
    ["past 30 days", win("2026-08-15", "2026-09-14")],
    ["in March", win("2026-03-01", "2026-04-01")],
    ["march", win("2026-03-01", "2026-04-01")],
    ["March 2025", win("2025-03-01", "2025-04-01")],
    ["in December", win("2025-12-01", "2026-01-01")], // not yet this year → last year
    ["March 10", win("2026-03-10", "2026-03-11")],
    ["10 March 2026", win("2026-03-10", "2026-03-11")],
    ["2026-03-01", win("2026-03-01", "2026-03-02")],
    ["2026-03", win("2026-03-01", "2026-04-01")],
    ["2025", win("2025-01-01", "2026-01-01")],
    ["Last Week.", win("2026-08-31", "2026-09-07")], // case + punctuation tolerant
  ];

  for (const [hint, expected] of cases) {
    it(`"${hint}"`, () => {
      const parsed = parseDateHint(hint, NOW);
      expect(parsed.note).toBeUndefined();
      expect(parsed.anniversary).toBeUndefined();
      expect({ after: parsed.after, before: parsed.before }).toEqual(expected);
    });
  }
});

describe("parseDateHint — open-ended and anniversary", () => {
  it("since <phrase> keeps only the lower bound", () => {
    expect(parseDateHint("since last week", NOW)).toEqual({ after: "2026-08-31" });
    expect(parseDateHint("since March", NOW)).toEqual({ after: "2026-03-01" });
  });

  it("before <phrase> keeps only the upper bound (start of the phrase's window)", () => {
    expect(parseDateHint("before March", NOW)).toEqual({ before: "2026-03-01" });
    expect(parseDateHint("before last week", NOW)).toEqual({ before: "2026-08-31" });
  });

  it("after <phrase> starts where the phrase's window ends", () => {
    expect(parseDateHint("after March", NOW)).toEqual({ after: "2026-04-01" });
  });

  it("on this day yields an anniversary marker, not a range", () => {
    for (const hint of ["on this day", "this day in history", "today in history", "on this date"]) {
      const parsed = parseDateHint(hint, NOW);
      expect(parsed.anniversary).toEqual({ month: 9, day: 13 });
      expect(parsed.after).toBeUndefined();
      expect(parsed.before).toBeUndefined();
    }
  });
});

describe("parseDateHint — edge cases", () => {
  it("leap day: this day last year clamps Feb 29 → Feb 28", () => {
    const leap = new Date("2028-02-29T09:00:00Z");
    expect(parseDateHint("this day last year", leap)).toEqual(win("2027-02-28", "2027-03-01"));
  });

  it("leap day: yesterday from Mar 1 in a leap year is Feb 29", () => {
    expect(parseDateHint("yesterday", new Date("2028-03-01T09:00:00Z"))).toEqual(
      win("2028-02-29", "2028-03-01"),
    );
  });

  it("leap day ISO passthrough is valid only in leap years", () => {
    expect(parseDateHint("2028-02-29", NOW)).toEqual(win("2028-02-29", "2028-03-01"));
    expect(parseDateHint("2027-02-29", NOW).note).toMatch(/unrecognized/);
  });

  it("month name without a year resolves to the most recent occurrence", () => {
    const jan = new Date("2026-01-15T00:00:00Z");
    expect(parseDateHint("in March", jan)).toEqual(win("2025-03-01", "2025-04-01"));
    expect(parseDateHint("in January", jan)).toEqual(win("2026-01-01", "2026-02-01"));
  });

  it("this week uses Monday as the first day", () => {
    const monday = new Date("2026-09-07T01:00:00Z");
    expect(parseDateHint("this week", monday)).toEqual(win("2026-09-07", "2026-09-14"));
  });

  it("unrecognized hints apply no filter and carry a note", () => {
    const parsed = parseDateHint("whenever the mood struck", NOW);
    expect(parsed).toEqual({ note: 'unrecognized date hint: "whenever the mood struck"' });
    expect(parseDateHint("   ", NOW).note).toBe("empty date hint");
    expect(parseDateHint("2026-13", NOW).note).toMatch(/unrecognized/);
  });

  it("is deterministic for a fixed now", () => {
    const a = parseDateHint("2 weeks ago", NOW);
    const b = parseDateHint("2 weeks ago", new Date(NOW.getTime()));
    expect(a).toEqual(b);
  });

  it("does not depend on local timezone (UTC boundaries)", () => {
    // 23:30Z on the 13th is still the 13th in UTC regardless of host TZ
    expect(parseDateHint("today", new Date("2026-09-13T23:30:00Z"))).toEqual(
      win("2026-09-13", "2026-09-14"),
    );
    expect(toIsoDay(new Date("2026-09-13T23:30:00Z"))).toBe("2026-09-13");
  });
});

describe("resolveDateFilter — precedence and transparency", () => {
  it("returns undefined when nothing temporal was requested", () => {
    expect(resolveDateFilter({}, NOW)).toBeUndefined();
    expect(resolveDateFilter({ dateBasis: "event" }, NOW)).toBeUndefined();
  });

  it("uses the hint's window when no explicit bounds are given", () => {
    expect(resolveDateFilter({ dateHint: "last week" }, NOW)).toEqual({
      basis: "filed",
      hint: "last week",
      after: "2026-08-31",
      before: "2026-09-07",
    });
  });

  it("explicit after/before override the hint and are reported", () => {
    const meta = resolveDateFilter(
      { dateHint: "last week", after: "2026-09-03" },
      NOW,
    );
    expect(meta).toMatchObject({
      basis: "filed",
      hint: "last week",
      after: "2026-09-03",
      before: "2026-09-07",
      overridden: ["after"],
    });
    expect(meta!.note).toMatch(/explicit after overrode the hint/);

    const both = resolveDateFilter(
      { dateHint: "last week", after: "2026-01-01", before: "2026-02-01" },
      NOW,
    );
    expect(both).toMatchObject({
      after: "2026-01-01",
      before: "2026-02-01",
      overridden: ["after", "before"],
    });
  });

  it("unknown hint → no bounds, note preserved, basis still reported", () => {
    const meta = resolveDateFilter({ dateHint: "whenever", dateBasis: "event" }, NOW);
    expect(meta).toEqual({
      basis: "event",
      hint: "whenever",
      note: 'unrecognized date hint: "whenever"',
    });
  });

  it("anniversary hints pass the marker through", () => {
    expect(resolveDateFilter({ dateHint: "on this day" }, NOW)).toEqual({
      basis: "filed",
      hint: "on this day",
      anniversary: { month: 9, day: 13 },
    });
  });
});

describe("SQL filter builders — shared edge semantics", () => {
  it("isoDayToEpochSeconds is start-of-day UTC", () => {
    expect(isoDayToEpochSeconds("2026-03-01")).toBe(Date.UTC(2026, 2, 1) / 1000);
    expect(isoDayToEpochSeconds("nope")).toBeUndefined();
  });

  it("ISO and epoch filters produce matching predicates", () => {
    const iso = buildIsoDateFilter("e.timestamp", { after: "2026-03-01", before: "2026-04-01" });
    expect(iso.clause).toBe("AND e.timestamp >= ? AND e.timestamp <= ?");
    expect(iso.params).toEqual(["2026-03-01", "2026-04-01"]);

    const epoch = buildEpochDateFilter("m.created_at", { after: "2026-03-01", before: "2026-04-01" });
    expect(epoch.clause).toBe("AND m.created_at >= ? AND m.created_at <= ?");
    expect(epoch.params).toEqual([
      isoDayToEpochSeconds("2026-03-01"),
      isoDayToEpochSeconds("2026-04-01"),
    ]);
  });

  it("anniversary predicate uses strftime on the basis expression", () => {
    const iso = buildIsoDateFilter("e.timestamp", { anniversary: { month: 3, day: 9 } });
    expect(iso.clause).toBe("AND strftime('%m-%d', e.timestamp) = ?");
    expect(iso.params).toEqual(["03-09"]);

    const epoch = buildEpochDateFilter("COALESCE(m.event_ts, m.created_at)", {
      anniversary: { month: 12, day: 25 },
    });
    expect(epoch.clause).toBe("AND strftime('%m-%d', COALESCE(m.event_ts, m.created_at), 'unixepoch') = ?");
    expect(epoch.params).toEqual(["12-25"]);
  });

  it("empty filters produce no clause", () => {
    expect(buildIsoDateFilter("e.timestamp", {})).toEqual({ clause: "", params: [] });
    expect(buildEpochDateFilter("m.created_at")).toEqual({ clause: "", params: [] });
    expect(hasDateFilter({})).toBe(false);
    expect(hasDateFilter({ after: "2026-01-01" })).toBe(true);
  });

  it("basis expression falls back from event_ts to created_at", () => {
    expect(memoryBasisExpr("filed")).toBe("m.created_at");
    expect(memoryBasisExpr(undefined)).toBe("m.created_at");
    expect(memoryBasisExpr("event")).toBe("COALESCE(m.event_ts, m.created_at)");
    expect(memoryBasisExpr("event", "")).toBe("COALESCE(event_ts, created_at)");
  });
});
