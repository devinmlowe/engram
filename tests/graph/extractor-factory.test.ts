/**
 * W6 — the graph extractor must obtain its LLM through the _core/llm
 * factory so the configured cascade (Ollama → OpenRouter → Anthropic)
 * applies. SPEC.md INV-3: no cloud dependency when a local LLM is available.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";


import type { AnthropicClient as Anthropic } from "../../src/_core/llm/index.js";
import {
  extractEntities,
  extractRelationships,
  initGraphExtractor,
  resetGraphExtractor,
  setGraphExtractorClient,
} from "../../src/graph/extractor.js";
import type { ConversationExchange, ConversationMetadata } from "../../src/semantic/extractor.js";
import { anthropicCalls, anthropicToolMock, stubFetch as stubLlmFetch, type StubFetchOptions } from "../mocks/llm-fetch.js";
import { makeExchanges } from "../helpers.js";

// ─── Helpers ────────────────────────────────────────────────────

const metadata: ConversationMetadata = {
  project: "test-project",
  dateRange: "2026-09-01 to 2026-09-16",
};

const OLLAMA_ENTITIES = {
  entities: [
    { name: "Ollama", type: "tool", description: "Local LLM runtime" },
    { name: "engram", type: "project" },
  ],
};

const OLLAMA_RELATIONSHIPS = {
  relationships: [
    { source_entity_index: 1, target_entity_index: 0, type: "uses", context: "engram uses Ollama" },
  ],
};

const OPENROUTER_ENTITIES = {
  entities: [{ name: "OpenRouter", type: "tool" }],
};

/** Ollama answers by requested schema (entities vs relationships); OpenRouter/Anthropic answer with their own entity lists. */
const stubFetch = (opts: Pick<StubFetchOptions, "ollamaUp" | "openrouter">) =>
  stubLlmFetch({
    ...opts,
    ollama: (body) => ("relationships" in ((body?.format as { properties?: Record<string, unknown> })?.properties ?? {}) ? OLLAMA_RELATIONSHIPS : OLLAMA_ENTITIES),
    tool: "extract_entities",
    openrouterResult: OPENROUTER_ENTITIES,
  });
const makeAnthropicMock = () => anthropicToolMock("extract_entities", { entities: [{ name: "Anthropic", type: "tool" }] });

// ─── Env isolation ──────────────────────────────────────────────

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST"] as const;

beforeEach(() => {
  resetGraphExtractor();
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
});

afterEach(() => {
  resetGraphExtractor();
  vi.unstubAllGlobals();
});

// ─── Tests ──────────────────────────────────────────────────────

describe("graph extractor routes through the LLM factory", () => {
  it("extractEntities uses the Ollama tier and never constructs an Anthropic client", async () => {
    const { calls, bodies } = stubFetch({ ollamaUp: true });

    await expect(initGraphExtractor()).resolves.toBeUndefined();

    const result = await extractEntities(makeExchanges(3), metadata);

    expect(result.tier).toBe("local");
    expect(result.model).toBe("qwen2.5:7b");
    expect(result.entities.map((e) => e.name)).toEqual(["Ollama", "engram"]);

    expect(anthropicCalls()).toEqual([]);
    expect(calls.some((u) => u.includes("openrouter.ai"))).toBe(false);

    const generateBody = bodies.find((b) => b.format !== undefined);
    expect((generateBody?.format as { properties: Record<string, unknown> }).properties.entities).toBeDefined();
    expect((generateBody?.options as { num_predict: number }).num_predict).toBe(4096);
  });

  it("extractRelationships uses the Ollama tier and never constructs an Anthropic client", async () => {
    stubFetch({ ollamaUp: true });

    const resolved = [
      { index: 0, id: "e-0", name: "Ollama", type: "tool" as const },
      { index: 1, id: "e-1", name: "engram", type: "project" as const },
    ];
    const result = await extractRelationships(makeExchanges(3), metadata, resolved);

    expect(result.tier).toBe("local");
    expect(result.model).toBe("qwen2.5:7b");
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].type).toBe("uses");
    expect(anthropicCalls()).toEqual([]);
  });

  it("falls back Ollama → OpenRouter → Anthropic in order", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");

    // OpenRouter healthy: served before Anthropic
    const first = stubFetch({ ollamaUp: false, openrouter: "ok" });
    const mockCreate = makeAnthropicMock();
    setGraphExtractorClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const viaOpenRouter = await extractEntities(makeExchanges(2), metadata);
    expect(viaOpenRouter.tier).toBe("openrouter");
    expect(viaOpenRouter.entities[0].name).toBe("OpenRouter");
    expect(first.calls[0]).toMatch(/\/api\/tags$/);
    expect(first.calls[1]).toContain("openrouter.ai");
    expect(mockCreate).not.toHaveBeenCalled();

    // OpenRouter rejects: Anthropic is last resort
    vi.unstubAllGlobals();
    const second = stubFetch({ ollamaUp: false, openrouter: "unauthorized" });

    const viaAnthropic = await extractEntities(makeExchanges(2), metadata);
    expect(viaAnthropic.tier).toBe("haiku");
    expect(viaAnthropic.model).toBe("claude-haiku-4-5-20251001");
    expect(viaAnthropic.entities[0].name).toBe("Anthropic");
    expect(second.calls[0]).toMatch(/\/api\/tags$/);
    expect(second.calls[1]).toContain("openrouter.ai");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0];
    expect(args.tools[0].name).toBe("extract_entities");
    expect(args.tool_choice).toEqual({ type: "tool", name: "extract_entities" });
    expect(anthropicCalls()).toEqual([]);
  });

  it("initGraphExtractor rejects when no tier is reachable", async () => {
    stubFetch({ ollamaUp: false });
    await expect(initGraphExtractor()).rejects.toThrow("No graph extraction provider configured");
  });
});
