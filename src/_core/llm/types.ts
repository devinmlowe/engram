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

export interface GenerationResult<T = string> {
  result: T;
  source: "local" | "api";
  model: string;
  durationMs: number;
}
