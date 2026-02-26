/**
 * NLI (Natural Language Inference) contradiction detection via DeBERTa ONNX.
 *
 * Uses @xenova/transformers to run a cross-encoder NLI model that classifies
 * premise-hypothesis pairs as entailment, contradiction, or neutral.
 *
 * Preferred model: cross-encoder/nli-deberta-v3-base
 * Fallback model:  Xenova/nli-deberta-v3-xsmall
 */

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  softmax,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from "@xenova/transformers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NliResult {
  entailment: number; // 0-1 probability
  contradiction: number; // 0-1 probability
  neutral: number; // 0-1 probability
  label: "entailment" | "contradiction" | "neutral";
}

// ---------------------------------------------------------------------------
// Module-level state (lazy singleton)
// ---------------------------------------------------------------------------

const PREFERRED_MODEL = "cross-encoder/nli-deberta-v3-base";
const FALLBACK_MODEL = "Xenova/nli-deberta-v3-xsmall";

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
let labelMap: Record<number, string> = {};
let activeModelName: string | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the NLI model and tokenizer.
 * Tries the preferred cross-encoder/nli-deberta-v3-base first,
 * falls back to Xenova/nli-deberta-v3-xsmall.
 *
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
export async function initNli(): Promise<void> {
  if (tokenizer && model) return;

  try {
    tokenizer = await AutoTokenizer.from_pretrained(PREFERRED_MODEL);
    model = await AutoModelForSequenceClassification.from_pretrained(
      PREFERRED_MODEL,
    );
    activeModelName = PREFERRED_MODEL;
  } catch {
    tokenizer = await AutoTokenizer.from_pretrained(FALLBACK_MODEL);
    model = await AutoModelForSequenceClassification.from_pretrained(
      FALLBACK_MODEL,
    );
    activeModelName = FALLBACK_MODEL;
  }

  // Build label map from model config (e.g. {0: "entailment", 1: "neutral", 2: "contradiction"})
  const id2label = (model as unknown as { config: { id2label: Record<string, string> } }).config
    .id2label;

  if (id2label) {
    for (const [id, rawLabel] of Object.entries(id2label)) {
      labelMap[Number(id)] = rawLabel.toLowerCase();
    }
  } else {
    // Sensible default for most NLI models
    labelMap = { 0: "entailment", 1: "neutral", 2: "contradiction" };
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a single premise-hypothesis pair via NLI.
 *
 * Returns softmax probabilities for entailment, contradiction, and neutral,
 * plus the winning label.
 */
export async function classifyNli(
  premise: string,
  hypothesis: string,
): Promise<NliResult> {
  if (!tokenizer || !model) await initNli();

  // Tokenize as a sentence pair -- the tokenizer handles [CLS] premise [SEP] hypothesis [SEP]
  const inputs = tokenizer!(premise, {
    text_pair: hypothesis,
    padding: true,
    truncation: true,
  });

  // Run forward pass
  const outputs = await model!(inputs);

  // Extract logits and apply softmax
  const logits = Array.from(outputs.logits.data as Float32Array);
  const probs = softmax(logits) as number[];

  // Map probabilities to named labels
  const result: Record<string, number> = {
    entailment: 0,
    contradiction: 0,
    neutral: 0,
  };

  for (let i = 0; i < probs.length; i++) {
    const label = labelMap[i];
    if (label && label in result) {
      result[label] = probs[i];
    }
  }

  // Determine winning label
  let bestLabel: "entailment" | "contradiction" | "neutral" = "neutral";
  let bestScore = -1;
  for (const key of ["entailment", "contradiction", "neutral"] as const) {
    if (result[key] > bestScore) {
      bestScore = result[key];
      bestLabel = key;
    }
  }

  return {
    entailment: result.entailment,
    contradiction: result.contradiction,
    neutral: result.neutral,
    label: bestLabel,
  };
}

/**
 * Classify a batch of premise-hypothesis pairs.
 *
 * Processes pairs sequentially since transformers.js cross-encoders
 * do not always handle batch inference reliably.
 */
export async function classifyNliBatch(
  pairs: [string, string][],
): Promise<NliResult[]> {
  if (!tokenizer || !model) await initNli();

  const results: NliResult[] = [];
  for (const [premise, hypothesis] of pairs) {
    results.push(await classifyNli(premise, hypothesis));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Diagnostics / testing helpers
// ---------------------------------------------------------------------------

/**
 * Get the name of the active NLI model (for diagnostics).
 */
export function getActiveNliModel(): string | null {
  return activeModelName;
}

/**
 * Reset the NLI pipeline (for testing).
 */
export function resetNli(): void {
  tokenizer = null;
  model = null;
  labelMap = {};
  activeModelName = null;
}
