/**
 * OpenRouter tier — one route constant over the shared OpenAI-compatible
 * client (#45, #118). Enabled by OPENROUTER_API_KEY; the model comes from the
 * cascade config (`ENGRAM_OPENROUTER_MODEL`). OpenRouter accepts
 * `temperature`, so this route keeps the historical default of 0.
 */

import type { IntelligenceConfig, TierError, TierOutcome, GenerationOptions } from "../types.js";
import {
  OpenAICompatibleError,
  routeGenerate,
  routeGenerateStructured,
  type OpenAIRoute,
} from "./openai-compatible.js";

export { OpenAICompatibleError as OpenRouterError };

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Check whether OpenRouter is configured (API key is set). */
export function isOpenRouterAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/** The OpenRouter route from the cascade config, or the config reason it is skipped. */
export function openrouterRoute(
  config: IntelligenceConfig,
  env: Record<string, string | undefined> = process.env,
): { route: OpenAIRoute } | { failure: TierError } {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { failure: { tier: "openrouter", errorClass: "config", message: "skipped: OPENROUTER_API_KEY not set" } };
  }
  if (!config.openrouterModel) {
    return { failure: { tier: "openrouter", errorClass: "config", message: "skipped: no OpenRouter model configured" } };
  }
  return {
    route: {
      tier: "openrouter",
      label: "OpenRouter",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey,
      model: config.openrouterModel,
      headers: { "HTTP-Referer": "https://github.com/devinmlowe/engram", "X-Title": "engram dream cycle" },
      temperature: 0,
    },
  };
}

/** Structured generation via OpenRouter. Returns a `failure` outcome (never throws). */
export const openrouterGenerateStructured = <T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
  options: GenerationOptions = {},
): Promise<TierOutcome<T>> => routeGenerateStructured<T>(openrouterRoute, systemPrompt, userPrompt, schema, config, options);

/** Free-text generation via OpenRouter. Returns a `failure` outcome (never throws). */
export const openrouterGenerate = (
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<TierOutcome<string>> => routeGenerate(openrouterRoute, systemPrompt, userPrompt, config);
