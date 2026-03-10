# LLM Providers

Provider-specific LLM client implementations. Each adapter conforms to the unified interface defined in [llm/](../).

## In Scope

- HTTP client wrappers for each LLM provider API
- Provider-specific request/response mapping
- Structured output (tool use) implementation per provider

## Out of Scope

- Provider selection logic (see [llm/index.ts](../index.ts))
- Prompt template content (see [prompts/](../../../../prompts/))

## Contains

- `anthropic.ts` — Anthropic API client (Claude models)
- `openrouter.ts` — OpenRouter API client (multi-model routing)
- `ollama.ts` — Ollama local LLM client (local inference)

## See Also

- [llm/](../) — Parent module with factory and selection logic
- [decisions/002-llm-agnostic.md](../../../../decisions/002-llm-agnostic.md) — LLM-agnostic design
