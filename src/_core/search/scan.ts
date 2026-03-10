/**
 * Regex-based file scanning: read a file server-side, apply regex patterns,
 * and return structured matches with surrounding context.
 *
 * Phase 7D implementation.
 */

import { existsSync, readFileSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────

export interface ScanFileParams {
  path: string;
  patterns: string[];                // max 10 regex patterns
  context_lines?: number;            // default 2, max 10
  group_by?: "pattern" | "location"; // default "location"
  max_matches?: number;              // default 100, max 500
  deduplicate_overlaps?: boolean;    // default true
  session_id?: string;               // optional budget tracking
}

export interface ScanMatch {
  line: number;                      // 1-indexed
  pattern: string;                   // which pattern matched
  matchText: string;                 // actual matched text
  context: string;                   // surrounding lines with line numbers
  functionContext?: string;          // enclosing function name if detectable
}

export interface ScanFileResult {
  path: string;
  totalLines: number;
  totalMatches: number;
  matchesByPattern: Record<string, number>;
  truncated: boolean;
  tokenEstimate: number;
  matches: ScanMatch[];
  patternErrors?: Record<string, string>;
}

// ─── Function Context Detection ─────────────────────────────────

const FUNCTION_PATTERNS = [
  // function name() / async function name()
  /(?:async\s+)?function\s+(\w+)/,
  // const/let/var name = (...) => / async (...) =>
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/,
  // method() { / async method() {
  /^\s+(\w+)\s*\([^)]*\)\s*\{/,
  // name: function / name: async function
  /(\w+)\s*:\s*(?:async\s+)?function/,
];

function detectFunctionContext(lines: string[], matchLineIdx: number): string | undefined {
  // Scan backwards from the match line to find the nearest enclosing function/method
  for (let i = matchLineIdx; i >= 0; i--) {
    const line = lines[i];
    for (const pattern of FUNCTION_PATTERNS) {
      const m = pattern.exec(line);
      if (m?.[1]) {
        return m[1];
      }
    }
    // Also check for class declarations (skip them, keep looking for method)
    if (/^\s*class\s+\w+/.test(line) && i < matchLineIdx) {
      // We hit a class without finding a method — no function context
      return undefined;
    }
  }
  return undefined;
}

// ─── Context Extraction ─────────────────────────────────────────

function extractContext(
  lines: string[],
  matchLine: number, // 0-indexed
  contextLines: number,
  totalLines: number,
): string {
  const start = Math.max(0, matchLine - contextLines);
  const end = Math.min(totalLines - 1, matchLine + contextLines);
  const lineNumWidth = String(end + 1).length;

  const contextParts: string[] = [];
  for (let i = start; i <= end; i++) {
    const num = String(i + 1).padStart(lineNumWidth, " ");
    const marker = i === matchLine ? ">" : " ";
    contextParts.push(`${num}${marker}| ${lines[i]}`);
  }
  return contextParts.join("\n");
}

// ─── Raw Match (before context/dedup) ───────────────────────────

interface RawMatch {
  line: number;        // 1-indexed
  lineIdx: number;     // 0-indexed
  pattern: string;
  matchText: string;
}

// ─── Implementation ─────────────────────────────────────────────

export function scanFile(params: ScanFileParams): ScanFileResult {
  const {
    path,
    patterns,
    context_lines = 2,
    group_by = "location",
    max_matches = 100,
    deduplicate_overlaps = true,
    // session_id is consumed at the MCP layer, not here
  } = params;

  // ── Validation ──────────────────────────────────────────────
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  if (patterns.length === 0) {
    throw new Error("At least one pattern is required");
  }
  if (patterns.length > 10) {
    throw new Error("Maximum 10 patterns allowed");
  }
  if (context_lines < 0 || context_lines > 10) {
    throw new Error("context_lines must be between 0 and 10");
  }
  if (max_matches < 1 || max_matches > 500) {
    throw new Error("max_matches must be between 1 and 500");
  }

  // ── Read file once ──────────────────────────────────────────
  const fileContent = readFileSync(path, "utf-8");
  const allLines = fileContent.split("\n");
  // Trim trailing empty line from trailing newline
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const totalLines = allLines.length;

  // ── Compile patterns ──────────────────────────────────────────
  const compiled: Array<{ pattern: string; regex: RegExp | null; error?: string }> = [];
  const patternErrors: Record<string, string> = {};
  const matchesByPattern: Record<string, number> = {};

  for (const p of patterns) {
    matchesByPattern[p] = 0;
    try {
      compiled.push({ pattern: p, regex: new RegExp(p, "g") });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      compiled.push({ pattern: p, regex: null, error: msg });
      patternErrors[p] = msg;
    }
  }

  // ── Single-pass scan ──────────────────────────────────────────
  const rawMatches: RawMatch[] = [];

  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const line = allLines[lineIdx];
    for (const entry of compiled) {
      if (!entry.regex) continue;
      // Reset lastIndex for global regex
      entry.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = entry.regex.exec(line)) !== null) {
        rawMatches.push({
          line: lineIdx + 1,
          lineIdx,
          pattern: entry.pattern,
          matchText: m[0],
        });
        matchesByPattern[entry.pattern]++;
        // Prevent infinite loop on zero-length matches
        if (m[0].length === 0) {
          entry.regex.lastIndex++;
        }
      }
    }
  }

  const totalMatches = rawMatches.length;

  // ── Sort matches ──────────────────────────────────────────────
  if (group_by === "pattern") {
    // Group by pattern (in input order), then by line within each group
    const patternOrder = new Map(patterns.map((p, i) => [p, i]));
    rawMatches.sort((a, b) => {
      const pa = patternOrder.get(a.pattern) ?? 0;
      const pb = patternOrder.get(b.pattern) ?? 0;
      if (pa !== pb) return pa - pb;
      return a.line - b.line;
    });
  } else {
    // Sort by location (line number), then by pattern input order
    const patternOrder = new Map(patterns.map((p, i) => [p, i]));
    rawMatches.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return (patternOrder.get(a.pattern) ?? 0) - (patternOrder.get(b.pattern) ?? 0);
    });
  }

  // ── Truncate to max_matches ───────────────────────────────────
  const truncated = rawMatches.length > max_matches;
  const effectiveMatches = rawMatches.slice(0, max_matches);

  // ── Build context windows and deduplicate overlaps ────────────
  const matches: ScanMatch[] = [];

  if (deduplicate_overlaps && effectiveMatches.length > 0) {
    // Compute context windows and merge overlapping ones
    type WindowedMatch = RawMatch & { contextStart: number; contextEnd: number };
    const windowed: WindowedMatch[] = effectiveMatches.map((m) => ({
      ...m,
      contextStart: Math.max(0, m.lineIdx - context_lines),
      contextEnd: Math.min(totalLines - 1, m.lineIdx + context_lines),
    }));

    // Group consecutive matches whose windows overlap
    // We need to track which lines have already been assigned to avoid duplication
    const usedLines = new Set<string>(); // "lineIdx:pattern" to track context assignment

    for (let i = 0; i < windowed.length; i++) {
      const wm = windowed[i];

      // Find the merged window for this match considering overlap with previous
      let mergedStart = wm.contextStart;
      let mergedEnd = wm.contextEnd;

      // Check if this match's context overlaps with the previous match's context
      if (i > 0) {
        const prev = windowed[i - 1];
        if (wm.contextStart <= prev.contextEnd) {
          // Overlapping — only show from after previous context end
          mergedStart = prev.contextEnd + 1;
          if (mergedStart > mergedEnd) {
            // Entirely contained in previous context — show just the match line
            mergedStart = wm.lineIdx;
            mergedEnd = wm.lineIdx;
          }
        }
      }

      // Build context for this match using its (possibly trimmed) window
      const lineNumWidth = String(mergedEnd + 1).length;
      const contextParts: string[] = [];
      for (let li = mergedStart; li <= mergedEnd; li++) {
        const num = String(li + 1).padStart(lineNumWidth, " ");
        const marker = li === wm.lineIdx ? ">" : " ";
        contextParts.push(`${num}${marker}| ${allLines[li]}`);
      }

      matches.push({
        line: wm.line,
        pattern: wm.pattern,
        matchText: wm.matchText,
        context: contextParts.join("\n"),
        functionContext: detectFunctionContext(allLines, wm.lineIdx),
      });
    }
  } else {
    // No deduplication — each match gets its own full context window
    for (const rm of effectiveMatches) {
      matches.push({
        line: rm.line,
        pattern: rm.pattern,
        matchText: rm.matchText,
        context: extractContext(allLines, rm.lineIdx, context_lines, totalLines),
        functionContext: detectFunctionContext(allLines, rm.lineIdx),
      });
    }
  }

  // ── Token estimate ────────────────────────────────────────────
  const totalChars = matches.reduce((sum, m) => sum + m.context.length + m.matchText.length + m.pattern.length + 20, 0);
  const tokenEstimate = Math.ceil(totalChars / 4);

  const result: ScanFileResult = {
    path,
    totalLines,
    totalMatches,
    matchesByPattern,
    truncated,
    tokenEstimate,
    matches,
  };

  if (Object.keys(patternErrors).length > 0) {
    result.patternErrors = patternErrors;
  }

  return result;
}
