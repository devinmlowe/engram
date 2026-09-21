import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isOllamaAvailable,
  buildIntelligenceConfig,
  generateStructured,
  generate,
  resetIntelligence,
  setClient,
  CascadeError,
  type IntelligenceConfig,
} from "../../src/_core/llm/index.js";
import { loadConfig } from "../../src/_core/config/index.js";

// ─── Helpers ─────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<IntelligenceConfig> = {},
): IntelligenceConfig {
  return {
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "qwen2.5:7b",
    apiModel: "claude-haiku-4-5-20251001",
    apiFallbackModel: "claude-sonnet-4-6",
    timeoutMs: 120_000,
    ...overrides,
  };
}

/**
 * Helper to create a mock fetch that responds based on URL pattern.
 */
function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): void {
  vi.stubGlobal("fetch", vi.fn(handler));
}

/**
 * Build a mock Anthropic client with a configurable messages.create.
 */
function makeMockClient(createFn: ReturnType<typeof vi.fn>) {
  return {
    messages: { create: createFn },
  } as unknown as import("../../src/_core/llm/index.js").AnthropicClient;
}

// ─── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  resetIntelligence();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetIntelligence();
  vi.unstubAllGlobals();
});

// ─── isOllamaAvailable() ────────────────────────────────────────

describe("isOllamaAvailable", () => {
  it("returns true when Ollama has the target model", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "qwen2.5:7b" },
            { name: "llama3:8b" },
          ],
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig();
    const available = await isOllamaAvailable(config);
    expect(available).toBe(true);
  });

  it("returns true when model name includes :latest suffix", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "qwen2.5:7b:latest" }],
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig();
    // The model "qwen2.5:7b" should match "qwen2.5:7b:latest"
    // via the name === `${target}:latest` check
    const available = await isOllamaAvailable(config);
    expect(available).toBe(true);
  });

  it("returns false when target model is not in the list", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "llama3:8b" },
            { name: "mistral:7b" },
          ],
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig();
    const available = await isOllamaAvailable(config);
    expect(available).toBe(false);
  });

  it("returns false when connection is refused", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const config = makeConfig();
    const available = await isOllamaAvailable(config);
    expect(available).toBe(false);
  });

  it("returns false when Ollama returns non-200 status", async () => {
    mockFetch(async () =>
      new Response("Internal Server Error", { status: 500 }),
    );

    const config = makeConfig();
    const available = await isOllamaAvailable(config);
    expect(available).toBe(false);
  });

  it("returns false when response has no models array", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const config = makeConfig();
    const available = await isOllamaAvailable(config);
    expect(available).toBe(false);
  });

  it("is case-insensitive for model name matching", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "Qwen2.5:7B" }],
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig({ ollamaModel: "qwen2.5:7b" });
    const available = await isOllamaAvailable(config);
    expect(available).toBe(true);
  });
});

// ─── buildIntelligenceConfig() ───────────────────────────────────

describe("buildIntelligenceConfig", () => {
  it("maps EngramConfig dream fields to IntelligenceConfig", () => {
    const engramConfig = loadConfig({
      dream: {
        localModel: "custom-model:3b",
        apiModel: "claude-haiku-4-5-20251001",
        apiFallbackModel: "claude-sonnet-4-6",
        concurrency: 1,
        scheduleHour: 2,
      },
    });

    const ic = buildIntelligenceConfig(engramConfig);

    expect(ic.ollamaModel).toBe("custom-model:3b");
    expect(ic.apiModel).toBe("claude-haiku-4-5-20251001");
    expect(ic.apiFallbackModel).toBe("claude-sonnet-4-6");
    expect(ic.timeoutMs).toBe(120_000);
  });

  it("uses default Ollama model when localModel is not set", () => {
    const engramConfig = loadConfig();
    const ic = buildIntelligenceConfig(engramConfig);

    expect(ic.ollamaModel).toBe("qwen2.5:7b");
  });

  it("uses OLLAMA_HOST env var for ollamaUrl when set", () => {
    const original = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://remote-ollama:11434";
    try {
      const engramConfig = loadConfig();
      const ic = buildIntelligenceConfig(engramConfig);
      expect(ic.ollamaUrl).toBe("http://remote-ollama:11434");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_HOST;
      } else {
        process.env.OLLAMA_HOST = original;
      }
    }
  });

  it("defaults ollamaUrl to localhost:11434 when OLLAMA_HOST is not set", () => {
    const original = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST;
    try {
      const engramConfig = loadConfig();
      const ic = buildIntelligenceConfig(engramConfig);
      expect(ic.ollamaUrl).toBe("http://localhost:11434");
    } finally {
      if (original !== undefined) {
        process.env.OLLAMA_HOST = original;
      }
    }
  });
});

