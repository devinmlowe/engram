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
  LlmProvider,
} from "./types.js";
import { CascadeError, tierErrorMessage } from "./types.js";
import { resolveOllamaModel, ollamaGenerateStructured, ollamaGenerate } from "./providers/ollama.js";
import { openrouterGenerateStructured, openrouterGenerate, classifyHttpStatus } from "./providers/openrouter.js";
import { openaiGenerateStructured, openaiGenerate, openaiRoute, resolveOpenAIRouteConfig, OPENAI_BASE_URL_ENV } from "./providers/openai-compatible.js";
import { ALL_PROVIDERS, DEFAULT_PROVIDER_ORDER } from "./types.js";
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
export { CascadeError, ALL_PROVIDERS, DEFAULT_PROVIDER_ORDER } from "./types.js";
export {
  resolveOpenAIRouteConfig, normalizeBaseUrl, openaiRoute,
  OPENAI_BASE_URL_ENV, OPENAI_MODEL_ENV, OPENAI_API_KEY_ENV_ENV, OPENAI_TEMPERATURE_ENV, DEFAULT_OPENAI_API_KEY_ENV,
} from "./providers/openai-compatible.js";

// ─── Re-export provider functions for external use ───────────────

export { isOllamaAvailable, resolveOllamaModel, type OllamaProbe } from "./providers/ollama.js";
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
export const LLM_TIMEOUT_ENV = "ENGRAM_LLM_TIMEOUT_MS";

/**
 * Per-request timeout for every tier (ms). `ENGRAM_LLM_TIMEOUT_MS` raises it for
 * slow local models (a 27B model on Apple Silicon needs minutes for an
 * extraction prompt); blank or non-numeric values fall back to the default.
 */
export function resolveLlmTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[LLM_TIMEOUT_ENV]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_TIMEOUT_MS;
}

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
    ollamaModelFallbacks: config.dream.localModelFallbacks ?? [],
    openrouterModel:
      config.dream.openrouterModel ??
      (process.env.OPENROUTER_API_KEY ? DEFAULT_OPENROUTER_MODEL : undefined),
    apiModel: config.dream.apiModel,
    apiFallbackModel: config.dream.apiFallbackModel,
    timeoutMs: resolveLlmTimeoutMs(process.env),
    openai: resolveOpenAIRouteConfig(process.env),
    providerOrder: parseProviderOrder(process.env.ENGRAM_LLM_PROVIDERS),
  };
}

export const PROVIDER_ORDER_ENV = "ENGRAM_LLM_PROVIDERS";

/**
 * ENGRAM_LLM_PROVIDERS: comma-separated tier names in the order to try
 * (e.g. "openai,anthropic"). Unknown names are dropped with a one-time
 * warning; an empty or absent value means DEFAULT_PROVIDER_ORDER. A tier
 * left out is never tried, whatever else is configured.
 */
export function parseProviderOrder(raw: string | undefined, warn: (m: string) => void = console.warn): LlmProvider[] {
  const names = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  if (names.length === 0) return [...DEFAULT_PROVIDER_ORDER];
  const order: LlmProvider[] = [];
  for (const n of names) {
    if ((ALL_PROVIDERS as readonly string[]).includes(n)) {
      if (!order.includes(n as LlmProvider)) order.push(n as LlmProvider);
    } else {
      warn(`[llm] ${PROVIDER_ORDER_ENV}: unknown provider "${n}" ignored (known: ${ALL_PROVIDERS.join(", ")})`);
    }
  }
  return order.length > 0 ? order : [...DEFAULT_PROVIDER_ORDER];
}

export interface ProviderStatus {
  tier: LlmProvider;
  /** true when the tier is configured well enough to be tried (Ollama: reachable and model pulled is checked separately). */
  configured: boolean;
  /** Never contains a credential value. */
  detail: string;
}

/**
 * Diagnostics for `engram doctor`: the tier order and each tier's config
 * state. Names env vars, endpoints and models; never key values.
 */
