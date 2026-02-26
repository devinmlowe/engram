# Local NLI Models and LLM Inference for macOS M4

> Research compiled 2026-02-26 for engram Phase 3 (Semantic Extraction)
> Back-reference: [spec.md Phase 3](../../spec.md#phase-3-semantic-extraction)

---

## Executive Summary

This document evaluates local inference options for a memory system running on an M4 Mac Mini (16GB) that needs contradiction detection, semantic similarity, and fact extraction without cloud API dependency. Covers NLI models, cross-encoder rerankers, local LLMs, transformers.js capabilities, hybrid architectures, and cost analysis.

---

## 1. NLI Models for Contradiction Detection

### 1.1 Recommended Models

| Model | Params | SNLI | MNLI-mm | ONNX | transformers.js |
|---|---|---|---|---|---|
| cross-encoder/nli-deberta-v3-large | 400M | 92.20% | 90.49% | Yes | Yes (Xenova) |
| MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli | 400M | N/A | 90.8% | Yes | Yes |
| cross-encoder/nli-deberta-v3-base | 86M | 92.38% | 90.04% | Yes | Yes (Xenova) |
| cross-encoder/nli-deberta-v3-xsmall | 22M | ~90% | ~88% | Yes | Yes (Xenova) |

**Primary recommendation**: `cross-encoder/nli-deberta-v3-base` -- best accuracy/speed balance. Available as `Xenova/nli-deberta-v3-base` in ONNX format.

**Lightweight option**: `Xenova/nli-deberta-v3-xsmall` (22M params) for latency-critical paths.

**Adversarial robustness**: `MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli` -- trained on adversarial data (ANLI), better for subtle contradictions.

Sources: [cross-encoder/nli-deberta-v3-large](https://huggingface.co/cross-encoder/nli-deberta-v3-large), [MoritzLaurer model](https://huggingface.co/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli)

### 1.2 Usage Pattern

Given a pair of memories (existing, candidate), the NLI model outputs three probabilities summing to 1.0:
- **entailment**: Candidate is consistent with existing (reinforcement)
- **contradiction**: Candidate conflicts with existing (flag for resolution)
- **neutral**: No clear relationship (treat as distinct)

**Thresholds for engram:**
- Contradiction score > 0.7 → log conflict, queue for resolution
- Contradiction score 0.5-0.7 → flag for LLM verification
- Entailment score > 0.7 → potential duplicate, check cosine similarity

---

## 2. Cross-Encoder Reranker Models

### 2.1 Available Models

| Model | Params | Task | ONNX | Downloads |
|---|---|---|---|---|
| Xenova/bge-reranker-base | ~278M | text-ranking | Yes | 102.5K |
| BAAI/bge-reranker-v2-m3 | Larger | multilingual ranking | Yes | High |
| cross-encoder/ms-marco-MiniLM-L-6-v2 | ~22M | passage reranking | Yes | Very High |

**Recommendation**: `Xenova/bge-reranker-base` for engram's recall pipeline -- well-tested, good quality, available in transformers.js.

### 2.2 Latency Estimates

For DeBERTa-based models on CPU (ONNX Runtime on M4):
- Single pair: ~30ms per inference
- Batch of 20 pairs (reranking recall results): ~600ms
- Native ONNX Runtime (via onnxruntime-node) is 2-10x faster than WASM

---

## 3. Local LLM Options for M4 Mac Mini

### 3.1 Framework Comparison

| Framework | Throughput Rank | Notes |
|-----------|----------------|-------|
| **MLX** | 1st (~230 tok/s on 8B) | Highest sustained, native Apple Silicon |
| **MLC-LLM** | 2nd (~190 tok/s) | Lower TTFT |
| **llama.cpp** | 3rd (~150 tok/s) | Wide model support |
| **Ollama** | 4th | Wraps llama.cpp, easy setup |

MLX is consistently **20-30% faster** than llama.cpp on Apple Silicon.

Source: [Production-Grade Local LLM Inference on Apple Silicon](https://arxiv.org/abs/2511.05502)

### 3.2 M4 Mac Mini 16GB Benchmarks

| Model | Quant | MLX tok/s | Ollama tok/s |
|-------|-------|-----------|-------------|
| Qwen 2.5 7B | Q4_K_M | ~32-35 | ~25-28 |
| Llama 3.1 8B | Q4_K_M | ~28-32 | ~22-26 |
| Phi-4 Mini 3.8B | Q4_K_M | ~40-50 | ~35-42 |

Source: [Like2Byte M4 benchmarks](https://like2byte.com/mac-mini-m4-16gb-local-llm-benchmarks-roi/)

### 3.3 Model Selection for Structured Extraction

**Qwen 2.5 7B / Qwen 3 8B (Recommended)**
- Best structured output and JSON generation in the 7-8B class
- "Significant improvements in understanding structured data and generating structured outputs, especially JSON" ([Qwen 2.5 blog](https://qwenlm.github.io/blog/qwen2.5-llm/))
- MMLU-pro: 74, MATH: 75.5, HumanEval: 84.8
- MLX-optimized checkpoints available

**Phi-4 Mini (3.8B)**
- Best reasoning per parameter
- Designed for tool calling and structured outputs
- Faster on 16GB M4 (~40-50 tok/s)
- Good for simpler extraction tasks

### 3.4 Quantization Recommendations

| Quant | Size (8B) | Quality Loss | Speed |
|-------|-----------|-------------|-------|
| Q8 | ~8 GB | Minimal | Baseline |
| Q6_K | ~6.5 GB | Very low | ~10% faster |
| **Q4_K_M** | **~4.5 GB** | **Low** | **~30% faster** |
| Q3_K | ~3.5 GB | Moderate | ~40% faster |

**Best for 16GB M4**: Q4_K_M of a 7-8B model at ~4.5 GB leaves comfortable headroom for concurrent operations.

---

## 4. Transformers.js Capabilities

### 4.1 Current State (v4, February 2026)

- Completely rewritten WebGPU runtime in C++ with ONNX Runtime team
- Up to 4x faster BERT-based models
- ~200 model architectures supported
- Server-side Node.js with automatic execution provider selection
- LLM support up to 20B+ models

Source: [Transformers.js v4](https://huggingface.co/blog/transformersjs-v4)

### 4.2 Confirmed ONNX Models for transformers.js

| Model | Task | Size |
|-------|------|------|
| Xenova/nli-deberta-v3-xsmall | zero-shot-classification | ~70M |
| Xenova/nli-deberta-v3-small | zero-shot-classification | ~140M |
| Xenova/nli-deberta-v3-base | zero-shot-classification | ~184M |
| Xenova/nli-deberta-v3-large | zero-shot-classification | ~400M |
| Xenova/bge-reranker-base | text-ranking | ~278M |

### 4.3 ONNX Runtime on Apple Silicon

- `onnxruntime-node` uses native ARM binaries (not WASM)
- 2-10x faster than WASM, zero warm-up overhead
- CPU execution provider with ARM NEON optimizations
- CoreML execution provider available via C/C++ APIs

---

## 5. Hybrid Local/Cloud Architecture

### 5.1 SLM-Default, LLM-Fallback Pattern

1. All queries route to local model first
2. Only escalate to cloud if confidence is low
3. Handles the reality that most extraction tasks are straightforward

Source: [SLM-default, LLM-fallback Pattern](https://www.strathweb.com/2025/12/slm-default-llm-fallback-pattern-with-agent-framework-and-azure-ai-foundry/)

### 5.2 Confidence-Based Routing

- Local model appends confidence score (1-10) to output
- Scores >= 8 terminate locally
- Below 8 triggers cloud escalation
- Hybrid approach reduces cloud API usage by **>60%**, ~40% lower average latency

Source: [Hybrid Cloud Architecture for LLM Deployment](https://journal-isi.org/index.php/isi/article/view/1170)

### 5.3 Recommended Three-Tier Architecture

**Tier 1 -- Encoder Models (transformers.js / ONNX):**
- NLI contradiction detection (DeBERTa-v3)
- Semantic similarity (embeddings already in engram)
- ~30ms per pair, no LLM needed
- Handles majority of dedup/conflict tasks

**Tier 2 -- Local LLM (MLX):**
- Fact extraction, entity extraction, structured summarization
- Qwen 3 8B Q4_K_M via MLX-LM
- ~32 tok/s on M4
- Handles most extraction tasks

**Tier 3 -- Cloud API (Claude Haiku 4.5 Batch):**
- Complex reasoning, ambiguous cases
- Confidence < threshold escalation
- Batch API with 50% discount for overnight processing

### 5.4 When to Escalate

| Task | Local Model | Escalate When |
|------|------------|---------------|
| Contradiction detection | DeBERTa NLI | Both scores > 0.3 (ambiguous) |
| Simple fact extraction | Qwen 3 8B | Confidence < 0.8 |
| Entity extraction | Qwen 3 8B | Novel entity types |
| Multi-hop reasoning | Always escalate | Cloud LLM significantly better |

---

## 6. Cost Analysis

### 6.1 API Pricing (Claude Haiku 4.5)

| Mode | Input/MTok | Output/MTok |
|------|-----------|-------------|
| Standard | $1.00 | $5.00 |
| Batch API (50% off) | $0.50 | $2.50 |

### 6.2 Processing Scenarios

**100 conversations/night (Haiku Batch):**
- Input: 250K tokens = $0.125
- Output: 50K tokens = $0.125
- **Monthly: ~$7.50**

**500 conversations/night (Haiku Batch):**
- **Monthly: ~$37.50**

**Hybrid (60% local):**
- **Monthly: ~$5-15**

### 6.3 Local Processing Time

500 conversations x 500 output tokens = 250K tokens @ 32 tok/s = ~2.2 hours. Fits in nightly batch window.

### 6.4 The Real Case for Local

At engram's scale (100-500 conversations/night), cloud costs are modest ($7.50-$37.50/month). The real reasons for local:

1. **Privacy**: Conversations never leave the machine
2. **Availability**: No external dependency
3. **Unlimited iteration**: Experiment without cost anxiety
4. **Offline capability**: Works without internet

---

## 7. Summary of Recommendations

### Contradiction Detection
Use **DeBERTa-v3 NLI models via transformers.js** (ONNX). Start with `Xenova/nli-deberta-v3-xsmall` for speed or `Xenova/nli-deberta-v3-base` for accuracy. Entirely in Node.js, ~30ms per pair.

### Reranking
Use **Xenova/bge-reranker-base** via transformers.js. Already planned in engram spec, confirmed available and performant.

### Fact Extraction
Use **Qwen 3 8B Q4_K_M via MLX-LM** as primary. Fall back to **Claude Haiku 4.5 Batch API** for complex cases.

### Architecture
Three-tier: encoder models (fast, free) for NLI/similarity → local LLM for extraction → cloud API for fallback. Confidence-based routing at 0.8 threshold.

---

## Sources

- [cross-encoder/nli-deberta-v3-large](https://huggingface.co/cross-encoder/nli-deberta-v3-large)
- [MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli](https://huggingface.co/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli)
- [Transformers.js v4](https://huggingface.co/blog/transformersjs-v4)
- [Production-Grade Local LLM Inference on Apple Silicon](https://arxiv.org/abs/2511.05502)
- [Like2Byte M4 Benchmarks](https://like2byte.com/mac-mini-m4-16gb-local-llm-benchmarks-roi/)
- [SLM-default, LLM-fallback Pattern](https://www.strathweb.com/2025/12/slm-default-llm-fallback-pattern-with-agent-framework-and-azure-ai-foundry/)
- [Hybrid Cloud Architecture](https://journal-isi.org/index.php/isi/article/view/1170)
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Xenova/bge-reranker-base](https://hf.co/Xenova/bge-reranker-base)
- [Qwen 2.5 LLM](https://qwenlm.github.io/blog/qwen2.5-llm/)
- [MLX-LM GitHub](https://github.com/ml-explore/mlx-lm)
- [FSRS Algorithm](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)
