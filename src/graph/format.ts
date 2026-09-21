/**
 * Renderers for the graph results both agent surfaces show (#119): `"xml"`
 * is what the MCP `explore` / `reflect` tools return, `"text"` is what the
 * CLI prints. Each result shape is walked once, in one section order, so
 * the two surfaces cannot drift.
 */

import { escapeXml } from "../_core/search/format.js";
import type { ExploreResult, ReflectResult } from "./types.js";

export type GraphFormat = "xml" | "text";

/** `explore` result. The token budget only applies to XML (neighbors are dropped once it is spent). */
export function formatExplore(result: ExploreResult, format: GraphFormat, budget = Infinity): string {
  const c = result.centerEntity;
  const out: string[] = [];

  if (format === "text") {
    out.push(`\n${c.name} (${c.type})`);
    if (c.description) out.push(`  ${c.description}`);
    out.push(`  Mentions: ${c.mentionCount}\n`);
    if (result.neighbors.length === 0) return [...out, "  No connections found."].join("\n");
    out.push("  Connections:");
    for (const n of result.neighbors) {
      const r = n.relationship;
      out.push(`    ${r.direction === "outgoing" ? "->" : "<-"} ${r.type} ${n.entity.name} (${n.entity.type}, weight: ${r.weight.toFixed(2)}, depth: ${n.depth})`);
      if (r.context) out.push(`      ${r.context}`);
    }
    if (result.community) out.push(`\n  Community: ${result.community.name} (${result.community.entityCount} entities)`);
    return out.join("\n");
  }

  let tokens = 0;
  const push = (line: string) => {
    out.push(line);
    tokens += Math.ceil(line.length / 4);
  };
  push(`<engram_graph entity="${escapeXml(c.name)}" type="${c.type}" total_neighbors="${result.neighbors.length}">`);
  if (c.description) push(`  <description>${escapeXml(c.description)}</description>`);
  let included = 0;
  for (const n of result.neighbors) {
    const r = n.relationship;
    const attrs = `direction="${r.direction}" type="${r.type}" ${r.direction === "outgoing" ? "target" : "source"}="${escapeXml(n.entity.name)}" weight="${r.weight.toFixed(2)}"`;
    const line = r.context ? `  <relationship ${attrs}>\n    ${escapeXml(r.context)}\n  </relationship>` : `  <relationship ${attrs} />`;
    if (tokens + Math.ceil(line.length / 4) > budget) break;
    push(line);
    included++;
  }
  if (included < result.neighbors.length) out.push(`  <!-- ${result.neighbors.length - included} more neighbors omitted (budget) -->`);
  if (result.community) out.push(`  <community name="${escapeXml(result.community.name)}" entities="${result.community.entityCount}" />`);
  out.push("</engram_graph>");
  return out.join("\n");
}

