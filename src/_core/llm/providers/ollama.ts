/**
 * Ollama provider — local LLM inference via REST API.
 *
 * Handles availability checking, structured generation (JSON schema mode),
 * and free-text generation against a locally-running Ollama instance.
 */

import type { IntelligenceConfig, GenerationOptions, TierOutcome, TierError } from "../types.js";
import { DEFAULT_MAX_TOKENS, tierErrorMessage } from "../types.js";

// ─── Configuration ───────────────────────────────────────────────

const AVAILABILITY_TIMEOUT_MS = 5_000;

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

// ─── Failure Reporting ───────────────────────────────────────────

function ollamaFailure(err: unknown): { failure: TierError } {
  const aborted = err instanceof Error && err.name === "AbortError";
  return {
    failure: {
      tier: "ollama",
      errorClass: aborted ? "transient" : "unknown",
      message: aborted ? "Ollama request timed out" : `Ollama: ${tierErrorMessage(err)}`,
    },
  };
}

function ollamaHttpFailure(response: Response): { failure: TierError } {
  return {
    failure: {
      tier: "ollama",
      errorClass: response.status >= 500 ? "transient" : "unknown",
      message: `Ollama HTTP ${response.status}`,
    },
  };
}

const EMPTY_RESPONSE: { failure: TierError } = {
  failure: { tier: "ollama", errorClass: "unknown", message: "Ollama returned an empty response" },
};

// ─── Structured Generation ───────────────────────────────────────

/**
 * Attempt structured generation via Ollama's JSON schema mode.
 *
 * Uses POST /api/generate with `format` set to the JSON schema.
 * Returns a `failure` outcome if the call fails for any reason (caller will fallback).
 */
export async function ollamaGenerateStructured<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  config: IntelligenceConfig,
  options: GenerationOptions = {},
): Promise<TierOutcome<T>> {
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
        options: { num_predict: options.maxTokens ?? DEFAULT_MAX_TOKENS },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return ollamaHttpFailure(response);
    }

    const data = (await response.json()) as { response?: string };
    if (!data.response) {
      return EMPTY_RESPONSE;
    }

    const parsed = JSON.parse(data.response) as T;
    const durationMs = Date.now() - startMs;

    return {
      result: parsed,
      source: "local",
      provider: "ollama",
      model: config.ollamaModel,
      durationMs,
    };
  } catch (err) {
    return ollamaFailure(err);
  }
}

// ─── Free-Text Generation ────────────────────────────────────────

/**
 * Attempt free-text generation via Ollama.
 *
 * Uses POST /api/generate without the `format` parameter.
 * Returns a `failure` outcome if the call fails for any reason.
 */
export async function ollamaGenerate(
  systemPrompt: string,
  userPrompt: string,
  config: IntelligenceConfig,
): Promise<TierOutcome<string>> {
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
        options: { num_predict: DEFAULT_MAX_TOKENS },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return ollamaHttpFailure(response);
    }

    const data = (await response.json()) as { response?: string };
    if (!data.response) {
      return EMPTY_RESPONSE;
    }

    const durationMs = Date.now() - startMs;

    return {
      result: data.response,
      source: "local",
      provider: "ollama",
      model: config.ollamaModel,
      durationMs,
    };
  } catch (err) {
    return ollamaFailure(err);
  }
}
