/**
 * Intelligence Layer — unified LLM interface for dream-state processing.
 *
 * Prefers local inference via Ollama REST API and falls back to the
 * Claude API when Ollama is unavailable or generation fails.
 *
 * Phase 5, Step 2 implementation.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { EngramConfig } from "../_core/types/index.js";
import {
  callOpenRouterTool,
  callOpenRouterText,
} from "../core/openrouter.js";

// ─── Types ───────────────────────────────────────────────────────

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

// ─── Configuration ───────────────────────────────────────────────

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 120_000;
const AVAILABILITY_TIMEOUT_MS = 5_000;

/**
 * Build an IntelligenceConfig from the application EngramConfig.
 *
 * Maps dream config fields to intelligence config, applying defaults
 * and reading OLLAMA_HOST from the environment.
 */
export function buildIntelligenceConfig(
  config: EngramConfig,
): IntelligenceConfig {
  return {
    ollamaUrl:
      process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL,
    ollamaModel:
      config.dream.localModel ?? DEFAULT_OLLAMA_MODEL,
    openrouterModel:
      config.dream.openrouterModel ??
      (process.env.OPENROUTER_API_KEY ? DEFAULT_OPENROUTER_MODEL : undefined),
    apiModel: config.dream.apiModel,
    apiFallbackModel: config.dream.apiFallbackModel,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

// ─── Ollama Availability ─────────────────────────────────────────

/**
 * Check whether Ollama is running and has the configured model available.
 *
 * GETs /api/tags with a 5-second timeout, then checks whether the
 * target model appears in the response's model list.
 * Returns false on any error (connection refused, timeout, model missing).
 */
export async function isOllamaAvailable(
  config: IntelligenceConfig,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      AVAILABILITY_TIMEOUT_MS,
    );

    const response = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };

    if (!Array.isArray(data.models)) {
      return false;
    }

    // Ollama model names may include `:latest` suffix — match with
    // or without the tag.
    const target = config.ollamaModel.toLowerCase();
    return data.models.some((m) => {
      const name = (m.name ?? "").toLowerCase();
      return name === target || name === `${target}:latest`;
    });
  } catch {
    return false;
  }
}

// ─── Local Generation (Ollama) ───────────────────────────────────

/**
 * Attempt structured generation via Ollama's JSON schema mode.
 *
 * Uses POST /api/generate with `format` set to the JSON schema.
 * Returns null if the call fails for any reason (caller will fallback).
 */
async function ollamaGenerateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
): Promise<GenerationResult<T> | null> {
  try {
    const startMs = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs,
    );

    const response = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        system: systemPrompt,
        prompt: userPrompt,
        format: schema,
        stream: false,
        options: { num_predict: 4096 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { response?: string };
    if (!data.response) {
      return null;
    }

    const parsed = JSON.parse(data.response) as T;
    const durationMs = Date.now() - startMs;

    return {
      result: parsed,
      source: "local",
      model: config.ollamaModel,
      durationMs,
    };
  } catch {
    return null;
  }
}

/**
 * Attempt free-text generation via Ollama.
 *
 * Uses POST /api/generate without the `format` parameter.
 * Returns null if the call fails for any reason.
 */
async function ollamaGenerate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<GenerationResult<string> | null> {
  try {
    const startMs = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs,
    );

    const response = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        system: systemPrompt,
        prompt: userPrompt,
        stream: false,
        options: { num_predict: 4096 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { response?: string };
    if (!data.response) {
      return null;
    }

    const durationMs = Date.now() - startMs;

    return {
      result: data.response,
      source: "local",
      model: config.ollamaModel,
      durationMs,
    };
  } catch {
    return null;
  }
}

// ─── OpenRouter (Cloud Fallback) ─────────────────────────────────

/**
 * Structured generation via the shared OpenRouter client.
 * Returns null on failure so the caller can fall through.
 */
async function openrouterGenerateStructured<T>(
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
async function openrouterGenerate(
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

// ─── API Fallback (Claude) ───────────────────────────────────────

/**
 * Structured generation via the Anthropic API using tool_use.
 *
 * Converts the JSON schema into a tool definition and forces tool use,
 * then extracts the structured input from the response.
 */
async function apiGenerateStructured<T>(
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

/**
 * Free-text generation via the Anthropic API.
 */
async function apiGenerate(
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

// ─── Public Generation Functions ─────────────────────────────────

/**
 * Generate structured output (JSON matching a schema).
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 */
export async function generateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
): Promise<GenerationResult<T>> {
  // Tier 1: Try Ollama (local, free)
  const available = await isOllamaAvailable(config);
  if (available) {
    const localResult = await ollamaGenerateStructured<T>(
      systemPrompt,
      userPrompt,
      schema,
      config,
    );
    if (localResult) {
      return localResult;
    }
  }

  // Tier 2: Try OpenRouter (cheap cloud)
  const openrouterResult = await openrouterGenerateStructured<T>(
    systemPrompt,
    userPrompt,
    schema,
    config,
  );
  if (openrouterResult) {
    return openrouterResult;
  }

  // Tier 3: Fall back to Anthropic API
  return apiGenerateStructured<T>(systemPrompt, userPrompt, schema, config);
}

/**
 * Generate a free-text response.
 *
 * Tier cascade: Ollama (local) → OpenRouter (cheap cloud) → Anthropic API.
 */
export async function generate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<GenerationResult<string>> {
  // Tier 1: Try Ollama (local, free)
  const available = await isOllamaAvailable(config);
  if (available) {
    const localResult = await ollamaGenerate(
      systemPrompt,
      userPrompt,
      config,
    );
    if (localResult) {
      return localResult;
    }
  }

  // Tier 2: Try OpenRouter (cheap cloud)
  const openrouterResult = await openrouterGenerate(
    systemPrompt,
    userPrompt,
    config,
  );
  if (openrouterResult) {
    return openrouterResult;
  }

  // Tier 3: Fall back to Anthropic API
  return apiGenerate(systemPrompt, userPrompt, config);
}