/** `reflect` result; `mode` picks one section or `all`. Observations are always included when present. */
export function formatReflect(result: ReflectResult, mode: string, format: GraphFormat): string {
  const xml = format === "xml";
  const want = (section: string) => mode === "all" || mode === section;
  const at = new Date(result.generatedAt * 1000);
  const h = result.health;
  const out: string[] = [];
  // Text sections end with a blank line, or "(none detected)" when empty.
  const endText = (count: number) => (count === 0 ? "  (none detected)\n" : "");

  out.push(
    xml
      ? `<engram_reflection mode="${escapeXml(mode)}" generation="${result.generation}" timestamp="${at.toISOString()}">`
      : `Reflection (generation ${result.generation}, ${at.toLocaleString()})\n`,
  );

  if (want("communities")) {
    const list = result.communities;
    out.push(xml ? `  <communities count="${list.length}" modularity="${h.modularity.toFixed(2)}">` : `Communities (${list.length}):`);
    for (const c of list) {
      if (xml) {
        out.push(`    <community name="${escapeXml(c.name)}" coherence="${c.coherenceScore.toFixed(2)}" entities="${c.entityCount}" memories="${c.memoryCount}">`);
        out.push(`      <description>${escapeXml(c.description)}</description>`);
        if (c.topEntities.length > 0) {
          out.push("      <top_entities>");
          for (const e of c.topEntities) out.push(`        <entity name="${escapeXml(e.name)}" type="${escapeXml(e.type)}" />`);
          out.push("      </top_entities>");
        }
        out.push("    </community>");
      } else {
        out.push(`  ${c.name} (${c.entityCount} entities, coherence: ${c.coherenceScore.toFixed(2)}, memories: ${c.memoryCount})`);
        out.push(`    ${c.description}`);
        if (c.topEntities.length > 0) out.push(`    Top entities: ${c.topEntities.map((e) => `${e.name} [${e.type}]`).join(", ")}`);
      }
    }
    out.push(xml ? "  </communities>" : endText(list.length));
  }

  if (want("bridges")) {
    const list = result.bridges;
    out.push(xml ? `  <bridges count="${list.length}">` : `Bridge Entities (${list.length}):`);
    for (const b of list) {
      if (xml) {
        out.push(`    <bridge entity="${escapeXml(b.entityName)}" type="${escapeXml(b.entityType)}" score="${b.bridgeScore.toFixed(2)}" span="${b.communitySpan}">`);
        if (b.narrative) out.push(`      <narrative>${escapeXml(b.narrative)}</narrative>`);
        if (b.connectedCommunities.length > 0) {
          out.push("      <connects>");
          for (const name of b.connectedCommunities) out.push(`        <community name="${escapeXml(name)}" />`);
          out.push("      </connects>");
        }
        out.push("    </bridge>");
      } else {
        out.push(`  ${b.entityName} [${b.entityType}] (score: ${b.bridgeScore.toFixed(2)}, spans ${b.communitySpan} communities)`);
        if (b.narrative) out.push(`    ${b.narrative}`);
        if (b.connectedCommunities.length > 0) out.push(`    Connects: ${b.connectedCommunities.join(", ")}`);
      }
    }
    out.push(xml ? "  </bridges>" : endText(list.length));
  }

  if (want("temporal")) {
    const list = result.temporalPatterns;
    out.push(xml ? `  <temporal_patterns count="${list.length}">` : `Temporal Patterns (${list.length}):`);
    for (const p of list) {
      if (xml) {
        out.push(`    <pattern type="${escapeXml(p.type)}" confidence="${p.confidence.toFixed(1)}">`);
        out.push(`      <description>${escapeXml(p.description)}</description>`);
        if (p.entityIds.length > 0) out.push(`      <entities>${escapeXml(p.entityIds.join(", "))}</entities>`);
        out.push("    </pattern>");
      } else {
        out.push(`  [${p.type}] (confidence: ${p.confidence.toFixed(1)})`);
        out.push(`    ${p.description}`);
      }
    }
    out.push(xml ? "  </temporal_patterns>" : endText(list.length));
  }

  if (want("health")) {
    if (xml) {
      out.push("  <health>");
      out.push(`    <stat name="total_nodes" value="${h.totalNodes}" />`);
      out.push(`    <stat name="total_edges" value="${h.totalEdges}" />`);
      out.push(`    <stat name="modularity" value="${h.modularity.toFixed(2)}" />`);
      out.push(`    <stat name="communities" value="${h.communityCount}" />`);
      out.push(`    <stat name="orphan_nodes" value="${h.orphanNodes}" />`);
      out.push(`    <stat name="stale_nodes" value="${h.staleNodes}" />`);
      out.push(`    <stat name="average_coherence" value="${h.averageCoherence.toFixed(2)}" />`);
      if (result.staleEntities.length > 0) {
        // #57: flagged by forget, deleted by the next dream prune once no evidence remains
        out.push("    <stale_entities>");
        for (const e of result.staleEntities) out.push(`      <entity name="${escapeXml(e.name)}" type="${escapeXml(e.type)}" stale_since="${escapeXml(e.staleSince)}" />`);
        out.push("    </stale_entities>");
      }
      out.push("  </health>");
    } else {
      out.push("Graph Health:");
      out.push(`  Nodes:            ${h.totalNodes}`);
      out.push(`  Edges:            ${h.totalEdges}`);
      out.push(`  Modularity:       ${h.modularity.toFixed(2)}`);
      out.push(`  Communities:      ${h.communityCount}`);
      out.push(`  Orphan nodes:     ${h.orphanNodes}`);
      out.push(`  Stale nodes:      ${h.staleNodes} (flagged by forget; pruned on the next dream run)`);
      out.push(`  Avg coherence:    ${h.averageCoherence.toFixed(2)}`);
      out.push(`  Generations:      ${h.generationCount}`);
      if (result.staleEntities.length > 0) {
        out.push("  Stale entities:");
        for (const e of result.staleEntities) out.push(`    ${e.name} (${e.type}) since ${e.staleSince}`);
      }
      out.push("");
    }
  }

  if (result.observations.length > 0) {
    out.push(xml ? "  <observations>" : `Observations (${result.observations.length}):`);
    for (const o of result.observations) {
      if (xml) out.push(`    <observation type="${escapeXml(o.type)}" confidence="${o.confidence.toFixed(1)}">${escapeXml(o.content)}</observation>`);
      else out.push(`  [${o.type}] (confidence: ${o.confidence.toFixed(1)})`, `    ${o.content}`);
    }
    out.push(xml ? "  </observations>" : "");
  }

  if (xml) out.push("</engram_reflection>");
  return out.join("\n");
}
