/**
 * Types for the LLM intelligence layer.
 */

export interface IntelligenceConfig {
  ollamaUrl: string;
  ollamaModel: string;
  /** Tried in order when `ollamaModel` is not pulled on the Ollama host. */
  ollamaModelFallbacks?: string[];
  openrouterModel?: string;
  apiModel: string;
  apiFallbackModel: string;
  timeoutMs: number;
  /** Generic OpenAI-compatible route (OpenAI, LiteLLM, self-hosted gateway), from ENGRAM_OPENAI_* (#45). */
  openai?: {
    baseUrl: string;
    model: string;
    /** NAME of the env var holding the credential; the value is read at call time and never stored. */
    apiKeyEnv: string;
    /** Sent only when set; many gateways reject the field. */
    temperature?: number;
  };
  /** Tier order (ENGRAM_LLM_PROVIDERS); tiers not listed are never tried. Default DEFAULT_PROVIDER_ORDER. */
  providerOrder?: LlmProvider[];
}

/** Which tier of the cascade produced a result. */
export type LlmProvider = "ollama" | "openai" | "openrouter" | "anthropic";

export const ALL_PROVIDERS: readonly LlmProvider[] = ["ollama", "openai", "openrouter", "anthropic"];

/** Local first, then the caller's own gateway, then OpenRouter, then Anthropic. */
export const DEFAULT_PROVIDER_ORDER: readonly LlmProvider[] = ["ollama", "openai", "openrouter", "anthropic"];

export interface GenerationResult<T = string> {
  result: T;
  source: "local" | "api";
  /** Cascade tier that produced the result (absent only from hand-built mocks). */
  provider?: LlmProvider;
  model: string;
  durationMs: number;
}

/**
 * Per-call options for structured generation.
 *
 * Callers that need a named tool (so provider logs and mocks show e.g.
 * `extract_memories`), a different output budget, or an explicit cloud
 * pin set them here rather than bypassing the factory.
 */
export interface GenerationOptions {
  /** Tool name surfaced to tool-calling providers. Default "structured_output". */
  toolName?: string;
  /** Tool description surfaced to tool-calling providers. */
  toolDescription?: string;
  /** Output token budget. Default 4096. */
  maxTokens?: number;
  /** Skip the local Ollama tier (explicit cloud model pins). Default false. */
  skipLocal?: boolean;
}

// ─── Cascade Diagnostics ─────────────────────────────────────────

/**
 * Why a tier produced no result. `config` means the tier was skipped
 * before any request was made (missing key, model not pulled, explicit
 * skipLocal pin); the rest mirror OpenRouterError's runtime classes.
 */
export type TierErrorClass = "config" | "transient" | "provider" | "permanent" | "unknown";

/** One tier's failure, collected as the cascade falls through. */
export interface TierError {
  tier: LlmProvider;
  errorClass: TierErrorClass;
  message: string;
}

/** What a fallible tier returns: a result, or the reason it produced none. */
export type TierOutcome<T> = GenerationResult<T> | { failure: TierError };

/**
 * Thrown by generateStructured()/generate() when every tier failed. The
 * message names each tier and its reason so a caller that only keeps the
 * message (dream checkpoints, logs) still sees the real failure instead of
 * only the last tier's.
 */
export class CascadeError extends Error {
  readonly tierErrors: TierError[];

  constructor(tierErrors: TierError[]) {
    super(
      "All LLM tiers failed — " +
        tierErrors.map((t) => `${t.tier} (${t.errorClass}): ${t.message}`).join("; "),
    );
    this.name = "CascadeError";
    this.tierErrors = tierErrors;
  }
}

/** Per-tier messages are clipped so the cascade message survives the 500-char checkpoint column. */
export const TIER_ERROR_MESSAGE_MAX = 120;

export function tierErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > TIER_ERROR_MESSAGE_MAX ? `${msg.slice(0, TIER_ERROR_MESSAGE_MAX)}…` : msg;
}

export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TOOL_NAME = "structured_output";
export const DEFAULT_TOOL_DESCRIPTION = "Return structured data matching the schema";
