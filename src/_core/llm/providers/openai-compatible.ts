/**
 * Generic OpenAI-compatible chat-completions client (#45).
 *
 * One HTTP implementation serves every route that speaks the OpenAI wire
 * format: OpenRouter (the built-in cloud tier), OpenAI itself, LiteLLM and
 * other gateways, self-hosted servers. A `Route` says where to send the
 * request, which model to ask for, and where the credential comes from —
 * always an environment variable *name*, so no token is ever stored in
 * config, printed, or committed.
 *
 * The generic `openai` tier is configured entirely from the environment:
 *
 *   ENGRAM_OPENAI_BASE_URL      endpoint, e.g. https://api.openai.com/v1 or http://localhost:4000
 *                               (a bare origin gets "/v1" appended; an explicit path is kept)
 *   ENGRAM_OPENAI_MODEL         model name the route serves (required for the tier to be active)
 *   ENGRAM_OPENAI_API_KEY_ENV   name of the env var holding the credential (default OPENAI_API_KEY)
 *   ENGRAM_OPENAI_TEMPERATURE   optional; omitted from requests when unset, because many
 *                               gateways and reasoning models reject the field
 *
 * Each deployment maps its own secret to that env var outside the repo.
 */

import type { IntelligenceConfig, GenerationOptions, TierOutcome, TierError, LlmProvider } from "../types.js";
import { DEFAULT_TOOL_NAME, DEFAULT_TOOL_DESCRIPTION, tierErrorMessage } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────

export interface OpenAIToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAICallOptions {
  model?: string;
  maxTokens?: number;
  /** Sent only when a number; `undefined` omits the field entirely. */
  temperature?: number;
  timeoutMs?: number;
}

export interface OpenAIRoute {
  /** Tier id used in diagnostics and TierError. */
  tier: LlmProvider;
  /** Human label for error names/messages, e.g. "OpenRouter", "OpenAI-compatible". */
  label: string;
  /** Base URL ending in the API root (".../v1" for OpenAI and OpenRouter). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra request headers (OpenRouter attribution headers, for example). */
  headers?: Record<string, string>;
  /** Default temperature for this route; `undefined` = never send one. */
  temperature?: number;
}

/** Where the generic tier is configured to go; the key value is never stored here. */
export interface OpenAIRouteConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  model?: string;
}

export type ProviderErrorClass = "transient" | "provider" | "permanent" | "unknown";

// ─── Errors ─────────────────────────────────────────────────────

export class OpenAICompatibleError extends Error {
  httpStatus: number | undefined;
  errorClass: ProviderErrorClass;

  constructor(message: string, httpStatus?: number, errorClass?: ProviderErrorClass, label = "OpenAICompatible") {
    super(message);
    this.name = `${label.replace(/[^A-Za-z0-9]/g, "")}Error`;
    this.httpStatus = httpStatus;
    this.errorClass = errorClass ?? classifyHttpStatus(httpStatus);
  }
}

export function classifyHttpStatus(status?: number): ProviderErrorClass {
  if (!status) return "unknown";
  if ([429, 500, 502, 503, 504].includes(status)) return "transient";
  if ([401, 402, 403].includes(status)) return "provider";
  if ([400, 404, 422].includes(status)) return "permanent";
  return "unknown";
}

// ─── Retry ──────────────────────────────────────────────────────

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts - 1;
      // Permanent and provider (auth/billing) errors never improve on retry.
      if (err instanceof OpenAICompatibleError && (err.errorClass === "permanent" || err.errorClass === "provider")) {
        throw err;
      }
      if (isLast) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new OpenAICompatibleError(`${label} request timed out after ${maxAttempts} attempts`, undefined, "transient", label);
        }
        throw err;
      }
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, Math.random() * cap));
    }
  }
  throw new Error("retryWithBackoff: unreachable");
}

// ─── Content sanitisation ───────────────────────────────────────

/** Strip Unicode control characters that trigger Gemini's MALFORMED_FUNCTION_CALL. */
export function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u2028-\u202F\uFEFF]/g, "");
}

