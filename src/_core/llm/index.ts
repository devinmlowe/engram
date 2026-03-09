/**
 * Intelligence Layer — unified LLM interface for dream-state processing.
 *
 * Prefers local inference via Ollama REST API, falls back to OpenRouter
 * (cheap cloud), then to the Claude API when prior tiers are unavailable
 * or generation fails.
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 */

import type { EngramConfig } from "../types/index.js";
import type { IntelligenceConfig, GenerationResult } from "./types.js";
import { isOllamaAvailable, ollamaGenerateStructured, ollamaGenerate } from "./providers/ollama.js";
import { openrouterGenerateStructured, openrouterGenerate } from "./providers/openrouter.js";
import { apiGenerateStructured, apiGenerate, setClient, resetIntelligence } from "./providers/anthropic.js";

// ─── Re-export types ─────────────────────────────────────────────

export type { IntelligenceConfig, GenerationResult } from "./types.js";

// ─── Re-export provider functions for external use ───────────────

export { isOllamaAvailable } from "./providers/ollama.js";
export { setClient, resetIntelligence } from "./providers/anthropic.js";
export {
  isOpenRouterAvailable,
  callOpenRouterTool,
  callOpenRouterText,
  type OpenRouterToolDef,
  type OpenRouterCallOptions,
} from "./providers/openrouter.js";

// ─── Configuration ───────────────────────────────────────────────

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build an IntelligenceConfig from the application EngramConfig.
 *
 * Maps dream config fields to intelligence config, applying defaults
 * and reading OLLAMA_HOST from the environment.
 */
export function buildIntelligenceConfig(
  config: EngramConfig,
): IntelligenceConfig {
  return {
    ollamaUrl:
      process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL,
    ollamaModel:
      config.dream.localModel ?? DEFAULT_OLLAMA_MODEL,
    openrouterModel:
      config.dream.openrouterModel ??
      (process.env.OPENROUTER_API_KEY ? DEFAULT_OPENROUTER_MODEL : undefined),
    apiModel: config.dream.apiModel,
    apiFallbackModel: config.dream.apiFallbackModel,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

// ─── Public Generation Functions ─────────────────────────────────

/**
 * Generate structured output (JSON matching a schema).
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 */
export async function generateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
): Promise<GenerationResult<T>> {
  // Tier 1: Try Ollama (local, free)
  const available = await isOllamaAvailable(config);
  if (available) {
    const localResult = await ollamaGenerateStructured<T>(
      systemPrompt,
      userPrompt,
      schema,
      config,
    );
    if (localResult) {
      return localResult;
    }
  }

  // Tier 2: Try OpenRouter (cheap cloud)
  const openrouterResult = await openrouterGenerateStructured<T>(
    systemPrompt,
    userPrompt,
    schema,
    config,
  );
  if (openrouterResult) {
    return openrouterResult;
  }

  // Tier 3: Fall back to Anthropic API
  return apiGenerateStructured<T>(systemPrompt, userPrompt, schema, config);
}

/**
 * Generate a free-text response.
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 */
export async function generate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<GenerationResult<string>> {
  // Tier 1: Try Ollama (local, free)
  const available = await isOllamaAvailable(config);
  if (available) {
    const localResult = await ollamaGenerate(
      systemPrompt,
      userPrompt,
      config,
    );
    if (localResult) {
      return localResult;
    }
  }

  // Tier 2: Try OpenRouter (cheap cloud)
  const openrouterResult = await openrouterGenerate(
    systemPrompt,
    userPrompt,
    config,
  );
  if (openrouterResult) {
    return openrouterResult;
  }

  // Tier 3: Fall back to Anthropic API
  return apiGenerate(systemPrompt, userPrompt, config);
}
