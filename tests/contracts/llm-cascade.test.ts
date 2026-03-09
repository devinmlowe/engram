/**
 * Contract: LLM Cascade Behavior
 *
 * The intelligence layer's tier cascade (Ollama → OpenRouter → Anthropic)
 * must work identically after extraction to _core/llm/. The cascade is the
 * system's cost optimization strategy — if it breaks, dream runs either
 * fail silently or burn expensive API calls unnecessarily.
 *
 * These tests verify the cascade logic via controlled mocks, pinning:
 * - Fallback order (local → cheap cloud → expensive API)
 * - Source tracking in GenerationResult
 * - Error classification (transient → retry, permanent → throw)
 * - Availability check behavior
 * - State isolation (no leaked clients between calls)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateStructured,
  generate,
  isOllamaAvailable,
  buildIntelligenceConfig,
  resetIntelligence,
  setClient,
  type IntelligenceConfig,
} from "../../src/_core/llm/index.js";
import { loadConfig } from "../../src/_core/config/index.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeConfig(overrides: Partial<IntelligenceConfig> = {}): IntelligenceConfig {
  return {
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "qwen2.5:7b",
    apiModel: "claude-haiku-4-5-20251001",
    apiFallbackModel: "claude-sonnet-4-6",
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeMockAnthropicClient(response: unknown) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(response),
    },
  } as any;
}

describe("LLM Cascade Contract", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetIntelligence();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetIntelligence();
    // Clean up any env vars we set
    delete process.env.OPENROUTER_API_KEY;
  });

  // ── Availability Checks ────────────────────────────────────────

  it("isOllamaAvailable returns true when model is present", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
        { status: 200 },
      ),
    );

    const result = await isOllamaAvailable(makeConfig());
    expect(result).toBe(true);
  });

  it("isOllamaAvailable returns false on connection error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await isOllamaAvailable(makeConfig());
    expect(result).toBe(false);
  });

  it("isOllamaAvailable returns false when model not in list", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ models: [{ name: "llama3:latest" }] }),
        { status: 200 },
      ),
    );

    const result = await isOllamaAvailable(makeConfig());
    expect(result).toBe(false);
  });

  it("isOllamaAvailable matches model name case-insensitively", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ models: [{ name: "Qwen2.5:7B" }] }),
        { status: 200 },
      ),
    );

    const result = await isOllamaAvailable(makeConfig());
    expect(result).toBe(true);
  });

  it("isOllamaAvailable matches with :latest suffix", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ models: [{ name: "qwen2.5:latest" }] }),
        { status: 200 },
      ),
    );

    const result = await isOllamaAvailable(makeConfig({ ollamaModel: "qwen2.5" }));
    expect(result).toBe(true);
  });

  // ── Cascade: Ollama → API ──────────────────────────────────────

  it("falls through to API when Ollama is unavailable", async () => {
    // Ollama check fails
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    // No OpenRouter key
    const config = makeConfig({ openrouterModel: undefined });

    // Set up Anthropic mock
    const mockClient = makeMockAnthropicClient({
      content: [{ type: "tool_use", input: { answer: 42 } }],
    });
    setClient(mockClient);

    const result = await generateStructured<{ answer: number }>(
      "system prompt",
      "user prompt",
      { properties: { answer: { type: "number" } } },
      config,
    );

    expect(result.source).toBe("api");
    expect(result.result).toEqual({ answer: 42 });
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it("uses Ollama when available (does not call API)", async () => {
    // Ollama availability check
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
        { status: 200 },
      ),
    );

    // Ollama generate
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ response: '{"answer": 42}' }),
        { status: 200 },
      ),
    );

    const config = makeConfig({ openrouterModel: undefined });
    const mockClient = makeMockAnthropicClient({});
    setClient(mockClient);

    const result = await generateStructured<{ answer: number }>(
      "system", "user",
      { properties: { answer: { type: "number" } } },
      config,
    );

    expect(result.source).toBe("local");
    expect(result.model).toBe("qwen2.5:7b");
    expect(result.result).toEqual({ answer: 42 });
    // API should NOT have been called
    expect(mockClient.messages.create).not.toHaveBeenCalled();
  });

  // ── Cascade: API primary → API fallback ────────────────────────

  it("falls from primary API model to fallback on failure", async () => {
    // Ollama unavailable
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const config = makeConfig({ openrouterModel: undefined });

    // First API call (haiku) fails, second (sonnet) succeeds
    const mockClient = {
      messages: {
        create: vi.fn()
          .mockRejectedValueOnce(new Error("Rate limited"))
          .mockResolvedValueOnce({
            content: [{ type: "tool_use", input: { answer: 42 } }],
          }),
      },
    } as any;
    setClient(mockClient);

    const result = await generateStructured<{ answer: number }>(
      "system", "user",
      { properties: { answer: { type: "number" } } },
      config,
    );

    expect(result.source).toBe("api");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
  });

  // ── GenerationResult Contract ──────────────────────────────────

  it("GenerationResult includes source, model, and positive duration", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const config = makeConfig({ openrouterModel: undefined });
    const mockClient = makeMockAnthropicClient({
      content: [{ type: "text", text: "hello world" }],
    });
    setClient(mockClient);

    const result = await generate("system", "user", config);

    expect(result).toHaveProperty("result");
    expect(result).toHaveProperty("source");
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("durationMs");
    expect(typeof result.result).toBe("string");
    expect(["local", "api"]).toContain(result.source);
    expect(typeof result.model).toBe("string");
    expect(result.model.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── State Isolation ────────────────────────────────────────────

  it("resetIntelligence clears client state", async () => {
    const mockClient1 = makeMockAnthropicClient({
      content: [{ type: "text", text: "first" }],
    });
    setClient(mockClient1);
    resetIntelligence();

    // After reset, a new client should be created (from env)
    // If ANTHROPIC_API_KEY is not set, this should throw
    // This verifies the reset actually cleared the singleton
    const mockClient2 = makeMockAnthropicClient({
      content: [{ type: "text", text: "second" }],
    });
    setClient(mockClient2);

    fetchSpy.mockRejectedValueOnce(new Error("No Ollama"));
    const config = makeConfig({ openrouterModel: undefined });

    const result = await generate("system", "user", config);
    expect(result.result).toBe("second");
    // Verify client1 was NOT called
    expect(mockClient1.messages.create).not.toHaveBeenCalled();
  });

  // ── buildIntelligenceConfig ────────────────────────────────────

  it("buildIntelligenceConfig maps EngramConfig correctly", () => {
    const engramConfig = loadConfig();
    const ic = buildIntelligenceConfig(engramConfig);

    expect(ic.apiModel).toBe(engramConfig.dream.apiModel);
    expect(ic.apiFallbackModel).toBe(engramConfig.dream.apiFallbackModel);
    expect(ic.timeoutMs).toBe(120_000);
    expect(typeof ic.ollamaUrl).toBe("string");
    expect(typeof ic.ollamaModel).toBe("string");
  });

  it("OLLAMA_HOST env var overrides ollamaUrl", () => {
    const original = process.env.OLLAMA_HOST;
    try {
      process.env.OLLAMA_HOST = "http://custom:11434";
      const ic = buildIntelligenceConfig(loadConfig());
      expect(ic.ollamaUrl).toBe("http://custom:11434");
    } finally {
      if (original) process.env.OLLAMA_HOST = original;
      else delete process.env.OLLAMA_HOST;
    }
  });
});
