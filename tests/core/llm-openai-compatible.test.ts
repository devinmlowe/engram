/**
 * #45: generic OpenAI-compatible provider. A real local HTTP server plays the
 * gateway so the request shape (auth header from the NAMED env var, no
 * temperature by default, /v1 normalisation, tool-call and content parsing,
 * error classes) is asserted on the wire. Placeholder credentials only.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  callOpenAICompatibleTool, callOpenAICompatibleText, normalizeBaseUrl, resolveOpenAIRouteConfig, openaiRoute,
  openaiGenerateStructured, OpenAICompatibleError, classifyHttpStatus, type OpenAIRoute,
} from "../../src/_core/llm/providers/openai-compatible.js";
import { OpenRouterError } from "../../src/_core/llm/providers/openrouter.js";
import {
  generateStructured, parseProviderOrder, describeProviders, buildIntelligenceConfig, DEFAULT_PROVIDER_ORDER, resetIntelligence,
  type IntelligenceConfig,
} from "../../src/_core/llm/index.js";
import { loadConfig } from "../../src/_core/config/index.js";
import { checkLlmProviders } from "../../src/interfaces/cli/doctor.js";

const ENV = ["ENGRAM_OPENAI_BASE_URL", "ENGRAM_OPENAI_MODEL", "ENGRAM_OPENAI_API_KEY_ENV", "ENGRAM_OPENAI_TEMPERATURE", "ENGRAM_LLM_PROVIDERS", "OPENAI_API_KEY", "GATEWAY_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_HOST"];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); for (const k of ENV) delete process.env[k]; resetIntelligence(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetIntelligence(); });

type Seen = { path: string; auth: string | undefined; body: Record<string, unknown> };
let server: Server;
let base: string;
const seen: Seen[] = [];
let respond: (s: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const s: Seen = { path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "{}") };
      seen.push(s);
      const r = respond(s);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { seen.length = 0; });

const toolReply = (args: unknown, model = "gw-model") => ({
  status: 200,
  body: { model, choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "structured_output", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] },
});
const route = (over: Partial<OpenAIRoute> = {}): OpenAIRoute => ({
  tier: "openai", label: "OpenAI-compatible", baseUrl: `${base}/v1`, apiKey: "placeholder-token", model: "gw-model", ...over,
});

describe("route configuration", () => {
  it("normalises the base URL: trailing slashes dropped, /v1 appended to a bare origin, explicit paths kept", () => {
    expect(normalizeBaseUrl("https://api.openai.com/")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("http://localhost:4000")).toBe("http://localhost:4000/v1");
    expect(normalizeBaseUrl("http://gw.internal/openai/v1/")).toBe("http://gw.internal/openai/v1");
    expect(normalizeBaseUrl("http://gw.internal/custom")).toBe("http://gw.internal/custom");
  });

  it("is inactive without a model; the credential comes from the env var NAMED by ENGRAM_OPENAI_API_KEY_ENV", () => {
    expect(resolveOpenAIRouteConfig({})).toBeUndefined();
    const rc = resolveOpenAIRouteConfig({ ENGRAM_OPENAI_MODEL: "m", ENGRAM_OPENAI_BASE_URL: "http://localhost:4000", ENGRAM_OPENAI_API_KEY_ENV: "GATEWAY_TOKEN", ENGRAM_OPENAI_TEMPERATURE: "0.2" });
    expect(rc).toEqual({ baseUrl: "http://localhost:4000/v1", model: "m", apiKeyEnv: "GATEWAY_TOKEN", temperature: 0.2 });
    expect(resolveOpenAIRouteConfig({ ENGRAM_OPENAI_MODEL: "m" })).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", temperature: undefined });
    const cfg = { ...buildIntelligenceConfig(loadConfig()), openai: rc };
    const missing = openaiRoute(cfg, {});
    expect(missing).toHaveProperty("failure");
    expect((missing as { failure: { message: string } }).failure.message).toBe("skipped: GATEWAY_TOKEN (from ENGRAM_OPENAI_API_KEY_ENV) not set");
    const ok = openaiRoute(cfg, { GATEWAY_TOKEN: "placeholder-token" });
    expect((ok as { route: OpenAIRoute }).route).toMatchObject({ tier: "openai", apiKey: "placeholder-token", model: "m", temperature: 0.2 });
  });

  it("provider order: default, custom, unknown names dropped with a warning, empty falls back", () => {
    expect(parseProviderOrder(undefined)).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(DEFAULT_PROVIDER_ORDER).toEqual(["ollama", "openai", "openrouter", "anthropic"]);
    const warnings: string[] = [];
    expect(parseProviderOrder("openai, anthropic ,openai", (m) => warnings.push(m))).toEqual(["openai", "anthropic"]);
    expect(parseProviderOrder("bogus,anthropic", (m) => warnings.push(m))).toEqual(["anthropic"]);
    expect(warnings[0]).toContain('unknown provider "bogus"');
    expect(parseProviderOrder("bogus", (m) => warnings.push(m))).toEqual([...DEFAULT_PROVIDER_ORDER]);
  });
});

describe("wire format", () => {
  it("sends Authorization from the route key, the model, tool + tool_choice, and NO temperature by default", async () => {
    respond = () => toolReply({ answer: 42 });
    const { result, model } = await callOpenAICompatibleTool<{ answer: number }>(route(), [{ role: "user", content: "hi​" }], { name: "structured_output", description: "d", parameters: { type: "object" } });
    expect(result).toEqual({ answer: 42 });
    expect(model).toBe("gw-model");
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/v1/chat/completions");
    expect(seen[0].auth).toBe("Bearer placeholder-token");
    expect(seen[0].body.model).toBe("gw-model");
    expect(seen[0].body).not.toHaveProperty("temperature");
    expect((seen[0].body.messages as Array<{ content: string }>)[0].content).toBe("hi"); // control chars stripped
    expect((seen[0].body.tool_choice as { function: { name: string } }).function.name).toBe("structured_output");
  });

  it("sends temperature when the route (or call) sets one — the OpenRouter route keeps 0", async () => {
    respond = () => toolReply({ ok: true });
    await callOpenAICompatibleTool(route({ temperature: 0.5 }), [{ role: "user", content: "x" }], { name: "t", description: "d", parameters: {} });
    expect(seen[0].body.temperature).toBe(0.5);
    await callOpenAICompatibleText(route({ temperature: 0 }), [{ role: "user", content: "x" }]).catch(() => {});
    expect(seen[1].body.temperature).toBe(0);
  });

  it("falls back to JSON in content (with code fences) when a model answers there instead of tool_calls", async () => {
    respond = () => ({ status: 200, body: { choices: [{ message: { content: "```json\n{\"answer\": 7}\n```" } }] } });
    const { result } = await callOpenAICompatibleTool<{ answer: number }>(route(), [{ role: "user", content: "x" }], { name: "t", description: "d", parameters: {} });
    expect(result).toEqual({ answer: 7 });
  });

  it("classifies errors: 401 is a provider error and is not retried; the error name reflects the route label", async () => {
    respond = () => ({ status: 401, body: { error: "bad token" } });
    await expect(callOpenAICompatibleText(route(), [{ role: "user", content: "x" }])).rejects.toMatchObject({ errorClass: "provider", httpStatus: 401, name: "OpenAIcompatibleError" });
    expect(seen).toHaveLength(1);
    expect(classifyHttpStatus(429)).toBe("transient");
    expect(classifyHttpStatus(404)).toBe("permanent");
    expect(OpenRouterError).toBe(OpenAICompatibleError); // one class, two names
    expect(new OpenRouterError("x", 500, undefined, "OpenRouter").name).toBe("OpenRouterError");
  });
});

describe("cascade + diagnostics", () => {
  function cfg(over: Partial<IntelligenceConfig> = {}): IntelligenceConfig {
    return {
      ollamaUrl: "http://127.0.0.1:9", ollamaModel: "none", apiModel: "claude-haiku-4-5-20251001", apiFallbackModel: "claude-sonnet-4-6", timeoutMs: 5000,
      openai: { baseUrl: `${base}/v1`, model: "gw-model", apiKeyEnv: "GATEWAY_TOKEN" },
      providerOrder: ["openai", "anthropic"],
      ...over,
    };
  }

  it("the openai tier answers structured generation through the gateway; provider is reported", async () => {
    process.env.GATEWAY_TOKEN = "placeholder-token";
    respond = () => toolReply({ facts: ["a"] });
    const r = await generateStructured<{ facts: string[] }>("sys", "user", { properties: { facts: { type: "array" } } }, cfg());
    expect(r.provider).toBe("openai");
    expect(r.source).toBe("api");
    expect(r.result).toEqual({ facts: ["a"] });
    expect(seen[0].auth).toBe("Bearer placeholder-token");
  });

  it("a tier left out of ENGRAM_LLM_PROVIDERS is never tried; the CascadeError names each tried tier", async () => {
    process.env.GATEWAY_TOKEN = "placeholder-token";
    respond = () => toolReply({ x: 1 });
    await expect(generateStructured("s", "u", {}, cfg({ providerOrder: ["anthropic"] }))).rejects.toThrow(/anthropic \(config\): skipped: ANTHROPIC_API_KEY not set/);
    expect(seen).toHaveLength(0); // the configured gateway was not called
    const direct = await openaiGenerateStructured("s", "u", {}, cfg({ openai: undefined }));
    expect(direct).toEqual({ failure: { tier: "openai", errorClass: "config", message: "skipped: ENGRAM_OPENAI_MODEL not set" } });
  });

  it("describeProviders / doctor name the order, endpoints, models and key variables — never a key value", () => {
    process.env.GATEWAY_TOKEN = "super-secret-value";
    const { order, tiers } = describeProviders(cfg(), process.env);
    expect(order).toEqual(["openai", "anthropic"]);
    expect(tiers[0]).toMatchObject({ tier: "openai", configured: true });
    expect(tiers[0].detail).toContain("gw-model at " + base + "/v1, key from GATEWAY_TOKEN");
    expect(tiers[0].detail).toContain("no temperature sent");
    expect(tiers[1]).toMatchObject({ tier: "anthropic", configured: false });
    expect(JSON.stringify(tiers)).not.toContain("super-secret-value");
    process.env.ENGRAM_OPENAI_MODEL = "gw-model";
    process.env.ENGRAM_OPENAI_BASE_URL = base;
    process.env.ENGRAM_OPENAI_API_KEY_ENV = "GATEWAY_TOKEN";
    process.env.ENGRAM_LLM_PROVIDERS = "openai";
    const check = checkLlmProviders(loadConfig(), process.env);
    expect(check).toMatchObject({ name: "llm providers", level: "ok", required: false });
    expect(check.detail).toContain("order openai (ENGRAM_LLM_PROVIDERS)");
    expect(check.detail).not.toContain("super-secret-value");
    delete process.env.GATEWAY_TOKEN;
    const warn = checkLlmProviders(loadConfig(), process.env);
    expect(warn.level).toBe("warn");
    expect(warn.detail).toContain("GATEWAY_TOKEN (from ENGRAM_OPENAI_API_KEY_ENV) not set");
  });
});
