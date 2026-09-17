/**
 * W6 — the graph extractor must obtain its LLM through the _core/llm
 * factory so the configured cascade (Ollama → OpenRouter → Anthropic)
 * applies. SPEC.md INV-3: no cloud dependency when a local LLM is available.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

import Anthropic from "@anthropic-ai/sdk";
import {
  extractEntities,
  extractRelationships,
  initGraphExtractor,
  resetGraphExtractor,
  setGraphExtractorClient,
} from "../../src/graph/extractor.js";
import type { ConversationExchange, ConversationMetadata } from "../../src/semantic/extractor.js";

const AnthropicCtor = vi.mocked(Anthropic);

// ─── Helpers ────────────────────────────────────────────────────

function makeExchanges(count: number): ConversationExchange[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    userMessage: `User message ${i}`,
    assistantMessage: `Assistant response ${i}`,
  }));
}

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function stubFetch(opts: {
  ollamaUp: boolean;
  openrouter?: "ok" | "unauthorized";
}): { calls: string[]; bodies: Array<Record<string, unknown>> } {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      if (body) bodies.push(body);

      if (url.endsWith("/api/tags")) {
        if (!opts.ollamaUp) throw new Error("ECONNREFUSED (stubbed)");
        return json({ models: [{ name: "qwen2.5:7b" }] });
      }
      if (url.endsWith("/api/generate")) {
        // Route by requested schema: entities vs relationships
        const props = (body?.format as { properties?: Record<string, unknown> })?.properties ?? {};
        const payload = "relationships" in props ? OLLAMA_RELATIONSHIPS : OLLAMA_ENTITIES;
        return json({ response: JSON.stringify(payload) });
      }
      if (url.includes("openrouter.ai")) {
        if (opts.openrouter === "unauthorized") return json({ error: "nope" }, 401);
        return json({
          model: "google/gemini-2.5-flash-lite",
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "extract_entities",
                      arguments: JSON.stringify(OPENROUTER_ENTITIES),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return { calls, bodies };
}

function makeAnthropicMock(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "extract_entities",
        input: { entities: [{ name: "Anthropic", type: "tool" }] },
      },
    ],
  });
}

// ─── Env isolation ──────────────────────────────────────────────

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetGraphExtractor();
  AnthropicCtor.mockClear();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  resetGraphExtractor();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

    expect(AnthropicCtor).not.toHaveBeenCalled();
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
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it("falls back Ollama → OpenRouter → Anthropic in order", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

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
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it("initGraphExtractor rejects when no tier is reachable", async () => {
    stubFetch({ ollamaUp: false });
    await expect(initGraphExtractor()).rejects.toThrow("No graph extraction provider configured");
  });
});
