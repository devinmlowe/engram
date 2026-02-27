# Dream Cycle Model Selection Research

> Date: 2026-02-27 (updated)
> Context: Evaluating cost-optimal alternatives to Anthropic API (Haiku 4.5) for dream pipeline extraction
> Hardware: M4 Mac Mini, 24GB unified memory, 120 GB/s bandwidth

## Problem Statement

The engram dream pipeline processes conversation archives through semantic extraction, consolidation, and graph building. The current implementation uses Haiku 4.5 via the Anthropic API at an estimated cost of **$90-120** for the full 738-conversation archive (530MB, ~3,500 API calls after chunking).

Four approaches were evaluated:
1. **MLX local inference** (primary recommendation)
2. **Ollama local inference** (zero-config fallback)
3. **OpenRouter** budget models
4. **Claude Code CLI** (`claude -p`) leveraging a Max subscription

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

## Hardware Constraints

The M4 base chip has **120 GB/s** unified memory bandwidth (vs M4 Pro's 273 GB/s). LLM inference is bandwidth-bound, making this the primary constraint:

- **8B models** (~5 GB Q4): 25-35 tok/sec (Ollama), 60-80 tok/sec (MLX)
- **14B models** (~9-10 GB Q4): 9-12 tok/sec — too slow for batch processing
- **32B+ models**: exceed safe memory budget with KV cache at 15K context

### Model Selection: Qwen3 8B

Across all evaluated models, **Qwen3 8B** is the clear winner for this workload:

| Model | Size (Q4) | JSON Quality | Notes |
|-------|-----------|-------------|-------|
| **Qwen3 8B** | 5.2 GB | **90.96%** (StructEval JSON) | Best in class; requires `/no_think` |
| Qwen2.5 14B | 9.0 GB | Strong | Too slow at 9.6 tok/sec |
| Qwen3 14B | 9.3 GB | F1=0.95 (LLMStructBench) | Quality leader but too slow |
| Llama 3.1 8B | ~5 GB | 78.82% (StructEval JSON) | Slower and less accurate |
| Phi-4 14B | 9.1 GB | F1=0.94 (LLMStructBench) | No advantage, same speed problem |
| DeepSeek-R1 7B | ~5 GB | Composite 0.67 | CoT overhead wasteful for extraction |

Key finding from StructEval: Qwen3-8B matches Qwen2.5-14B on most general benchmarks and scores highest in its size class on JSON generation tasks.

## Option 1: MLX Local Inference (Primary Recommendation)

### Why MLX Over Ollama

MLX is Apple's purpose-built array framework for Apple Silicon with Metal-native kernels. Independent benchmarks consistently show a **30-56% throughput advantage** over Ollama (which uses llama.cpp's cross-platform Metal backend):

| Framework | Qwen 8B 4-bit (est. M4 24GB) | Source |
|-----------|-------------------------------|--------|
| **MLX** | **60-80 tok/sec** | Benchmarked 56% faster on M1 Max (Ajit Singh); confirmed by arXiv 2511.05502 |
| Ollama | 40-55 tok/sec | llama.cpp Metal path |

From the academic comparative study (arXiv 2511.05502):
> "MLX achieves the highest sustained generation throughput. Ollama emphasizes developer ergonomics but lags in throughput and TTFT."

Additional MLX advantages:
- **In-process execution**: No HTTP server, no REST API overhead per call. Model weights share unified memory with the application.
- **Memory efficiency**: No separate server process, no inter-process communication overhead, no GGUF translation layer.
- **Existing ecosystem**: MLX models already cached on this machine (Kokoro, Chatterbox, Whisper from Nova voice project).

### Structured Output: Outlines + mlx-lm

