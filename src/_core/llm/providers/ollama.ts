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

/** Result of probing the Ollama host for a usable model. */
export interface OllamaProbe {
  /** False when /api/tags could not be fetched (server down, timeout, non-2xx). */
  reachable: boolean;
  /** Model tags the host reports (empty when unreachable). */
  available: string[];
  /**
   * The model the Ollama tier will use: `ollamaModel` when pulled, else the
   * first pulled entry of `ollamaModelFallbacks`; undefined when none is.
   */
  model?: string;
}

/** Ollama model names may carry a `:latest` suffix — match with or without it. */
function findPulled(target: string, available: string[]): string | undefined {
  const t = target.toLowerCase();
  return available.find((name) => {
    const n = name.toLowerCase();
    return n === t || n === `${t}:latest`;
  });
}

/**
 * Probe the Ollama host and resolve which model (configured or fallback)
 * the local tier can use.
 *
 * GETs /api/tags with a 5-second timeout. Never throws: any error (connection
 * refused, timeout, non-2xx, malformed body) reports `reachable: false`.
 */
export async function resolveOllamaModel(
  config: IntelligenceConfig,
): Promise<OllamaProbe> {
  let available: string[];
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
      return { reachable: false, available: [] };
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };

    if (!Array.isArray(data.models)) {
      return { reachable: false, available: [] };
    }
    available = data.models.map((m) => m.name ?? "").filter(Boolean);
  } catch {
    return { reachable: false, available: [] };
  }

  for (const candidate of [config.ollamaModel, ...(config.ollamaModelFallbacks ?? [])]) {
    if (findPulled(candidate, available)) {
      return { reachable: true, available, model: candidate };
    }
  }
  return { reachable: true, available };
}

/**
 * Check whether Ollama is running and has the configured model — or one of
 * its configured fallbacks — available.
 */
export async function isOllamaAvailable(
  config: IntelligenceConfig,
): Promise<boolean> {
  return (await resolveOllamaModel(config)).model !== undefined;
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