// ─── generateStructured() ────────────────────────────────────────

describe("generateStructured", () => {
  const schema = {
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            importance: { type: "number" },
          },
        },
      },
    },
    required: ["facts"],
  };

  it("returns local result when Ollama succeeds", async () => {
    const expectedResult = {
      facts: [{ content: "Test fact", importance: 0.8 }],
    };

    mockFetch(async (url: string) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        return new Response(
          JSON.stringify({ response: JSON.stringify(expectedResult) }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const config = makeConfig();
    const result = await generateStructured<typeof expectedResult>(
      "You are an extractor.",
      "Extract facts from this text.",
      schema,
      config,
    );

    expect(result.source).toBe("local");
    expect(result.model).toBe("qwen2.5:7b");
    expect(result.result).toEqual(expectedResult);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends correct payload to Ollama /api/generate", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ response: JSON.stringify({ facts: [] }) }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const config = makeConfig();
    await generateStructured(
      "System prompt",
      "User prompt",
      schema,
      config,
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.model).toBe("qwen2.5:7b");
    expect(capturedBody!.system).toBe("System prompt");
    expect(capturedBody!.prompt).toBe("User prompt");
    expect(capturedBody!.format).toEqual(schema);
    expect(capturedBody!.stream).toBe(false);
    expect((capturedBody!.options as Record<string, unknown>).num_predict).toBe(4096);
  });

  it("falls back to API when Ollama is unavailable", async () => {
    // Fetch throws for Ollama availability check (simulating connection refused)
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "structured_output",
          input: {
            facts: [{ content: "API fact", importance: 0.9 }],
          },
        },
      ],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generateStructured(
      "System prompt",
      "User prompt",
      schema,
      config,
    );

    expect(result.source).toBe("api");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.result).toEqual({
      facts: [{ content: "API fact", importance: 0.9 }],
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("falls back to API when Ollama generation fails", async () => {
    mockFetch(async (url: string) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_456",
          name: "structured_output",
          input: {
            facts: [{ content: "Fallback fact", importance: 0.7 }],
          },
        },
      ],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generateStructured(
      "System",
      "User",
      schema,
      config,
    );

    expect(result.source).toBe("api");
    expect(result.result).toEqual({
      facts: [{ content: "Fallback fact", importance: 0.7 }],
    });
  });

  it("uses API tool_use with correct schema shape", async () => {
    // Ollama unavailable
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_789",
          name: "structured_output",
          input: { facts: [] },
        },
      ],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    await generateStructured("System", "User", schema, config);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe("structured_output");
    expect(callArgs.tools[0].input_schema.type).toBe("object");
    expect(callArgs.tools[0].input_schema.properties).toEqual(schema.properties);
    expect(callArgs.tool_choice).toEqual({
      type: "tool",
      name: "structured_output",
    });
    expect(callArgs.system).toBe("System");
    expect(callArgs.messages).toEqual([
      { role: "user", content: "User" },
    ]);
  });

  it("falls back from primary API model to fallback model on error", async () => {
    // Ollama unavailable
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(({ model }) => {
      callCount++;
      if (model === "claude-haiku-4-5-20251001") {
        throw new Error("Rate limit exceeded");
      }
      return Promise.resolve({
        content: [
          {
            type: "tool_use",
            id: "toolu_fallback",
            name: "structured_output",
            input: { facts: [{ content: "Sonnet result", importance: 0.6 }] },
          },
        ],
      });
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generateStructured(
      "System",
      "User",
      schema,
      config,
    );

    expect(callCount).toBe(2);
    expect(result.source).toBe("api");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.result).toEqual({
      facts: [{ content: "Sonnet result", importance: 0.6 }],
    });
  });
});

// ─── generate() ──────────────────────────────────────────────────

