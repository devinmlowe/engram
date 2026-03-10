# Prompts

LLM prompt templates used by the dream pipeline and semantic extraction layer. These are the structured instructions sent to LLMs during knowledge processing.

## In Scope

- Prompt templates for LLM-based extraction, analysis, and generation
- Few-shot examples and output schema definitions

## Out of Scope

- Prompt execution logic (see [src/semantic/extractor.ts](../src/semantic/extractor.ts) and [src/graph/extractor.ts](../src/graph/extractor.ts))
- LLM provider configuration (see [src/_core/llm/](../src/_core/llm/))

## Contains

- [extract-facts.md](./extract-facts.md) — Fact/preference/decision extraction from conversations
- [extract-entities.md](./extract-entities.md) — Named entity extraction with type classification
- [extract-relationships.md](./extract-relationships.md) — Relationship detection between entities
- [resolve-conflict.md](./resolve-conflict.md) — Contradiction resolution between memories
- [reflect.md](./reflect.md) — Higher-order pattern and observation generation
- [summarize.md](./summarize.md) — Conversation summarization

## See Also

- [src/semantic/extractor.ts](../src/semantic/extractor.ts) — Uses extract-facts, calls LLM with these templates
- [src/graph/extractor.ts](../src/graph/extractor.ts) — Uses extract-entities and extract-relationships
- [src/graph/reflection.ts](../src/graph/reflection.ts) — Uses reflect template
- [decisions/005-unified-llm-factory.md](../decisions/005-unified-llm-factory.md) — LLM provider design
