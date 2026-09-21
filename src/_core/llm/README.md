# LLM

Unified LLM client factory with tiered provider cascade. Abstracts provider differences behind a common interface for extraction, analysis, and generation tasks.

## In Scope

- Provider-agnostic LLM client interface
- Tiered provider cascade (default Ollama → OpenAI-compatible route → OpenRouter → Anthropic; order from `ENGRAM_LLM_PROVIDERS`)
- Structured output via tool use with `strict: true`
- Provider availability detection and graceful fallback

## Out of Scope

- Prompt template content (see [prompts/](../../../prompts/))
- Embedding models (see [_core/embeddings/](../embeddings/))

## Contains

- `index.ts` — LLM factory, provider selection, unified interface
- `types.ts` — LLM request/response type definitions
- `providers/` — Provider-specific implementations
  - `anthropic.ts` — Anthropic API client
  - `openai-compatible.ts` — Generic OpenAI chat-completions client + the `openai` tier (OpenAI, LiteLLM, self-hosted gateways; endpoint/model/key-env-var from `ENGRAM_OPENAI_*`, #45)
  - `openrouter.ts` — OpenRouter tier: one route constant (endpoint, attribution headers, temperature 0) served by the generic client's tier wrappers
  - `ollama.ts` — Ollama local LLM client

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/002-llm-agnostic.md](../../../decisions/002-llm-agnostic.md) — LLM-agnostic design
- [decisions/005-unified-llm-factory.md](../../../decisions/005-unified-llm-factory.md) — Factory pattern design
- [_core/](../) — Parent shared infrastructure