describe("generate", () => {
  it("returns local result when Ollama succeeds", async () => {
    mockFetch(async (url: string) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        return new Response(
          JSON.stringify({ response: "This is the generated text." }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const config = makeConfig();
    const result = await generate(
      "You are a summarizer.",
      "Summarize this text.",
      config,
    );

    expect(result.source).toBe("local");
    expect(result.model).toBe("qwen2.5:7b");
    expect(result.result).toBe("This is the generated text.");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not include format parameter in Ollama text generation", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ response: "Text output" }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const config = makeConfig();
    await generate("System", "User", config);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.model).toBe("qwen2.5:7b");
    expect(capturedBody!.format).toBeUndefined();
    expect(capturedBody!.stream).toBe(false);
  });

  it("falls back to API when Ollama is unavailable", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: "API-generated text response.",
        },
      ],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generate(
      "System prompt",
      "User prompt",
      config,
    );

    expect(result.source).toBe("api");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.result).toBe("API-generated text response.");
  });

  it("API fallback uses simple messages without tools", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Response" }],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    await generate("System", "User", config);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
    expect(callArgs.tool_choice).toBeUndefined();
    expect(callArgs.system).toBe("System");
    expect(callArgs.messages).toEqual([
      { role: "user", content: "User" },
    ]);
  });

  it("falls back to API when Ollama returns empty response", async () => {
    mockFetch(async (url: string) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        return new Response(
          JSON.stringify({ response: "" }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Fallback text" }],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generate("System", "User", config);

    expect(result.source).toBe("api");
    expect(result.result).toBe("Fallback text");
  });

  it("falls back from primary API model to fallback model on error", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const mockCreate = vi.fn().mockImplementation(({ model }) => {
      if (model === "claude-haiku-4-5-20251001") {
        throw new Error("Service unavailable");
      }
      return Promise.resolve({
        content: [{ type: "text", text: "Sonnet response" }],
      });
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generate("System", "User", config);

    expect(result.source).toBe("api");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.result).toBe("Sonnet response");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────

describe("edge cases", () => {
  it("generateStructured returns empty result from Ollama when JSON is valid", async () => {
    mockFetch(async (url: string) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        return new Response(
          JSON.stringify({ response: JSON.stringify({ facts: [] }) }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const config = makeConfig();
    const result = await generateStructured(
      "System",
      "User",
      { properties: { facts: { type: "array" } }, required: ["facts"] },
      config,
    );

    expect(result.source).toBe("local");
    expect(result.result).toEqual({ facts: [] });
  });

  it("generateStructured falls back to API when Ollama returns invalid JSON", async () => {
    mockFetch(async (url: string) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        return new Response(
          JSON.stringify({ response: "not valid json {{{" }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_err",
          name: "structured_output",
          input: { facts: [{ content: "Recovered" }] },
        },
      ],
    });

    setClient(makeMockClient(mockCreate));

    const config = makeConfig();
    const result = await generateStructured(
      "System",
      "User",
      { properties: { facts: { type: "array" } }, required: ["facts"] },
      config,
    );

    expect(result.source).toBe("api");
    expect(result.result).toEqual({ facts: [{ content: "Recovered" }] });
  });
});

// ─── Cascade diagnostics (#15) ───────────────────────────────────

describe("cascade diagnostics", () => {
  const schema = { properties: { facts: { type: "array" } }, required: ["facts"] };
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Ollama down, OpenRouter rejects the key with 401. */
  function mockOllamaDownOpenRouter401(): void {
    mockFetch(async (url: string) => {
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({ error: { message: "User not found.", code: 401 } }),
          { status: 401 },
        );
      }
      throw new TypeError("fetch failed");
    });
  }

  it("OpenRouter 401 with no Anthropic key throws a CascadeError naming OpenRouter and 401", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-rejected";
    mockOllamaDownOpenRouter401();

    const config = makeConfig({ openrouterModel: "google/gemini-2.5-flash-lite" });
    const promise = generateStructured("System", "User", schema, config);

    await expect(promise).rejects.toBeInstanceOf(CascadeError);
    await expect(promise).rejects.toThrow(/openrouter/i);
    await expect(promise).rejects.toThrow(/401/);

    const err = await promise.catch((e: unknown) => e as CascadeError);
    // #45: the generic openai tier sits between ollama and openrouter and is skipped (config) when unconfigured
    expect(err.tierErrors.map((t) => t.tier)).toEqual(["ollama", "openai", "openrouter", "anthropic"]);
    expect(err.tierErrors[0].errorClass).toBe("config");
    expect(err.tierErrors[1]).toMatchObject({ tier: "openai", errorClass: "config" });
    expect(err.tierErrors[2]).toMatchObject({ errorClass: "provider" });
    expect(err.tierErrors[2].message).toMatch(/401/);
    expect(err.tierErrors[3]).toMatchObject({ errorClass: "config" });
    expect(err.tierErrors[3].message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("generate() reports the same per-tier failures", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-rejected";
    mockOllamaDownOpenRouter401();

    const config = makeConfig({ openrouterModel: "google/gemini-2.5-flash-lite" });
    const err = await generate("System", "User", config).catch((e: unknown) => e as CascadeError);

    expect(err).toBeInstanceOf(CascadeError);
    expect(err.message).toMatch(/openrouter \(provider\): OpenRouter API error 401/);
  });

  it("warns 'skipped' for config-skipped tiers and 'failed' for runtime failures", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-rejected";
    mockOllamaDownOpenRouter401();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = makeConfig({ openrouterModel: "google/gemini-2.5-flash-lite" });
    await generateStructured("System", "User", schema, config).catch(() => {});

    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /openrouter tier failed \(provider\)/.test(l))).toBe(true);
    expect(lines.some((l) => /anthropic tier skipped \(config\)/.test(l))).toBe(true);
    expect(lines.some((l) => /openrouter tier skipped/.test(l))).toBe(false);
  });

  it("a later tier's success still returns a result after an earlier runtime failure", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-rejected";
    mockOllamaDownOpenRouter401();
    setClient(makeMockClient(vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "structured_output", input: { facts: [] } }],
    })));

    const config = makeConfig({ openrouterModel: "google/gemini-2.5-flash-lite" });
    const result = await generateStructured("System", "User", schema, config);

    expect(result.provider).toBe("anthropic");
  });
});