export function describeProviders(
  config: IntelligenceConfig,
  env: Record<string, string | undefined> = process.env,
): { order: LlmProvider[]; tiers: ProviderStatus[] } {
  const order = config.providerOrder ?? [...DEFAULT_PROVIDER_ORDER];
  const tiers: ProviderStatus[] = order.map((tier) => {
    switch (tier) {
      case "ollama":
        return { tier, configured: true, detail: `${config.ollamaModel} at ${config.ollamaUrl} (probed live by the ollama check)` };
      case "openai": {
        const r = openaiRoute(config, env);
        if ("failure" in r) return { tier, configured: false, detail: r.failure.message };
        return {
          tier, configured: true,
          detail: `${config.openai!.model} at ${config.openai!.baseUrl}, key from ${config.openai!.apiKeyEnv}${config.openai!.temperature !== undefined ? `, temperature ${config.openai!.temperature}` : ", no temperature sent"}`,
        };
      }
      case "openrouter":
        return env.OPENROUTER_API_KEY
          ? { tier, configured: Boolean(config.openrouterModel), detail: config.openrouterModel ? `${config.openrouterModel} via openrouter.ai, key from OPENROUTER_API_KEY` : "skipped: no OpenRouter model configured" }
          : { tier, configured: false, detail: "skipped: OPENROUTER_API_KEY not set" };
      case "anthropic":
        return env.ANTHROPIC_API_KEY
          ? { tier, configured: true, detail: `${config.apiModel} (fallback ${config.apiFallbackModel}), key from ANTHROPIC_API_KEY` }
          : { tier, configured: false, detail: "skipped: ANTHROPIC_API_KEY not set" };
    }
  });
  if (!order.includes("openai") && config.openai) {
    tiers.push({ tier: "openai", configured: false, detail: `configured (${OPENAI_BASE_URL_ENV}) but not in ${PROVIDER_ORDER_ENV}; never tried` });
  }
  return { order, tiers };
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

/**
 * Ollama's tier-1 outcome, or the config reason it was not tried. `run`
 * receives the resolved model: the configured one, or the first pulled entry
 * of `ollamaModelFallbacks` when the configured one is not on the host.
 */
async function ollamaTier<T>(
  config: IntelligenceConfig,
  skipLocal: boolean,
  run: (model: string) => Promise<TierOutcome<T>>,
): Promise<TierOutcome<T>> {
  if (skipLocal) {
    return { failure: { tier: "ollama", errorClass: "config", message: "skipped: caller pinned a cloud tier (skipLocal)" } };
  }
  const probe = await resolveOllamaModel(config);
  if (!probe.reachable) {
    return { failure: { tier: "ollama", errorClass: "config", message: `skipped: Ollama not reachable at ${config.ollamaUrl}` } };
  }
  if (!probe.model) {
    return {
      failure: {
        tier: "ollama",
        errorClass: "config",
        message: `Ollama reachable but model ${config.ollamaModel} not found; available: [${probe.available.join(", ")}]`,
      },
    };
  }
  return run(probe.model);
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
  const tiers: Record<LlmProvider, () => Promise<TierOutcome<T>>> = {
    ollama: () => ollamaTier<T>(config, options.skipLocal ?? false, (model) =>
      ollamaGenerateStructured<T>(systemPrompt, userPrompt, schema, { ...config, ollamaModel: model }, options)),
    openai: () => openaiGenerateStructured<T>(systemPrompt, userPrompt, schema, config, options),
    openrouter: () => openrouterGenerateStructured<T>(systemPrompt, userPrompt, schema, config, options),
    anthropic: () => anthropicTier<T>(() => apiGenerateStructured<T>(systemPrompt, userPrompt, schema, config, options)),
  };
  return runCascade<T>((config.providerOrder ?? DEFAULT_PROVIDER_ORDER).map((p) => tiers[p]));
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
  const tiers: Record<LlmProvider, () => Promise<TierOutcome<string>>> = {
    ollama: () => ollamaTier<string>(config, false, (model) =>
      ollamaGenerate(systemPrompt, userPrompt, { ...config, ollamaModel: model })),
    openai: () => openaiGenerate(systemPrompt, userPrompt, config),
    openrouter: () => openrouterGenerate(systemPrompt, userPrompt, config),
    anthropic: () => anthropicTier<string>(() => apiGenerate(systemPrompt, userPrompt, config)),
  };
  return runCascade<string>((config.providerOrder ?? DEFAULT_PROVIDER_ORDER).map((p) => tiers[p]));
}
