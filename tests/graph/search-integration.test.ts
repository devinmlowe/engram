import { describe, it, expect } from "vitest";
import { formatRecallXml } from "../../src/episodic/search.js";
import type { RecallResponse, SearchResult } from "../../src/core/types.js";

describe("Graph source in formatRecallXml", () => {
  it("outputs <graph> tags for graph-sourced results", () => {
    const graphResult: SearchResult = {
      id: "ent-1",
      source: "graph",
      score: 0.85,
      content: "TypeScript (technology): A typed superset of JavaScript\nRelationships: -> uses Node.js",
      metadata: {
        entityName: "TypeScript",
        entityType: "technology",
        mentionCount: 5,
      },
      tokenEstimate: 30,
    };

    const response: RecallResponse = {
      results: [graphResult],
      tokensUsed: 30,
      totalResults: 1,
      query: "TypeScript",
    };

    const xml = formatRecallXml(response);

    expect(xml).toContain("<graph");
    expect(xml).toContain('entity="TypeScript"');
    expect(xml).toContain('type="technology"');
    expect(xml).toContain('relevance="85%"');
    expect(xml).toContain("typed superset of JavaScript");
    expect(xml).toContain("</graph>");
  });

  it("handles mixed sources correctly", () => {
    const semanticResult: SearchResult = {
      id: "mem-1",
      source: "semantic",
      score: 0.9,
      content: "User prefers TypeScript",
      metadata: {
        type: "preference",
        confidence: 0.8,
        importance: 0.7,
      },
      tokenEstimate: 10,
    };

    const graphResult: SearchResult = {
      id: "ent-2",
      source: "graph",
      score: 0.75,
      content: "React (technology): A JavaScript UI library",
      metadata: {
        entityName: "React",
        entityType: "technology",
      },
      tokenEstimate: 15,
    };

    const episodicResult: SearchResult = {
      id: "exch-1",
      source: "episodic",
      score: 0.6,
      content: "User: How to use React?\nAssistant: React is...",
      metadata: {
        date: "2025-01-15",
        project: "web-app",
      },
      tokenEstimate: 20,
    };

    const response: RecallResponse = {
      results: [semanticResult, graphResult, episodicResult],
      tokensUsed: 45,
      totalResults: 3,
      query: "React TypeScript",
    };

    const xml = formatRecallXml(response);

    // Should contain all three source types
    expect(xml).toContain("<semantic");
    expect(xml).toContain("<graph");
    expect(xml).toContain("<episodic");

    // Should be within engram_memory wrapper
    expect(xml).toContain("<engram_memory");
    expect(xml).toContain("</engram_memory>");

    // Verify ordering matches input
    const semanticIdx = xml.indexOf("<semantic");
    const graphIdx = xml.indexOf("<graph");
    const episodicIdx = xml.indexOf("<episodic");
    expect(semanticIdx).toBeLessThan(graphIdx);
    expect(graphIdx).toBeLessThan(episodicIdx);
  });

  it("escapes XML special characters in graph results", () => {
    const graphResult: SearchResult = {
      id: "ent-3",
      source: "graph",
      score: 0.7,
      content: 'C++ <templates> & "generics"',
      metadata: {
        entityName: "C++",
        entityType: "technology",
      },
      tokenEstimate: 10,
    };

    const response: RecallResponse = {
      results: [graphResult],
      tokensUsed: 10,
      totalResults: 1,
      query: "C++",
    };

    const xml = formatRecallXml(response);

    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;templates&gt;");
    expect(xml).toContain("&quot;generics&quot;");
    // Should not contain raw < > & in content
    expect(xml).not.toMatch(/<templates>/);
  });
});
