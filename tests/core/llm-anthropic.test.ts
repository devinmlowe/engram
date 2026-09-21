/**
 * #118 — the Anthropic tier is a plain fetch POST to the Messages API, not
 * the `@anthropic-ai/sdk` client. These tests pin the wire contract the SDK
 * used to provide: URL, auth and version headers, the request body fields,
 * the timeout signal, and an error that carries the HTTP status for the
 * cascade's classifier.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  AnthropicApiError,
  apiGenerateStructured,
  apiGenerate,
  createAnthropicClient,
  resetIntelligence,
} from "../../src/_core/llm/providers/anthropic.js";
import type { IntelligenceConfig } from "../../src/_core/llm/types.js";

const config: IntelligenceConfig = {
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "qwen2.5:7b",
  apiModel: "claude-haiku-4-5-20251001",
  apiFallbackModel: "claude-sonnet-4-6",
  timeoutMs: 5000,
};

function toolUseReply(input: unknown): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: "structured_output", input }], model: config.apiModel }),
    { status: 200 },
  );
}

const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  resetIntelligence();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIntelligence();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("createAnthropicClient", () => {
  it("POSTs the params to the Messages API with the key and version headers", async () => {
    const fetchMock = vi.fn(async () => toolUseReply({ facts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createAnthropicClient("sk-ant-test");
    const signal = AbortSignal.timeout(1000);
    const reply = await client.messages.create(
      { model: "m", max_tokens: 10, system: "s", messages: [{ role: "user", content: "u" }] },
      { signal },
    );

    expect(reply.content[0].type).toBe("tool_use");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": ANTHROPIC_VERSION,
    });
    expect(init.signal).toBe(signal);
    expect(JSON.parse(String(init.body))).toEqual({ model: "m", max_tokens: 10, system: "s", messages: [{ role: "user", content: "u" }] });
  });

  it("throws an AnthropicApiError carrying the HTTP status and body on a non-2xx reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 })));

    const client = createAnthropicClient("bad");
    const err = await client.messages
      .create({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "u" }] })
      .catch((e: unknown) => e as AnthropicApiError);

    expect(err).toBeInstanceOf(AnthropicApiError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/^Anthropic API error 401: .*authentication_error/);
  });
});

describe("apiGenerateStructured over fetch", () => {
  it("sends model, max_tokens, system, messages, tools and a forced tool_choice, with a timeout signal", async () => {
    const fetchMock = vi.fn(async () => toolUseReply({ facts: ["x"] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiGenerateStructured<{ facts: string[] }>(
      "System", "User", { properties: { facts: { type: "array" } } }, config, { toolName: "extract_memories", maxTokens: 2048 },
    );

    expect(result).toMatchObject({ result: { facts: ["x"] }, source: "api", provider: "anthropic", model: config.apiModel });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: config.apiModel,
      max_tokens: 2048,
      system: "System",
      tools: [{ name: "extract_memories", description: expect.any(String), input_schema: { type: "object", properties: { facts: { type: "array" } } } }],
      tool_choice: { type: "tool", name: "extract_memories" },
      messages: [{ role: "user", content: "User" }],
    });
    expect(body).not.toHaveProperty("temperature");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the second model after a failed primary and surfaces the last error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(toolUseReply({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiGenerateStructured("S", "U", {}, config);
    expect(result.model).toBe(config.apiFallbackModel);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    const err = await apiGenerateStructured("S", "U", {}, config).catch((e: unknown) => e as AnthropicApiError);
    expect(err).toBeInstanceOf(AnthropicApiError);
    expect(err.status).toBe(400);
  });

  it("apiGenerate returns the first text block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "hello" }] }), { status: 200 })));
    const result = await apiGenerate("S", "U", config);
    expect(result.result).toBe("hello");
    expect(result.provider).toBe("anthropic");
  });
});
