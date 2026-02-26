# Entity Extraction & Knowledge Graphs for Developer Conversations

## Research Document for Engram Phase 4

**Date**: 2026-02-26
**Domain**: NER, relationship extraction, knowledge graph construction, GraphRAG
**Scope**: Extracting entities and relationships from Claude Code conversation histories (developer-assistant dialogues about software engineering)

---

## Table of Contents

1. [Entity Extraction from Developer Conversations](#1-entity-extraction-from-developer-conversations)
2. [Relationship Extraction Techniques](#2-relationship-extraction-techniques)
3. [LLM-Based Entity Extraction Prompt Engineering](#3-llm-based-entity-extraction-prompt-engineering)
4. [Entity Normalization and Resolution](#4-entity-normalization-and-resolution)
5. [Temporal Knowledge Graphs](#5-temporal-knowledge-graphs)
6. [Graph-Enhanced Retrieval (GraphRAG)](#6-graph-enhanced-retrieval-graphrag)
7. [Incremental Graph Building](#7-incremental-graph-building)
8. [Recommendations for Engram](#8-recommendations-for-engram)

---

## 1. Entity Extraction from Developer Conversations

### 1.1 Relevant Entity Types for Developer Knowledge Graphs

The current engram spec defines seven entity types: `project`, `tool`, `technology`, `person`, `concept`, `file`, `repo`. Research and production systems suggest this is a reasonable starting set, but the academic and industry consensus offers refinements.

**Microsoft GraphRAG** uses a generic approach where entity types are domain-tuned at prompt configuration time. Their auto-tuning system generates few-shot examples specific to the input domain, enumerates relevant entity types, and customizes extraction prompts accordingly.
(Source: [Microsoft GraphRAG Auto-Tuning](https://www.microsoft.com/en-us/research/blog/graphrag-auto-tuning-provides-rapid-adaptation-to-new-domains/))

**Graphiti/Zep** supports dynamic entity type labels rather than a fixed enum. Each `EntityNode` stores a `labels` list (e.g., `["Person", "Engineer"]`) and an `attributes` dictionary for type-specific properties. Their MCP server demonstrates nine predefined types: `Preference`, `Requirement`, `Procedure`, `Location`, `Event`, `Organization`, `Document`, `Topic`, `Object`.
(Source: [Graphiti GitHub](https://github.com/getzep/graphiti))

**Recommended entity types for developer conversations** (expanding engram's current set):

| Entity Type | Description | Examples |
|-------------|-------------|----------|
| `project` | Software project or product | "engram", "nova-voice" |
| `technology` | Language, framework, or library | "TypeScript", "React", "SQLite" |
| `tool` | Development tool or utility | "tmux", "Fish shell", "fd" |
| `file` | Specific file or directory path | "src/semantic/extractor.ts", "package.json" |
| `repo` | Git repository | "getzep/graphiti", "microsoft/graphrag" |
| `person` | User, contributor, or referenced individual | "the user", "Preston Rasmussen" |
| `concept` | Technical concept, architecture pattern, or algorithm | "vector search", "Matryoshka embeddings", "FSRS" |
| `configuration` | Config value, env var, or setting | "ANTHROPIC_API_KEY", "ESM modules" |
| `error` | Specific error or bug pattern | "WAL checkpoint failure", "CORS error" |
| `command` | CLI command or script | "npm run build", "git rebase" |

**Key insight**: Developer conversations are highly technical with a mix of proper nouns (React, SQLite) and informal references ("that bug", "the DB layer"). The informal, abbreviated nature of developer conversations requires:

1. **Coreference resolution** -- resolving "it", "that module", "the fix" to specific entities
2. **Code-aware tokenization** -- recognizing `src/foo/bar.ts` as a single entity, not three words
3. **Context-dependent typing** -- "Python" could be a language (technology) or a file (`python` command/tool) depending on context

(Source: [Neo4j Text-to-KG Pipeline](https://neo4j.com/blog/genai/text-to-knowledge-graph-information-extraction-pipeline/))

### 1.2 Handling Informal/Technical Language

The Zep paper describes extracting entities from conversational messages with these specific guidelines:

- **ALWAYS extract the speaker/actor as the first node**
- Use explicit, full names; avoid abbreviations
- Replace pronouns (he/she/they/this/that) with the actual entity names
- Exclude temporal information (dates, times) from entity extraction -- handle those on edges instead
- Extract entities mentioned **explicitly or implicitly** in the current message

The "reflexion" technique from Graphiti reduces hallucinations: after initial extraction, a second pass reviews the results and identifies missed entities.
(Source: [Zep Arxiv Paper](https://arxiv.org/html/2501.13956v1))

---

## 2. Relationship Extraction Techniques

### 2.1 Approach Comparison

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Template-based** | Predictable output, fast, no LLM needed | Rigid, misses novel relationships | Fixed-schema domains |
| **OpenIE** | No predefined schema needed, discovers novel relations | Noisy, hard to normalize, many duplicates | Exploration/discovery |
| **LLM-based (few-shot)** | Flexible, high quality, handles context | Cost, latency, potential hallucination | Production knowledge graphs |
| **LLM-based (fine-tuned)** | Lower latency, consistent output | Training data required, less flexible | High-volume extraction |
| **Hybrid** | Best of both worlds | Complexity | Production systems at scale |

(Sources: [Survey on OpenIE](https://arxiv.org/html/2208.08690v6), [LangExtract by Google](https://developers.googleblog.com/introducing-langextract-a-gemini-powered-information-extraction-library/))

### 2.2 Graphiti's Approach (LLM-Based, Recommended)

Graphiti extracts relationships as **natural language facts** between entity pairs. Their `Edge` schema:

```python
class Edge(BaseModel):
    relation_type: str  # SCREAMING_SNAKE_CASE (e.g., USES, DEPENDS_ON)
    source_entity_id: int  # References extracted entity list
    target_entity_id: int
    fact: str  # Natural language description of the relationship
    valid_at: str | None  # ISO 8601 -- when relationship became true
    invalid_at: str | None  # ISO 8601 -- when relationship ended
```

Key design decisions:
- **Relation types in SCREAMING_SNAKE_CASE** for consistency (e.g., `WORKS_AS`, `IS_FRIENDS_WITH`)
- **Facts are paraphrased**, not verbatim from text
- **Temporal bounds resolved against reference time** (the message timestamp)
- Each edge captures **both** a structured relation type and a natural language fact description

(Source: [Graphiti extract_edges.py](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/extract_edges.py))

### 2.3 Relationship Types for Developer Knowledge Graphs

The current engram spec defines: `uses`, `depends_on`, `related_to`, `part_of`, `configured_by`, `solved_by`. Recommended expansion:

| Relationship Type | Description | Example |
|-------------------|-------------|---------|
| `USES` | Active use of a tool/technology | project USES TypeScript |
| `DEPENDS_ON` | Runtime or build dependency | engram DEPENDS_ON better-sqlite3 |
| `PART_OF` | Containment/membership | extractor.ts PART_OF semantic module |
| `CONFIGURED_BY` | Configuration relationship | embedding model CONFIGURED_BY nomic-embed-text |
| `SOLVED_BY` | Problem-solution link | WAL error SOLVED_BY checkpoint fix |
| `RELATED_TO` | Weak association | vector search RELATED_TO embeddings |
| `REPLACED_BY` | Supersession | moment.js REPLACED_BY dayjs |
| `CONFLICTS_WITH` | Incompatibility or tension | ESM CONFLICTS_WITH require() |
| `IMPLEMENTS` | Implementation relationship | consolidator.ts IMPLEMENTS deduplication |
| `PREFERS_OVER` | User preference between alternatives | Fish PREFERS_OVER Bash |

### 2.4 Microsoft GraphRAG Pipeline

Microsoft's GraphRAG extracts entities and relationships in parallel from text chunks:

1. **Entity & Relationship Extraction**: LLM processes each TextUnit to identify entities (title, type, description) and relationships (source, target, description)
2. **Deduplication**: Duplicate entities and relationships are merged by consolidating descriptions
3. **Summarization**: Multiple descriptions per entity/relationship are condensed via LLM
4. **Community Detection**: Hierarchical Leiden algorithm recursively clusters entities
5. **Community Summarization**: LLM generates reports for each community
6. **Embedding**: Entity descriptions, text units, and community reports get vector embeddings

Default chunk size: 1200 tokens (configurable).
(Source: [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/))

---

## 3. LLM-Based Entity Extraction Prompt Engineering

### 3.1 Graphiti's Prompt Architecture

Graphiti evolved from a single "mega-prompt" (35 guidelines, full graph context) to a **specialized multi-prompt architecture**. The key insight from their engineering:

> "Separation of concerns we employ in our prompts allows us to run many of them concurrently, significantly reducing the total completion time."

**Pipeline of specialized prompts:**

1. **Entity extraction** from current episode (zero-shot, no graph context needed)
2. **Entity deduplication** against existing nodes (hybrid search narrows candidates)
3. **Fact/edge extraction** between identified entities
4. **Fact deduplication** against existing edges
5. **Temporal validation** (resolve temporal expressions)
6. **Fact expiration** (invalidate outdated edges)

Each prompt is focused on a single task. Unnecessary context is removed -- for example, the entity extraction prompt does not include existing graph context because "LLMs are already adept at zero-shot entity extraction from arbitrary text."

(Source: [Zep Blog - LLM Data Extraction](https://blog.getzep.com/llm-rag-knowledge-graphs-faster-and-more-dynamic/))

### 3.2 Graphiti Entity Extraction Prompt Structure

From the source code (`graphiti_core/prompts/extract_nodes.py`):

**System message:**
```
You are an AI assistant that extracts entity nodes from conversational messages.
Your primary task is to extract and classify the speaker and other significant
entities mentioned in the conversation.
```

**Extraction rules (from the user prompt):**
- ALWAYS extract the speaker/actor as the first entity
- Extract significant entities, concepts, or actors explicitly or implicitly mentioned
- Only extract from the **current message** (previous messages are context only)
- Disambiguate pronouns to full entity names
- Do not extract relationships, actions, dates, or temporal info
- Use full names, avoid abbreviations
- Classify each entity using provided entity_type_id integers

**Output schema (Pydantic):**
```python
class ExtractedEntity(BaseModel):
    name: str = Field(..., description='Name of the extracted entity')
    entity_type_id: int = Field(
        description='ID of the classified entity type. '
        'Must be one of the provided entity_type_id integers.'
    )

class ExtractedEntities(BaseModel):
    extracted_entities: list[ExtractedEntity]
```

(Source: [Graphiti extract_nodes.py](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/extract_nodes.py))

### 3.3 Graphiti Edge Extraction Prompt Structure

**System message:**
```
You are an expert fact extractor that extracts fact triples from text.
1. Extracted fact triples should include relevant date information.
2. Treat CURRENT TIME as message send time.
```

**Key rules:**
- Only use entity IDs from the provided entity list
- Source and target must be distinct entities
- Relation types in SCREAMING_SNAKE_CASE
- No duplicate facts
- Paraphrase (don't copy verbatim)
- Resolve temporal expressions against reference time
- Do not hallucinate temporal bounds

**Output schema:**
```python
class Edge(BaseModel):
    relation_type: str  # FACT_PREDICATE_IN_SCREAMING_SNAKE_CASE
    source_entity_id: int
    target_entity_id: int
    fact: str  # Natural language description
    valid_at: str | None  # ISO 8601
    invalid_at: str | None  # ISO 8601
```

(Source: [Graphiti extract_edges.py](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/extract_edges.py))

### 3.4 Few-Shot Prompting Best Practices

Research from 2025 provides clear guidance on few-shot NER:

1. **Retrieved examples outperform fixed examples** in one-shot and few-shot settings. Dynamically selecting examples similar to the input text improves extraction quality.

2. **Coverage matters**: selection strategies should ensure coverage of all entity types and difficult-to-extract entities.

3. **Prompt structure** (from PromptNER): task description + domain specification + entity type definitions + few-shot examples + input text. The task description should briefly explain the NER task and clearly define the domain, allowing the LLM to leverage domain-specific pre-training knowledge.

4. **One-shot vs zero-shot**: adding even a single example provides a measurable improvement, but the gains diminish after 3-5 examples for most tasks.

5. **Chain-of-thought**: for complex extraction, ZeroTuneBio NER integrates chain-of-thought reasoning directly in the prompt.

(Sources: [PromptNER](https://arxiv.org/abs/2305.15444), [FsPONER](https://arxiv.org/html/2407.08035v2), [LLMs for Few-Shot NER](https://www.mdpi.com/2076-3417/15/7/3838))

### 3.5 Structured Output Best Practices

The 2025 consensus on structured output for extraction:

1. **Define clear schemas** using Pydantic/Zod with field descriptions. The schema itself guides the LLM's output structure.

2. **Three output methods** (ranked by reliability):
   - **Tool/function calling** -- most reliable, model trained for this
   - **Native JSON mode** -- model constrained to valid JSON matching schema
   - **Prompted JSON** -- schema injected into instructions, least reliable

3. **Set temperature=0** for deterministic extraction.

4. **Spot-check results** and iterate on schema field descriptions.

5. **Nested structures** are handled well by Pydantic/Zod but would be difficult to describe in plain text prompts.

(Sources: [Building with LLMs PyCon 2025](https://building-with-llms-pycon-2025.readthedocs.io/en/latest/structured-data-extraction.html), [Simon Willison on LLM Schemas](https://simonwillison.net/2025/Feb/28/llm-schemas/), [Pydantic for LLMs](https://pydantic.dev/articles/llm-intro))

### 3.6 Coreference Resolution

Coreference resolution is critical for knowledge graph construction from conversations. Without it, splitting text into exchanges loses the information needed to resolve pronouns.

**Approaches:**

1. **LLM-inline resolution**: Include previous messages as context and instruct the LLM to resolve pronouns during extraction (Graphiti's approach). Engram's existing `extract-facts.md` prompt already does this: "Replace all pronouns with the specific entity names they refer to."

2. **Pre-processing pass**: Run a dedicated coreference resolution step before entity extraction. The Microsoft GraphRAG team has an [open feature request](https://github.com/microsoft/graphrag/issues/1244) for improved coreference resolution.

3. **Cross-document coreference**: Recent 2025 research addresses coreference across multiple documents/conversations, relevant for engram's multi-session scenario. Uses knowledge graph structure itself to aid resolution.
(Source: [Cross-Document Coreference in KGs](https://arxiv.org/abs/2504.05767))

---

## 4. Entity Normalization and Resolution

### 4.1 The Problem

"React.js", "ReactJS", "React", "react" must all resolve to one canonical entity. This is crucial for developer conversations where:
- Technologies have many aliases (TypeScript/TS, JavaScript/JS, Node.js/Node)
- Tools have version-specific names (Python 3.11, Node 20)
- Files can be referenced by full path or filename only
- Projects may be referenced by repo name, package name, or informal names

### 4.2 Multi-Stage Resolution Pipeline

The academic and industry consensus converges on a **multi-stage pipeline**:

**Stage 1: Candidate Generation (Blocking)**
- Embedding-based cosine similarity search (fast, recall-oriented)
- Full-text/BM25 search on entity names and aliases
- MinHash string similarity (Graphiti uses this as a heuristic)

**Stage 2: Candidate Ranking**
- Cosine similarity scoring between entity name embeddings
- String similarity metrics (Levenshtein distance, Jaccard)
- Description/context similarity

**Stage 3: LLM Verification (for ambiguous cases)**
- Present top candidates to LLM with context
- LLM determines if entities are duplicates or distinct
- LLM generates updated canonical name and merged summary

**Graphiti's specific approach:**
```
1. Extract entities from current episode
2. Generate embeddings for extracted entity names
3. Hybrid search (embedding + full-text) for candidate existing entities
4. For each extracted entity:
   a. If exact match found -> merge
   b. If high-similarity candidates found -> LLM verification
   c. If no candidates -> create new entity
5. When merging: LLM generates updated name and summary
```

(Sources: [Zep Arxiv Paper](https://arxiv.org/html/2501.13956v1), [iText2KG](https://arxiv.org/html/2409.03284v1))

### 4.3 Similarity Thresholds

**iText2KG** established empirically-derived thresholds from analysis of 1,500 entity pairs:
- **Entity merging threshold**: ~0.7 cosine similarity (using text-embedding-3-large)
- **Relationship merging threshold**: ~0.56 cosine similarity
- Upper threshold for high-precision matching; lower threshold reduces specificity

**SapBERT** (biomedical domain) uses a threshold of 0.8 on canonical name + definition similarity.

**Practical recommendation for engram**: Start with a 0.75 cosine similarity threshold on entity name embeddings for automatic merging, and use LLM verification for entities in the 0.6-0.75 range.

(Source: [iText2KG](https://arxiv.org/html/2409.03284v1))

### 4.4 Alias Management and Canonical Name Selection

**Strategies observed in production systems:**

1. **Most-mentioned form**: Track which alias appears most frequently; use it as canonical
2. **Most-formal form**: Prefer full names over abbreviations (e.g., "TypeScript" over "TS")
3. **LLM-selected**: When merging entities, ask the LLM to select the best canonical name
4. **Graphiti's approach**: When deduplication identifies a match, the LLM generates an "updated name" that becomes the new canonical form. The old name becomes an alias.

**Alias storage pattern** (engram already uses this):
```sql
-- Entity with JSON array of aliases
entities (
    name TEXT NOT NULL,          -- canonical name
    aliases TEXT,                -- JSON array: ["React.js", "ReactJS"]
)
```

**Recommended additions for engram:**
- Store alias->canonical mappings in a lookup table for O(1) resolution
- When a new entity is extracted, check aliases before embedding similarity
- Maintain a "common aliases" seed list for popular technologies

```sql
-- Fast alias lookup
CREATE TABLE entity_aliases (
    alias TEXT PRIMARY KEY,       -- normalized lowercase
    entity_id TEXT NOT NULL REFERENCES entities(id),
    source TEXT,                  -- 'extracted' | 'manual' | 'seed'
    created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_alias_entity ON entity_aliases(entity_id);
```

(Sources: [Entity Resolved KGs - Neo4j](https://neo4j.com/blog/developer/entity-resolved-knowledge-graphs/), [Entity Normalization](https://gofishdigital.com/blog/entity-normalization/))

---

## 5. Temporal Knowledge Graphs

### 5.1 Graphiti's Bi-Temporal Model

Graphiti tracks four timestamps per edge (relationship), implementing a full bi-temporal model:

**Transaction Timeline (database auditing):**
- `created_at`: When the relationship entered the database
- `expired_at`: When the relationship was marked as superseded (nullable)

**Event Timeline (real-world truth):**
- `valid_at`: When the relationship began being true in reality
- `invalid_at`: When the relationship ceased being true in reality

This enables queries like:
- "What did I believe was true on January 15?" (transaction time)
- "What was actually true on January 15?" (valid time)
- "Show me how my understanding evolved" (both dimensions)

(Source: [Zep Arxiv Paper](https://arxiv.org/html/2501.13956v1), [Beyond Static Graphs - Zep Blog](https://blog.getzep.com/beyond-static-knowledge-graphs/))

### 5.2 Temporal Invalidation Process

When new information contradicts existing relationships:

1. LLM evaluates each new edge against existing similar edges
2. Conflicting edges are identified
3. The old edge's `expired_at` is set (transaction time)
4. The old edge's fact is **regenerated** to reflect historical context

**Example:**
- Existing edge: "Maria works as junior manager" (valid_at: 2024-01-01)
- New episode: "Maria was promoted to senior manager"
- Result: Old edge fact updated to "Maria used to work as a junior manager, until her promotion to senior manager"
- New edge: "Maria works as senior manager" (valid_at: 2025-03-01)

For **non-chronological episodes** (processing conversations out of order), edges are sorted by `valid_at` dates, and the system correctly invalidates the earlier relationship.

(Source: [Beyond Static Graphs - Zep Blog](https://blog.getzep.com/beyond-static-knowledge-graphs/))

### 5.3 When Temporal Tracking Matters for Engram

**High value for engram:**
- Technology/tool preferences that change over time ("switched from Moment to Day.js")
- Project architecture decisions that evolve ("moved from REST to GraphQL")
- Tool versions ("upgraded from Node 18 to Node 22")

**Lower value for engram (but still useful):**
- Static facts about the environment ("uses M4 MacMini") -- these rarely change
- File paths -- these change with refactoring but the old path has limited value

**Recommendation**: Implement temporal tracking on edges (relationships) but not on entity nodes. Entity nodes should track `first_seen` and `last_seen` (already in engram's spec) but don't need the full bi-temporal model.

---

## 6. Graph-Enhanced Retrieval (GraphRAG)

### 6.1 How Knowledge Graphs Improve Retrieval

Standard vector search retrieves text chunks similar to a query. GraphRAG adds:

1. **Multi-hop reasoning**: Traverse relationships to find indirectly related information. "What tools are used by projects that depend on SQLite?" requires two hops.

2. **Entity-centric queries**: Retrieve everything known about an entity (its relationships, connected entities, community membership) rather than just text chunks that mention it.

3. **Community summaries**: Pre-computed summaries of entity clusters enable answering broad questions ("What are the main technology stacks I work with?") that no single text chunk could answer.

4. **Relationship-centric queries**: "What are the dependencies of project X?" or "What problems have I solved related to SQLite?"

(Sources: [GraphRAG ACM Survey](https://dl.acm.org/doi/10.1145/3777378), [IBM GraphRAG](https://www.ibm.com/think/topics/graphrag))

### 6.2 Retrieval Architecture: Dual-Channel

The current best practice is a **dual-channel architecture**:

**Channel 1: Vector/text retrieval** (existing engram episodic + semantic search)
- Embedding-based similarity search
- BM25 keyword search
- Reciprocal Rank Fusion to combine

**Channel 2: Graph-based retrieval**
- Entity lookup by name/alias
- N-hop neighbor traversal
- Community membership lookup
- Path-based queries between entities

**Fusion**: Results from both channels are merged using Reciprocal Rank Fusion (RRF) or a learned reranker. Graphiti reports that graph distance can be used for reranking -- entities closer in the graph to query entities get boosted.

Recent work shows improvements of up to **15%** over vanilla vector retrieval when adding graph-based retrieval.

(Sources: [HybRAG](https://www.mdpi.com/2076-3417/16/5/2244), [GraphRAG Complete Guide](https://medium.com/@brian-curry-research/graphrag-the-complete-guide-to-graph-powered-retrieval-augmented-generation-eeb58a6bb4d1))

### 6.3 Engram's `explore` Tool Design

The engram spec describes an `explore` MCP tool for graph traversal:

```typescript
// Tool 3: Explore -- traverse the knowledge graph
{
  name: "explore",
  description: "Explore connections in the knowledge graph",
  inputSchema: {
    entity: string,          // starting entity name
    depth?: number,          // hops (default 1)
    relationship_types?: string[]
  }
}
```

**Recommended query patterns for engram:**

1. **Entity profile**: Given entity name, return canonical info + all direct relationships + community membership
2. **Neighborhood**: N-hop expansion from entity, optionally filtered by relationship type
3. **Path finding**: Shortest path between two entities (reveals non-obvious connections)
4. **Community browse**: List entities in a topic cluster, ranked by centrality
5. **Similar entities**: Find entities with similar relationship patterns (structural similarity)

### 6.4 Graphiti's Hybrid Search (No LLM at Query Time)

A critical design decision in Graphiti: **retrieval uses zero LLM calls**. The search combines:
- Semantic embeddings (cosine similarity on name/fact embeddings)
- Keyword search (BM25 on entity names and edge facts)
- Graph traversal (direct neighborhood expansion)

This achieves low-latency queries suitable for real-time use in agent workflows.

(Source: [Graphiti GitHub](https://github.com/getzep/graphiti))

---

## 7. Incremental Graph Building

### 7.1 The Core Challenge

When processing a new conversation, the system must:
1. Extract entities and relationships from the new text
2. Determine which extracted entities match existing graph entities
3. Merge or create accordingly
4. Add new relationships without duplicating existing ones
5. Handle contradictions with existing knowledge

All **without reprocessing the entire graph**.

### 7.2 iText2KG Incremental Pipeline

iText2KG processes documents sequentially against a growing global entity set:

```
For each new document:
  1. Extract local entities E_d from document
  2. For each local entity e in E_d:
     a. Check exact match against global entities E
     b. If no exact match: compute cosine similarity against all global entities
     c. If similarity > threshold (0.7): merge with existing entity
     d. If similarity < threshold: add as new entity to E
  3. Extract relationships using resolved entity references
  4. Update global entity set: E = E ∪ (new entities)
```

Uses `text-embedding-3-large` for entity embeddings and cosine similarity at 0.7 threshold.

(Source: [iText2KG](https://arxiv.org/html/2409.03284v1), [iText2KG GitHub](https://github.com/AuvaLab/itext2kg))

### 7.3 Graphiti's Incremental Episode Processing

Graphiti processes each episode (message/conversation) immediately through a concurrent pipeline:

```
Episode ingestion:
  1. Retrieve last 3 episodes for context
  2. Extract entities (LLM, zero-shot)
  3. For each extracted entity:
     a. Generate name embedding
     b. Hybrid search for candidate existing entities
     c. Heuristic matching (MinHash string similarity)
     d. LLM verification for ambiguous cases
     e. Merge or create
  4. Extract edges/facts between resolved entities
  5. For each extracted edge:
     a. Generate fact embedding
     b. Search for similar existing edges (constrained to same entity pair)
     c. LLM deduplication for candidate matches
     d. Merge, update, or create
  6. Temporal resolution: set valid_at/invalid_at
  7. Contradiction detection: expire invalidated edges
```

Key concurrency insight: Steps 2-7 can run with up to 10 concurrent LLM calls (configurable `SEMAPHORE_LIMIT`), and independent sub-tasks within each step run in parallel.

(Source: [Zep Blog - LLM Data Extraction](https://blog.getzep.com/llm-rag-knowledge-graphs-faster-and-more-dynamic/))

### 7.4 ATOM: Atomic Fact Extraction for Temporal KGs

ATOM is a few-shot, scalable approach that:

1. **Splits input into "atomic facts"** -- minimal, self-contained factual statements
2. **Derives atomic KGs** from each set of facts
3. **Merges atomic KGs in parallel** using entity resolution

The atomic fact decomposition improves extraction exhaustivity (catches more entities) and stability (consistent results across runs).

(Source: [Incremental KG Construction - Emergent Mind](https://www.emergentmind.com/topics/incremental-knowledge-graph-construction))

### 7.5 Scalable Entity Resolution for Incremental Updates

Production systems use several optimizations:

1. **Blocking/indexing**: Don't compare every new entity against every existing entity. Use embedding ANN search or BM25 to narrow candidates.

2. **Alias lookup tables**: O(1) check of known aliases before any similarity computation.

3. **Correlation clustering**: Group similar entities using graph-based clustering (DBSCAN on entity embeddings).

4. **Confidence scoring**: Track provenance and source reliability for each entity assertion.

5. **Batch vs. online**: For engram's dream-state daemon, batch processing is fine. For the `remember` MCP tool (real-time), online resolution with cached embeddings is needed.

(Source: [IncRML](https://www.semantic-web-journal.net/content/incrml-incremental-knowledge-graph-construction-heterogeneous-data-sources))

---

## 8. Recommendations for Engram Phase 4

### 8.1 Extraction Pipeline Architecture

Follow Graphiti's separated-prompt pattern. The dream-state daemon should process each conversation through:

```
Phase 2 (Extract) - already exists for semantic facts
  |
  v
Phase 2b (Entity Extraction) - NEW
  1. For each conversation not yet entity-processed:
     a. Build entity extraction prompt (conversation text + metadata)
     b. LLM extracts entities (tool_use, structured output)
     c. Resolve each entity against existing graph (alias check -> embedding search -> LLM verify)
     d. Merge or create entities
  2. Build relationship extraction prompt (conversation text + resolved entity list)
     a. LLM extracts relationships/edges
     b. Resolve each edge against existing edges between same entity pairs
     c. Merge, update, or create edges
  3. Update entity mention counts, first_seen, last_seen
```

### 8.2 Recommended Prompt Template: Entity Extraction

```markdown
# Entity Extraction from Developer Conversation

You are an entity extraction specialist analyzing a conversation between
a developer and Claude Code (an AI coding assistant).

## Entity Types

Extract entities into exactly one of these types:

- **project**: Software project, application, or product name
- **technology**: Programming language, framework, library, or protocol
- **tool**: Development tool, CLI utility, editor, or service
- **file**: Specific file path, directory, or configuration file
- **repo**: Git repository (org/name format preferred)
- **person**: The user, or any referenced individual
- **concept**: Technical concept, design pattern, algorithm, or architecture approach
- **configuration**: Environment variable, config setting, or feature flag
- **command**: CLI command, script, or build step
- **error**: Specific error type, bug pattern, or failure mode

## Rules

1. ALWAYS extract the developer (user) as the first entity if they are identifiable.
2. Extract entities explicitly or implicitly mentioned in the conversation.
3. Replace ALL pronouns with the actual entity names.
4. Use the most complete, formal name available:
   - "TypeScript" not "TS"
   - "better-sqlite3" not "the sqlite library"
   - "src/semantic/extractor.ts" not "the extractor"
5. For file paths, preserve the full relative path when available.
6. Do NOT extract:
   - Temporal information (dates, times) -- these go on relationships
   - Generic actions or verbs
   - Conversational filler
7. If an entity could be multiple types, choose the most specific type.

## Output

For each entity, provide:
- name: The canonical entity name
- type: One of the entity types above
- description: Brief (1 sentence) description of what this entity is
```

### 8.3 Recommended Prompt Template: Relationship Extraction

```markdown
# Relationship Extraction from Developer Conversation

You are a relationship extraction specialist. Given a developer conversation
and a list of resolved entities, extract factual relationships between them.

## Relationship Types

- USES: Active use of a tool, technology, or library
- DEPENDS_ON: Runtime, build, or logical dependency
- PART_OF: Containment (file in project, module in system)
- CONFIGURED_BY: Configuration relationship
- SOLVED_BY: Problem resolved by a solution or tool
- RELATED_TO: General association (use sparingly)
- REPLACED_BY: One entity supersedes another
- CONFLICTS_WITH: Incompatibility or tension between entities
- IMPLEMENTS: Entity implements a concept or pattern
- PREFERS_OVER: User preference between alternatives

## Rules

1. Each relationship must connect two DISTINCT entities from the provided list.
2. Use the entity IDs provided, not new entity names.
3. Relation types must be in SCREAMING_SNAKE_CASE.
4. The fact field should be a concise natural language description.
5. Include temporal bounds (valid_at, invalid_at) only when the conversation
   provides clear temporal signals. Use the conversation timestamp as reference.
6. Do not hallucinate temporal information.
7. Paraphrase facts -- do not copy text verbatim.

## ENTITIES

{resolved_entity_list}

## CONVERSATION

{conversation_text}
```

### 8.4 Recommended Entity Resolution Algorithm

```typescript
async function resolveEntity(
  extracted: ExtractedEntity,
  existingEntities: Entity[],
  aliasLookup: Map<string, string>,
): Promise<{ action: 'create' | 'merge'; entityId: string }> {

  // Stage 1: Alias lookup (O(1))
  const normalizedName = extracted.name.toLowerCase().trim();
  const aliasMatch = aliasLookup.get(normalizedName);
  if (aliasMatch) {
    return { action: 'merge', entityId: aliasMatch };
  }

  // Stage 2: Embedding similarity search
  const nameEmbedding = await embed(extracted.name);
  const candidates = await vectorSearch(nameEmbedding, {
    table: 'vec_entities',
    limit: 5,
    threshold: 0.6,  // broad recall
  });

  if (candidates.length === 0) {
    return { action: 'create', entityId: generateId() };
  }

  // Stage 3: Score candidates
  const topCandidate = candidates[0];

  // Auto-merge if very high similarity AND same type
  if (topCandidate.score > 0.85 && topCandidate.type === extracted.type) {
    return { action: 'merge', entityId: topCandidate.id };
  }

  // Stage 4: LLM verification for ambiguous range (0.6-0.85)
  if (topCandidate.score > 0.6) {
    const isDuplicate = await llmVerifyDuplicate(extracted, topCandidate);
    if (isDuplicate) {
      return { action: 'merge', entityId: topCandidate.id };
    }
  }

  return { action: 'create', entityId: generateId() };
}
```

### 8.5 Schema Additions for Phase 4

Based on research, consider these additions to the existing engram schema:

```sql
-- Fast alias lookup (addition)
CREATE TABLE entity_aliases (
    alias TEXT PRIMARY KEY,       -- normalized lowercase
    entity_id TEXT NOT NULL REFERENCES entities(id),
    source TEXT DEFAULT 'extracted',  -- 'extracted' | 'manual' | 'seed'
    created_at INTEGER DEFAULT (unixepoch())
);

-- Track which conversations have been entity-processed
ALTER TABLE conversations ADD COLUMN entity_processed INTEGER DEFAULT 0;

-- Entity-to-memory links (which memories mention which entities)
CREATE TABLE entity_memories (
    entity_id TEXT NOT NULL REFERENCES entities(id),
    memory_id TEXT NOT NULL REFERENCES memories(id),
    exchange_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (entity_id, memory_id)
);

-- Relationship temporal fields (expand existing schema)
-- Add valid_at and invalid_at to relationships table
ALTER TABLE relationships ADD COLUMN valid_at INTEGER;
ALTER TABLE relationships ADD COLUMN invalid_at INTEGER;
ALTER TABLE relationships ADD COLUMN expired_at INTEGER;
ALTER TABLE relationships ADD COLUMN fact TEXT;  -- natural language description
```

### 8.6 Technology Alias Seed Data

Pre-populate common developer technology aliases:

```typescript
const TECH_ALIASES: Record<string, string[]> = {
  'TypeScript': ['TS', 'typescript', 'ts'],
  'JavaScript': ['JS', 'javascript', 'js', 'ECMAScript'],
  'React': ['React.js', 'ReactJS', 'react'],
  'Node.js': ['Node', 'node', 'NodeJS', 'node.js'],
  'Python': ['python', 'py', 'Python3', 'python3'],
  'SQLite': ['sqlite', 'sqlite3', 'SQLite3'],
  'PostgreSQL': ['Postgres', 'postgres', 'pg', 'psql'],
  'Visual Studio Code': ['VS Code', 'VSCode', 'vscode'],
  'Git': ['git'],
  'GitHub': ['github', 'GH', 'gh'],
  'Docker': ['docker'],
  'Kubernetes': ['K8s', 'k8s', 'kubernetes'],
  'next.js': ['Next.js', 'NextJS', 'Next', 'nextjs'],
  'tailwindcss': ['Tailwind', 'tailwind', 'Tailwind CSS'],
  'better-sqlite3': ['better-sqlite', 'betterSqlite3'],
  'Fish': ['fish', 'Fish shell', 'fish shell'],
  'tmux': ['Tmux'],
};
```

### 8.7 Concurrency and Cost Optimization

Following Graphiti's approach:

1. **Batch entity extraction per conversation** -- one LLM call per chunk (25 exchanges)
2. **Parallel resolution** -- entity resolution calls can run concurrently
3. **Limit LLM calls for resolution** -- only invoke LLM for ambiguous candidates (0.6-0.85 similarity range); auto-merge high-similarity, auto-create low-similarity
4. **Use Haiku for extraction, Sonnet for resolution** -- extraction is simpler (zero-shot NER); resolution requires nuanced judgment
5. **Cache entity embeddings** -- store in `vec_entities` table, reuse across conversations

---

## Sources

### Primary Research Papers
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/html/2501.13956v1) -- Arxiv, Jan 2025
- [iText2KG: Incremental Knowledge Graphs Construction Using Large Language Models](https://arxiv.org/html/2409.03284v1) -- Arxiv, Sep 2024
- [PromptNER: Prompting For Named Entity Recognition](https://arxiv.org/abs/2305.15444) -- Arxiv, 2023
- [FsPONER: Few-shot Prompt Optimization for Named Entity Recognition](https://arxiv.org/html/2407.08035v2) -- Arxiv, 2024
- [Advancing Few-Shot Named Entity Recognition with Large Language Model](https://www.mdpi.com/2076-3417/15/7/3838) -- Applied Sciences, 2025
- [A Survey on Open Information Extraction](https://arxiv.org/html/2208.08690v6) -- EMNLP Findings, 2024
- [Graph Retrieval-Augmented Generation: A Survey](https://dl.acm.org/doi/10.1145/3777378) -- ACM TOIS, 2025
- [Cross-Document Contextual Coreference Resolution in Knowledge Graphs](https://arxiv.org/abs/2504.05767) -- Arxiv, Apr 2025
- [Entity Relationship Extraction via Dependency Parsing and GNNs](https://www.nature.com/articles/s41598-025-33922-7) -- Scientific Reports, 2025
- [LLM-empowered Knowledge Graph Construction: A Survey](https://arxiv.org/pdf/2510.20345) -- Arxiv, 2025
- [Knowledge Graph Construction: Extraction, Learning, and Evaluation](https://www.mdpi.com/2076-3417/15/7/3727) -- Applied Sciences, 2025
- [Testing Prompt Engineering Methods for Knowledge Extraction](https://journals.sagepub.com/doi/10.3233/SW-243719) -- Semantic Web Journal, 2025
- [Towards Practical GraphRAG: Efficient KG Construction at Scale](https://arxiv.org/abs/2507.03226) -- Arxiv, 2025

### Production Systems & Code
- [Graphiti GitHub Repository](https://github.com/getzep/graphiti) -- Zep
- [Graphiti extract_nodes.py](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/extract_nodes.py) -- Entity extraction prompts
- [Graphiti extract_edges.py](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/extract_edges.py) -- Edge extraction prompts
- [Microsoft GraphRAG](https://microsoft.github.io/graphrag/) -- Microsoft Research
- [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) -- Processing pipeline
- [GraphRAG Community Summarization](https://github.com/microsoft/graphrag/blob/main/graphrag/prompt_tune/template/community_report_summarization.py)
- [IncRML](https://www.semantic-web-journal.net/content/incrml-incremental-knowledge-graph-construction-heterogeneous-data-sources) -- Incremental KG from heterogeneous sources

### Blog Posts & Guides
- [Zep Blog: LLM Data Extraction at Scale](https://blog.getzep.com/llm-rag-knowledge-graphs-faster-and-more-dynamic/) -- Prompt engineering lessons
- [Zep Blog: Beyond Static Graphs](https://blog.getzep.com/beyond-static-knowledge-graphs/) -- Temporal invalidation
- [Neo4j: Graphiti Knowledge Graph Memory](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Neo4j: Text to Knowledge Graph Pipeline](https://neo4j.com/blog/genai/text-to-knowledge-graph-information-extraction-pipeline/)
- [Neo4j: Entity Resolved Knowledge Graphs Tutorial](https://neo4j.com/blog/developer/entity-resolved-knowledge-graphs/)
- [Building with LLMs PyCon 2025: Structured Data Extraction](https://building-with-llms-pycon-2025.readthedocs.io/en/latest/structured-data-extraction.html)
- [Simon Willison: LLM Schemas](https://simonwillison.net/2025/Feb/28/llm-schemas/)
- [Pydantic for LLMs](https://pydantic.dev/articles/llm-intro)
- [IBM: What is GraphRAG](https://www.ibm.com/think/topics/graphrag)
- [Knowledge Graph Extraction in Pydantic](https://dev.to/jhagerer/knowledge-graph-extraction-in-pydantic-32on)
- [KG Construction End-to-End Guide 2026](https://medium.com/@brian-curry-research/building-a-knowledge-graph-a-comprehensive-end-to-end-guide-using-modern-tools-e06fe8f3b368)
- [GraphRAG Complete Guide 2026](https://medium.com/@brian-curry-research/graphrag-the-complete-guide-to-graph-powered-retrieval-augmented-generation-eeb58a6bb4d1)
- [LLMs to Knowledge Graphs 2025](https://medium.com/@claudiubranzan/from-llms-to-knowledge-graphs-building-production-ready-graph-systems-in-2025-2b4aff1ec99a)
- [Microsoft GraphRAG Auto-Tuning](https://www.microsoft.com/en-us/research/blog/graphrag-auto-tuning-provides-rapid-adaptation-to-new-domains/)
- [Entity Normalization - Go Fish Digital](https://gofishdigital.com/blog/entity-normalization/)
- [Awesome-GraphRAG Paper List](https://github.com/DEEP-PolyU/Awesome-GraphRAG)
- [Awesome-LLM4IE Paper List](https://github.com/quqxui/Awesome-LLM4IE-Papers)
- [Best Open Source LLMs for KG Construction 2026](https://www.siliconflow.com/articles/en/best-open-source-LLM-for-Knowledge-Graph-Construction)
