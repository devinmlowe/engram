/**
 * graph/format.ts (#119): one renderer per result shape, "xml" for the MCP
 * tools and "text" for the CLI. The fixtures populate every branch (optional
 * description, incoming and outgoing edges with and without context, a
 * community, empty and non-empty sections, stale entities, observations).
 */

import { describe, it, expect } from "vitest";
import { formatExplore, formatReflect } from "../../src/graph/format.js";
import type { ExploreResult, ReflectResult } from "../../src/graph/types.js";

const explore: ExploreResult = {
  centerEntity: { id: "e1", name: "engram", type: "project", description: "Memory <system>", mentionCount: 42 },
  neighbors: [
    {
      entity: { id: "e2", name: "SQLite", type: "technology" },
      relationship: { type: "uses", weight: 0.9, direction: "outgoing", context: "storage & search" },
      depth: 1,
    },
    {
      entity: { id: "e3", name: "hermes", type: "tool" },
      relationship: { type: "depends_on", weight: 0.5, direction: "incoming" },
      depth: 2,
    },
  ],
  community: { name: "Infra", entityCount: 7 },
};

const reflect: ReflectResult = {
  communities: [
    {
      name: "Infra & Ops",
      description: "Servers",
      entityCount: 3,
      coherenceScore: 0.812,
      memoryCount: 9,
      topEntities: [{ name: "SQLite", type: "technology" }],
    },
  ],
  bridges: [
    { entityName: "engram", entityType: "project", bridgeScore: 0.456, communitySpan: 2, narrative: "links", connectedCommunities: ["Infra & Ops", "Agents"] },
  ],
  temporalPatterns: [],
  health: { totalNodes: 10, totalEdges: 12, modularity: 0.333, communityCount: 2, orphanNodes: 1, staleNodes: 1, averageCoherence: 0.75, generationCount: 4 },
  staleEntities: [{ name: "old", type: "concept", staleSince: "2026-09-01T00:00:00Z" }],
  observations: [{ id: "o1", type: "growth_observation", content: "growing", relatedEntityIds: [], confidence: 0.9, generation: 4 }],
  generation: 4,
  generatedAt: 1_758_000_000,
};

describe("formatExplore", () => {
  it("xml: escapes, both edge directions, context, community, closing tag", () => {
    const xml = formatExplore(explore, "xml");
    expect(xml).toBe(
      [
        '<engram_graph entity="engram" type="project" total_neighbors="2">',
        "  <description>Memory &lt;system&gt;</description>",
        '  <relationship direction="outgoing" type="uses" target="SQLite" weight="0.90">',
        "    storage &amp; search",
        "  </relationship>",
        '  <relationship direction="incoming" type="depends_on" source="hermes" weight="0.50" />',
        '  <community name="Infra" entities="7" />',
        "</engram_graph>",
      ].join("\n"),
    );
  });

  it("xml: stops adding neighbors once the token budget is spent and says how many were omitted", () => {
    const xml = formatExplore(explore, "xml", 40);
    expect(xml).toContain("<!-- 2 more neighbors omitted (budget) -->");
    expect(xml).not.toContain("<relationship");
    expect(xml).toContain('<community name="Infra"');
  });

  it("text: human layout with arrows, depth and community", () => {
    expect(formatExplore(explore, "text")).toBe(
      [
        "",
        "engram (project)",
        "  Memory <system>",
        "  Mentions: 42\n",
        "  Connections:",
        "    -> uses SQLite (technology, weight: 0.90, depth: 1)",
        "      storage & search",
        "    <- depends_on hermes (tool, weight: 0.50, depth: 2)",
        "\n  Community: Infra (7 entities)",
      ].join("\n"),
    );
  });

  it("text: no neighbors ends with the no-connections line (no community)", () => {
    const text = formatExplore({ ...explore, neighbors: [] }, "text");
    expect(text.endsWith("  Mentions: 42\n\n  No connections found.")).toBe(true);
    expect(text).not.toContain("Community");
  });
});

describe("formatReflect", () => {
  it("xml: every section in mode all, stale entities under health, observations last", () => {
    const xml = formatReflect(reflect, "all", "xml");
    const stamp = new Date(reflect.generatedAt * 1000).toISOString();
    expect(xml.startsWith(`<engram_reflection mode="all" generation="4" timestamp="${stamp}">`)).toBe(true);
    expect(xml).toContain('  <communities count="1" modularity="0.33">');
    expect(xml).toContain('    <community name="Infra &amp; Ops" coherence="0.81" entities="3" memories="9">');
    expect(xml).toContain('        <entity name="SQLite" type="technology" />');
    expect(xml).toContain('    <bridge entity="engram" type="project" score="0.46" span="2">');
    expect(xml).toContain('        <community name="Agents" />');
    expect(xml).toContain('  <temporal_patterns count="0">\n  </temporal_patterns>');
    expect(xml).toContain('    <stat name="stale_nodes" value="1" />');
    expect(xml).toContain('      <entity name="old" type="concept" stale_since="2026-09-01T00:00:00Z" />');
    expect(xml).toContain('    <observation type="growth_observation" confidence="0.9">growing</observation>');
    expect(xml.endsWith("</engram_reflection>")).toBe(true);
  });

  it("xml: a single mode renders only that section plus observations", () => {
    const xml = formatReflect(reflect, "health", "xml");
    expect(xml).toContain("<health>");
    expect(xml).not.toContain("<communities");
    expect(xml).not.toContain("<bridges");
    expect(xml).toContain("<observations>");
  });

  it("text: sections end with a blank line, empty ones say so, health lists every stat", () => {
    const text = formatReflect(reflect, "all", "text");
    expect(text).toContain("Reflection (generation 4, ");
    expect(text).toContain("Communities (1):\n  Infra & Ops (3 entities, coherence: 0.81, memories: 9)\n    Servers\n    Top entities: SQLite [technology]\n\n");
    expect(text).toContain("Bridge Entities (1):\n  engram [project] (score: 0.46, spans 2 communities)\n    links\n    Connects: Infra & Ops, Agents\n\n");
    expect(text).toContain("Temporal Patterns (0):\n  (none detected)\n\n");
    expect(text).toContain("Graph Health:\n  Nodes:            10\n  Edges:            12\n  Modularity:       0.33\n  Communities:      2\n  Orphan nodes:     1\n  Stale nodes:      1 (flagged by forget; pruned on the next dream run)\n  Avg coherence:    0.75\n  Generations:      4\n  Stale entities:\n    old (concept) since 2026-09-01T00:00:00Z\n\n");
    expect(text.endsWith("Observations (1):\n  [growth_observation] (confidence: 0.9)\n    growing\n")).toBe(true);
  });
});
