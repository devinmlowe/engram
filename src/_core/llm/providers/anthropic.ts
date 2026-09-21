/**
 * Anthropic provider — Claude Messages API over `fetch` (#118).
 *
 * The request shape is the one the `@anthropic-ai/sdk` client used to send
 * (model, max_tokens, system, messages, tools, tool_choice) with the same
 * `anthropic-version` header; the SDK itself is no longer a dependency. The
 * client seam (`setClient`) is kept so tests can inject a mock with a
 * `messages.create` function. Supports primary → fallback model cascade
 * within the Anthropic tier.
 */

import type { IntelligenceConfig, GenerationResult, GenerationOptions } from "../types.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOOL_NAME,
  DEFAULT_TOOL_DESCRIPTION,
} from "../types.js";

// ─── Wire types ──────────────────────────────────────────────────

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** API version header; the value the SDK (0.125.0) sent. */
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: { type: "object"; [key: string]: unknown };
}

export interface AnthropicMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: AnthropicTool[];
  tool_choice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
  temperature?: number;
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicMessage {
  content: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string | null;
}

export interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

/** The slice of the Anthropic client surface engram uses; test mocks implement it. */
export interface AnthropicClient {
  messages: {
    create(params: AnthropicMessageParams, options?: AnthropicRequestOptions): Promise<AnthropicMessage>;
  };
}

/** Non-2xx reply; `status` lets the cascade classify it (transient / provider / permanent). */
export class AnthropicApiError extends Error {
  status: number;

  constructor(status: number, body: string) {
    super(`Anthropic API error ${status}: ${body}`);
    this.name = "AnthropicApiError";
    this.status = status;
  }
}

/** A minimal Messages API client over `fetch`. */
export function createAnthropicClient(apiKey: string): AnthropicClient {
  return {
    messages: {
      async create(params, options) {
        const response = await fetch(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(params),
          signal: options?.signal,
        });
        if (!response.ok) {
          throw new AnthropicApiError(response.status, await response.text());
        }
        return (await response.json()) as AnthropicMessage;
      },
    },
  };
}

// ─── Module State ────────────────────────────────────────────────

let client: AnthropicClient | null = null;

// ─── Client Management ───────────────────────────────────────────

/**
 * Set a custom Anthropic client (for testing with mocks).
 */
export function setClient(customClient: AnthropicClient): void {
  client = customClient;
}

/**
 * Whether the Anthropic tier can serve requests: either a client was
 * injected or an API key is present. Mirrors isOpenRouterAvailable().
 */
export function isAnthropicAvailable(): boolean {
  return client !== null || Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Primary → fallback model order, collapsed when both are the same model
 * (an explicit pin) so a failure is not retried against the same model.
 */
function modelsToTry(config: IntelligenceConfig): string[] {
  return [...new Set([config.apiModel, config.apiFallbackModel])];
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
function getClient(): AnthropicClient {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Anthropic API key required for intelligence fallback. " +
          "Set ANTHROPIC_API_KEY environment variable.",
      );
    }
    client = createAnthropicClient(apiKey);
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
  options: GenerationOptions = {},
): Promise<GenerationResult<T>> {
  const startMs = Date.now();
  const anthropic = getClient();

  const toolName = options.toolName ?? DEFAULT_TOOL_NAME;
  const tool: AnthropicTool = {
    name: toolName,
    description: options.toolDescription ?? DEFAULT_TOOL_DESCRIPTION,
    input_schema: {
      type: "object" as const,
      ...schema,
    },
  };

  // Try primary model, fall back to apiFallbackModel
  let lastError: unknown;

  for (const model of modelsToTry(config)) {
    try {
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: systemPrompt,
          tools: [tool],
          tool_choice: { type: "tool", name: toolName },
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal: AbortSignal.timeout(config.timeoutMs) },
      );

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
        provider: "anthropic",
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

  let lastError: unknown;

  for (const model of modelsToTry(config)) {
    try {
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal: AbortSignal.timeout(config.timeoutMs) },
      );

      const textBlock = response.content.find(
        (block) => block.type === "text",
      );

      const text =
        textBlock && textBlock.type === "text" ? textBlock.text : "";
      const durationMs = Date.now() - startMs;

      return {
        result: text,
        source: "api",
        provider: "anthropic",
        model,
        durationMs,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("All API models failed for text generation");
}
