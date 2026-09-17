/**
 * Types for the LLM intelligence layer.
 */

export interface IntelligenceConfig {
  ollamaUrl: string;
  ollamaModel: string;
  openrouterModel?: string;
  apiModel: string;
  apiFallbackModel: string;
  timeoutMs: number;
}

/** Which tier of the cascade produced a result. */
export type LlmProvider = "ollama" | "openrouter" | "anthropic";

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

export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TOOL_NAME = "structured_output";
export const DEFAULT_TOOL_DESCRIPTION = "Return structured data matching the schema";
