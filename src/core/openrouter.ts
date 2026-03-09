/**
 * OpenRouter client — re-export stub.
 *
 * All implementation has moved to src/_core/llm/providers/openrouter.ts.
 * This file preserves backward compatibility for existing imports.
 */

export {
  isOpenRouterAvailable,
  callOpenRouterTool,
  callOpenRouterText,
  type OpenRouterToolDef,
  type OpenRouterCallOptions,
} from "../_core/llm/providers/openrouter.js";
