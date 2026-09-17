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
import type {
  IntelligenceConfig,
  GenerationResult,
  GenerationOptions,
  TierError,
  TierOutcome,
} from "./types.js";
import { CascadeError, tierErrorMessage } from "./types.js";
import { isOllamaAvailable, ollamaGenerateStructured, ollamaGenerate } from "./providers/ollama.js";
import { openrouterGenerateStructured, openrouterGenerate, classifyHttpStatus } from "./providers/openrouter.js";
import {
  apiGenerateStructured,
  apiGenerate,
  resetIntelligence as resetAnthropic,
  isAnthropicAvailable,
} from "./providers/anthropic.js";

// ─── Re-export types ─────────────────────────────────────────────

export type {
  IntelligenceConfig,
  GenerationResult,
  GenerationOptions,
  LlmProvider,
  TierError,
  TierErrorClass,
} from "./types.js";
export { CascadeError } from "./types.js";

// ─── Re-export provider functions for external use ───────────────

export { isOllamaAvailable } from "./providers/ollama.js";
export { setClient, isAnthropicAvailable } from "./providers/anthropic.js";

/** Reset module state (for testing): injected client and once-per-process warnings. */
export function resetIntelligence(): void {
  resetAnthropic();
  warnedConfigSkips.clear();
}
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

// ─── Cascade Diagnostics ─────────────────────────────────────────

/**
 * Config skips (no key, model not pulled) repeat identically on every call
 * of a dream run, so each distinct reason is warned once per process.
 * Runtime failures are warned every time — each one is a real event.
 */
const warnedConfigSkips = new Set<string>();

function noteTierFailure(tierErrors: TierError[], failure: TierError): void {
  tierErrors.push(failure);
  const line = `[llm] ${failure.tier} tier ${failure.errorClass === "config" ? "skipped" : "failed"} (${failure.errorClass}): ${failure.message}`;
  if (failure.errorClass === "config") {
    if (warnedConfigSkips.has(line)) return;
    warnedConfigSkips.add(line);
  }
  console.warn(line);
}

/** Ollama's tier-1 outcome, or the config reason it was not tried. */
async function ollamaTier<T>(
  config: IntelligenceConfig,
  skipLocal: boolean,
  run: () => Promise<TierOutcome<T>>,
): Promise<TierOutcome<T>> {
  if (skipLocal) {
    return { failure: { tier: "ollama", errorClass: "config", message: "skipped: caller pinned a cloud tier (skipLocal)" } };
  }
  if (!(await isOllamaAvailable(config))) {
    return {
      failure: {
        tier: "ollama",
        errorClass: "config",
        message: `skipped: Ollama unavailable at ${config.ollamaUrl} or model ${config.ollamaModel} not pulled`,
      },
    };
  }
  return run();
}

/**
 * Run the Anthropic tier, converting a config skip or a runtime error into
 * a TierError so the cascade can report it alongside the other tiers.
 */
async function anthropicTier<T>(run: () => Promise<GenerationResult<T>>): Promise<TierOutcome<T>> {
  if (!isAnthropicAvailable()) {
    return { failure: { tier: "anthropic", errorClass: "config", message: "skipped: ANTHROPIC_API_KEY not set" } };
  }
  try {
    return await run();
  } catch (err) {
    const status = typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: number }).status
      : undefined;
    return {
      failure: { tier: "anthropic", errorClass: classifyHttpStatus(status), message: tierErrorMessage(err) },
    };
  }
}

/**
 * Walk the tiers in order; return the first result, or throw a CascadeError
 * carrying every tier's failure once all of them have been exhausted.
 */
async function runCascade<T>(tiers: Array<() => Promise<TierOutcome<T>>>): Promise<GenerationResult<T>> {
  const tierErrors: TierError[] = [];
  for (const tier of tiers) {
    const outcome = await tier();
    if ("failure" in outcome) {
      noteTierFailure(tierErrors, outcome.failure);
      continue;
    }
    return outcome;
  }
  throw new CascadeError(tierErrors);
}

// ─── Public Generation Functions ─────────────────────────────────

/**
 * Generate structured output (JSON matching a schema).
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 * `options.skipLocal` bypasses the Ollama probe for explicit cloud pins.
 *
 * @throws CascadeError naming every tier's failure when no tier succeeds.
 */
export async function generateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
  options: GenerationOptions = {},
): Promise<GenerationResult<T>> {
  return runCascade<T>([
    () => ollamaTier<T>(config, options.skipLocal ?? false, () =>
      ollamaGenerateStructured<T>(systemPrompt, userPrompt, schema, config, options)),
    () => openrouterGenerateStructured<T>(systemPrompt, userPrompt, schema, config, options),
    () => anthropicTier<T>(() => apiGenerateStructured<T>(systemPrompt, userPrompt, schema, config, options)),
  ]);
}

/**
 * Generate a free-text response.
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 *
 * @throws CascadeError naming every tier's failure when no tier succeeds.
 */
export async function generate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<GenerationResult<string>> {
  return runCascade<string>([
    () => ollamaTier<string>(config, false, () => ollamaGenerate(systemPrompt, userPrompt, config)),
    () => openrouterGenerate(systemPrompt, userPrompt, config),
    () => anthropicTier<string>(() => apiGenerate(systemPrompt, userPrompt, config)),
  ]);
}
