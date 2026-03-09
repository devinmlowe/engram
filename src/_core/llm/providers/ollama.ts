/**
 * Ollama provider — local LLM inference via REST API.
 *
 * Handles availability checking, structured generation (JSON schema mode),
 * and free-text generation against a locally-running Ollama instance.
 */

import type { IntelligenceConfig, GenerationResult } from "../types.js";

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

// ─── Structured Generation ───────────────────────────────────────

/**
 * Attempt structured generation via Ollama's JSON schema mode.
 *
 * Uses POST /api/generate with `format` set to the JSON schema.
 * Returns null if the call fails for any reason (caller will fallback).
 */
export async function ollamaGenerateStructured<T>(
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

// ─── Free-Text Generation ────────────────────────────────────────

/**
 * Attempt free-text generation via Ollama.
 *
 * Uses POST /api/generate without the `format` parameter.
 * Returns null if the call fails for any reason.
 */
export async function ollamaGenerate(
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
