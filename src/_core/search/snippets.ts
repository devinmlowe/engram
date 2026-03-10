/**
 * Multi-snippet fetch: read multiple line ranges from a single file in one call.
 *
 * Phase 7A.1 — more efficient than N separate show/read calls for targeted
 * code reading. Ranges are sorted, merged when overlapping, padded with
 * optional context lines, and joined with gap markers.
 */

import { existsSync, readFileSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────

export interface SnippetRange {
  start: number;
  end: number;
}

export interface FetchSnippetsParams {
  path: string;
  ranges: SnippetRange[];
  context?: number;
  session_id?: string;
}

export interface FetchSnippetsResult {
  content: string;
  totalLines: number;
  rangesCovered: number;
  tokenEstimate: number;
}

// ─── Implementation ─────────────────────────────────────────────

export function fetchSnippets(params: FetchSnippetsParams): FetchSnippetsResult {
  const { path, ranges, context = 0 } = params;

  // ── Validation ──────────────────────────────────────────────
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  if (ranges.length === 0) {
    throw new Error("At least one range is required");
  }
  if (ranges.length > 20) {
    throw new Error("Maximum 20 ranges allowed");
  }
  if (context < 0 || context > 50) {
    throw new Error("context must be between 0 and 50");
  }
  for (const range of ranges) {
    if (range.start > range.end) {
      throw new Error(`Invalid range: start must be <= end (got ${range.start}-${range.end})`);
    }
  }

  // ── Read file once ──────────────────────────────────────────
  const fileContent = readFileSync(path, "utf-8");
  const allLines = fileContent.split("\n");
  // Handle trailing newline: if last element is empty string from trailing \n, keep it
  // but for line count purposes we treat it as the actual line count
  const totalLines = allLines.length;

  // ── Sort ranges by start ────────────────────────────────────
  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  // ── Apply context padding and clamp to bounds ───────────────
  const padded: SnippetRange[] = sorted.map((r) => ({
    start: Math.max(1, r.start - context),
    end: Math.min(totalLines, r.end + context),
  }));

  // ── Merge overlapping/adjacent ranges ───────────────────────
  const merged: SnippetRange[] = [];
  for (const range of padded) {
    if (merged.length === 0) {
      merged.push({ ...range });
      continue;
    }
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 1) {
      // Overlapping or adjacent — extend
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  // ── Extract lines and format ────────────────────────────────
  const lineNumWidth = String(merged[merged.length - 1].end).length;
  const outputParts: string[] = [];

  for (let i = 0; i < merged.length; i++) {
    const range = merged[i];

    // Add gap marker between ranges
    if (i > 0) {
      const prevEnd = merged[i - 1].end;
      const gapStart = prevEnd + 1;
      const gapEnd = range.start - 1;
      outputParts.push(`--- gap (lines ${gapStart}-${gapEnd}) ---`);
    }

    // Extract and format lines (1-indexed)
    for (let lineNum = range.start; lineNum <= range.end; lineNum++) {
      const lineIdx = lineNum - 1;
      if (lineIdx >= allLines.length) break;
      const paddedNum = String(lineNum).padStart(lineNumWidth, " ");
      outputParts.push(`${paddedNum} | ${allLines[lineIdx]}`);
    }
  }

  const content = outputParts.join("\n");
  const tokenEstimate = Math.ceil(content.length / 4);

  return {
    content,
    totalLines,
    rangesCovered: merged.length,
    tokenEstimate,
  };
}
