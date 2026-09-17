/**
 * OpenRouter tier — the built-in cheap cloud route, now a thin route over the
 * shared OpenAI-compatible client (#45). Public names are unchanged:
 * `callOpenRouterTool`, `callOpenRouterText`, `OpenRouterError`,
 * `classifyHttpStatus`, `isOpenRouterAvailable`, and the tier wrappers.
 *
 * Enabled by OPENROUTER_API_KEY; the model comes from ENGRAM_OPENROUTER_MODEL
 * (or the cascade config). OpenRouter accepts `temperature`, so this route
 * keeps the historical default of 0.
 */

import type { IntelligenceConfig, GenerationOptions, TierOutcome, TierError } from "../types.js";
import { DEFAULT_TOOL_NAME, DEFAULT_TOOL_DESCRIPTION, tierErrorMessage } from "../types.js";
import {
  OpenAICompatibleError,
  callOpenAICompatibleTool,
  callOpenAICompatibleText,
  classifyHttpStatus,
  type ChatMessage,
  type OpenAIRoute,
  type OpenAIToolDef,
  type OpenAICallOptions,
} from "./openai-compatible.js";

export { classifyHttpStatus };
export { OpenAICompatibleError as OpenRouterError };
export type OpenRouterToolDef = OpenAIToolDef;
export type OpenRouterCallOptions = OpenAICallOptions;

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const BASE_URL = "https://openrouter.ai/api/v1";
const LABEL = "OpenRouter";

function openrouterRoute(options?: OpenRouterCallOptions): OpenAIRoute {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenAICompatibleError("OPENROUTER_API_KEY not set", undefined, "permanent", LABEL);
  }
  return {
    tier: "openrouter",
    label: LABEL,
    baseUrl: BASE_URL,
    apiKey,
    model: options?.model ?? process.env.ENGRAM_OPENROUTER_MODEL ?? DEFAULT_MODEL,
    headers: { "HTTP-Referer": "https://github.com/devinmlowe/engram", "X-Title": "engram dream cycle" },
    temperature: 0,
  };
}

/** Check whether OpenRouter is configured (API key is set). */
export function isOpenRouterAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/**
 * Call OpenRouter with a tool/function definition and return the parsed result.
 * @throws OpenRouterError with classified error type
 */
export async function callOpenRouterTool<T = Record<string, unknown>>(
  messages: ChatMessage[],
  tool: OpenRouterToolDef,
  options?: OpenRouterCallOptions,
): Promise<{ result: T; model: string }> {
  return callOpenAICompatibleTool<T>(openrouterRoute(options), messages, tool, options);
}

/**
 * Call OpenRouter for free-text generation (no tool/function calling).
 * @throws OpenRouterError with classified error type
 */
export async function callOpenRouterText(
  messages: ChatMessage[],
  options?: OpenRouterCallOptions,
): Promise<{ result: string; model: string }> {
  return callOpenAICompatibleText(openrouterRoute(options), messages, options);
}

// ─── Intelligence-Layer Wrappers ─────────────────────────────────

function openrouterConfigSkip(config: IntelligenceConfig): { failure: TierError } | null {
  const reason = !process.env.OPENROUTER_API_KEY
    ? "skipped: OPENROUTER_API_KEY not set"
    : !config.openrouterModel
      ? "skipped: no OpenRouter model configured"
      : null;
  return reason ? { failure: { tier: "openrouter", errorClass: "config", message: reason } } : null;
}

function openrouterFailure(err: unknown): { failure: TierError } {
  return {
    failure: {
      tier: "openrouter",
      errorClass: err instanceof OpenAICompatibleError ? err.errorClass : "unknown",
      message: tierErrorMessage(err),
    },
  };
}

/** Structured generation via OpenRouter. Returns a `failure` outcome (never throws). */
export async function openrouterGenerateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
  options: GenerationOptions = {},
): Promise<TierOutcome<T>> {
  const skip = openrouterConfigSkip(config);
  if (skip) return skip;
  try {
    const startMs = Date.now();
    const { result, model } = await callOpenRouterTool<T>(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      {
        name: options.toolName ?? DEFAULT_TOOL_NAME,
        description: options.toolDescription ?? DEFAULT_TOOL_DESCRIPTION,
        parameters: { type: "object", ...schema },
      },
      { model: config.openrouterModel, timeoutMs: config.timeoutMs, maxTokens: options.maxTokens },
    );
    return { result, source: "api", provider: "openrouter", model, durationMs: Date.now() - startMs };
  } catch (err) {
    return openrouterFailure(err);
  }
}

/** Free-text generation via OpenRouter. Returns a `failure` outcome (never throws). */
export async function openrouterGenerate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<TierOutcome<string>> {
  const skip = openrouterConfigSkip(config);
  if (skip) return skip;
  try {
    const startMs = Date.now();
    const { result, model } = await callOpenRouterText(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { model: config.openrouterModel, timeoutMs: config.timeoutMs },
    );
    return { result, source: "api", provider: "openrouter", model, durationMs: Date.now() - startMs };
  } catch (err) {
    return openrouterFailure(err);
  }
}
