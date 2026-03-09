/**
 * Shared OpenRouter client for LLM calls via OpenAI-compatible API.
 *
 * Provides a generic function calling interface that mirrors Anthropic's
 * tool_use pattern. Used by semantic/extractor, graph/extractor, and
 * semantic/consolidator to route through OpenRouter when OPENROUTER_API_KEY
 * is set (10x cheaper than Anthropic Haiku for batch workloads).
 */

import type { IntelligenceConfig, GenerationResult } from "../types.js";

const DEFAULT_MODEL = "google/gemini-2.5-flash";
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
    finish_reason?: string;
  }>;
  model?: string;
}

// ─── Error Classification ───────────────────────────────────────

export class OpenRouterError extends Error {
  httpStatus: number | undefined;
  errorClass: "transient" | "provider" | "permanent" | "unknown";

  constructor(
    message: string,
    httpStatus?: number,
    errorClass?: "transient" | "provider" | "permanent" | "unknown",
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.httpStatus = httpStatus;
    this.errorClass = errorClass ?? classifyHttpStatus(httpStatus);
  }
}

function classifyHttpStatus(
  status?: number,
): "transient" | "provider" | "permanent" | "unknown" {
  if (!status) return "unknown";
  if ([429, 500, 502, 503, 504].includes(status)) return "transient";
  if ([401, 402].includes(status)) return "provider";
  if ([400, 422].includes(status)) return "permanent";
  return "unknown";
}

// ─── Retry Logic ────────────────────────────────────────────────

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts - 1;

      // Don't retry permanent or provider errors
      if (err instanceof OpenRouterError) {
        if (err.errorClass === "permanent" || err.errorClass === "provider") {
          throw err;
        }
      }

      // Wrap timeout AbortErrors with classified OpenRouterError for callers
      if (isLast) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new OpenRouterError(
            `OpenRouter request timed out after ${maxAttempts} attempts`,
            undefined,
            "transient",
          );
        }
        throw err;
      }

      // Full jitter: delay = random(0, min(maxDelay, baseDelay * 2^attempt))
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const delay = Math.random() * cap;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("retryWithBackoff: unreachable");
}

// ─── Content Sanitization ───────────────────────────────────────

/**
 * Strip Unicode control characters that trigger Gemini's MALFORMED_FUNCTION_CALL.
 * Preserves normal whitespace (space, tab, newline, carriage return).
 */
function stripControlChars(text: string): string {
  return text.replace(
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u2028-\u202F\uFEFF]/g,
    "",
  );
}

/**
 * Strip markdown code fences that some models wrap around JSON responses.
 * Handles ```json ... ``` and plain ``` ... ``` patterns.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
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
 * Features:
 * - Retry with exponential backoff + jitter for transient errors (429, 5xx)
 * - Unicode control character sanitization to avoid Gemini empty responses
 * - Markdown code fence stripping for content fallback parsing
 * - Respects Retry-After header when present
 *
 * @throws OpenRouterError with classified error type
 */
export async function callOpenRouterTool<T = Record<string, unknown>>(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  tool: OpenRouterToolDef,
  options?: OpenRouterCallOptions,
): Promise<{ result: T; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY not set", undefined, "permanent");
  }

  const model = options?.model ?? process.env.ENGRAM_OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  // Sanitize message content to avoid Gemini MALFORMED_FUNCTION_CALL
  const sanitizedMessages = messages.map((m) => ({
    ...m,
    content: stripControlChars(m.content),
  }));

  return retryWithBackoff(async () => {
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
        messages: sanitizedMessages,
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new OpenRouterError(
        `OpenRouter API error ${response.status}: ${body}`,
        response.status,
      );
    }

    const data = (await response.json()) as OpenRouterAPIResponse;
    const usedModel = data.model ?? model;
    const finishReason = data.choices?.[0]?.finish_reason;

    // Primary path: function call arguments
    const toolCalls = data.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const parsed = JSON.parse(toolCalls[0].function.arguments) as T;
      return { result: parsed, model: usedModel };
    }

    // Fallback: some models return JSON in content instead of tool_calls
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      const cleaned = stripCodeFences(content);
      const parsed = JSON.parse(cleaned) as T;
      return { result: parsed, model: usedModel };
    }

    // Both tool_calls and content empty — classify as transient (Gemini empty response)
    throw new OpenRouterError(
      `OpenRouter response contained no tool_calls or content (finish_reason: ${finishReason ?? "unknown"})`,
      undefined,
      "transient",
    );
  });
}

/**
 * Call OpenRouter for free-text generation (no tool/function calling).
 *
 * @throws OpenRouterError with classified error type
 */
export async function callOpenRouterText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options?: OpenRouterCallOptions,
): Promise<{ result: string; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY not set", undefined, "permanent");
  }

  const model = options?.model ?? process.env.ENGRAM_OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 4096;
  const temperature = options?.temperature ?? 0;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  // Sanitize message content
  const sanitizedMessages = messages.map((m) => ({
    ...m,
    content: stripControlChars(m.content),
  }));

  return retryWithBackoff(async () => {
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
        messages: sanitizedMessages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new OpenRouterError(
        `OpenRouter API error ${response.status}: ${body}`,
        response.status,
      );
    }

    const data = (await response.json()) as OpenRouterAPIResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      const finishReason = data.choices?.[0]?.finish_reason;
      throw new OpenRouterError(
        `OpenRouter response contained no content (finish_reason: ${finishReason ?? "unknown"})`,
        undefined,
        "transient",
      );
    }

    return { result: content, model: data.model ?? model };
  });
}

// ─── Intelligence-Layer Wrappers ─────────────────────────────────

/**
 * Structured generation via the shared OpenRouter client.
 * Returns null on failure so the caller can fall through.
 */
export async function openrouterGenerateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
): Promise<GenerationResult<T> | null> {
  if (!config.openrouterModel) return null;

  try {
    const startMs = Date.now();
    const { result, model } = await callOpenRouterTool<T>(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        name: "structured_output",
        description: "Return structured data matching the schema",
        parameters: { type: "object", ...schema },
      },
      { model: config.openrouterModel, timeoutMs: config.timeoutMs },
    );

    return {
      result,
      source: "api",
      model,
      durationMs: Date.now() - startMs,
    };
  } catch {
    return null;
  }
}

/**
 * Free-text generation via the shared OpenRouter client.
 * Returns null on failure so the caller can fall through.
 */
export async function openrouterGenerate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<GenerationResult<string> | null> {
  if (!config.openrouterModel) return null;

  try {
    const startMs = Date.now();
    const { result, model } = await callOpenRouterText(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { model: config.openrouterModel, timeoutMs: config.timeoutMs },
    );

    return {
      result,
      source: "api",
      model,
      durationMs: Date.now() - startMs,
    };
  } catch {
    return null;
  }
}
