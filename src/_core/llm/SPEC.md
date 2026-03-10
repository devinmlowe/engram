---
module: llm
level: L2
derives-from: ../SPEC.md
status: draft
verified-by: ../../../tests/core/llm.test.ts
decision-log:
  - ../../../decisions/005-unified-llm-factory.md
  - ../../../decisions/002-llm-agnostic.md
---

# LLM

Unified LLM client factory with tiered provider cascade. Owns execution mechanics (provider abstraction, retry, sanitization); callers own policy (tier strategy, prompts, schemas, model selection).

## Requirements

- **REQ-1**: The module shall support three provider tiers: Ollama (local), OpenRouter (cloud), Anthropic API. *(traces to L0 INV-3, INV-4)*
- **REQ-2**: The module shall execute a caller-configured cascade: try providers in order, fall through on failure. *(traces to ADR-005)*
- **REQ-3**: The module shall provide `generate()` (free text) and `generateStructured<T>()` (JSON via tool_use/schema). *(traces to L0 REQ-2)*
- **REQ-4**: The module shall retry transient failures with exponential backoff and jitter. *(traces to ADR-005)*
- **REQ-5**: The module shall sanitize content (control characters, code fences) before sending to providers. *(traces to ADR-005)*
- **REQ-6**: The module shall check provider availability before attempting calls (Ollama ping, API key checks). *(traces to L0 PRE-4)*

## Interface Contract

### Preconditions

- **PRE-1**: At least one provider shall be configured and reachable.
- **PRE-2**: Caller shall provide `IntelligenceConfig` specifying tier preferences and model selections.

### Postconditions

- **POST-1**: Successful calls shall return `GenerationResult<T>` with source provider, model used, and duration.
- **POST-2**: Permanent errors (401, 400) shall throw immediately without retry.
- **POST-3**: Transient errors shall be retried up to 3 times before propagating.

### Invariants

- **INV-1**: The module shall not contain prompt templates, schemas, or domain-specific content.
- **INV-2**: The module shall not make model selection policy decisions — callers configure tiers.
- **INV-3**: No domain shall directly import provider SDKs (Anthropic, etc.) — all LLM access through this module.
