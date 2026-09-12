/**
 * buildFtsMatchQuery — bounded, de-noised FTS5 MATCH expressions.
 *
 * Regression guard for the "long prefetch query" incident: an 81-word
 * message OR-ed verbatim into FTS5 took 134s on the live database and got
 * the executing worker killed. Long free text must become a short, specific
 * OR query; short specific queries must be unchanged.
 */

import { describe, it, expect } from "vitest";
import {
  buildFtsMatchQuery,
  tokenizeForFts,
  DEFAULT_MAX_FTS_TERMS,
  FTS_STOP_WORDS,
} from "../../src/_core/search/fts-query.js";

const SYSTEM_NOTE =
  "[System note: The previous turn was interrupted by a gateway shutdown; the gateway is now back online. " +
  "Any restart/shutdown command in the history has already completed, so do not run it again. Please continue " +
  "from where the conversation left off and summarize what the user asked for in the last message before the " +
  "interruption, then carry on with the task as if nothing happened. If the task is complete, say so briefly and " +
  "wait for the next instruction from the user.]";

const termsOf = (expr: string) => expr.split(" OR ");

describe("buildFtsMatchQuery", () => {
  it("keeps short specific queries as quoted OR terms (previous behaviour)", () => {
    expect(buildFtsMatchQuery("sqlite wal busy_timeout")).toBe('"sqlite" OR "wal" OR "busy_timeout"');
    expect(buildFtsMatchQuery("engram")).toBe('"engram"');
  });

  it("strips quote characters so FTS5 syntax cannot be injected", () => {
    // "it's" → "its", which is a stop word, so it is dropped as well
    expect(buildFtsMatchQuery(`he said "hello" it's`)).toBe('"said" OR "hello"');
    expect(buildFtsMatchQuery(`"phrase" 'quoted' busy_timeout`)).toBe('"phrase" OR "quoted" OR "busy_timeout"');
  });

  it("returns an empty string for blank input", () => {
    expect(buildFtsMatchQuery("")).toBe("");
    expect(buildFtsMatchQuery("   \n\t ")).toBe("");
  });

  it("drops stop words and single-character tokens", () => {
    const expr = buildFtsMatchQuery("what database should I use for a local-first app");
    expect(termsOf(expr)).toEqual(['"database"', '"use"', '"local-first"', '"app"']);
  });

  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(buildFtsMatchQuery("Hermes hermes HERMES gateway Gateway")).toBe('"Hermes" OR "gateway"');
  });

  it("falls back to the raw tokens when everything is a stop word", () => {
    expect(buildFtsMatchQuery("the")).toBe('"the"');
    expect(buildFtsMatchQuery("is it")).toBe('"is" OR "it"');
  });

  it("caps the number of OR terms at DEFAULT_MAX_FTS_TERMS", () => {
    const words = Array.from({ length: 200 }, (_, i) => `token${i}`).join(" ");
    const terms = termsOf(buildFtsMatchQuery(words));
    expect(terms).toHaveLength(DEFAULT_MAX_FTS_TERMS);
    expect(terms[0]).toBe('"token0"');
    expect(terms.at(-1)).toBe(`"token${DEFAULT_MAX_FTS_TERMS - 1}"`);
  });

  it("honours a custom maxTerms and minLength", () => {
    expect(buildFtsMatchQuery("alpha beta gamma delta", { maxTerms: 2 })).toBe('"alpha" OR "beta"');
    expect(buildFtsMatchQuery("ab abc abcd", { minLength: 4 })).toBe('"abcd"');
  });

  it("turns the 81-word gateway system note into a short, specific query", () => {
    const raw = tokenizeForFts(SYSTEM_NOTE);
    expect(raw.length).toBeGreaterThan(70);
    const terms = termsOf(buildFtsMatchQuery(SYSTEM_NOTE));
    expect(terms.length).toBeLessThanOrEqual(DEFAULT_MAX_FTS_TERMS);
    // Function words are gone; discriminating words survive.
    const lowered = terms.map((t) => t.replace(/"/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""));
    for (const t of lowered) expect(FTS_STOP_WORDS.has(t)).toBe(false);
    expect(lowered).toContain("gateway");
    expect(lowered).toContain("shutdown");
    expect(lowered).toContain("interrupted");
    expect(lowered).not.toContain("the");
    expect(lowered).not.toContain("is");
  });

  it("every term is individually quoted so operators stay literal", () => {
    const terms = termsOf(buildFtsMatchQuery("NOT AND OR NEAR(foo) col:bar *"));
    for (const t of terms) expect(t).toMatch(/^".*"$/);
  });
});