/** Strip markdown code fences some models wrap around JSON. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

// ─── Route resolution ───────────────────────────────────────────

/** Trim, drop trailing slashes, and append "/v1" to a bare origin. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.pathname === "" || u.pathname === "/") return `${trimmed}/v1`;
    return trimmed;
  } catch {
    return trimmed;
  }
}

export const OPENAI_BASE_URL_ENV = "ENGRAM_OPENAI_BASE_URL";
export const OPENAI_MODEL_ENV = "ENGRAM_OPENAI_MODEL";
export const OPENAI_API_KEY_ENV_ENV = "ENGRAM_OPENAI_API_KEY_ENV";
export const OPENAI_TEMPERATURE_ENV = "ENGRAM_OPENAI_TEMPERATURE";
export const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** The generic route's configuration from the environment, or undefined when no model is set. */
export function resolveOpenAIRouteConfig(env: Record<string, string | undefined> = process.env): OpenAIRouteConfig | undefined {
  const model = env[OPENAI_MODEL_ENV]?.trim();
  if (!model) return undefined;
  const rawTemp = env[OPENAI_TEMPERATURE_ENV]?.trim();
  const temperature = rawTemp !== undefined && rawTemp !== "" && Number.isFinite(Number(rawTemp)) ? Number(rawTemp) : undefined;
  return {
    baseUrl: normalizeBaseUrl(env[OPENAI_BASE_URL_ENV]?.trim() || DEFAULT_OPENAI_BASE_URL),
    model,
    apiKeyEnv: env[OPENAI_API_KEY_ENV_ENV]?.trim() || DEFAULT_OPENAI_API_KEY_ENV,
    temperature,
  };
}

/**
 * Config-level reason the generic tier cannot run, or the concrete route.
 * The reason names the env var that is missing, never a value.
 */
export function openaiRoute(
  config: IntelligenceConfig,
  env: Record<string, string | undefined> = process.env,
): { route: OpenAIRoute } | { failure: TierError } {
  const rc = config.openai;
  if (!rc) {
    return { failure: { tier: "openai", errorClass: "config", message: `skipped: ${OPENAI_MODEL_ENV} not set` } };
  }
  const apiKey = env[rc.apiKeyEnv]?.trim();
  if (!apiKey) {
    return { failure: { tier: "openai", errorClass: "config", message: `skipped: ${rc.apiKeyEnv} (from ${OPENAI_API_KEY_ENV_ENV}) not set` } };
  }
  return {
    route: { tier: "openai", label: "OpenAI-compatible", baseUrl: rc.baseUrl, apiKey, model: rc.model, temperature: rc.temperature },
  };
}

// ─── Wire calls ─────────────────────────────────────────────────

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function requestBody(route: OpenAIRoute, messages: ChatMessage[], options: OpenAICallOptions | undefined, extra: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    model: options?.model ?? route.model,
    messages: messages.map((m) => ({ ...m, content: stripControlChars(m.content) })),
    max_tokens: options?.maxTokens ?? 4096,
    ...extra,
  };
  const temperature = options?.temperature ?? route.temperature;
  if (typeof temperature === "number") body.temperature = temperature;
  return body;
}

async function post(route: OpenAIRoute, body: Record<string, unknown>, timeoutMs: number): Promise<ChatCompletionResponse> {
  const response = await fetch(`${route.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${route.apiKey}`,
      ...(route.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new OpenAICompatibleError(`${route.label} API error ${response.status}: ${text}`, response.status, undefined, route.label);
  }
  return (await response.json()) as ChatCompletionResponse;
}

/**
 * Chat completion with a single forced tool call; returns the parsed
 * arguments (or JSON found in `content` when a model answers there instead).
 */
export async function callOpenAICompatibleTool<T = Record<string, unknown>>(
  route: OpenAIRoute,
  messages: ChatMessage[],
  tool: OpenAIToolDef,
  options?: OpenAICallOptions,
): Promise<{ result: T; model: string }> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const body = requestBody(route, messages, options, {
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
    tool_choice: { type: "function", function: { name: tool.name } },
  });
  return retryWithBackoff(async () => {
    const data = await post(route, body, timeoutMs);
    const usedModel = data.model ?? (body.model as string);
    const toolCalls = data.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      return { result: JSON.parse(toolCalls[0].function.arguments) as T, model: usedModel };
    }
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      return { result: JSON.parse(stripCodeFences(content)) as T, model: usedModel };
    }
    throw new OpenAICompatibleError(
      `${route.label} response contained no tool_calls or content (finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"})`,
      undefined, "transient", route.label,
    );
  }, route.label);
}

