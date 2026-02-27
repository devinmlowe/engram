# Dream Cycle Model Selection Research

> Date: 2026-02-27
> Context: Evaluating cost-optimal alternatives to Anthropic API (Haiku 4.5) for dream pipeline extraction
> Hardware: M4 Mac Mini, 24GB unified memory, 120 GB/s bandwidth

## Problem Statement

The engram dream pipeline processes conversation archives through semantic extraction, consolidation, and graph building. The current implementation uses Haiku 4.5 via the Anthropic API at an estimated cost of **$90-120** for the full 738-conversation archive (530MB, ~3,500 API calls after chunking).

Three alternative approaches were evaluated:
1. **Local inference** via Ollama/MLX on the M4 Mac Mini
2. **OpenRouter** budget models
3. **Claude Code CLI** (`claude -p`) leveraging a Max subscription

## Workload Profile

| Parameter | Value |
|-----------|-------|
| Conversations | 738 |
| Archive size | 530 MB (JSONL) |
| Estimated API calls (after chunking) | ~3,000-3,500 |
| Input tokens per call | ~10-15K |
| Output tokens per call | ~4K max (typically ~700-1K) |
| Total input tokens | ~30-52M |
| Total output tokens | ~12-14M |
| Task type | Structured JSON extraction with fixed schema |

### Extraction Schema

Each call must produce an array of facts with:
- `type`: enum (preference, decision, pattern, fact, solution, convention)
- `content`: string
- `context`: string (optional)
- `importance`: float 0-1
- `source_exchange_indexes`: int array

## Option 1: Local Inference (Ollama)

### Hardware Constraints

