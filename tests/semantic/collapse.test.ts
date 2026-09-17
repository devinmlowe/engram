/**
 * W9: intra-batch near-duplicate collapse.
 *
 * The consolidator dedups each candidate against the DB one at a time; this
 * module collapses candidates that race each other inside one extraction
 * batch (and across a dream run's candidate set) before any of them is
 * inserted. Live-DB evidence: 330 groups of dream memories shared their
 * first 60 characters; the top groups were byte-identical 7-18x.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeContent,
  mergeFacts,
  collapseExact,
  collapseByEmbedding,
  collapseAcrossBatches,
} from "../../src/semantic/collapse.js";
import type { ExtractedFact } from "../../src/semantic/types.js";
import { cosineSimilarity } from "../helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    type: "fact",
    content: "The project uses vitest.",
    importance: 0.5,
    sourceExchangeIds: [],
    ...overrides,
  };
}

function seededEmbedding(seed: number, dims = 32): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/** A unit vector within `noise` of `base` (cosine stays well above 0.95). */
function perturb(base: number[], noise: number, seed: number): number[] {
  const n = seededEmbedding(seed, base.length);
  const v = base.map((x, i) => x + noise * n[i]);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function loadFixture(): ExtractedFact[] {
  const raw = readFileSync(join(__dirname, "fixtures", "dream-duplicates.json"), "utf-8");
  return (JSON.parse(raw) as { facts: ExtractedFact[] }).facts;
}

/** Same grouping the live-DB characterisation query used. */
function prefixGroups(facts: readonly ExtractedFact[]): number {
  const counts = new Map<string, number>();
  for (const f of facts) {
    const k = f.content.slice(0, 60);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.values()].filter((c) => c > 1).length;
}

describe("normalizeContent", () => {
  it("lowercases and collapses whitespace and punctuation", () => {
    expect(normalizeContent("  The BLE SPEC is missing DFU.  ")).toBe(
      normalizeContent("the ble spec is missing dfu"),
    );
    expect(normalizeContent("kept 'flat', with files")).toBe(
      normalizeContent('kept "flat" , with   files'),
    );
  });

  it("keeps materially different content distinct", () => {
    expect(normalizeContent("result-rlm-v2.md")).not.toBe(normalizeContent("result-rlm-v3.md"));
  });
});

describe("mergeFacts", () => {
  it("keeps the higher-confidence fact and unions source exchanges in order", () => {
    const a = fact({ content: "A", confidence: 0.4, importance: 0.9, sourceExchangeIds: ["e1", "e2"] });
    const b = fact({ content: "a", confidence: 0.8, importance: 0.3, context: "why", sourceExchangeIds: ["e2", "e3"] });
    const merged = mergeFacts(a, b);
    expect(merged.content).toBe("a");
    expect(merged.confidence).toBe(0.8);
    expect(merged.importance).toBe(0.3);
    expect(merged.context).toBe("why");
    expect(merged.sourceExchangeIds).toEqual(["e1", "e2", "e3"]);
  });

  it("treats absent confidence as 0.5 and breaks ties on importance, then first-seen", () => {
    const a = fact({ content: "A", importance: 0.5, sourceExchangeIds: ["e1"] });
    const b = fact({ content: "B", confidence: 0.5, importance: 0.7, sourceExchangeIds: ["e2"] });
    expect(mergeFacts(a, b).content).toBe("B");
    const c = fact({ content: "C", importance: 0.5, sourceExchangeIds: ["e3"] });
    expect(mergeFacts(a, c).content).toBe("A");
  });

  it("falls back to the loser's context when the winner has none", () => {
    const a = fact({ content: "A", confidence: 0.9, sourceExchangeIds: [] });
    const b = fact({ content: "A", confidence: 0.1, context: "ctx", sourceExchangeIds: [] });
    expect(mergeFacts(a, b).context).toBe("ctx");
  });
});

describe("collapseExact", () => {
  it("three near-identical statements collapse to one with unioned sources", () => {
    const facts = [
      fact({ content: "The BLE SPEC is missing mcumgr/SMP DFU service references.", sourceExchangeIds: ["e1"] }),
      fact({ content: "The BLE SPEC is missing mcumgr/SMP DFU service references", sourceExchangeIds: ["e2"] }),
      fact({ content: "the ble spec is missing mcumgr/smp dfu service references.", sourceExchangeIds: ["e3"], confidence: 0.9 }),
    ];
    const { survivors, memberOf } = collapseExact(facts);
    expect(survivors).toHaveLength(1);
    expect(memberOf).toEqual([0, 0, 0]);
    expect(survivors[0].sourceExchangeIds).toEqual(["e1", "e2", "e3"]);
    // higher-confidence member wins the representative content
    expect(survivors[0].confidence).toBe(0.9);
  });

  it("preserves order and maps each original index to its survivor", () => {
    const facts = [
      fact({ content: "Alpha", sourceExchangeIds: ["a"] }),
      fact({ content: "Beta", sourceExchangeIds: ["b"] }),
      fact({ content: "alpha.", sourceExchangeIds: ["a2"] }),
      fact({ content: "Gamma", sourceExchangeIds: ["g"] }),
    ];
    const { survivors, memberOf } = collapseExact(facts);
    expect(survivors.map((f) => f.content)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(memberOf).toEqual([0, 1, 0, 2]);
  });

  it("returns an empty result for an empty batch", () => {
    expect(collapseExact([])).toEqual({ survivors: [], memberOf: [] });
  });
});

describe("collapseByEmbedding", () => {
  it("collapses cosine-near duplicates at the merge threshold, keeping the winner's embedding", () => {
    const base = seededEmbedding(1);
    const near = perturb(base, 0.1, 2);
    const far = seededEmbedding(3);
    expect(cosineSimilarity(base, near)).toBeGreaterThanOrEqual(0.95);
    expect(cosineSimilarity(base, far)).toBeLessThan(0.95);

    const facts = [
      fact({ content: "Facts A", sourceExchangeIds: ["e1"], confidence: 0.4 }),
      fact({ content: "Facts A, phrased differently", sourceExchangeIds: ["e2"], confidence: 0.8 }),
      fact({ content: "Something else", sourceExchangeIds: ["e3"] }),
    ];
    const result = collapseByEmbedding(facts, [base, near, far], 0.95);
    expect(result.survivors).toHaveLength(2);
    expect(result.memberOf).toEqual([0, 0, 1]);
    expect(result.survivors[0].content).toBe("Facts A, phrased differently");
    expect(result.survivors[0].sourceExchangeIds).toEqual(["e1", "e2"]);
    expect(result.embeddings[0]).toBe(near);
    expect(result.embeddings[1]).toBe(far);
  });

  it("does not collapse below the threshold", () => {
    const a = seededEmbedding(10);
    const b = seededEmbedding(11);
    const result = collapseByEmbedding([fact({ content: "x" }), fact({ content: "y" })], [a, b], 0.95);
    expect(result.survivors).toHaveLength(2);
    expect(result.memberOf).toEqual([0, 1]);
  });

  it("rejects mismatched embeddings length", () => {
    expect(() => collapseByEmbedding([fact()], [], 0.95)).toThrow();
  });
});

describe("collapseAcrossBatches", () => {
  it("removes later normalised-identical facts across conversations and unions sources into the first", () => {
    const batches = [
      { conversationId: "c1", facts: [fact({ content: "The run ID is <id>.", sourceExchangeIds: ["c1-e1"] })] },
      { conversationId: "c2", facts: [
        fact({ content: "The run ID is <id>", sourceExchangeIds: ["c2-e1"] }),
        fact({ content: "Unique to c2", sourceExchangeIds: ["c2-e2"] }),
      ] },
      { conversationId: "c3", facts: [fact({ content: "the run id is <id>.", sourceExchangeIds: ["c3-e1"] })] },
    ];
    const { batches: out, collapsed } = collapseAcrossBatches(batches);
    expect(collapsed).toBe(2);
    expect(out.map((b) => b.conversationId)).toEqual(["c1", "c2", "c3"]);
    expect(out[0].facts[0].sourceExchangeIds).toEqual(["c1-e1", "c2-e1", "c3-e1"]);
    expect(out[1].facts.map((f) => f.content)).toEqual(["Unique to c2"]);
    expect(out[2].facts).toEqual([]);
    // input untouched
    expect(batches[0].facts[0].sourceExchangeIds).toEqual(["c1-e1"]);
  });

  it("is a no-op when nothing repeats", () => {
    const batches = [
      { conversationId: "c1", facts: [fact({ content: "A" })] },
      { conversationId: "c2", facts: [fact({ content: "B" })] },
    ];
    const { batches: out, collapsed } = collapseAcrossBatches(batches);
    expect(collapsed).toBe(0);
    expect(out).toEqual(batches);
  });
});

describe("live-DB duplicate fixture (redacted)", () => {
  it("collapses the duplicate groups the dream daemon previously wrote", () => {
    const facts = loadFixture();
    const before = prefixGroups(facts);
    expect(before).toBeGreaterThanOrEqual(10);

    const { survivors } = collapseExact(facts);
    const after = prefixGroups(survivors);

    expect(after).toBeLessThan(before);
    // Only groups that merely share a prefix but differ materially may remain
    // (result-rlm-v2 vs v3). The two team-role facts differ within 60 chars.
    expect(after).toBeLessThanOrEqual(1);
    expect(survivors.length).toBe(19);
    // sources are unioned, never lost
    const inputSources = facts.flatMap((f) => f.sourceExchangeIds).sort();
    const outputSources = survivors.flatMap((f) => f.sourceExchangeIds).sort();
    expect(outputSources).toEqual(inputSources);
  });
});
