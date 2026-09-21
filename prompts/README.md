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
- [extract-commitments.md](./extract-commitments.md) — First-person promises, intentions and follow-ups owed by others (commitments ledger)
- [extract-entities.md](./extract-entities.md) — Named entity extraction with type classification
- [extract-relationships.md](./extract-relationships.md) — Relationship detection between entities
- [resolve-conflict.md](./resolve-conflict.md) — Contradiction resolution between memories
- [smoke-conversation.json](./smoke-conversation.json) — The bundled 3-exchange conversation the `extraction smoke` doctor check extracts when no conversation is indexed yet (#61); its facts are never written to the store

## See Also

- [src/semantic/extractor.ts](../src/semantic/extractor.ts) — Uses extract-facts, calls LLM with these templates
- [src/interfaces/cli/smoke.ts](../src/interfaces/cli/smoke.ts) — Loads smoke-conversation.json for `engram doctor` / `engram setup`
- [src/semantic/commitments.ts](../src/semantic/commitments.ts) — Uses extract-commitments (dream commitments pass)
- [src/graph/extractor.ts](../src/graph/extractor.ts) — Uses extract-entities and extract-relationships
- [src/semantic/consolidator.ts](../src/semantic/consolidator.ts) — Uses resolve-conflict
- [decisions/005-unified-llm-factory.md](../decisions/005-unified-llm-factory.md) — LLM provider design
