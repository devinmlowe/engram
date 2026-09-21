/**
 * Reachability gate shared by the semantic extractor, the consolidator and
 * the graph extractor. Credentials and clients are owned by the _core/llm
 * factory; the gate only checks that some cascade tier can serve a call so
 * callers fail fast with a clear message. Per SPEC.md INV-3 a reachable
 * local Ollama model is sufficient on its own.
 */

import { loadConfig } from "../config/index.js";
import {
  buildIntelligenceConfig,
  isAnthropicAvailable,
  isOllamaAvailable,
  isOpenRouterAvailable,
  resetIntelligence,
  resolveOpenAIRouteConfig,
  setClient,
  type AnthropicClient,
  type IntelligenceConfig,
} from "./index.js";

export interface LlmGate {
  /** Throw unless at least one cascade tier is configured or reachable. */
  init(): Promise<void>;
  /** Reset the factory's injected client and warnings (tests). */
  reset(): void;
  /** Inject a custom Anthropic client into the factory (tests). */
  setClient(client: AnthropicClient): void;
  /** Cascade configuration derived from the application config. */
  config(): IntelligenceConfig;
}

/** `name` names the caller in the failure message ("No <name> provider configured"). */
export function makeLlmGate(name: string): LlmGate {
  const config = (): IntelligenceConfig => buildIntelligenceConfig(loadConfig());
  return {
    async init() {
      // A configured OpenAI-compatible route (#45: ENGRAM_OPENAI_MODEL + key) is
      // a tier of its own; the cascade decides reachability per call.
      if (isAnthropicAvailable() || isOpenRouterAvailable() || resolveOpenAIRouteConfig() !== undefined) return;
      if (await isOllamaAvailable(config())) return;
      throw new Error(
        `No ${name} provider configured. ` +
          "Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or ENGRAM_OPENAI_MODEL (+ ENGRAM_OPENAI_BASE_URL), " +
          "or run Ollama with the configured local model.",
      );
    },
    reset: resetIntelligence,
    setClient,
    config,
  };
}
