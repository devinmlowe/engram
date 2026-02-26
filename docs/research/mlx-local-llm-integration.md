# Apple MLX Framework Integration for Local LLM Inference

## Research Document for Engram Phase 5: Dream State Daemon

**Date**: 2026-02-26
**Domain**: Apple MLX, local LLM inference, structured output, Apple Silicon optimization
**Scope**: Integrating local LLMs via MLX for cost-free entity and fact extraction on an M4 Mac Mini

---

## Table of Contents

1. [MLX Ecosystem Overview](#1-mlx-ecosystem-overview)
2. [MLX-LM for Running Quantized LLMs](#2-mlx-lm-for-running-quantized-llms)
3. [Model Selection for Structured Extraction](#3-model-selection-for-structured-extraction)
4. [Node.js Integration Options](#4-nodejs-integration-options)
5. [Structured Output and JSON Mode](#5-structured-output-and-json-mode)
6. [Performance Benchmarks on Apple Silicon](#6-performance-benchmarks-on-apple-silicon)
7. [Comparison: MLX vs Ollama vs llama.cpp vs LM Studio](#7-comparison-mlx-vs-ollama-vs-llamacpp-vs-lm-studio)
8. [Model Loading and Warm-Start Strategies](#8-model-loading-and-warm-start-strategies)
9. [WWDC 2025: MLX Updates and Neural Accelerator Support](#9-wwdc-2025-mlx-updates-and-neural-accelerator-support)
10. [Key Takeaways for Engram](#10-key-takeaways-for-engram)

---

## 1. MLX Ecosystem Overview

### 1.1 What is MLX?

MLX is Apple's open-source machine learning framework purpose-built for Apple Silicon. Key characteristics:

- **Unified memory architecture**: CPU and GPU share the same memory, eliminating data transfer overhead between CPU and GPU. This is a fundamental advantage over NVIDIA-based systems where data must be copied between CPU RAM and GPU VRAM.
- **Metal acceleration**: Uses Apple's Metal API for GPU computation
- **Lazy evaluation**: Computations are only materialized when needed, reducing unnecessary work
- **Dynamic graph**: Computation graph is built on-the-fly (like PyTorch), not pre-compiled (like TensorFlow)
- **Python-first**: Primary API is Python; familiar NumPy-like interface

MLX is the de facto framework for running ML workloads on Apple Silicon. It powers LM Studio's MLX backend, Apple's own on-device intelligence features, and a growing ecosystem of developer tools.

(Source: [Explore Large Language Models on Apple Silicon with MLX - WWDC25](https://developer.apple.com/videos/play/wwdc2025/298/))

### 1.2 MLX Ecosystem Components

| Component | Purpose | Relevance to Engram |
|-----------|---------|---------------------|
| **mlx** | Core ML framework | Foundation library |
| **mlx-lm** | LLM inference and fine-tuning | Primary tool for running extraction models |
| **mlx-community** | Hugging Face org with pre-quantized models | Source of ready-to-use models |
| **mlx-lm.server** | OpenAI-compatible HTTP API server | Integration point for Node.js |
| **vllm-mlx** | High-throughput MLX inference server | Higher performance alternative |
| **mlx-openai-server** | FastAPI-based OpenAI-compatible server | Feature-rich alternative |

(Source: [MLX-LM GitHub](https://github.com/ml-explore/mlx-lm))

### 1.3 Current State (2025-2026)

The MLX ecosystem has matured significantly:

- **WWDC 2025**: Apple officially endorsed MLX for on-device LLM development, announced Neural Accelerator support on M5
- **Model coverage**: Thousands of pre-quantized models on Hugging Face's `mlx-community` organization
- **Performance**: Competitive with or exceeding Ollama and llama.cpp on Apple Silicon
- **Production use**: LM Studio, Aider, LibreChat, and others use MLX as their Apple Silicon backend
- **vllm-mlx**: Production-grade server with continuous batching, achieving 400+ tok/s

(Sources: [WWDC 2025 - Explore LLM on Apple Silicon with MLX](https://dev.to/arshtechpro/wwdc-2025-explore-llm-on-apple-silicon-with-mlx-1if7), [vllm-mlx GitHub](https://github.com/waybarrios/vllm-mlx))

---

## 2. MLX-LM for Running Quantized LLMs

### 2.1 Installation

```bash
pip install mlx-lm
```

### 2.2 Command-Line Usage

```bash
# Generate text
mlx_lm.generate --model mlx-community/Qwen2.5-7B-Instruct-4bit \
  --prompt "Extract entities from: The user prefers TypeScript over JavaScript" \
  --max-tokens 512

# Interactive chat
mlx_lm.chat --model mlx-community/Qwen2.5-7B-Instruct-4bit

# Run as OpenAI-compatible server
mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 8080

# Convert/quantize a model
mlx_lm.convert --hf-path Qwen/Qwen2.5-7B-Instruct -q --q-bits 4
```

### 2.3 Python API

```python
from mlx_lm import load, generate

model, tokenizer = load("mlx-community/Qwen2.5-7B-Instruct-4bit")

prompt = """Extract entities from the following text as JSON:
Text: "The user is building engram with TypeScript and better-sqlite3"
"""

response = generate(
    model, tokenizer,
    prompt=prompt,
    max_tokens=512,
    temp=0.0,  # Deterministic for extraction
)
print(response)
```

### 2.4 MLX-LM Server (OpenAI-Compatible API)

```bash
# Start server
mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 8080

# The server exposes:
# POST /v1/chat/completions   (Chat completions)
# POST /v1/completions        (Text completions)
```

Client usage from any language:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mlx-community/Qwen2.5-7B-Instruct-4bit",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

### 2.5 Key Features

- **Rotating KV cache**: `--max-kv-size N` limits memory usage by rotating the key-value cache. Trades off quality for reduced RAM on long contexts.
- **Prompt caching**: `mlx_lm.cache_prompt` pre-computes and saves KV cache for a given prompt prefix, enabling fast repeated queries with shared system prompts.
- **Streaming**: `stream_generate()` provides token-by-token streaming.
- **Quantization**: 4-bit and 8-bit quantization supported. 4-bit is the sweet spot for quality/performance on 8GB+ machines.

(Source: [MLX-LM GitHub](https://github.com/ml-explore/mlx-lm))

---

## 3. Model Selection for Structured Extraction

### 3.1 Candidate Models

For entity extraction and fact extraction from developer conversations, the model needs:
- Strong instruction following
- Reliable JSON output generation
- Good performance on structured data extraction
- Reasonable size for background processing (7-8B parameters at 4-bit quantization fits in ~5GB RAM)

| Model | Size | Quantized Size | Strengths | Weaknesses |
|-------|------|---------------|-----------|------------|
| **Qwen 2.5 7B Instruct** | 7B | ~4.5 GB (4-bit) | Best structured output, strong JSON, multilingual | Slightly slower generation |
| **Qwen 3 8B** | 8B | ~5 GB (4-bit) | Newest, MoE thinking mode, tool calling | May overthink for simple extraction |
| **Llama 3.1 8B Instruct** | 8B | ~5 GB (4-bit) | Fast inference, strong reasoning, robust | Slightly weaker on structured output |
| **Phi-3 Mini 3.8B** | 3.8B | ~2.5 GB (4-bit) | Very small, fast, good for simple tasks | Limited on complex extraction |
| **Gemma 2 9B** | 9B | ~5.5 GB (4-bit) | Strong general capabilities | Larger memory footprint |
| **Qwen 3 Coder 30B-A3B** | 30B MoE | ~18 GB (8-bit) | Only 3B active params, code-aware | Large download, more memory |

### 3.2 Recommendation: Qwen 2.5 7B Instruct

For Engram's extraction pipeline, **Qwen 2.5 7B Instruct** (4-bit quantized) is the recommended model:

1. **Structured output excellence**: "Qwen 2.5 is particularly impressive with JSON and complex data structures, making it an excellent choice for enterprise applications where clean, structured outputs matter."

2. **Instruction following**: Strong performance on following detailed extraction prompts with specific output schemas.

3. **Mathematical reasoning**: 83.1% on MATH benchmarks -- relevant for understanding technical specifications and version numbers in developer conversations.

4. **Memory footprint**: ~4.5 GB at 4-bit quantization fits comfortably on an M4 Mac Mini with 16+ GB unified memory, leaving ample room for the embedding model and SQLite operations.

5. **MLX availability**: Pre-quantized at `mlx-community/Qwen2.5-7B-Instruct-4bit`.

(Sources: [Llama 3.1 8B vs Qwen 2.5 7B Comparison](https://blog.galaxy.ai/compare/llama-3-1-8b-instruct-vs-qwen-2-5-7b-instruct), [Qwen 2.5 7B vs Llama 3.1 8B](https://rankllms.com/compare/llama-3-1-8b-vs-qwen-2-5-7b/))

### 3.3 Alternative: Qwen 3 8B

Qwen 3 8B is the newest option with notable improvements:

- **Thinking mode**: Can enable/disable chain-of-thought reasoning via `/think` and `/no_think` tags
- **Tool calling**: Native structured tool calling support
- **100+ tok/s on M4 Max**: Strong performance with MLX backend

For extraction tasks, the `/no_think` mode would be used to get direct JSON output without reasoning overhead. However, Qwen 2.5 7B has more established benchmarks for structured extraction specifically.

(Source: [Running Qwen3 on Your MacBook with MLX](https://news.ycombinator.com/item?id=43856489))

### 3.4 Fallback: Phi-3 Mini for Light Tasks

For simpler extraction tasks (e.g., extracting a list of entity names without complex resolution), Phi-3 Mini 3.8B provides:
- ~2.5 GB memory at 4-bit
- Very fast inference (higher tok/s due to smaller size)
- Good enough for simple structured output

A two-model strategy could use Phi-3 for initial entity name extraction and Qwen 2.5 for complex relationship extraction and entity resolution.

---

## 4. Node.js Integration Options

### 4.1 Option A: HTTP Server (Recommended)

Start an MLX-LM server and communicate via HTTP from Node.js. This is the cleanest integration pattern.

**Architecture:**

```
Dream Daemon (Node.js)  ---HTTP--->  MLX-LM Server (Python)
     |                                    |
     |--- Start as subprocess             |--- Loads model once
     |--- Send extraction requests        |--- Keeps model warm
     |--- Parse JSON responses            |--- OpenAI-compatible API
     |--- Kill on daemon exit             |
```

**Implementation:**

```typescript
// src/daemon/llm-client.ts
import { spawn, ChildProcess } from 'node:child_process';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export class LocalLLMClient {
  private serverProcess: ChildProcess | null = null;
  private baseUrl: string;
  private model: string;

  constructor(
    private port: number = 8080,
    model: string = 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.model = model;
  }

  async startServer(): Promise<void> {
    this.serverProcess = spawn('python', [
      '-m', 'mlx_lm.server',
      '--model', this.model,
      '--port', String(this.port),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server to be ready
    await this.waitForReady(30_000);
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/models`);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('MLX-LM server failed to start within timeout');
  }

  async chat(messages: ChatMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as LLMResponse;
    return data.choices[0].message.content;
  }

  async stop(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }
}
```

**Advantages:**
- Clean separation between Node.js and Python
- OpenAI-compatible API -- same client code works with Ollama, OpenAI, or any compatible provider
- Model stays loaded between requests within a single daemon run
- No native Python bindings needed in Node.js

**Disadvantages:**
- Requires Python environment with mlx-lm installed
- Server startup overhead (~5-15 seconds for model loading)
- Additional process to manage

### 4.2 Option B: Ollama Integration (Simpler)

Use Ollama as the LLM backend. Ollama wraps llama.cpp (and recently MLX) with a user-friendly API.

```typescript
// src/daemon/llm-client-ollama.ts

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl;
  }

  async chat(messages: ChatMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    format?: object;  // JSON schema for structured output
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0,
          num_predict: options?.maxTokens ?? 2048,
        },
        // Structured output via JSON schema
        format: options?.format,
      }),
    });

    const data = await res.json();
    return data.message.content;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

**Advantages:**
- Ollama may already be installed and running
- Simpler setup -- no Python environment management
- Built-in model management (`ollama pull`)
- Structured output support since v0.5 (JSON schema enforcement)
- Model stays warm between requests (configurable keep-alive)

**Disadvantages:**
- ~20% slower than native MLX for generation throughput
- Additional background daemon (Ollama) must be running
- Less control over quantization and model configuration

### 4.3 Option C: Child Process Spawning (Direct CLI)

For simple use cases, spawn `mlx_lm.generate` directly:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function generate(prompt: string): Promise<string> {
  const { stdout } = await execFileAsync('python', [
    '-m', 'mlx_lm.generate',
    '--model', 'mlx-community/Qwen2.5-7B-Instruct-4bit',
    '--prompt', prompt,
    '--max-tokens', '2048',
    '--temp', '0',
  ], { maxBuffer: 1024 * 1024 });

  return stdout.trim();
}
```

**Advantages:** No server to manage.
**Disadvantages:** Model loads fresh for every call (~5-15 seconds overhead). Completely impractical for batch processing.

### 4.4 Option D: Abstracted Provider Interface (Recommended Architecture)

Design the LLM client behind an interface that supports multiple backends:

```typescript
// src/daemon/llm-provider.ts

export interface LLMProvider {
  initialize(): Promise<void>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStructured<T>(messages: ChatMessage[], schema: ZodSchema<T>, options?: ChatOptions): Promise<T>;
  shutdown(): Promise<void>;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

// Factory function
export function createLLMProvider(config: DaemonConfig): LLMProvider {
  switch (config.llmProvider) {
    case 'mlx':
      return new MLXServerProvider(config.mlxModel, config.mlxPort);
    case 'ollama':
      return new OllamaProvider(config.ollamaUrl, config.ollamaModel);
    case 'anthropic':
      return new AnthropicProvider(config.anthropicModel);
    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
  }
}
```

This allows:
- Development/testing with Anthropic API
- Production use with local MLX or Ollama
- Fallback chains (try local first, fall back to API)

(Sources: [mlx-lm GitHub](https://github.com/ml-explore/mlx-lm), [Ollama Structured Outputs](https://ollama.com/blog/structured-outputs), [mlx-openai-server](https://github.com/cubist38/mlx-openai-server))

---

## 5. Structured Output and JSON Mode

### 5.1 Ollama Structured Output (Schema-Enforced)

Since Ollama v0.5, JSON schema enforcement is built in. Ollama generates a grammar from the JSON schema and constrains output via llama.cpp's grammar-guided generation.

```typescript
// Zod schema for entity extraction
import { z } from 'zod';

const EntitySchema = z.object({
  entities: z.array(z.object({
    name: z.string(),
    type: z.enum(['project', 'technology', 'tool', 'file', 'person', 'concept', 'configuration', 'command', 'error']),
    description: z.string(),
  })),
});

// Convert Zod to JSON Schema for Ollama
const jsonSchema = zodToJsonSchema(EntitySchema);

const response = await ollama.chat({
  model: 'qwen2.5:7b',
  messages: [
    { role: 'system', content: 'Extract entities from the conversation.' },
    { role: 'user', content: conversationText },
  ],
  format: jsonSchema,  // Ollama enforces this schema
  stream: false,
});

const entities = EntitySchema.parse(JSON.parse(response.message.content));
```

**How it works:** Ollama converts the JSON schema to a formal grammar (BNF/PEG) and feeds it to llama.cpp's grammar-constrained sampling. Every generated token is guaranteed to produce valid JSON matching the schema. The LLM cannot produce malformed output.

(Source: [Ollama Structured Outputs](https://ollama.com/blog/structured-outputs), [How Ollama Structured Outputs Work](https://blog.danielclayton.co.uk/posts/ollama-structured-outputs/))

### 5.2 MLX-LM Structured Output

MLX-LM's built-in server does not natively support JSON schema enforcement as of early 2026. Options:

1. **Prompt-based JSON**: Instruct the model to output JSON and parse the response. Works well with Qwen 2.5 which has strong JSON instruction following.

2. **mlx-openai-server**: A FastAPI-based server that wraps MLX-LM with additional features including structured output support.

3. **Outlines integration**: The Outlines library (by .txt) provides grammar-constrained generation for MLX. LM Studio uses Outlines internally for its structured output feature.

4. **Post-processing**: Parse the response, validate against schema, retry on failure. With `temperature=0`, responses are deterministic.

### 5.3 Practical Approach for Engram

Given the options, the recommended approach:

1. **Primary**: Use Ollama with JSON schema enforcement. This provides the most reliable structured output with minimal code.
2. **Fallback**: MLX-LM server with prompt-based JSON and Zod validation. Retry once on parse failure.

```typescript
async function extractEntities(
  provider: LLMProvider,
  conversation: string,
): Promise<ExtractedEntity[]> {
  const result = await provider.chatStructured(
    [
      { role: 'system', content: ENTITY_EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: conversation },
    ],
    EntitySchema,
    { temperature: 0, maxTokens: 2048 },
  );

  return result.entities;
}
```

The `chatStructured` method handles:
- Schema enforcement (Ollama: format parameter; MLX: prompt + validation)
- Parse validation via Zod
- Retry on failure (once, with slightly adjusted prompt)

(Sources: [Ollama Structured Outputs Docs](https://docs.ollama.com/capabilities/structured-outputs), [llm-structured-output PyPI](https://pypi.org/project/llm-structured-output/))

---

## 6. Performance Benchmarks on Apple Silicon

### 6.1 Framework Comparison

From the comparative study "Production-Grade Local LLM Inference on Apple Silicon" (November 2025):

| Framework | Throughput (tok/s) | TTFT | Best For |
|-----------|-------------------|------|----------|
| **MLX** | ~230 | Moderate | Highest sustained throughput |
| **MLC-LLM** | ~190 | Lowest | Best time-to-first-token |
| **llama.cpp** | Competitive | Moderate | Single-stream, lightweight |
| **Ollama** | 20-40 | Higher | Developer ergonomics |
| **vllm-mlx** | 400+ | Low | Production server, continuous batching |

**Key insight:** MLX achieves approximately 230 tok/s sustained throughput, which is 5-10x faster than Ollama. For batch processing hundreds of conversations, this difference is significant.

(Source: [Production-Grade Local LLM Inference on Apple Silicon](https://arxiv.org/abs/2511.05502))

### 6.2 M4 Mac Mini Specific Performance

The M4 Mac Mini has 120 GB/s memory bandwidth. LLM inference is memory-bandwidth-bound for token generation:

| Model | Quantization | Estimated tok/s (M4) | Memory Usage |
|-------|-------------|----------------------|--------------|
| Qwen 2.5 7B | 4-bit | ~50-65 tok/s | ~4.5 GB |
| Llama 3.1 8B | 4-bit | ~45-60 tok/s | ~5 GB |
| Phi-3 Mini 3.8B | 4-bit | ~90-120 tok/s | ~2.5 GB |
| Qwen 3 Coder 30B-A3B | 4-bit | ~60-80 tok/s (3B active) | ~18 GB |

For the base M4 (not Max or Pro), the 120 GB/s bandwidth limits token generation. The M4 Pro (273 GB/s) and M4 Max (546 GB/s) would be significantly faster.

**For Engram's batch processing:** Even at 50 tok/s, processing a 2000-token conversation and generating a 500-token extraction response takes about 10 seconds per conversation. For 100 conversations per day, that is approximately 17 minutes of total processing time -- well within the budget of a background daemon.

(Sources: [Exploring LLMs with MLX on M5](https://machinelearning.apple.com/research/exploring-llms-mlx-m5), [Local AI with MLX on Mac](https://www.markus-schall.de/en/2025/09/mlx-on-apple-silicon-as-local-ki-compared-with-ollama-co/))

### 6.3 Memory Bandwidth is Everything

> "The first token is compute-bound, but all subsequent tokens are memory-bound. This means for interactive use -- where you care most about token generation speed -- bandwidth is nearly everything."

This is why:
- MLX outperforms Ollama: MLX is optimized specifically for Metal and Apple's unified memory architecture
- 4-bit quantization helps: Halving the model size effectively doubles the bandwidth available per parameter
- Larger models need more bandwidth: 7B-8B models are the sweet spot for M4 base

### 6.4 Time-to-First-Token (TTFT)

For batch extraction, TTFT matters less than throughput (we are not interactive). However:
- MLX prompt caching can significantly reduce TTFT for repeated system prompts
- Caching the entity extraction system prompt prefix saves recomputing it for every conversation

---

## 7. Comparison: MLX vs Ollama vs llama.cpp vs LM Studio

### 7.1 Detailed Comparison

| Feature | MLX (mlx-lm) | Ollama | llama.cpp | LM Studio |
|---------|-------------|--------|-----------|-----------|
| **Performance** | Fastest on Apple Silicon | 20-40 tok/s (uses llama.cpp) | Fast, close to MLX | Uses MLX backend |
| **Structured output** | Prompt-based (no grammar) | JSON schema grammar | Grammar-based | Outlines-based |
| **API** | OpenAI-compatible | OpenAI-compatible + native | Server mode (OpenAI) | OpenAI-compatible |
| **Model management** | Manual (Hugging Face) | Built-in pull/manage | Manual (GGUF files) | GUI + CLI |
| **Memory management** | Configurable KV cache | Keep-alive timer, auto-unload | Manual configuration | Automatic |
| **Setup complexity** | Python + pip | Single binary | Compile or download | GUI installer |
| **macOS integration** | Native Metal | Via llama.cpp Metal | Metal support | Native Metal (MLX) |
| **Prompt caching** | Yes (cache_prompt) | Limited | Yes | Yes |
| **Node.js SDK** | HTTP only | ollama-js npm package | HTTP only | HTTP only |

### 7.2 Production Daemon Comparison

For Engram's daemon use case (batch processing, no interactive use):

| Criterion | MLX | Ollama | Winner |
|-----------|-----|--------|--------|
| Raw throughput | ~230 tok/s | ~30 tok/s | MLX |
| Structured output reliability | Prompt-based | Grammar-enforced | Ollama |
| Setup simplicity | Requires Python | Single binary | Ollama |
| Already running on system | Unlikely | Likely (common dev tool) | Ollama |
| Memory efficiency | Best on Apple Silicon | Good | MLX |
| Long-running stability | Tested | Production-grade | Tie |
| Node.js integration | HTTP client | ollama-js library | Ollama |
| Model warm start | Server must be running | Configurable keep-alive | Tie |

### 7.3 Recommendation

**Use Ollama as the default provider** with MLX as an optional high-performance alternative:

1. **Ollama first**: Most users will have Ollama installed. Grammar-enforced structured output eliminates JSON parse errors. The ollama-js SDK provides a clean TypeScript API.

2. **MLX-LM for power users**: When throughput matters (processing thousands of conversations), MLX-LM's 5-10x speed advantage is significant. Worth the Python dependency.

3. **Anthropic API as fallback**: For users without local LLM setup, fall back to Claude Haiku for extraction. This costs money but requires zero local setup.

(Sources: [MLX vs Ollama Comparison](https://www.markus-schall.de/en/2025/09/mlx-on-apple-silicon-as-local-ki-compared-with-ollama-co/), [Ollama FAQ](https://docs.ollama.com/faq), [Best Local LLMs for Mac 2026](https://www.insiderllm.com/guides/best-local-llms-mac-2026/))

---

## 8. Model Loading and Warm-Start Strategies

### 8.1 The Cold Start Problem

Loading a 4-bit 7B model from disk takes 5-15 seconds (reading ~4.5 GB from SSD + model initialization). For a batch daemon processing many conversations, this should happen once per run, not per request.

### 8.2 MLX-LM Server (Keep Warm During Run)

Start the server at the beginning of the daemon run, process all conversations, then shut down:

```typescript
// src/daemon/pipeline.ts
export class DreamPipeline {
  private llm: LocalLLMClient;

  async run(): Promise<void> {
    // Start LLM server (model loads once)
    await this.llm.startServer();

    try {
      // Process all pending conversations
      const pending = await this.getPendingConversations();
      for (const conv of pending) {
        await this.processConversation(conv);
        await this.checkpoint();
      }
    } finally {
      // Shut down LLM server (free memory)
      await this.llm.stop();
    }
  }
}
```

### 8.3 Ollama Keep-Alive Configuration

Ollama unloads models after 5 minutes of inactivity by default. For batch processing:

```bash
# Keep model loaded for 1 hour
OLLAMA_KEEP_ALIVE=1h ollama serve

# Keep model loaded indefinitely
OLLAMA_KEEP_ALIVE=-1 ollama serve
```

Or per-request:

```typescript
const response = await ollama.chat({
  model: 'qwen2.5:7b',
  messages,
  keep_alive: '30m',  // Keep loaded for 30 minutes after this request
});
```

For the daemon: send `keep_alive: '30m'` with each request during batch processing, ensuring the model stays warm between conversation extractions.

(Source: [Ollama Keep Models Loaded](https://blog.nashcom.de/nashcomblog.nsf/dx/ollama-keep-models-loaded-for-longer-than-5-minutes-idle.htm))

### 8.4 Prompt Caching

Both MLX and Ollama support prompt caching, which is critical for extraction workloads where the system prompt is the same for every request:

**MLX prompt caching:**
```bash
# Pre-cache the system prompt
mlx_lm.cache_prompt --model mlx-community/Qwen2.5-7B-Instruct-4bit \
  --prompt "$(cat entity-extraction-system-prompt.txt)" \
  --output entity-prompt-cache.safetensors
```

Then, each extraction request reuses the cached prompt prefix, skipping recomputation of the system prompt tokens.

**Ollama implicit caching:** Ollama caches the KV state of the most recent prompt. If consecutive requests share the same prefix (system prompt), Ollama reuses the cached state. No explicit configuration needed.

### 8.5 Memory Budget Planning

For an M4 Mac Mini with 16 GB unified memory:

| Component | Memory | Notes |
|-----------|--------|-------|
| macOS + apps | ~6 GB | Baseline usage |
| Qwen 2.5 7B (4-bit) | ~4.5 GB | Model weights |
| KV Cache (8K context) | ~0.5 GB | Grows with context length |
| Node.js daemon | ~0.2 GB | Lightweight process |
| SQLite + embeddings | ~0.1 GB | Database operations |
| **Total** | **~11.3 GB** | Leaves ~4.7 GB headroom |

For 24 GB or 32 GB configurations, there is ample headroom to run larger models or keep embedding models loaded simultaneously.

---

## 9. WWDC 2025: MLX Updates and Neural Accelerator Support

### 9.1 Neural Accelerator Support (M5)

At WWDC 2025, Apple announced MLX support for the Neural Accelerators (ANE) in the M5 chip. Key findings:

- **Up to 4x speedup** compared to M4 baseline for time-to-first-token
- Neural Accelerators shine with "ML workloads involving large matrix multiplications"
- The M5 provides 19-27% performance boost over M4 due to greater memory bandwidth (153 GB/s vs 120 GB/s)

While Engram targets M4, these developments indicate Apple is investing heavily in on-device LLM inference, making MLX a safe long-term bet.

(Source: [Exploring LLMs with MLX and the Neural Accelerators in the M5 GPU](https://machinelearning.apple.com/research/exploring-llms-mlx-m5))

### 9.2 vllm-mlx: Production Server

A significant 2025 development is **vllm-mlx** -- a production-grade inference server for Apple Silicon:

- **OpenAI and Anthropic compatible API**
- **Continuous batching**: Multiple requests processed simultaneously
- **400+ tokens/second** on M4 Max
- **MCP tool calling support**: Relevant for future Engram integrations
- **Multimodal support**: Handles vision-language models

For Engram, vllm-mlx is overkill (we do not need batching or multimodal), but it represents the maturity of the MLX ecosystem for production use.

(Source: [vllm-mlx GitHub](https://github.com/waybarrios/vllm-mlx))

### 9.3 Docker Model Runner with MLX

Docker has added MLX support via Docker Model Runner, enabling containerized LLM inference on macOS. This may be relevant for future Engram distribution but adds container overhead that is unnecessary for a personal tool.

(Source: [Docker Model Runner Adds vLLM Support on macOS](https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/))

---

## 10. Key Takeaways for Engram

### Architecture Decision: Ollama with MLX Fallback

```
User Config (engram.toml):
  [dream.llm]
  provider = "ollama"           # or "mlx" or "anthropic"
  model = "qwen2.5:7b"          # Ollama model name
  # model = "mlx-community/Qwen2.5-7B-Instruct-4bit"  # MLX model
  temperature = 0
  max_tokens = 2048
```

### Provider Priority

1. **Ollama** (default): Simplest setup, grammar-enforced JSON, widely installed
2. **MLX-LM**: For users who want maximum throughput and have Python configured
3. **Anthropic API**: Fallback for users without local LLM setup

### Implementation Plan

1. Define `LLMProvider` interface with `chat()` and `chatStructured()` methods
2. Implement `OllamaProvider` using `ollama-js` with JSON schema format parameter
3. Implement `MLXProvider` using HTTP client against mlx-lm.server
4. Implement `AnthropicProvider` using existing `@anthropic-ai/sdk` (already a dependency)
5. Daemon startup: detect available provider, start if needed, verify model is available
6. Daemon shutdown: release model resources (Ollama: no action needed; MLX: stop server subprocess)

### Performance Budget

For the M4 Mac Mini processing 100 conversations/day:

| Phase | Time per Conversation | Total (100 convs) |
|-------|----------------------|-------------------|
| Fact extraction (Ollama, ~30 tok/s) | ~20s | ~33 min |
| Entity extraction (Ollama, ~30 tok/s) | ~15s | ~25 min |
| Relationship extraction (Ollama, ~30 tok/s) | ~15s | ~25 min |
| Entity resolution (non-LLM) | ~2s | ~3 min |
| **Total** | | **~86 min** |

With MLX (~150 tok/s effective):

| Phase | Time per Conversation | Total (100 convs) |
|-------|----------------------|-------------------|
| All extraction phases | ~10s | ~17 min |
| Entity resolution | ~2s | ~3 min |
| **Total** | | **~20 min** |

Both are well within the budget of a background daemon running during off-hours.

### Model Selection Summary

- **Primary**: `qwen2.5:7b` via Ollama (or `mlx-community/Qwen2.5-7B-Instruct-4bit` via MLX)
- **Why Qwen 2.5**: Best structured output, strong JSON compliance, proven extraction quality
- **Size**: ~4.5 GB at 4-bit quantization
- **Alternative**: Qwen 3 8B when its structured output reliability is better benchmarked

---

## Sources

### Apple / MLX
- [Explore Large Language Models on Apple Silicon with MLX - WWDC25](https://developer.apple.com/videos/play/wwdc2025/298/)
- [WWDC 2025 - Explore LLM on Apple Silicon with MLX](https://dev.to/arshtechpro/wwdc-2025-explore-llm-on-apple-silicon-with-mlx-1if7)
- [Exploring LLMs with MLX and the Neural Accelerators in the M5 GPU](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)
- [MLX-LM GitHub](https://github.com/ml-explore/mlx-lm)

### Performance Research
- [Production-Grade Local LLM Inference on Apple Silicon (arxiv)](https://arxiv.org/abs/2511.05502)
- [Local AI with MLX on Mac](https://www.markus-schall.de/en/2025/09/mlx-on-apple-silicon-as-local-ki-compared-with-ollama-co/)
- [Benchmarking Apple's MLX vs llama.cpp](https://medium.com/@andreask_75652/benchmarking-apples-mlx-vs-llama-cpp-bbbebdc18416)
- [Best Local LLMs for Mac in 2026](https://www.insiderllm.com/guides/best-local-llms-mac-2026/)
- [Ollama vs LM Studio Comparison Guide 2026](https://globaltill.com/ollama-vs-lm-studio/)

### Model Comparisons
- [Llama 3.1 8B vs Qwen 2.5 7B Comparison](https://blog.galaxy.ai/compare/llama-3-1-8b-instruct-vs-qwen-2-5-7b-instruct)
- [Qwen3 Technical Report](https://arxiv.org/pdf/2505.09388)
- [Running Qwen3 on Your MacBook with MLX](https://news.ycombinator.com/item?id=43856489)

### Integration
- [Ollama Structured Outputs Blog](https://ollama.com/blog/structured-outputs)
- [Ollama Structured Outputs Docs](https://docs.ollama.com/capabilities/structured-outputs)
- [How Ollama Structured Outputs Work](https://blog.danielclayton.co.uk/posts/ollama-structured-outputs/)
- [Ollama FAQ (Keep-Alive)](https://docs.ollama.com/faq)
- [Ollama Keep Models Loaded](https://blog.nashcom.de/nashcomblog.nsf/dx/ollama-keep-models-loaded-for-longer-than-5-minutes-idle.htm)
- [mlx-openai-server GitHub](https://github.com/cubist38/mlx-openai-server)
- [vllm-mlx GitHub](https://github.com/waybarrios/vllm-mlx)
- [Run LLMs on macOS using llm-mlx](https://simonwillison.net/2025/Feb/15/llm-mlx/)

### LM Studio
- [LM Studio 0.3.4 Ships with Apple MLX](https://lmstudio.ai/blog/lmstudio-v0.3.4)

### Docker / Infrastructure
- [Docker Model Runner Adds vLLM Support on macOS](https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/)
