/**
 * Tests for the multi-snippet fetch tool.
 *
 * Phase 7A.1: Multi-Snippet Fetch — TDD tests written first.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchSnippets } from "../../src/_core/search/snippets.js";

// ─── Test Fixtures ──────────────────────────────────────────────

let testDir: string;
let testFile: string;

function makeTestFile(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`line ${i}: content here`);
  }
  const content = lines.join("\n");
  writeFileSync(testFile, content, "utf-8");
  return content;
}

beforeEach(() => {
  testDir = join(tmpdir(), `engram-snippets-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  testFile = join(testDir, "test.txt");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Valid Ranges ───────────────────────────────────────────────

describe("fetchSnippets", () => {
  it("should fetch a single range", () => {
    makeTestFile(10);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 3, end: 5 }],
    });

    expect(result.rangesCovered).toBe(1);
    expect(result.totalLines).toBe(10);
    expect(result.content).toContain("line 3:");
    expect(result.content).toContain("line 4:");
    expect(result.content).toContain("line 5:");
    expect(result.content).not.toContain("line 2:");
    expect(result.content).not.toContain("line 6:");
  });

  it("should fetch multiple non-overlapping ranges with gap markers", () => {
    makeTestFile(20);
    const result = fetchSnippets({
      path: testFile,
      ranges: [
        { start: 2, end: 4 },
        { start: 10, end: 12 },
      ],
    });

    expect(result.rangesCovered).toBe(2);
    expect(result.content).toContain("line 2:");
    expect(result.content).toContain("line 4:");
    expect(result.content).toContain("--- gap (lines 5-9) ---");
    expect(result.content).toContain("line 10:");
    expect(result.content).toContain("line 12:");
  });

  it("should format lines with line numbers", () => {
    makeTestFile(10);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 1, end: 2 }],
    });

    // Format: " N | content" (width depends on max line number)
    expect(result.content).toMatch(/\d+ \| line 1:/);
    expect(result.content).toMatch(/\d+ \| line 2:/);
  });

  it("should estimate tokens at ~4 chars per token", () => {
    makeTestFile(10);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 1, end: 10 }],
    });

    expect(result.tokenEstimate).toBe(Math.ceil(result.content.length / 4));
  });

  // ─── Overlapping Range Merge ────────────────────────────────

  it("should merge overlapping ranges", () => {
    makeTestFile(20);
    const result = fetchSnippets({
      path: testFile,
      ranges: [
        { start: 1, end: 5 },
        { start: 3, end: 8 },
      ],
    });

    // Should merge into a single range 1-8
    expect(result.rangesCovered).toBe(1);
    expect(result.content).toContain("line 1:");
    expect(result.content).toContain("line 8:");
    expect(result.content).not.toContain("--- gap");
  });

  it("should merge adjacent ranges", () => {
    makeTestFile(20);
    const result = fetchSnippets({
      path: testFile,
      ranges: [
        { start: 1, end: 5 },
        { start: 6, end: 10 },
      ],
    });

    expect(result.rangesCovered).toBe(1);
    expect(result.content).not.toContain("--- gap");
  });

  // ─── Out-of-Bounds Clamping ─────────────────────────────────

  it("should clamp end beyond file length", () => {
    makeTestFile(5);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 3, end: 100 }],
    });

    expect(result.rangesCovered).toBe(1);
    expect(result.content).toContain("line 3:");
    expect(result.content).toContain("line 5:");
    expect(result.totalLines).toBe(5);
  });

  // ─── Context Padding ───────────────────────────────────────

  it("should add context padding lines", () => {
    makeTestFile(20);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 5, end: 5 }],
      context: 2,
    });

    // Should include lines 3-7
    expect(result.content).toContain("line 3:");
    expect(result.content).toContain("line 7:");
  });

  it("should clamp context padding to file bounds", () => {
    makeTestFile(10);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 1, end: 2 }],
      context: 5,
    });

    // Should start at line 1 (not go negative)
    expect(result.content).toContain("line 1:");
    expect(result.content).toContain("line 7:");
    expect(result.content).not.toContain("line 8:");
  });

  it("should merge ranges that become adjacent after context padding", () => {
    makeTestFile(20);
    const result = fetchSnippets({
      path: testFile,
      ranges: [
        { start: 3, end: 3 },
        { start: 7, end: 7 },
      ],
      context: 2,
    });

    // Range 1 with context: 1-5, Range 2 with context: 5-9
    // They overlap at line 5, so they merge into 1-9
    expect(result.rangesCovered).toBe(1);
    expect(result.content).not.toContain("--- gap");
  });

  // ─── Sorting ────────────────────────────────────────────────

  it("should sort ranges by start line regardless of input order", () => {
    makeTestFile(20);
    const result = fetchSnippets({
      path: testFile,
      ranges: [
        { start: 15, end: 17 },
        { start: 2, end: 4 },
      ],
    });

    // First range in output should be 2-4
    const lines = result.content.split("\n");
    const firstContentLine = lines.find((l) => l.includes("|"));
    expect(firstContentLine).toMatch(/2 \| line 2:/);
  });

  // ─── Validation Errors ──────────────────────────────────────

  it("should throw when path does not exist", () => {
    expect(() =>
      fetchSnippets({
        path: "/nonexistent/file.txt",
        ranges: [{ start: 1, end: 1 }],
      }),
    ).toThrow("File not found");
  });

  it("should throw when start > end in a range", () => {
    makeTestFile(10);
    expect(() =>
      fetchSnippets({
        path: testFile,
        ranges: [{ start: 5, end: 3 }],
      }),
    ).toThrow("start must be <= end");
  });

  it("should throw when more than 20 ranges are provided", () => {
    makeTestFile(100);
    const ranges = Array.from({ length: 21 }, (_, i) => ({
      start: i * 4 + 1,
      end: i * 4 + 2,
    }));
    expect(() =>
      fetchSnippets({ path: testFile, ranges }),
    ).toThrow("Maximum 20 ranges");
  });

  it("should throw when ranges array is empty", () => {
    makeTestFile(10);
    expect(() =>
      fetchSnippets({ path: testFile, ranges: [] }),
    ).toThrow();
  });

  it("should throw when context exceeds 50", () => {
    makeTestFile(10);
    expect(() =>
      fetchSnippets({
        path: testFile,
        ranges: [{ start: 1, end: 1 }],
        context: 51,
      }),
    ).toThrow("context");
  });

  // ─── Edge Cases ─────────────────────────────────────────────

  it("should handle a single-line file", () => {
    writeFileSync(testFile, "only line", "utf-8");
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 1, end: 1 }],
    });

    expect(result.totalLines).toBe(1);
    expect(result.content).toContain("only line");
  });

  it("should handle a range that is a single line", () => {
    makeTestFile(10);
    const result = fetchSnippets({
      path: testFile,
      ranges: [{ start: 5, end: 5 }],
    });

    expect(result.rangesCovered).toBe(1);
    expect(result.content).toContain("line 5:");
    expect(result.content).not.toContain("line 4:");
    expect(result.content).not.toContain("line 6:");
  });

  it("should handle max 20 ranges without error", () => {
    makeTestFile(100);
    const ranges = Array.from({ length: 20 }, (_, i) => ({
      start: i * 5 + 1,
      end: i * 5 + 2,
    }));
    const result = fetchSnippets({ path: testFile, ranges });

    expect(result.rangesCovered).toBeGreaterThan(0);
  });
});
