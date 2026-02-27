/**
 * Shared OpenRouter client for LLM calls via OpenAI-compatible API.
 *
 * Provides a generic function calling interface that mirrors Anthropic's
 * tool_use pattern. Used by semantic/extractor, graph/extractor, and
 * semantic/consolidator to route through OpenRouter when OPENROUTER_API_KEY
 * is set (10x cheaper than Anthropic Haiku for batch workloads).
 */

const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";
const BASE_URL = "https://openrouter.ai/api/v1";

// ─── Types ──────────────────────────────────────────────────────

export interface OpenRouterToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenRouterCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

interface OpenRouterAPIResponse {
  choices?: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  model?: string;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check whether OpenRouter is configured (API key is set).
 */
export function isOpenRouterAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/**
 * Call OpenRouter with a tool/function definition and return the parsed result.
 *
 * Translates Anthropic-style tool schemas to OpenAI function calling format.
 * Returns the parsed JSON from the function call response.
 *
 * @throws Error if the API call fails or returns no valid result
 */
export async function callOpenRouterTool<T = Record<string, unknown>>(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  tool: OpenRouterToolDef,
  options?: OpenRouterCallOptions,
): Promise<{ result: T; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const model = options?.model ?? process.env.ENGRAM_OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/devinmlowe/engram",
        "X-Title": "engram dream cycle",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: [{
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }],
        tool_choice: { type: "function", function: { name: tool.name } },
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as OpenRouterAPIResponse;
    const usedModel = data.model ?? model;

    // Primary path: function call arguments
    const toolCalls = data.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const parsed = JSON.parse(toolCalls[0].function.arguments) as T;
      return { result: parsed, model: usedModel };
    }

    // Fallback: some models return JSON in content instead of tool_calls
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content) as T;
      return { result: parsed, model: usedModel };
    }

    throw new Error("OpenRouter response contained no tool_calls or content");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call OpenRouter for free-text generation (no tool/function calling).
 *
 * @throws Error if the API call fails or returns no content
 */
export async function callOpenRouterText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: OpenRouterCallOptions,
): Promise<{ result: string; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const model = options?.model ?? process.env.ENGRAM_OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/devinmlowe/engram",
        "X-Title": "engram dream cycle",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as OpenRouterAPIResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenRouter response contained no content");
    }

    return { result: content, model: data.model ?? model };
  } finally {
    clearTimeout(timeout);
  }
}