The M4 base chip has **120 GB/s** unified memory bandwidth (vs M4 Pro's 273 GB/s). LLM inference is bandwidth-bound, making this the primary constraint:

- **8B models** (~5 GB Q4_K_M): 25-35 tok/sec — feasible
- **14B models** (~9-10 GB Q4_K_M): 9-12 tok/sec — marginal
- **32B+ models**: exceed safe memory budget with KV cache at 15K context

### Existing Infrastructure

Engram already has a local model route via the intelligence layer (`src/dream/intelligence.ts`):
- Ollama REST API integration with structured JSON schema mode
- Default model: `qwen2.5:7b`
- Automatic fallback to Anthropic API if Ollama unavailable

### Model Comparison

| Model | Size (Q4_K_M) | Speed (M4 24GB) | JSON Quality | Notes |
|-------|---------------|-----------------|--------------|-------|
| **Qwen3 8B** | 5.2 GB | 25-35 tok/sec | 90.96% (StructEval JSON) | Best in class for JSON; requires `/no_think` |
| Qwen2.5 14B | 9.0 GB | 9.6 tok/sec | Strong (medical NLP validated) | Too slow for batch |
| Qwen3 14B | 9.3 GB | 9-12 tok/sec | F1=0.95 (LLMStructBench) | Quality leader but too slow |
| Llama 3.1 8B | ~5 GB | 17-22 tok/sec | 78.82% (StructEval JSON) | Slower and less accurate than Qwen3 8B |
| Phi-4 14B | 9.1 GB | ~10 tok/sec | F1=0.94 (LLMStructBench) | No advantage over Qwen, same speed problem |
| Gemma 3 12B | ~8 GB | 12-15 tok/sec | Limited benchmark data | No clear advantage |
| DeepSeek-R1 7B | ~5 GB | ~25 tok/sec | Composite 0.67 | CoT overhead wasteful for extraction |

### Recommended: Qwen3 8B (Q4_K_M) via Ollama

- **Throughput**: ~30 tok/sec avg, ~22-23 hours for full batch
- **Memory**: ~8 GB total (weights + KV cache), leaves 16 GB headroom
- **Cost**: $0 (electricity only)
- **Quality**: Best JSON generation scores in sub-14B class
- **Configuration**:
  - Disable thinking: `/no_think` in system prompt
  - Use Ollama `format` parameter with full JSON schema (GBNF grammar enforcement)
  - Temperature 0, fixed seed
  - `OLLAMA_KV_CACHE_TYPE=q8_0` to reduce KV cache memory
  - Sequential calls (parallel degrades bandwidth on single-chip M4)

### MLX Alternative: Qwen3 8B 4-bit

- 20-30% faster (~35-45 tok/sec, ~17 hours total)
- Loses Ollama's grammar enforcement — needs `outlines` or `instructor` for schema validation
- Model: `mlx-community/Qwen3-8B-4bit` on HuggingFace
- Higher setup complexity, marginal time savings

## Option 2: OpenRouter

### Cost Comparison (3,500 calls x 15K input x 4K output)

| Rank | Model | Input $/MTok | Output $/MTok | Total Cost | JSON Schema Support |
|------|-------|-------------|--------------|------------|-------------------|
| 1 | Qwen3 30B-A3B | $0.08 | $0.28 | ~$8,120 | No (json_object only) |
| 2 | Llama 3.3 70B | $0.10 | $0.32 | ~$9,730 | Yes (Fireworks/DeepInfra) |
| 3 | Gemini 2.5 Flash Lite | $0.10 | $0.40 | ~$10,850 | Yes (native) |
| 4 | Gemini 2.0 Flash | $0.10 | $0.40 | ~$10,850 | Yes (deprecated Mar 2026) |
| 5 | DeepSeek V3 0324 | $0.19 | $0.87 | ~$22,155 | JSON mode + tools |
| -- | **Haiku 4.5 (baseline)** | $1.00 | $5.00 | ~$90-120 | Yes (tool_use) |

**Important correction**: The OpenRouter agent's total token math was off by 1000x (used MTok as raw tokens). The actual costs at realistic volumes (52.5M input, 14M output):

| Model | Actual Total Cost |
|-------|------------------|
| Qwen3 30B-A3B | ~$8.10 |
| Llama 3.3 70B | ~$9.73 |
| Gemini 2.5 Flash Lite | ~$10.85 |
| DeepSeek V3 0324 | ~$22.16 |
| **Haiku 4.5** | **~$90-120** |

### Recommended: Gemini 2.5 Flash Lite via OpenRouter

- Native JSON schema enforcement (first-class API feature)
- 1M token context window (no overflow risk)
- $10.85 total — 90% cheaper than Haiku
- Stable (GA, replaces deprecated 2.0 Flash)
- Prompt caching available at $0.01/MTok for system prompt (further savings)

### Runner-up: Llama 3.3 70B Instruct

- IFEval instruction-following score of 92.1 (beats GPT-4o)
- JSON schema support on Fireworks/DeepInfra providers
- $9.73 total

### Avoid: Qwen3 30B-A3B

- Cheapest but `structured_outputs: false` on DeepInfra
- 40K context window is tight for 15K inputs
- Known vLLM bug with `enable_thinking=False` producing invalid JSON

## Option 3: Claude Code CLI (`claude -p`)

### Capabilities

The CLI has everything needed for structured extraction:

| Feature | CLI Flag | Status |
|---------|----------|--------|
| Schema-validated JSON | `--output-format json --json-schema <schema>` | First-class support |
| System prompt control | `--system-prompt-file ./prompt.txt` | Full replacement of defaults |
| Model selection | `--model sonnet` | Works |
| Disable tools | `--tools ""` | Prevents agentic behavior |
| Stdin piping | `cat file \| claude -p` | Documented pattern |
| Session isolation | `--no-session-persistence` | Prevents disk I/O |

### Rate Limit Reality

This is the blocking constraint:

| Plan | Calls per 5-hour window (est.) | Days to complete 738 calls |
|------|-------------------------------|--------------------------|
| Max 5x ($100/mo) | ~45-75 | 5-8 days |
| Max 20x ($200/mo) | ~90-180 | 2-4 days |

Additional concerns:
- **Shared quota**: All Claude surfaces (web, desktop, CLI) share the same pool
- **Current limits in flux**: January 2026 limit tightening (GitHub #16157, #17084) made quotas unpredictable
- **Per-call overhead**: 1-3 sec Node.js startup + ~50K tokens config loading per subprocess (mitigable with `--tools "" --setting-sources user`)
- **No batch API semantics**: Must manage retries, backoff, checkpointing manually

### Verdict: Feasible but impractical for bulk processing

Best suited for small validation runs (test 10-20 conversations), not the full 738-item batch.

## Recommendation Matrix

| Criterion | Local (Qwen3 8B) | OpenRouter (Gemini Flash) | Claude -p |
|-----------|-------------------|--------------------------|-----------|
| **Cost** | $0 | ~$11 | $0 (subscription) |
| **Speed** | ~22 hours | ~2-3 hours | 2-8 days |
| **Quality** | Good (90.96% JSON) | Excellent (native schema) | Excellent (Claude) |
| **Reliability** | High (grammar enforced) | High (native schema) | Low (rate limits) |
| **Setup effort** | Low (Ollama built-in) | Medium (new provider) | Medium (wrapper script) |
| **Ongoing cost** | $0 | Per-run | $0 (subscription) |

### Primary Recommendation: Local Ollama (Qwen3 8B)

**Rationale**: Zero marginal cost, already integrated into engram's intelligence layer, reliable grammar-enforced JSON, and ~22 hours is acceptable for an overnight/weekend batch. The quality tradeoff vs cloud models is minimal for this extraction task where Ollama's schema enforcement handles structural correctness and the model only needs to get semantic content right.

### Secondary Recommendation: OpenRouter (Gemini 2.5 Flash Lite)

**When to use**: If local quality proves insufficient after testing, or if you need faster turnaround. At ~$11 total it's a reasonable fallback.

### Implementation Path

1. `ollama pull qwen3:8b` (~5 GB download)
2. Update engram config to set `dream.localModel: "qwen3:8b"`
3. Test on 5-10 conversations, validate extraction quality
4. If quality acceptable: run full dream cycle locally
5. If quality insufficient: add OpenRouter provider to intelligence layer

## Sources

### Benchmarks
- [LLMStructBench (Feb 2025)](https://arxiv.org/html/2602.14743v1)
- [StructEval (May 2025)](https://arxiv.org/html/2505.20139v1)
- [Qwen3 Technical Report](https://arxiv.org/pdf/2505.09388)
- [JSONSchemaBench](https://arxiv.org/abs/2501.10868)

### Hardware Benchmarks
- [Mac Studio vs Mac Mini M4 Local AI Benchmarks](https://malcolmlow.net/2025/11/13/mac-studio-vs-mac-mini-m4-local-ai-performance-benchmarks/)
- [MLX on M5 GPU (Apple Research)](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)
- [Qwen3/Gemma3 on Consumer Hardware](https://boredconsultant.com/2025/06/26/Qwen3-and-Gemma3-Performance-on-Consumer-Hardware/)
- [K/V Context Quantisation in Ollama](https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/)

### Pricing
- [OpenRouter Pricing](https://openrouter.ai/pricing)
- [OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

### Claude Code CLI
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Max Plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
- [GitHub #16157: Usage limit reports](https://github.com/anthropics/claude-code/issues/16157)

### Real-World Validation
- [Comprehensive testing of LLMs for extraction of structured data in pathology](https://www.nature.com/articles/s43856-025-00808-8)
- [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)
