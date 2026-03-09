/**
 * Intelligence Layer — re-export stub.
 *
 * All implementation has moved to src/_core/llm/.
 * This file preserves backward compatibility for existing imports.
 */

export {
  generateStructured,
  generate,
  buildIntelligenceConfig,
  isOllamaAvailable,
  setClient,
  resetIntelligence,
  type IntelligenceConfig,
  type GenerationResult,
} from "../_core/llm/index.js";
