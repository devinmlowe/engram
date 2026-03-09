/**
 * Anthropic provider — Claude API for LLM inference.
 *
 * Handles client lifecycle (lazy singleton), structured generation via
 * tool_use, and free-text generation. Supports primary → fallback model
 * cascade within the Anthropic tier.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IntelligenceConfig, GenerationResult } from "../types.js";

// ─── Module State ────────────────────────────────────────────────

let client: Anthropic | null = null;

// ─── Client Management ───────────────────────────────────────────

/**
 * Set a custom Anthropic client (for testing with mocks).
 */
export function setClient(customClient: Anthropic): void {
  client = customClient;
}

/**
 * Reset module state (for testing).
 */
export function resetIntelligence(): void {
  client = null;
}

/**
 * Get or lazily create the Anthropic client singleton.
 */
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Anthropic API key required for intelligence fallback. " +
          "Set ANTHROPIC_API_KEY environment variable.",
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

// ─── Structured Generation ───────────────────────────────────────

/**
 * Structured generation via the Anthropic API using tool_use.
 *
 * Converts the JSON schema into a tool definition and forces tool use,
 * then extracts the structured input from the response.
 */
export async function apiGenerateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
): Promise<GenerationResult<T>> {
  const startMs = Date.now();
  const anthropic = getClient();

  const tool: Anthropic.Tool = {
    name: "structured_output",
    description: "Return structured data matching the schema",
    input_schema: {
      type: "object" as const,
      ...schema,
    },
  };

  // Try primary model, fall back to apiFallbackModel
  const modelsToTry = [config.apiModel, config.apiFallbackModel];
  let lastError: unknown;

  for (const model of modelsToTry) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: [tool],
        tool_choice: { type: "tool", name: "structured_output" },
        messages: [{ role: "user", content: userPrompt }],
      });

      const toolUseBlock = response.content.find(
        (block) => block.type === "tool_use",
      );

      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        throw new Error("No tool_use block in API response");
      }

      const durationMs = Date.now() - startMs;
      return {
        result: toolUseBlock.input as T,
        source: "api",
        model,
        durationMs,
      };
    } catch (err) {
      lastError = err;
      // If this is the last model, the throw below will fire
    }
  }

  throw lastError ?? new Error("All API models failed for structured generation");
}

// ─── Free-Text Generation ────────────────────────────────────────

/**
 * Free-text generation via the Anthropic API.
 */
export async function apiGenerate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<GenerationResult<string>> {
  const startMs = Date.now();
  const anthropic = getClient();

  const modelsToTry = [config.apiModel, config.apiFallbackModel];
  let lastError: unknown;

  for (const model of modelsToTry) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const textBlock = response.content.find(
        (block) => block.type === "text",
      );

      const text =
        textBlock && textBlock.type === "text" ? textBlock.text : "";
      const durationMs = Date.now() - startMs;

      return {
        result: text,
        source: "api",
        model,
        durationMs,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("All API models failed for text generation");
}