The main concern with MLX was the lack of built-in grammar-enforced JSON output (unlike Ollama's GBNF). This is solved by **Outlines**, which has official, documented mlx-lm integration.

Install: `pip install "outlines[mlxlm]"`

```python
from outlines import models, generate
from pydantic import BaseModel

class ExtractedFact(BaseModel):
    type: Literal["preference", "decision", "pattern", "fact", "solution", "convention"]
    content: str
    context: str | None
    importance: float
    source_exchange_indexes: list[int]

class ExtractionResult(BaseModel):
    facts: list[ExtractedFact]

model = models.mlxlm("mlx-community/Qwen3-8B-4bit")
generator = generate.json(model, ExtractionResult)
result = generator(prompt)
```

Outlines converts the JSON schema to a state machine and applies logit-level enforcement at each generation step — same mechanism as Ollama's GBNF grammars. This is hard enforcement, not prompt-based suggestion.

**Known limitation**: Constrained generation does not work with batch mode (single-request and streaming are supported). This is fine for engram's sequential extraction pipeline.

### Integration Paths (Node.js)

Engram is a Node.js project, so MLX (Python) needs a bridge. Three options:

| Path | Performance | Setup | Schema Enforcement |
|------|------------|-------|-------------------|
| **Toolio server** | High | Medium | Native `response_format` support |
| **Python sidecar** | Highest (in-process) | Medium | Outlines (logit-level) |
| **mlx-lm server** | High | Low | None (prompt-based only) |

**Recommended: Toolio** — An OpenAI-compatible HTTP server built specifically for MLX models with "schema-steered structured output (3SO)." It accepts `response_format` in the request body, making it compatible with engram's existing REST API code paths with minimal changes.

Alternative: **Python sidecar script** using Outlines + mlx-lm for maximum performance (eliminates HTTP overhead), invoked via `child_process.spawn()` from Node.js.

### Batch Estimates

| Metric | Value |
|--------|-------|
| Model | `mlx-community/Qwen3-8B-4bit` (~5 GB) |
| Memory footprint | ~8 GB (weights + KV cache), leaves 16 GB headroom |
| Throughput | ~60-80 tok/sec generation |
| Est. batch time | **~14-15 hours** (3,500 calls, ~700 output tokens avg) |
| Cost | $0 (electricity only) |

### Configuration Notes

- Disable Qwen3 thinking mode: `/no_think` in system prompt (thinking tokens waste output budget)
- Temperature 0, fixed seed for reproducibility
- Sequential calls (parallel degrades bandwidth on single-chip M4)
- Model: `mlx-community/Qwen3-8B-4bit` on HuggingFace (officially published)

## Option 2: Ollama Local Inference (Zero-Config Fallback)

### Existing Infrastructure

Engram already has a local model route via the intelligence layer (`src/dream/intelligence.ts`):
- Ollama REST API integration with structured JSON schema mode
- Default model: `qwen2.5:7b`
- Automatic fallback to Anthropic API if Ollama unavailable

### Why Keep Ollama as a Fallback

- **Zero code changes**: Update config `dream.localModel: "qwen3:8b"` and run
- **Built-in grammar enforcement**: Ollama's `format` parameter with JSON schema uses GBNF grammars — no additional dependencies
- **Battle-tested**: More community validation for structured extraction across model families
- **Auto model management**: Ollama handles model loading/unloading automatically

### Batch Estimates

| Metric | Value |
|--------|-------|
| Model | `qwen3:8b` (Q4_K_M, ~5.2 GB) |
| Memory footprint | ~8 GB total |
| Throughput | ~25-35 tok/sec generation |
| Est. batch time | **~22-23 hours** |
| Cost | $0 |

### Configuration

- Disable thinking: `/no_think` in system prompt
- Use Ollama `format` parameter with full JSON schema
- Temperature 0, fixed seed
- `OLLAMA_KV_CACHE_TYPE=q8_0` to reduce KV cache memory

## Option 3: OpenRouter

### Cost Comparison (3,500 calls x 15K input x 4K output)

At realistic volumes (52.5M input tokens, 14M output tokens):

| Model | Input $/MTok | Output $/MTok | Total Cost | JSON Schema Support |
|-------|-------------|--------------|------------|-------------------|
| Qwen3 30B-A3B | $0.08 | $0.28 | ~$8 | No (json_object only) |
| Llama 3.3 70B | $0.10 | $0.32 | ~$10 | Yes (Fireworks/DeepInfra) |
| **Gemini 2.5 Flash Lite** | $0.10 | $0.40 | **~$11** | Yes (native) |
| DeepSeek V3 0324 | $0.19 | $0.87 | ~$22 | JSON mode + tools |
| Haiku 4.5 (baseline) | $1.00 | $5.00 | ~$90-120 | Yes (tool_use) |

### Recommended: Gemini 2.5 Flash Lite

- Native JSON schema enforcement (first-class API feature)
- 1M token context window (no overflow risk)
- ~$11 total — 90% cheaper than Haiku
- Stable (GA, replaces deprecated 2.0 Flash)
- Prompt caching available at $0.01/MTok for system prompt (further savings)

### Runner-up: Llama 3.3 70B Instruct

- IFEval instruction-following score of 92.1 (beats GPT-4o)
- JSON schema support on Fireworks/DeepInfra providers
- ~$10 total

### Avoid: Qwen3 30B-A3B

- Cheapest but `structured_outputs: false` on DeepInfra
- 40K context window is tight for 15K inputs
- Known vLLM bug with `enable_thinking=False` producing invalid JSON

## Option 4: Claude Code CLI (`claude -p`)

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

### Rate Limit Reality (Blocking Constraint)

| Plan | Calls per 5-hour window (est.) | Days to complete 738 calls |
|------|-------------------------------|--------------------------|
| Max 5x ($100/mo) | ~45-75 | 5-8 days |
| Max 20x ($200/mo) | ~90-180 | 2-4 days |

Additional concerns:
- **Shared quota**: All Claude surfaces (web, desktop, CLI) share the same pool
- **Current limits in flux**: January 2026 limit tightening (GitHub #16157, #17084)
- **Per-call overhead**: 1-3 sec Node.js startup + config loading per subprocess
- **No batch API semantics**: Must manage retries, backoff, checkpointing manually

### Verdict: Feasible but impractical for bulk processing

Best suited for small validation runs (10-20 conversations), not the full 738-item batch.

## Recommendation Matrix

| Criterion | MLX (Qwen3 8B) | Ollama (Qwen3 8B) | OpenRouter (Gemini Flash) | Claude -p |
|-----------|-----------------|-------------------|--------------------------|-----------|
| **Cost** | $0 | $0 | ~$11 | $0 (subscription) |
| **Speed** | **~14-15 hours** | ~22 hours | ~2-3 hours | 2-8 days |
| **Quality** | Good (90.96% JSON) | Good (90.96% JSON) | Excellent (native schema) | Excellent (Claude) |
| **Reliability** | High (Outlines enforced) | High (GBNF enforced) | High (native schema) | Low (rate limits) |
| **Setup effort** | Medium (install mlx-lm + Outlines/Toolio) | Low (zero code changes) | Medium (new provider) | Medium (wrapper script) |
| **Ongoing cost** | $0 | $0 | Per-run | $0 (subscription) |

## Final Recommendations

### Primary: MLX + Qwen3 8B (via Toolio or Outlines)

**Rationale**: 30-56% faster than Ollama on the same hardware, zero marginal cost, hard JSON schema enforcement via Outlines, and leverages Apple Silicon's unified memory architecture as designed. The ~14-15 hour batch time makes overnight processing comfortable with margin.

**Implementation path**:
1. `pip install mlx-lm "outlines[mlxlm]"` (or install Toolio for HTTP server path)
2. Download model: `mlx-community/Qwen3-8B-4bit` (~5 GB)
3. Add MLX provider to engram's intelligence layer (Toolio: point REST calls at `localhost:8080`; or Python sidecar: invoke via `child_process.spawn()`)
4. Test on 5-10 conversations, validate extraction quality
5. Run full dream cycle

### Fallback: Ollama + Qwen3 8B (zero-config)

**When to use**: If MLX setup proves problematic or if you want the fastest path to a working dream cycle without any code changes.

1. `ollama pull qwen3:8b` (~5 GB download)
2. Update engram config: `dream.localModel: "qwen3:8b"`
3. Run dream cycle — existing intelligence layer handles everything

### Cloud Fallback: OpenRouter + Gemini 2.5 Flash Lite

**When to use**: If local model quality proves insufficient after testing, or if you need faster turnaround (~2-3 hours). At ~$11 total, this is a reasonable fallback that doesn't require repeated spending.

## Sources

### MLX Performance
- [MLX vs Ollama inference speed comparison (Ajit Singh)](https://singhajit.com/llm-inference-speed-comparison/)
- [Production-Grade Local LLM Inference on Apple Silicon (arXiv 2511.05502)](https://arxiv.org/abs/2511.05502)
- [MLX on M5 GPU (Apple Research)](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)
- [mlx-lm GitHub](https://github.com/ml-explore/mlx-lm)
- [mlx-lm SERVER.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)

### MLX Structured Output
- [Outlines mlx-lm integration](https://dottxt-ai.github.io/outlines/latest/features/models/mlxlm/)
- [Toolio: MLX server with schema-steered structured output](https://github.com/OoriData/Toolio)
- [FastMLX](https://blaizzy.github.io/fastmlx/)
- [llm-structured-output (PyPI)](https://pypi.org/project/llm-structured-output/)

### Model Benchmarks
- [LLMStructBench (Feb 2025)](https://arxiv.org/html/2602.14743v1)
- [StructEval (May 2025)](https://arxiv.org/html/2505.20139v1)
- [Qwen3 Technical Report](https://arxiv.org/pdf/2505.09388)
- [JSONSchemaBench](https://arxiv.org/abs/2501.10868)

### Hardware Benchmarks
- [Mac Studio vs Mac Mini M4 Local AI Benchmarks](https://malcolmlow.net/2025/11/13/mac-studio-vs-mac-mini-m4-local-ai-performance-benchmarks/)
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
- [Qwen MLX-LM docs](https://qwen.readthedocs.io/en/latest/run_locally/mlx-lm.html)
