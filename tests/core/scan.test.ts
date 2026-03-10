/**
 * Tests for the scan_file tool.
 *
 * Phase 7D: Regex-based file scanning — TDD tests written first.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanFile } from "../../src/_core/search/scan.js";

// ─── Test Fixtures ──────────────────────────────────────────────

let testDir: string;
let testFile: string;

function makeTestFile(content: string): void {
  writeFileSync(testFile, content, "utf-8");
}

function makeNumberedFile(lineCount: number): void {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`line ${i}: content here`);
  }
  makeTestFile(lines.join("\n"));
}

beforeEach(() => {
  testDir = join(tmpdir(), `engram-scan-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  testFile = join(testDir, "test.txt");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Single Pattern ─────────────────────────────────────────────

describe("scanFile", () => {
  it("should find all matches for a single pattern", () => {
    makeTestFile(
      "foo bar\nbaz foo\nqux\nfoo end\n"
    );
    const result = scanFile({
      path: testFile,
      patterns: ["foo"],
    });

    expect(result.totalMatches).toBe(3);
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].matchText).toBe("foo");
    expect(result.matches[1].line).toBe(2);
    expect(result.matches[2].line).toBe(4);
  });

  // ─── Multiple Patterns ─────────────────────────────────────────

  it("should find matches for multiple patterns", () => {
    makeTestFile(
      "const x = 1;\nlet y = 2;\nvar z = 3;\nconst w = 4;\n"
    );
    const result = scanFile({
      path: testFile,
      patterns: ["const", "var"],
    });

    expect(result.totalMatches).toBe(3);
    expect(result.matchesByPattern["const"]).toBe(2);
    expect(result.matchesByPattern["var"]).toBe(1);
  });

  // ─── Context Lines ────────────────────────────────────────────

  it("should add correct surrounding context lines", () => {
    makeNumberedFile(10);
    const result = scanFile({
      path: testFile,
      patterns: ["line 5"],
      context_lines: 2,
    });

    expect(result.matches).toHaveLength(1);
    const ctx = result.matches[0].context;
    // Should contain lines 3-7
    expect(ctx).toContain("line 3:");
    expect(ctx).toContain("line 4:");
    expect(ctx).toContain("line 5:");
    expect(ctx).toContain("line 6:");
    expect(ctx).toContain("line 7:");
    // Should NOT contain lines 1-2 or 8+
    expect(ctx).not.toContain("line 2:");
    expect(ctx).not.toContain("line 8:");
  });

  it("should clamp context lines to file bounds", () => {
    makeNumberedFile(5);
    const result = scanFile({
      path: testFile,
      patterns: ["line 1"],
      context_lines: 5,
    });

    expect(result.matches).toHaveLength(1);
    const ctx = result.matches[0].context;
    // Should start at line 1 (not go negative)
    expect(ctx).toContain("line 1:");
    // Context extends to at most line 5
    expect(ctx).toContain("line 5:");
  });

  // ─── Overlapping Context Deduplication ────────────────────────

  it("should merge overlapping contexts when deduplicate_overlaps is true", () => {
    makeNumberedFile(10);
    const result = scanFile({
      path: testFile,
      patterns: ["line 3", "line 5"],
      context_lines: 2,
      deduplicate_overlaps: true,
      group_by: "location",
    });

    // line 3 context: 1-5, line 5 context: 3-7
    // These overlap, so with dedup the contexts should be merged
    // Both matches should still be reported but with a single merged context window
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    // The key check: no duplicate line content across adjacent matches
    const allContextLines = result.matches.flatMap(m =>
      m.context.split("\n").filter(l => l.trim())
    );
    const uniqueLines = new Set(allContextLines);
    expect(uniqueLines.size).toBe(allContextLines.length);
  });

  it("should keep separate contexts when deduplicate_overlaps is false", () => {
    makeNumberedFile(10);
    const result = scanFile({
      path: testFile,
      patterns: ["line 3", "line 5"],
      context_lines: 2,
      deduplicate_overlaps: false,
      group_by: "location",
    });

    // Each match should have its own full context window
    expect(result.matches).toHaveLength(2);
    // Both should independently contain their full context
    expect(result.matches[0].context).toContain("line 3:");
    expect(result.matches[1].context).toContain("line 5:");
  });

  // ─── Group By ─────────────────────────────────────────────────

  it("should order by location when group_by is 'location'", () => {
    makeTestFile(
      "alpha\nbeta\nalpha\n"
    );
    const result = scanFile({
      path: testFile,
      patterns: ["alpha", "beta"],
      group_by: "location",
    });

    // Sorted by line number
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].pattern).toBe("alpha");
    expect(result.matches[1].line).toBe(2);
    expect(result.matches[1].pattern).toBe("beta");
    expect(result.matches[2].line).toBe(3);
    expect(result.matches[2].pattern).toBe("alpha");
  });

  it("should group by pattern when group_by is 'pattern'", () => {
    makeTestFile(
      "alpha\nbeta\nalpha\n"
    );
    const result = scanFile({
      path: testFile,
      patterns: ["alpha", "beta"],
      group_by: "pattern",
    });

    // All alpha matches first, then beta
    expect(result.matches[0].pattern).toBe("alpha");
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[1].pattern).toBe("alpha");
    expect(result.matches[1].line).toBe(3);
    expect(result.matches[2].pattern).toBe("beta");
    expect(result.matches[2].line).toBe(2);
  });

  // ─── Max Matches ──────────────────────────────────────────────

  it("should cap output at max_matches and set truncated=true", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `match ${i + 1}`);
    makeTestFile(lines.join("\n"));
    const result = scanFile({
      path: testFile,
      patterns: ["match"],
      max_matches: 5,
    });

    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.totalMatches).toBe(20);
  });

  it("should not set truncated when all matches fit", () => {
    makeTestFile("foo\nbar\nfoo\n");
    const result = scanFile({
      path: testFile,
      patterns: ["foo"],
      max_matches: 100,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  // ─── matchesByPattern ─────────────────────────────────────────

  it("should have correct matchesByPattern counts", () => {
    makeTestFile(
      "aaa\nbbb\naaa\nccc\nbbb\naaa\n"
    );
    const result = scanFile({
      path: testFile,
      patterns: ["aaa", "bbb", "ccc"],
    });

    expect(result.matchesByPattern["aaa"]).toBe(3);
    expect(result.matchesByPattern["bbb"]).toBe(2);
    expect(result.matchesByPattern["ccc"]).toBe(1);
  });

  it("should include patterns with zero matches in matchesByPattern", () => {
    makeTestFile("foo\nbar\n");
    const result = scanFile({
      path: testFile,
      patterns: ["foo", "nonexistent"],
    });

    expect(result.matchesByPattern["foo"]).toBe(1);
    expect(result.matchesByPattern["nonexistent"]).toBe(0);
  });

  // ─── Token Estimate ───────────────────────────────────────────

  it("should provide a reasonable tokenEstimate", () => {
    makeTestFile("some content\nmore content\neven more\n");
    const result = scanFile({
      path: testFile,
      patterns: ["content"],
    });

    // Token estimate should be positive and roughly chars/4
    expect(result.tokenEstimate).toBeGreaterThan(0);
    // Sanity: not wildly large
    expect(result.tokenEstimate).toBeLessThan(10000);
  });

  // ─── Validation Errors ────────────────────────────────────────

  it("should throw when patterns array is empty", () => {
    makeTestFile("content");
    expect(() =>
      scanFile({ path: testFile, patterns: [] })
    ).toThrow();
  });

  it("should throw when file does not exist", () => {
    expect(() =>
      scanFile({ path: "/nonexistent/file.txt", patterns: ["foo"] })
    ).toThrow("File not found");
  });

  // ─── Invalid Regex ────────────────────────────────────────────

  it("should return per-pattern error for invalid regex without crashing", () => {
    makeTestFile("hello world\n");
    const result = scanFile({
      path: testFile,
      patterns: ["hello", "[invalid"],
    });

    // Valid pattern still works
    expect(result.matchesByPattern["hello"]).toBe(1);
    // Invalid pattern gets 0 matches (error is handled gracefully)
    expect(result.matchesByPattern["[invalid"]).toBe(0);
    // Should have an errors field or the match count should be 0
    expect(result.totalMatches).toBe(1);
  });

  // ─── Function Context Detection ───────────────────────────────

  it("should detect enclosing JS/TS function name", () => {
    makeTestFile([
      "function doSomething() {",
      "  const x = 1;",
      "  return x + 2;",
      "}",
      "",
      "class MyClass {",
      "  method() {",
      "    console.log('hello');",
      "  }",
      "}",
      "",
      "const arrow = () => {",
      "  return 42;",
      "};",
    ].join("\n"));

    const result = scanFile({
      path: testFile,
      patterns: ["return"],
    });

    expect(result.matches).toHaveLength(2);

    // First return is inside doSomething
    expect(result.matches[0].functionContext).toBe("doSomething");

    // Second return is inside arrow
    expect(result.matches[1].functionContext).toBe("arrow");
  });

  it("should detect class method context", () => {
    makeTestFile([
      "class MyClass {",
      "  myMethod() {",
      "    const target = 'found';",
      "  }",
      "}",
    ].join("\n"));

    const result = scanFile({
      path: testFile,
      patterns: ["target"],
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].functionContext).toBe("myMethod");
  });

  // ─── Line Numbers ─────────────────────────────────────────────

  it("should use 1-indexed line numbers", () => {
    makeTestFile("first\nsecond\nthird\n");
    const result = scanFile({
      path: testFile,
      patterns: ["first"],
    });

    expect(result.matches[0].line).toBe(1);
  });

  it("should report correct totalLines", () => {
    makeNumberedFile(15);
    const result = scanFile({
      path: testFile,
      patterns: ["line 1:"],
    });

    expect(result.totalLines).toBe(15);
  });

  // ─── Path in Result ───────────────────────────────────────────

  it("should include the file path in the result", () => {
    makeTestFile("content");
    const result = scanFile({
      path: testFile,
      patterns: ["content"],
    });

    expect(result.path).toBe(testFile);
  });

  // ─── Regex Features ───────────────────────────────────────────

  it("should support regex features like capture groups and alternation", () => {
    makeTestFile("foo123\nbar456\nbaz789\n");
    const result = scanFile({
      path: testFile,
      patterns: ["(foo|bar)\\d+"],
    });

    expect(result.totalMatches).toBe(2);
    expect(result.matches[0].matchText).toBe("foo123");
    expect(result.matches[1].matchText).toBe("bar456");
  });

  // ─── Default Values ───────────────────────────────────────────

  it("should use default context_lines=2 when not specified", () => {
    makeNumberedFile(10);
    const result = scanFile({
      path: testFile,
      patterns: ["line 5"],
    });

    // Default context_lines is 2, so should show lines 3-7
    const ctx = result.matches[0].context;
    expect(ctx).toContain("line 3:");
    expect(ctx).toContain("line 7:");
  });

  // ─── Max Patterns ─────────────────────────────────────────────

  it("should reject more than 10 patterns", () => {
    makeTestFile("content");
    const patterns = Array.from({ length: 11 }, (_, i) => `p${i}`);
    expect(() =>
      scanFile({ path: testFile, patterns })
    ).toThrow();
  });

  // ─── Edge: Multiple matches on same line ──────────────────────

  it("should find multiple regex matches on the same line", () => {
    makeTestFile("foo bar foo baz foo\n");
    const result = scanFile({
      path: testFile,
      patterns: ["foo"],
    });

    // All three occurrences on line 1
    expect(result.totalMatches).toBe(3);
    expect(result.matches.every(m => m.line === 1)).toBe(true);
  });
});
