# ADR-005: Unified LLM Client Factory

**Status**: Accepted
**Date**: 2026-03-09

## Context

Four modules independently create lazy Anthropic client singletons. `dream/intelligence.ts` implements a tiered cascade (Ollama → OpenRouter → Anthropic) but lives in the dream domain. Other modules bypass it. The system's commitment to LLM agnosticism (ADR-002) requires a unified abstraction.

## Decision

Promote the intelligence layer to `_core/llm/` as a unified LLM client factory. The factory **owns execution mechanics**:

- Provider abstraction (Ollama, OpenRouter, Anthropic, future providers)
- Tiered fallback cascade
- Retry with exponential backoff
- Availability checks
- Content sanitization
- `GenerationResult<T>` observability contract

**Callers own policy**:

- Tier strategy (which providers, which order) via `IntelligenceConfig`
- Prompt templates and content
- JSON schemas for structured output
- Model selection per task

## Consequences

- Single point of provider management — adding a new LLM provider is one change
- Domains must explicitly claim ownership of their prompts, schemas, and model policies in their L1 specs
- Dream's current `intelligence.ts` becomes the migration starting point
- `core/openrouter.ts` merges into `_core/llm/` as a provider implementation
- No domain directly imports Anthropic SDK or makes raw fetch calls to LLM APIs