/** Free-text chat completion. */
export async function callOpenAICompatibleText(
  route: OpenAIRoute,
  messages: ChatMessage[],
  options?: OpenAICallOptions,
): Promise<{ result: string; model: string }> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const body = requestBody(route, messages, options, {});
  return retryWithBackoff(async () => {
    const data = await post(route, body, timeoutMs);
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new OpenAICompatibleError(
        `${route.label} response contained no content (finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"})`,
        undefined, "transient", route.label,
      );
    }
    return { result: content, model: data.model ?? (body.model as string) };
  }, route.label);
}

// ─── Tier wrappers ──────────────────────────────────────────────
//
// One pair of wrappers serves every tier that is an OpenAI-compatible route
// (the generic `openai` tier and OpenRouter, #118): a resolver turns the
// cascade config into a concrete route or a config-skip failure, and a
// runtime error becomes a `failure` outcome under the route's tier.

/** The cascade config → a concrete route, or the config reason the tier is skipped. */
export type RouteResolver = (config: IntelligenceConfig) => { route: OpenAIRoute } | { failure: TierError };

function routeFailure(tier: LlmProvider, err: unknown): { failure: TierError } {
  return {
    failure: {
      tier,
      errorClass: err instanceof OpenAICompatibleError ? err.errorClass : "unknown",
      message: tierErrorMessage(err),
    },
  };
}

/** Structured generation through a route. Returns a `failure` outcome (never throws). */
export async function routeGenerateStructured<T>(
  resolve: RouteResolver,
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
  options: GenerationOptions = {},
): Promise<TierOutcome<T>> {
  const resolved = resolve(config);
  if ("failure" in resolved) return resolved;
  try {
    const startMs = Date.now();
    const { result, model } = await callOpenAICompatibleTool<T>(
      resolved.route,
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      {
        name: options.toolName ?? DEFAULT_TOOL_NAME,
        description: options.toolDescription ?? DEFAULT_TOOL_DESCRIPTION,
        parameters: { type: "object", ...schema },
      },
      { timeoutMs: config.timeoutMs, maxTokens: options.maxTokens },
    );
    return { result, source: "api", provider: resolved.route.tier, model, durationMs: Date.now() - startMs };
  } catch (err) {
    return routeFailure(resolved.route.tier, err);
  }
}

/** Free-text generation through a route. Returns a `failure` outcome (never throws). */
export async function routeGenerate(
  resolve: RouteResolver,
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<TierOutcome<string>> {
  const resolved = resolve(config);
  if ("failure" in resolved) return resolved;
  try {
    const startMs = Date.now();
    const { result, model } = await callOpenAICompatibleText(
      resolved.route,
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { timeoutMs: config.timeoutMs },
    );
    return { result, source: "api", provider: resolved.route.tier, model, durationMs: Date.now() - startMs };
  } catch (err) {
    return routeFailure(resolved.route.tier, err);
  }
}

export const openaiGenerateStructured = <T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
  options: GenerationOptions = {},
): Promise<TierOutcome<T>> => routeGenerateStructured<T>(openaiRoute, systemPrompt, userPrompt, schema, config, options);

export const openaiGenerate = (
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<TierOutcome<string>> => routeGenerate(openaiRoute, systemPrompt, userPrompt, config);
