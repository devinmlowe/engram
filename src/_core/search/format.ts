/**
 * XML formatting for search results.
 *
 * Formats episodic, semantic, and graph results into structured XML
 * for LLM consumption. Extracted from episodic/search.ts during
 * Phase 1 core extraction.
 */

import type { SearchResult, RecallResponse } from "../types/index.js";

// ─── XML Escaping ────────────────────────────────────────────────

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Semantic XML ────────────────────────────────────────────────

/**
 * Format a single semantic result as an XML element.
 */
export function formatSemanticXml(result: SearchResult): string {
  const meta = result.metadata as Record<string, unknown>;
  const type = (meta.type as string) || "fact";
  const confidence = Math.round(((meta.confidence as number) || 0) * 100);
  const importance = (meta.importance as number) || 0;
  const importanceLabel =
    importance >= 0.8 ? "high" : importance >= 0.5 ? "medium" : "low";
  const score = Math.round(result.score * 100);

  const lines: string[] = [];
  lines.push(
    `  <semantic type="${escapeXml(type)}" confidence="${confidence}%" importance="${escapeXml(importanceLabel)}" relevance="${score}%">`,
  );
  lines.push(`    ${escapeXml(result.content)}`);
  lines.push("  </semantic>");
  return lines.join("\n");
}

// ─── Graph XML ───────────────────────────────────────────────────

/**
 * Format a single graph result as an XML element.
 */
export function formatGraphXml(result: SearchResult): string {
  const meta = result.metadata as Record<string, unknown>;
  const entityName = (meta.entityName as string) || "";
  const entityType = (meta.entityType as string) || "";
  const score = Math.round(result.score * 100);

  const lines: string[] = [];
  lines.push(
    `  <graph entity="${escapeXml(entityName)}" type="${escapeXml(entityType)}" relevance="${score}%">`,
  );
  lines.push(`    ${escapeXml(result.content)}`);
  lines.push("  </graph>");
  return lines.join("\n");
}

// ─── Recall XML ──────────────────────────────────────────────────

/**
 * Format recall results as XML, supporting episodic, semantic, and graph sources.
 */
export function formatRecallXml(response: RecallResponse): string {
  const lines: string[] = [];
  lines.push(
    `<engram_memory query="${escapeXml(response.query)}" tokens_used="${response.tokensUsed}" total_results="${response.totalResults}">`,
  );

  for (const result of response.results) {
    if (result.source === "semantic") {
      lines.push(formatSemanticXml(result));
    } else if (result.source === "graph") {
      lines.push(formatGraphXml(result));
    } else {
      // Episodic format
      const meta = result.metadata as Record<string, string>;
      const date = meta.date || "";
      const project = meta.project || "";
      const score = Math.round(result.score * 100);

      lines.push(
        `  <episodic date="${escapeXml(date)}" project="${escapeXml(project)}" relevance="${score}%">`,
      );
      lines.push(`    ${escapeXml(result.content)}`);
      lines.push("  </episodic>");
    }
  }

  lines.push("</engram_memory>");
  return lines.join("\n");
}
