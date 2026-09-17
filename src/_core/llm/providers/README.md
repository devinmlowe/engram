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
- `openai-compatible.ts` — Generic OpenAI chat-completions client (retry, sanitisation, tool-call/content parsing) and the `openai` tier configured from `ENGRAM_OPENAI_BASE_URL` / `ENGRAM_OPENAI_MODEL` / `ENGRAM_OPENAI_API_KEY_ENV` / `ENGRAM_OPENAI_TEMPERATURE` (#45)
- `openrouter.ts` — OpenRouter tier as a preconfigured route over the generic client (attribution headers, `temperature: 0`)
- `ollama.ts` — Ollama local LLM client (local inference)

## See Also

- [llm/](../) — Parent module with factory and selection logic
- [decisions/002-llm-agnostic.md](../../../../decisions/002-llm-agnostic.md) — LLM-agnostic design
