/**
 * W6 — the semantic extractor must obtain its LLM through the _core/llm
 * factory so the configured cascade (Ollama → OpenRouter → Anthropic)
 * applies. SPEC.md INV-3: no cloud dependency when a local LLM is available.
 *
 * Every fetch is stubbed and recorded so we can prove the Anthropic API
 * is never called when a lower tier serves the request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";


import type { AnthropicClient as Anthropic } from "../../src/_core/llm/index.js";
import {
  extractFromConversation,
  initExtractor,
  resetExtractor,
  setClient,
  type ConversationExchange,
  type ConversationMetadata,
} from "../../src/semantic/extractor.js";
import { anthropicCalls, anthropicToolMock, stubFetch as stubLlmFetch, type StubFetchOptions } from "../mocks/llm-fetch.js";

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

const OLLAMA_FACTS = {
  facts: [
    {
      type: "preference",
      content: "The user prefers local inference.",
      importance: 0.8,
      source_exchange_indexes: [0],
    },
  ],
};

const OPENROUTER_FACTS = {
  facts: [
    {
      type: "fact",
      content: "OpenRouter served this extraction.",
      importance: 0.6,
      source_exchange_indexes: [1],
    },
  ],
};

const stubFetch = (opts: Pick<StubFetchOptions, "ollamaUp" | "openrouter">) =>
  stubLlmFetch({ ...opts, ollama: OLLAMA_FACTS, tool: "extract_memories", openrouterResult: OPENROUTER_FACTS });
const makeAnthropicMock = () =>
  anthropicToolMock("extract_memories", {
    facts: [{ type: "decision", content: "Anthropic served this extraction.", importance: 0.7, source_exchange_indexes: [0] }],
  });

// ─── Env isolation ──────────────────────────────────────────────

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_HOST", "ENGRAM_OPENAI_BASE_URL", "ENGRAM_OPENAI_MODEL", "OPENAI_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetExtractor();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  resetExtractor();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Tests ──────────────────────────────────────────────────────

describe("semantic extractor routes through the LLM factory", () => {
  it("uses the Ollama tier when available and never constructs an Anthropic client", async () => {
    const { calls, bodies } = stubFetch({ ollamaUp: true });

    // INV-3: a local LLM alone is a valid provider — init must not throw
    await expect(initExtractor()).resolves.toBeUndefined();

    const result = await extractFromConversation(
      "conv-ollama",
      makeExchanges(3),
      metadata,
      { tier: "auto" },
    );

    expect(result.tier).toBe("local");
    expect(result.model).toBe("qwen2.5:7b");
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe("The user prefers local inference.");

    expect(anthropicCalls()).toEqual([]);
    expect(calls.some((u) => u.includes("openrouter.ai"))).toBe(false);

    // Structured-output contract preserved on the local path
    const generateBody = bodies.find((b) => b.format !== undefined);
    expect(generateBody).toBeDefined();
    expect(generateBody?.model).toBe("qwen2.5:7b");
    expect((generateBody?.format as { properties: Record<string, unknown> }).properties.facts).toBeDefined();
    expect((generateBody?.options as { num_predict: number }).num_predict).toBe(4096);
    expect(String(generateBody?.prompt)).toContain("[Exchange 0]");
  });

  it("falls back to OpenRouter when Ollama is unavailable, before Anthropic", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const { calls } = stubFetch({ ollamaUp: false, openrouter: "ok" });
    const mockCreate = makeAnthropicMock();
    setClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const result = await extractFromConversation(
      "conv-openrouter",
      makeExchanges(3),
      metadata,
    );

    expect(result.tier).toBe("openrouter");
    expect(result.model).toBe("google/gemini-2.5-flash-lite");
    expect(result.facts[0].content).toBe("OpenRouter served this extraction.");

    // Order: Ollama probe first, then OpenRouter; Anthropic untouched
    expect(calls[0]).toMatch(/\/api\/tags$/);
    expect(calls[1]).toContain("openrouter.ai");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(anthropicCalls()).toEqual([]);
  });

  it("falls through to Anthropic when both Ollama and OpenRouter fail", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const { calls } = stubFetch({ ollamaUp: false, openrouter: "unauthorized" });
    const mockCreate = makeAnthropicMock();
    setClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const result = await extractFromConversation(
      "conv-anthropic",
      makeExchanges(3),
      metadata,
    );

    expect(result.tier).toBe("haiku");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.facts[0].content).toBe("Anthropic served this extraction.");

    expect(calls[0]).toMatch(/\/api\/tags$/);
    expect(calls[1]).toContain("openrouter.ai");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.max_tokens).toBe(4096);
    expect(args.tools[0].name).toBe("extract_memories");
    expect(args.tool_choice).toEqual({ type: "tool", name: "extract_memories" });
  });

  it("honours an explicit Anthropic tier pin by skipping the local probe", async () => {
    const { calls } = stubFetch({ ollamaUp: true });
    const mockCreate = makeAnthropicMock();
    setClient({ messages: { create: mockCreate } } as unknown as Anthropic);

    const result = await extractFromConversation(
      "conv-pinned",
      makeExchanges(2),
      metadata,
      { tier: "sonnet" },
    );

    expect(result.tier).toBe("sonnet");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(calls).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("initExtractor rejects when no tier is reachable", async () => {
    stubFetch({ ollamaUp: false });
    await expect(initExtractor()).rejects.toThrow("No extraction provider configured");
  });

  it("initExtractor accepts a configured OpenAI-compatible route on its own (#45)", async () => {
    stubFetch({ ollamaUp: false });
    process.env.ENGRAM_OPENAI_BASE_URL = "http://127.0.0.1:8100/v1";
    process.env.ENGRAM_OPENAI_MODEL = "/models/local";
    process.env.OPENAI_API_KEY = "no-key-required";
    await expect(initExtractor()).resolves.toBeUndefined();
  });
});