// ─── Ollama model fallbacks (#16) ────────────────────────────────

describe("Ollama model fallbacks", () => {
  const schema = { properties: { facts: { type: "array" } }, required: ["facts"] };
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Ollama up with llama3.1:8b only; records the /api/generate bodies. */
  function mockOllamaWithLlama(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.1:8b" }, { name: "nomic-embed-text:latest" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/generate")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ response: JSON.stringify({ facts: [] }) }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
    return bodies;
  }

  it("uses the first pulled fallback when the configured model is missing", async () => {
    const bodies = mockOllamaWithLlama();
    const config = makeConfig({
      ollamaModel: "qwen2.5:7b",
      ollamaModelFallbacks: ["qwen3:8b", "llama3.1:8b"],
    });

    const result = await generateStructured("System", "User", schema, config);

    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3.1:8b");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe("llama3.1:8b");
  });

  it("generate() also resolves the fallback model", async () => {
    const bodies = mockOllamaWithLlama();
    const config = makeConfig({ ollamaModel: "qwen2.5:7b", ollamaModelFallbacks: ["llama3.1:8b"] });

    const result = await generate("System", "User", config);

    expect(result.provider).toBe("ollama");
    expect(bodies[0].model).toBe("llama3.1:8b");
  });

  it("isOllamaAvailable is true when only a fallback is pulled", async () => {
    mockOllamaWithLlama();
    expect(await isOllamaAvailable(makeConfig({ ollamaModel: "qwen2.5:7b" }))).toBe(false);
    expect(await isOllamaAvailable(makeConfig({ ollamaModel: "qwen2.5:7b", ollamaModelFallbacks: ["llama3.1:8b"] }))).toBe(true);
  });

  it("with no fallback, warns 'model not found; available: […]' exactly once per process across two calls", async () => {
    mockOllamaWithLlama();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig({ ollamaModel: "qwen2.5:7b" });

    for (let i = 0; i < 2; i++) {
      await generateStructured("System", "User", schema, config).catch(() => {});
    }

    const notFound = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => /Ollama reachable but model qwen2\.5:7b not found; available: \[llama3\.1:8b, nomic-embed-text:latest\]/.test(l));
    expect(notFound).toHaveLength(1);
  });
});
