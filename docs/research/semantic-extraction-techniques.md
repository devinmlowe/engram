# Semantic Extraction Techniques: State of the Art

> Research compiled 2026-02-26 for engram Phase 3 (Semantic Extraction)
> Back-reference: [spec.md Phase 3](../../spec.md#phase-3-semantic-extraction)

---

## Executive Summary

This document surveys the current state of the art for LLM-based extraction of structured facts and knowledge from conversation history. The research covers production memory systems (Mem0, Zep/Graphiti, LangMem, Letta/MemGPT, Supermemory, Amazon Bedrock AgentCore), extraction techniques, prompt engineering patterns, incremental processing strategies, and cost/quality tradeoffs across model tiers.

---

## 1. Structured Extraction Techniques

### 1.1 The Dominant Pattern: LLM-as-Extractor with Structured Output

The industry has converged on a common pattern: pass conversation text to an LLM with a carefully crafted system prompt that instructs it to extract structured facts, then enforce output structure through one of several mechanisms.

**Three approaches to structured output enforcement:**

1. **JSON Mode / Prompt-based**: Ask the LLM to output JSON and parse it. Simplest but least reliable -- models can produce malformed JSON, miss required fields, or return wrong types. ([Agenta guide](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms))

2. **Function Calling / Tool Use**: Define extraction as a "tool" with a JSON Schema. The model "calls" the tool with structured arguments. Claude's tool use with `strict: true` uses constrained decoding to guarantee schema compliance at the token generation level, eliminating type mismatches and missing fields. ([Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Claude Tool Use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use))

3. **Constrained Decoding**: Used by vLLM and other inference engines with open-source models. Compiles a JSON schema into a grammar that restricts token generation. Works with Llama, Qwen, and other local models. ([Together.ai Structured Outputs](https://docs.together.ai/docs/json-mode))

**Recommendation for engram**: Use Claude's tool use with `strict: true` for API-based extraction. For local models, use constrained decoding via vLLM or llama.cpp's grammar support.

### 1.2 Atomic Decomposition

Recent research on fact verification (AFEV framework) demonstrates that breaking complex claims into atomic facts improves both extraction quality and downstream utility. Rather than extracting a single complex memory like "User migrated from PostgreSQL to SQLite because of deployment simplicity and chose WAL mode for concurrency," decompose into:
- "User migrated from PostgreSQL to SQLite"
- "Migration motivated by deployment simplicity"
- "User chose WAL mode for SQLite"
- "WAL mode chosen for concurrency support"

This atomic approach enables better deduplication, more precise retrieval, and cleaner conflict resolution. ([AFEV framework](https://www.sciencedirect.com/science/article/abs/pii/S0957417425041879))

### 1.3 Reflection/Reflexion Technique

Both Zep/Graphiti and recent extraction frameworks use a two-pass approach: extract first, then run a "reflexion" pass that reviews the initial extraction against the source text to catch missed entities or facts. This technique reduces extraction recall gaps. Graphiti implements this as a separate prompt that asks "which entities/facts were missed?" ([Zep paper](https://arxiv.org/html/2501.13956v1))

---

## 2. Memory Systems Survey

### 2.1 Mem0 (mem0.ai)

**Architecture**: Two-phase pipeline (Extraction + Update) with vector storage and optional graph memory.

**Extraction Phase**: Processes the latest message pair along with three context sources:
- The most recent exchange (m_t-1, m_t)
- A rolling conversation summary (S)
- The last m=10 messages for granular context

**Update Phase**: Each extracted fact is embedded and compared against the top s=10 semantically similar existing memories. An LLM classifies each fact into one of four operations:
- **ADD**: New information not in the store
- **UPDATE**: Complements or supersedes existing memory
- **DELETE**: Contradicts existing information
- **NOOP**: Already present, no action needed

**Performance**: 26% relative improvement in LLM-as-a-Judge metrics over OpenAI baselines, 91% lower p95 latency, 90%+ token cost reduction. ([Mem0 paper](https://arxiv.org/abs/2504.19413))

### 2.2 Zep / Graphiti

**Architecture**: Temporal Knowledge Graph with bi-temporal model.

**Pipeline** ([Zep paper](https://arxiv.org/html/2501.13956v1)):

1. **Episode Ingestion**: Raw data enters as "episodes" (message, text, or JSON type)
2. **Entity Extraction**: Processes current message + last n=4 messages
3. **Reflexion Pass**: Second LLM call to catch missed entities
4. **Entity Resolution**: 1024-dimensional embeddings + full-text search to find existing matches. LLM-based deduplication generates updated name and summary.
5. **Fact/Edge Extraction**: Extracts relationships between identified entities with structured fields: relation type, source/target entity IDs, fact description, temporal validity bounds
6. **Edge Resolution**: Hybrid search constrained to edges between same entity pairs, LLM-based deduplication
7. **Graph Integration**: Predefined Cypher queries for consistent schema

**Bi-Temporal Model**: Each edge maintains four timestamps:
- t'_created, t'_expired (system/transactional timeline)
- t_valid, t_invalid (event timeline)

**Performance**: 94.8% on DMR benchmark (vs MemGPT's 93.4%), context retrieval under 200ms.

**Key insight**: LLMs in Graphiti "provide output used to build the database, rather than text output for human consumption" -- consistency and predictability in structure are paramount. Separation of concerns across prompts enables concurrent execution.

### 2.3 LangMem (LangChain)

**Three Memory Types** ([LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)):

1. **Semantic Memory** (facts/knowledge): Extracts structured facts via Pydantic schemas. Supports collection pattern (unbounded discrete facts with CRUD) and profile pattern (single updatable document).
2. **Episodic Memory** (past experiences): Preserves complete successful interactions as learning examples.
3. **Procedural Memory** (system instructions): Encodes behavioral patterns that evolve through feedback.

**Formation modes**:
- **Conscious**: During conversation, immediate but adds latency
- **Subconscious**: Post-conversation LLM reflection, higher recall, no latency impact

### 2.4 Letta (formerly MemGPT)

Two-tier memory (main context vs external) with self-editing capabilities through tool use.

**Memory Tiers** ([Letta docs](https://docs.letta.com/concepts/memgpt/)):
- **Core Memory**: Always in-context, compressed essential facts
- **Recall Memory**: Searchable database for specific memory reconstruction
- **Archival Memory**: Long-term storage for important information

### 2.5 Amazon Bedrock AgentCore

Strategy-based memory system with built-in semantic, episodic, summary, and user preference strategies.

Key extraction instruction: extract "standalone personal fact about the user, stated in a simple sentence... Include relevant details such as specific numbers, locations, or dates. Minimize coreference -- replace pronouns with actual entities."

---

## 3. Conversation Summarization vs. Discrete Fact Extraction

### 3.1 Current Consensus

The field has moved decisively toward **selective fact extraction over full summarization** for long-term memory:

- Mem0's research shows memory formation (selective fact storage) beats summarization by cutting token costs 80-90% while improving response quality 26%.
- Summarization compresses everything, losing important details. Fact extraction selectively stores what matters.
- LangMem explicitly distinguishes the approaches: semantic memory (facts) for grounding, episodic memory (experiences) for learning.

### 3.2 When Each Approach is Better

| Approach | Best For | Weaknesses |
|----------|----------|------------|
| **Discrete Facts** | Long-term user preferences, decisions, technical choices, patterns | Loses narrative context |
| **Rolling Summary** | Maintaining conversation continuity within a session | Lossy, can't retrieve specific details |
| **Episodic (full conversation)** | Learning from past interactions, debugging | Storage-heavy |
| **Hybrid** | Production systems | Complexity |

### 3.3 Recommendation for engram

Since engram processes Claude Code conversation history **after the fact** (not during live conversation), the optimal strategy is:

1. **Whole-conversation extraction** as the primary approach -- maximum context, maximum quality
2. **Chunked extraction for very long conversations** (>100 turns) -- split into overlapping windows of ~20-30 turns, extract from each, then deduplicate
3. **Incremental updates** when re-processing conversations that have grown since last extraction

---

## 4. Cost/Quality Tradeoffs

### 4.1 Model Tier Comparison

| Model | Input $/1M | Output $/1M | Extraction Quality |
|-------|-----------|-------------|-------------------|
| Claude Haiku 4.5 | $1.00 | $5.00 | Good (within ~5% of Sonnet on SWE-bench) |
| Claude Sonnet 4.5 | $3.00 | $15.00 | High |
| Qwen 2.5 7B (local) | ~$0 | ~$0 | Better than Llama 8B for structured output |
| Llama 3.1 8B (local) | ~$0 | ~$0 | Lower |

### 4.2 Practical Cost for engram

Processing 100 conversations (~1M input tokens, ~200K output tokens):

| Model | Total Cost |
|-------|-----------|
| Claude Haiku 4.5 | ~$2 |
| Claude Sonnet 4.5 | ~$6 |
| Local (Qwen 2.5 7B) | $0 |

### 4.3 Recommended Strategy

- **Default**: Claude Haiku 4.5 for extraction -- best cost/quality ratio
- **Quality tier**: Claude Sonnet for complex conversations
- **Local/free tier**: Qwen 2.5 7B with constrained decoding for offline/privacy use
- **Validation pass**: Optional second model to verify extracted facts (LLM-as-Judge)

---

## 5. Prompt Templates and Patterns

### 5.1 Common Structure

All surveyed systems follow a similar prompt structure:

```
[Role Assignment]
You are a memory extraction agent...

[Task Description]
Analyze the conversation and extract structured information...

[Extraction Guidelines]
- Extract ONLY from user messages (use assistant messages as context only)
- Only include explicitly stated or logically inferrable facts
- Do not incorporate external knowledge
- Avoid duplicates
- Return empty list if no relevant information found

[Category/Schema Guidance]
Extract facts in these categories: preferences, decisions, technical choices...

[Output Format]
Return JSON or use tool/function call schema

[Few-Shot Examples]
Input: "I switched to Neovim from VS Code because startup time matters"
Output: {"facts": ["User switched from VS Code to Neovim",
         "User values fast editor startup time"]}
```

### 5.2 Key Prompt Engineering Insights

1. **Few-shot examples are critical**: Positive and negative examples dramatically improve extraction precision.
2. **Negative examples matter**: Show the model what NOT to extract (casual conversation, greetings, system messages).
3. **Coreference resolution instruction**: "Replace pronouns with actual entities" prevents decontextualized memories.
4. **Temperature 0 or near-0**: Consistency is paramount for extraction.
5. **Language preservation**: Maintain the user's original language.
6. **Separation of extraction and classification**: Extracting entities first, then facts between entities, produces cleaner results than extracting everything in one pass (Graphiti's approach).

### 5.3 Mem0's Production Pattern

The extraction prompt categorizes into seven types: personal preferences, important personal details, plans/intentions, activity preferences, health/wellness, professional details, and miscellaneous.

The update prompt receives a new fact + top-10 similar existing memories and returns one of: ADD, UPDATE, DELETE, or NOOP.

### 5.4 Graphiti's Separation-of-Concerns Pattern

Five specialized prompts run in sequence (with some parallelizable):
1. Extract entities (nodes)
2. Resolve entities against existing graph
3. Extract facts (edges between entities)
4. Resolve facts against existing edges
5. Extract temporal information

This enables concurrent execution, easier debugging, and more consistent output.

---

## 6. Key Design Decisions for engram

### 6.1 Schema Approach: Typed Facts (Recommended)

```json
{
  "memories": [
    {"type": "preference", "content": "User prefers TypeScript over JavaScript"},
    {"type": "decision", "content": "Project uses SQLite for storage", "context": "migration phase"}
  ]
}
```

Matches engram's existing memory type taxonomy, provides enough structure for useful querying, and is robust enough for extraction by Haiku-class models.

### 6.2 Processing Pipeline for Claude Code Conversations

1. Parse JSONL into structured conversation
2. Filter to human + assistant text messages (use tool calls as optional context)
3. Chunk long conversations into overlapping windows (~20-30 turns)
4. Extract facts from each chunk with the conversation's metadata as additional context
5. Deduplicate across chunks
6. Tag extracted memories with session metadata (project, branch, timestamp)

---

## Sources

### Papers and Research
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [Recursively Summarizing Enables Long-Term Dialogue Memory in LLMs](https://arxiv.org/abs/2308.15022)
- [Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions](https://arxiv.org/html/2507.05257v2)
- [Fact in Fragments: Atomic Fact Extraction and Verification](https://www.sciencedirect.com/science/article/abs/pii/S0957417425041879)
- [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564)
- [Benchmarking LLMs for Extraction](https://www.nature.com/articles/s41698-025-00935-4)

### Documentation and Guides
- [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [Mem0 Custom Fact Extraction Prompt](https://docs.mem0.ai/open-source/features/custom-fact-extraction-prompt)
- [Graphiti Source: extract_nodes.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_nodes.py)
- [AWS Bedrock AgentCore Semantic Memory Prompt](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-system-prompt.html)
- [Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Letta/MemGPT Concepts](https://docs.letta.com/concepts/memgpt/)

### Comparisons
- [Supermemory Research](https://supermemory.ai/research)
- [Survey of AI Agent Memory Frameworks](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Qwen 2.5 LLM Improvements](https://qwenlm.github.io/blog/qwen2.5-llm/)
