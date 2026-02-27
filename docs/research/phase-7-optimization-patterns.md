# Phase 7: Optimization Patterns -- Research Document

> **Project:** engram
> **Domain:** retrieval optimization, context engineering, plugin packaging, graph performance, evaluation, background processing, spaced repetition
> **Created:** 2026-02-26
> **Scope:** Comprehensive research across seven optimization areas for Phase 7 of the Engram cognitive memory system

---

## Table of Contents

1. [Cross-Encoder Reranking Patterns](#1-cross-encoder-reranking-patterns)
2. [Context Budget Optimization for LLM Memory Systems](#2-context-budget-optimization-for-llm-memory-systems)
3. [Claude Code Plugin / MCP Server Packaging](#3-claude-code-plugin--mcp-server-packaging)
4. [Knowledge Graph Optimization Patterns](#4-knowledge-graph-optimization-patterns)
5. [Memory System Evaluation Metrics](#5-memory-system-evaluation-metrics)
6. [Dream State / Background Processing Patterns](#6-dream-state--background-processing-patterns)
7. [Spaced Repetition in Knowledge Systems](#7-spaced-repetition-in-knowledge-systems)

---

## 1. Cross-Encoder Reranking Patterns

### 1.1 Expert Consensus (2025-2026)

The two-stage retrieve-then-rerank pipeline is now the consensus architecture for production RAG systems. Cross-encoders examine full query-document pairs simultaneously, achieving deeper semantic understanding than bi-encoders that process queries and documents separately. The expert recommendation is clear: **always add a reranking stage** when retrieval quality matters.

Key findings from recent benchmarks:

- Cross-encoders consistently improve NDCG@10 by **5-15%** over bi-encoder alone
- Full cross-encoders outperform bi-encoders and late-interaction retrieval by **up to 10 nDCG points** on MS MARCO
- Reranking adds **50-400ms** extra latency per query depending on model and hardware
- The optimal number of candidates to rerank is **K in [20, 200]** -- below 20 the reranker has too few candidates, above 200 returns diminish

### 1.2 Model Comparison (February 2026)

| Model | Type | Params | Latency (GPU) | NDCG@10 | License | Best For |
|-------|------|--------|---------------|---------|---------|----------|
| **BGE-reranker-v2-m3** | Cross-encoder | 568M | 50-100ms | High | Apache 2.0 | Self-hosted multilingual |
| **BGE-reranker-base** | Cross-encoder | 278M | 30-80ms | Good | MIT | Lightweight self-hosted |
| **Jina Reranker v2 Base** | Cross-encoder | ~137M | 40-90ms | Good | Apache 2.0 | Fast English-focused |
| **Cohere Rerank 3.5** | API | N/A | ~600ms | High | API | Production reliability |
| **ZeroEntropy zerank-2** | API | N/A | ~500ms | Highest | API | Calibrated scores |
| **ms-marco-MiniLM-L-6-v2** | Cross-encoder | 22M | 10-30ms | Lower | MIT | Fast prototyping |
| **ColBERTv2 + PLAID** | Late interaction | 110M | Low (indexed) | Very High | MIT | Scale with precomputed index |

Agentset benchmark ELO ratings (higher is better):
- ZeroEntropy zerank-1: Highest ELO
- Cohere Rerank 3.5: 1451 ELO (41% win rate)
- BGE-reranker-v2-m3: 1327 ELO (29% win rate)
- Jina Reranker v2: 1327 ELO (28% win rate)

### 1.3 ColBERT and Late Interaction

ColBERT uses "late interaction" -- encoding queries and documents separately into per-token embeddings, then computing a lightweight MaxSim score at search time. This means document representations can be **precomputed and cached**, making retrieval extremely fast after initial indexing.

Key developments:
- **PLAID** (Performance-optimized Late Interaction Driver) accelerates ColBERT search by up to **7x on GPU** and **45x on CPU** vs vanilla ColBERTv2 while maintaining state-of-the-art quality
- **Jina ColBERT v2** adds multilingual support
- **PyLate** (2025) provides flexible Python training/deployment framework

**TypeScript/JavaScript limitation:** There is no production-ready TypeScript/JavaScript implementation of ColBERT or late interaction models. ColBERT is primarily a Python ecosystem (RAGatouille, PyLate). For Engram, which runs in Node.js, cross-encoder reranking via `@huggingface/transformers` is the practical path.

### 1.4 Performance vs Latency Tradeoffs

For Engram's use case (top-5 retrieval from a personal memory system):

**Recommended approach:**
1. Retrieve 20 candidates each from vector search and FTS5 (40 total, ~25-35 unique)
2. Apply RRF fusion to get unified ranking
3. Rerank top 20 with cross-encoder
4. Return top 5

**Latency budget analysis:**
| Stage | Estimated Latency | Notes |
|-------|------------------|-------|
| Vector search (sqlite-vec) | ~5-10ms | Exact KNN on <10K vectors |
| FTS5 search | ~2-5ms | SQLite FTS5 is very fast |
| RRF fusion | ~1ms | Simple arithmetic |
| Cross-encoder rerank (20 candidates) | ~50-150ms | BGE-base on Apple Silicon |
| **Total** | **~60-170ms** | Well within 500ms budget |

**Cold start warning:** First query after model loading takes 1-3 seconds for the cross-encoder model. Use singleton pattern to keep model warm.

### 1.5 Recommendations for Engram

1. **Primary model:** `Xenova/bge-reranker-base` (278M params) via `@huggingface/transformers` ONNX runtime. Good quality, manageable size for local inference.

2. **Upgrade path:** When BGE-reranker-v2-m3 has reliable ONNX support, switch for better multilingual and overall quality.

3. **Implementation pattern:** Singleton model loader with batch inference (pass all 20 query-candidate pairs in one forward pass).

4. **Toggle capability:** Expose `reranking: boolean` in search config. Default ON but allow disabling for latency-sensitive paths.

5. **Score blending:** After reranking, optionally blend the cross-encoder score with the original RRF score: `final = 0.7 * reranker_normalized + 0.3 * rrf_normalized`. This provides stability when the reranker is uncertain.

```typescript
// Recommended pattern for Engram
interface RerankerConfig {
  enabled: boolean;
  model: string;        // 'Xenova/bge-reranker-base'
  topK: number;         // 20 candidates to rerank
  finalK: number;       // 5 results to return
  blendWeight: number;  // 0.7 reranker, 0.3 original
}
```

### 1.6 Sources

- [ZeroEntropy: Ultimate Guide to Choosing the Best Reranking Model in 2026](https://www.zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025)
- [Agentset Reranker Leaderboard](https://agentset.ai/rerankers)
- [Agentset: Best Reranker for RAG](https://agentset.ai/blog/best-reranker)
- [BSWEN: Best Reranker Models for RAG (2026)](https://docs.bswen.com/blog/2026-02-25-best-reranker-models/)
- [Pinecone: Rerankers and Two-Stage Retrieval](https://www.pinecone.io/learn/series/rag/rerankers/)
- [NVIDIA: How Reranking Microservice Improves Accuracy](https://developer.nvidia.com/blog/how-using-a-reranking-microservice-can-improve-accuracy-and-costs-of-information-retrieval/)
- [Weaviate: Late Interaction Overview (ColBERT, ColPali, ColQwen)](https://weaviate.io/blog/late-interaction-overview)
- [Jina ColBERT v2 Announcement](https://jina.ai/news/jina-colbert-v2-multilingual-late-interaction-retriever-for-embedding-and-reranking/)
- [ColBERT and Friends: Re-Ranking That Feels Instant](https://medium.com/@2nick2patel2/colbert-and-friends-re-ranking-that-feels-instant-6c09102b7526)
- [FlagEmbedding GitHub (BGE models)](https://github.com/FlagOpen/FlagEmbedding)
- [BAAI/bge-reranker-base on HuggingFace](https://huggingface.co/BAAI/bge-reranker-base)

---

## 2. Context Budget Optimization for LLM Memory Systems

### 2.1 The "Lost in the Middle" Problem

Research consistently shows that LLMs exhibit **primacy bias** (favoring information at the beginning of the context) and **recency bias** (favoring information at the end). Content placed in the middle of long prompts suffers up to **40% context degradation**.

This has direct implications for how memory systems construct prompts with retrieved memories.

**Key findings:**
- Tokens at the beginning and end of the prompt receive disproportionate attention
- In extreme cases, attention collapses entirely on middle portions of input
- The effect worsens with longer contexts -- "context rot" degrades model performance as input tokens increase
- Expanding context windows does not guarantee improved model performance

### 2.2 How Production Memory Systems Handle Token Budgets

#### Mem0

Mem0 achieves **66.9% accuracy** on LoCoMo using just **7k tokens per conversation** -- compared to Zep which consumed over **600k tokens** by caching full abstractive summaries. This demonstrates that selective, compressed memory retrieval dramatically outperforms full-context approaches.

Mem0's pipeline:
1. Retrieve top-S similar memories via embedding search
2. LLM classifies each as ADD / UPDATE / DELETE / NOOP
3. Selective retrieval at query time returns only highly relevant memories
4. Median search latency: **0.20 seconds**

#### Zep / Graphiti

Zep's graph-based approach combines semantic similarity and BM25 for retrieval, achieving **94.8% accuracy** on the Deep Memory Retrieval benchmark. However, it consumes significantly more tokens (600k+) by caching full summaries at each node.

Key design: Zero LLM calls at retrieval time. All processing happens during ingestion. This means the token budget is only consumed by retrieved facts, not by processing overhead.

#### Letta (MemGPT)

Letta uses a hierarchical memory model:
- **Core Memory Blocks** (~2K tokens): Always in context, like RAM. Contains user profile, persona, key facts.
- **Recall Memory**: Searchable conversation history via embedding search
- **Archival Memory**: Long-term vector-searchable storage

The agent **self-edits** its core memory blocks during conversation, keeping them concise and up-to-date. This is the most aggressive token optimization -- the always-present context is actively curated.

#### SimpleMem (January 2026)

SimpleMem proposes a three-stage pipeline achieving **26.4% average F1 improvement** and **30x inference token compression**:
1. **Semantic Structured Compression**: Entropy-aware filtering distills interactions into compact multi-view indexed memory units
2. **Recursive Memory Consolidation**: Asynchronous process integrates related units into higher-level abstractions
3. **Adaptive Query-Aware Retrieval**: Dynamically adjusts retrieval scope based on query complexity

### 2.3 Primacy Placement Strategy

The expert consensus for prompt construction with retrieved memories:

```
[System instructions]          <-- Primacy zone (high attention)
[Most important memories]      <-- Place highest-relevance memories here
[Supporting context/memories]  <-- Middle zone (lower attention)
[Current conversation history] <-- Recency zone (high attention)
[Current user query]           <-- Final position (highest attention)
```

**Six-layer context structure** (emerging best practice):
1. **System rules**: Role, constraints, policies
2. **Memory**: Retrieved long-term memories (highest relevance first)
3. **Retrieved docs**: RAG results from external sources
4. **Tool schemas**: Available tool definitions
5. **Recent conversation**: Last N turns of dialogue
6. **Current task**: The immediate user request

### 2.4 Scoring and Selection Formula

The production standard for memory scoring combines three factors:

```
final_score = 0.60 * relevance + 0.25 * recency + 0.15 * importance
```

Where:
- **relevance**: Cosine similarity between memory embedding and query embedding
- **recency**: Time decay function: `1.0 / (1.0 + 0.01 * hours_elapsed)`
- **importance**: Explicit importance factor (0.0 to 1.0), set during extraction

This formula heavily favors relevance (0.6 weight) to prevent retrieving important-but-irrelevant memories. The recency component ensures recent context is preferred when relevance is similar. Importance acts as a tiebreaker.

### 2.5 Token Budget Management Algorithm

```typescript
interface ContextBudget {
  maxTokens: number;           // Total context window (e.g., 200000)
  systemPromptTokens: number;  // Fixed system instructions
  toolSchemaTokens: number;    // MCP tool definitions
  conversationTokens: number;  // Recent conversation history
  responseReserve: number;     // Tokens reserved for model response
  memoryBudget: number;        // Calculated: what's left for memories
}

function calculateMemoryBudget(config: ContextBudget): number {
  return config.maxTokens
    - config.systemPromptTokens
    - config.toolSchemaTokens
    - config.conversationTokens
    - config.responseReserve;
}

function selectMemories(
  candidates: ScoredMemory[],
  budgetTokens: number,
): SelectedMemory[] {
  // Sort by final_score descending
  const sorted = candidates.sort((a, b) => b.score - a.score);

  const selected: SelectedMemory[] = [];
  let usedTokens = 0;

  for (const memory of sorted) {
    const tokens = estimateTokens(memory.content);
    if (usedTokens + tokens > budgetTokens) {
      // Try compressed summary if available
      if (memory.summary && usedTokens + estimateTokens(memory.summary) <= budgetTokens) {
        selected.push({ ...memory, content: memory.summary, compressed: true });
        usedTokens += estimateTokens(memory.summary);
      }
      continue;
    }
    selected.push({ ...memory, compressed: false });
    usedTokens += tokens;
  }

  return selected;
}
```

### 2.6 Recommendations for Engram

1. **Implement token budget tracking** in the `recall` MCP tool. Count tokens used by system prompt, tool schemas, and conversation before allocating memory budget.

2. **Place memories in primacy position**: When constructing context for Claude, place the most relevant retrieved memories immediately after the system prompt, before other context.

3. **Use compressed summaries as fallback**: When a memory exceeds remaining budget, substitute its summary (if available from dream state processing).

4. **Target 7-14K tokens for memory context** (following Mem0's approach). This is sufficient for 10-20 high-quality memories without overwhelming the model.

5. **Implement the three-factor scoring formula**: `0.60 * relevance + 0.25 * recency + 0.15 * importance`. This is well-validated across production systems.

6. **Progressive disclosure**: Return fewer, higher-quality memories rather than cramming more memories into budget. Quality over quantity.

### 2.7 Sources

- [Tribe AI: Context-Aware Memory Systems in 2025](https://www.tribe.ai/applied-ai/beyond-the-bubble-how-context-aware-memory-systems-are-changing-the-game-in-2025)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (arXiv)](https://arxiv.org/html/2504.19413v1)
- [Mem0 Research: 26% Accuracy Boost](https://mem0.ai/research)
- [Mem0: Context Engineering for AI Agents Guide](https://mem0.ai/blog/context-engineering-ai-agents-guide)
- [FlowHunt: Context Engineering Definitive Guide 2025](https://www.flowhunt.io/blog/context-engineering/)
- [Agenta: Top Techniques to Manage Context Lengths](https://agenta.ai/blog/top-6-techniques-to-manage-context-length-in-llms)
- [DataCamp: How Does LLM Memory Work?](https://www.datacamp.com/blog/how-does-llm-memory-work)
- [SimpleMem: Efficient Lifelong Memory for LLM Agents (arXiv, Jan 2026)](https://arxiv.org/html/2601.02553v1)
- [SimpleMem: 30x More Efficient Memory (Tekta.ai Analysis)](https://www.tekta.ai/ai-research-papers/simplemem-llm-agent-memory-2026)
- [The New Stack: Memory for AI Agents, A New Paradigm](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/)
- [Graphlit: Survey of AI Agent Memory Frameworks](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Cognee: AI Memory Tools Evaluation](https://www.cognee.ai/blog/deep-dives/ai-memory-tools-evaluation)
- [From Beta to Battle-Tested: Letta, Mem0, Zep Comparison](https://medium.com/asymptotic-spaghetti-integration/from-beta-to-battle-tested-picking-between-letta-mem0-zep-for-ai-memory-6850ca8703d1)

---

## 3. Claude Code Plugin / MCP Server Packaging

### 3.1 Plugin Architecture Overview

Claude Code plugins are self-contained directories that extend Claude Code with custom functionality. A plugin can bundle:
- **Skills**: `/name` shortcuts invoked by users or Claude (SKILL.md files)
- **Agents**: Specialized subagents for specific tasks
- **Hooks**: Event handlers triggered at workflow points
- **MCP Servers**: Model Context Protocol servers for external tool integration
- **LSP Servers**: Language server protocol servers for code intelligence

### 3.2 Standard Directory Structure

```
engram-plugin/
  .claude-plugin/              # Metadata directory (ONLY plugin.json goes here)
    plugin.json                  # Plugin manifest
  commands/                    # Legacy command location
  skills/                      # Skill directories with SKILL.md
    recall/
      SKILL.md
    remember/
      SKILL.md
    explore/
      SKILL.md
    dream/
      SKILL.md
  agents/                      # Subagent markdown files
    memory-analyst.md
  hooks/                       # Hook configurations
    hooks.json
  .mcp.json                    # MCP server definitions
  scripts/                     # Utility scripts
    install.sh
    health-check.sh
  LICENSE
  CHANGELOG.md
```

**Critical rule:** Components must be at the plugin root, NOT inside `.claude-plugin/`. Only `plugin.json` belongs in `.claude-plugin/`.

### 3.3 Plugin Manifest (plugin.json)

```json
{
  "name": "engram",
  "version": "0.1.0",
  "description": "Cognitive memory system for Claude Code -- episodic, semantic, and graph-based memory layers",
  "author": {
    "name": "Devin Lowe",
    "url": "https://github.com/dml089"
  },
  "repository": "https://github.com/dml089/engram",
  "license": "MIT",
  "keywords": [
    "memory",
    "episodic",
    "semantic",
    "knowledge-graph",
    "rag",
    "mcp"
  ],
  "mcpServers": "./.mcp.json",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json"
}
```

Only `name` is required if a manifest is present. All other fields are optional metadata.

### 3.4 MCP Server Configuration (.mcp.json)

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["tsx", "${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts"],
      "env": {
        "ENGRAM_DATA_DIR": "~/.local/share/engram"
      }
    }
  }
}
```

Alternative for compiled distribution:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "env": {
        "ENGRAM_DATA_DIR": "~/.local/share/engram"
      }
    }
  }
}
```

**Key variable:** `${CLAUDE_PLUGIN_ROOT}` resolves to the absolute path of the plugin directory. Use this for all intra-plugin path references.

**Integration behavior:**
- Plugin MCP servers start automatically when the plugin is enabled
- Servers appear as standard MCP tools in Claude's toolkit
- Plugin servers can be configured independently of user MCP servers
- **You must restart Claude Code to apply MCP server changes**

### 3.5 Known Issue: Inline mcpServers

As of early 2026, there is a known bug where MCP servers defined inline in `plugin.json` using the `mcpServers` field are ignored -- the field is stripped during manifest parsing ([GitHub Issue #16143](https://github.com/anthropics/claude-code/issues/16143)). The workaround is to define MCP servers in a separate `.mcp.json` file and reference it from `plugin.json`:

```json
{
  "mcpServers": "./.mcp.json"
}
```

### 3.6 Installation Workflow

**Installation scopes:**

| Scope | Settings File | Use Case |
|-------|--------------|----------|
| `user` | `~/.claude/settings.json` | Personal plugins (default) |
| `project` | `.claude/settings.json` | Team plugins, version-controlled |
| `local` | `.claude/settings.local.json` | Project-specific, gitignored |

**Installation methods:**

1. **From marketplace:**
   ```bash
   claude plugin install engram@my-marketplace --scope user
   ```

2. **From local directory (development):**
   ```bash
   claude --plugin-dir /path/to/engram-plugin
   ```

3. **Direct .mcp.json configuration** (current Engram approach):
   ```json
   // .mcp.json in project root
   {
     "mcpServers": {
       "engram": {
         "command": "npx",
         "args": ["tsx", "/path/to/engram/src/mcp/server.ts"]
       }
     }
   }
   ```

### 3.7 Plugin Caching

When installed from a marketplace, Claude Code copies plugins to `~/.claude/plugins/cache/` rather than using them in-place. This means:
- Plugins cannot reference files outside their directory
- Symlinks are honored during the copy process
- Version bumps in `plugin.json` trigger cache updates

### 3.8 Recommendations for Engram

1. **Phase 7a -- Current state (MCP-only):** Continue using `.mcp.json` for MCP server configuration. This works today without plugin packaging overhead.

2. **Phase 7b -- Full plugin packaging:** Create the plugin directory structure with skills for `recall`, `remember`, `explore`, `reflect`, and `dream` commands.

3. **Distribution via marketplace.json:**
   ```json
   {
     "plugins": [
       {
         "name": "engram",
         "version": "0.1.0",
         "description": "Cognitive memory system",
         "source": "./plugins/engram"
       }
     ]
   }
   ```

4. **Use `.mcp.json` not inline** for MCP server definitions (workaround for the parsing bug).

5. **Include a `settings.json`** for default plugin configuration (only agent settings are currently supported).

6. **Add hook integration** for automatic memory capture on session events:
   ```json
   {
     "hooks": {
       "SessionEnd": [{
         "hooks": [{
           "type": "command",
           "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh"
         }]
       }]
     }
   }
   ```

### 3.9 Sources

- [Claude Code Docs: Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code Docs: Connect to Tools via MCP](https://code.claude.com/docs/en/mcp)
- [Anthropic: One-Click MCP Server Installation](https://www.anthropic.com/engineering/desktop-extensions)
- [anthropics/claude-plugins-official GitHub](https://github.com/anthropics/claude-plugins-official)
- [anthropics/claude-code plugins README](https://github.com/anthropics/claude-code/blob/main/plugins/README.md)
- [DataCamp: How to Build Claude Code Plugins](https://www.datacamp.com/tutorial/how-to-build-claude-code-plugins)
- [Context Studios: Claude Code Plugins Complete Guide](https://www.contextstudios.ai/blog/claude-code-plugins-the-complete-guide-to-the-extension-system-2025)
- [Composio: Improving Workflow with Claude Code Plugins](https://composio.dev/blog/claude-code-plugin)
- [DeepWiki: Plugin Structure and Manifest](https://deepwiki.com/anthropics/claude-plugins-official/5.1-plugin-structure-and-manifest)
- [GitHub Issue #16143: Inline mcpServers Parsing Bug](https://github.com/anthropics/claude-code/issues/16143)

---

## 4. Knowledge Graph Optimization Patterns

### 4.1 SQLite Performance Fundamentals

The following PRAGMA configuration is the baseline for all SQLite performance work in Engram:

```sql
PRAGMA journal_mode = WAL;          -- Write-Ahead Logging for concurrent reads
PRAGMA synchronous = normal;        -- Safe with WAL, avoids fsync per transaction
PRAGMA journal_size_limit = 6144000; -- 6MB WAL file size limit
PRAGMA cache_size = -64000;         -- 64MB page cache
PRAGMA mmap_size = 268435456;       -- 256MB memory-mapped I/O
PRAGMA temp_store = memory;         -- Keep temp tables in memory
PRAGMA foreign_keys = ON;           -- Enforce referential integrity
```

**Impact:** WAL + synchronous=normal can **reduce per-transaction overhead from 30ms+ to <1ms**. The `better-sqlite3` library already compiles with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so databases in WAL mode automatically default to NORMAL synchronous.

### 4.2 Batch Operation Patterns

#### Transaction Wrapping

Wrapping multiple writes into single transactions increases write throughput by **2-20x** compared to individual statement execution.

```typescript
// Pattern: Batch insert with prepared statements
function batchInsertEntities(db: Database, entities: Entity[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO entities (id, name, type, description, aliases, mention_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((entities: Entity[]) => {
    for (const entity of entities) {
      insert.run(entity.id, entity.name, entity.type, entity.description,
                 JSON.stringify(entity.aliases), entity.mentionCount);
    }
  });

  insertMany(entities);
}
```

#### JSON1 Bulk Operations

For large batches, SQLite's JSON1 extension enables single-statement bulk operations:

```sql
-- Bulk insert via json_each
INSERT OR REPLACE INTO entities (id, name, type)
SELECT
  json_extract(value, '$.id'),
  json_extract(value, '$.name'),
  json_extract(value, '$.type')
FROM json_each(:json_array);
```

This avoids multiple round-trips through the Node.js binding layer and is particularly effective for dream-state batch processing.

#### Parameter Limits

SQLite has a maximum variable number limit (`SQLITE_MAX_VARIABLE_NUMBER = 32766` on recent versions). For bulk operations with many columns, chunk operations into batches of ~5,000 rows to stay well within limits.

### 4.3 Graph Traversal Optimization

#### Index Strategy for Bidirectional Traversal

Engram's graph traversal requires efficient lookups in both directions. The minimum index set:

```sql
-- Composite indexes for edge lookups
CREATE INDEX IF NOT EXISTS idx_rel_source_type
  ON relationships(source_entity_id, type);
CREATE INDEX IF NOT EXISTS idx_rel_target_type
  ON relationships(target_entity_id, type);

-- Covering index for common traversal pattern
CREATE INDEX IF NOT EXISTS idx_rel_source_target_type
  ON relationships(source_entity_id, target_entity_id, type);
```

Always verify index usage with `EXPLAIN QUERY PLAN`:

```sql
EXPLAIN QUERY PLAN
SELECT * FROM relationships
WHERE source_entity_id = ? AND type = ?;
-- Should show: SEARCH relationships USING INDEX idx_rel_source_type
```

#### Depth-Limited Recursive CTEs

Always set maximum traversal depth. Without limits, CTEs on graphs with cycles can run indefinitely:

```sql
WITH RECURSIVE neighborhood(id, depth, path) AS (
  SELECT id, 0, id FROM entities WHERE id = :start_id
  UNION
  SELECT e.id, n.depth + 1, n.path || ',' || e.id
  FROM neighborhood n
  JOIN relationships rel
    ON rel.source_entity_id = n.id OR rel.target_entity_id = n.id
  JOIN entities e
    ON e.id = CASE
      WHEN rel.source_entity_id = n.id THEN rel.target_entity_id
      ELSE rel.source_entity_id
    END
  WHERE n.depth < 2  -- ALWAYS limit depth
    AND n.path NOT LIKE '%' || e.id || '%'
)
SELECT * FROM neighborhood;
```

**Depth recommendations:**
- 1 hop: Direct relationships (fast, <5ms)
- 2 hops: Extended neighborhood (moderate, 5-50ms for <10K entities)
- 3 hops: Broad exploration (slower, 50-500ms, use sparingly)

#### Super-Node Mitigation

Entities with many connections (e.g., "TypeScript", "Claude") create performance bottlenecks. Strategies:
- **Relationship partitioning**: Filter by relationship type during traversal
- **Label-based filtering**: Add entity type constraints to reduce search space
- **Query timeout limits**: Abort traversals exceeding time budget
- **Degree capping**: Limit the number of edges traversed per node to top-N by weight

### 4.4 Caching Strategies

#### Query Result Cache

Cache results from common traversal patterns. The dream state daemon can pre-compute and cache frequently accessed graph views:

```typescript
// Cache table populated during dream processing
const CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS graph_cache (
    cache_key TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`;

// Cache common queries
function cacheGraphView(db: Database, key: string, result: unknown, ttlHours: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT OR REPLACE INTO graph_cache (cache_key, result_json, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(key, JSON.stringify(result), now, now + ttlHours * 3600);
}

// Invalidate on graph changes
function invalidateCache(db: Database, entityId: string): void {
  db.prepare(`
    DELETE FROM graph_cache WHERE cache_key LIKE '%' || ? || '%'
  `).run(entityId);
}
```

#### Entity Embedding Cache

Keep entity embeddings warm in memory during search sessions:

```typescript
// LRU cache for entity embeddings
class EmbeddingCache {
  private cache = new Map<string, Float32Array>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(entityId: string): Float32Array | undefined {
    const val = this.cache.get(entityId);
    if (val) {
      // Move to end (most recently used)
      this.cache.delete(entityId);
      this.cache.set(entityId, val);
    }
    return val;
  }

  set(entityId: string, embedding: Float32Array): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(entityId, embedding);
  }
}
```

### 4.5 Background WAL Checkpoint

WAL checkpoints can cause occasional 30-100ms fsync pauses. Run checkpoints on a separate connection during idle periods:

```typescript
// Background checkpoint during dream processing
function performWalCheckpoint(dbPath: string): void {
  const checkpointDb = new Database(dbPath, { readonly: false });
  checkpointDb.pragma('wal_checkpoint(TRUNCATE)');
  checkpointDb.close();
}
```

### 4.6 ANALYZE for Query Planner

Run `ANALYZE` after bulk operations to update SQLite's statistics:

```typescript
// After dream processing batch
function postBatchOptimize(db: Database): void {
  db.exec('ANALYZE');
  db.exec('PRAGMA optimize');  // SQLite 3.18+ automatic optimization
}
```

**Alternative approach:** Use `likely()` / `unlikely()` SQL hints instead of `ANALYZE` to guide the query planner deterministically across different users' databases.

### 4.7 Recommendations for Engram

1. **Add PRAGMA configuration** to database initialization. The WAL + synchronous=normal combination is the single biggest performance improvement.

2. **Batch all dream-state writes** within transactions. Each phase (INGEST, EXTRACT, CONSOLIDATE) should wrap its writes in a single transaction per conversation.

3. **Add composite indexes** for bidirectional traversal. Currently Engram has basic indexes; add the recommended composite indexes.

4. **Implement graph result caching** for the `explore` MCP tool. Cache community membership and common traversal patterns.

5. **Run ANALYZE after dream processing** to keep query planner statistics fresh.

6. **Limit traversal depth to 2** for the `explore` tool's default behavior, with an option to increase to 3 for explicit deep exploration.

### 4.8 Sources

- [PowerSync: SQLite Optimizations for Ultra High-Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)
- [phiresky: SQLite Performance Tuning](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [better-sqlite3 Performance Documentation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [SQLite Bulk INSERT Benchmarking](https://zerowidthjoiner.net/2021/02/21/sqlite-bulk-insert-benchmarking-and-optimization)
- [Towards Inserting One Billion Rows in SQLite](https://avi.im/blag/2021/fast-sqlite-inserts/)
- [Hypermode: Knowledge Graph Optimization for AI Applications](https://hypermode.com/blog/knowledge-graph-optimization-ai-applications)
- [SQLite Forum: SQLite and Graph Hybrids](https://www.sqliteforum.com/p/sqlite-and-graph-hybrids)
- [PingCAP: Knowledge Graph Optimization Guide 2025](https://www.pingcap.com/article/knowledge-graph-optimization-guide-2025/)
- [FalkorDB: Graph Database Guide 2026](https://www.falkordb.com/blog/graph-database-guide/)
- [Android: SQLite Performance Best Practices](https://developer.android.com/topic/performance/sqlite-performance-best-practices)

---

## 5. Memory System Evaluation Metrics

### 5.1 Three-Layer Evaluation Framework

Production RAG and memory system evaluation requires tracking three layers:

**Layer 1 -- Retrieval Quality:**

| Metric | Formula | Best For |
|--------|---------|----------|
| **NDCG@k** | `DCG@k / IDCG@k` where `DCG = SUM(rel_i / log2(i+1))` | Graded relevance with position weighting |
| **MRR@k** | `(1/|Q|) * SUM(1/rank_i)` | Single-answer queries, first-hit quality |
| **Recall@k** | `|relevant in top-k| / |total relevant|` | Completeness of retrieval |
| **Precision@k** | `|relevant in top-k| / k` | Accuracy of top-k results |

**Layer 2 -- Generation Quality:**

| Metric | What It Measures |
|--------|-----------------|
| **Faithfulness** | Is the output grounded in retrieved documents? |
| **Answer relevance** | Does the response address the query? |
| **Citation coverage** | Are claims backed with sources? |
| **Hallucination rate** | Unsupported or fabricated content |

**Layer 3 -- End-to-End:**

| Metric | What It Measures |
|--------|-----------------|
| **Correctness** | Factual accuracy of final answer |
| **Latency** | Time from query to response |
| **Token efficiency** | Tokens consumed per query |
| **Cost** | API/compute cost per query |

### 5.2 Recommended Metrics for Engram

**Primary: NDCG@5**
- Engram returns top-5 results
- Graded relevance is natural (some memories are more relevant than others)
- Position sensitivity rewards systems that place the best memory at rank 1
- **Target: NDCG@5 >= 0.8**

**Secondary: Recall@5**
- Ensures important memories are not missed entirely
- Critical for decision recall ("what did we decide about X?")

**Diagnostic: MRR@5**
- Tracks first-hit quality
- Important for factual queries ("when did X happen?")

**Token Efficiency: tokens_per_query**
- Track how many tokens the memory context consumes
- Target: 7-14K tokens per memory retrieval (Mem0 benchmark)

### 5.3 Memory-Specific Benchmarks (2025-2026)

#### LoCoMo (Long Conversational Memory)

The standard benchmark for conversational memory systems. Tests recall over long multi-session conversations (~9K tokens).

**Current leaderboard positions:**
- Mem0: 66.9% (LLM-as-Judge)
- Mem0g (graph variant): Higher accuracy at 14K tokens
- Zep: ~58% (consuming 600K+ tokens)
- LangMem: ~58%
- OpenAI full-context: Second-best after Mem0

#### LongMemEval

500 manually created questions testing five core memory abilities:
1. Information extraction
2. Multi-session reasoning
3. Temporal reasoning
4. Knowledge updates
5. Abstention (knowing when you don't know)

Uses LLM judge (Gemini-1.5-Pro) to measure accuracy against human ground truth.
Retrieval evaluated via Recall@K.

**Limitation:** Uses synthetic conversations with limited topical diversity.

#### MemBench (MemoryAgentBench)

Evaluates memory of LLM-based agents on:
- Information extraction
- Multi-hop reasoning
- Knowledge updating
- Preference following
- Temporal reasoning

**Published at ICLR 2026.**

#### MemoryBench

Broader benchmark covering:
- Recall across sessions
- Temporal reasoning
- Multi-session reasoning
- Domain breadth

### 5.4 LLM-as-Judge Approach

For systems like Engram where ground truth labels are expensive to create, LLM-as-Judge evaluation is the scalable approach:

```typescript
interface JudgeEvaluation {
  queryId: string;
  query: string;
  retrievedMemories: string[];
  judgments: {
    memoryIndex: number;
    relevanceScore: 0 | 1 | 2 | 3;  // 0=irrelevant, 3=highly relevant
    reasoning: string;
  }[];
}

async function evaluateWithLLMJudge(
  query: string,
  memories: string[],
): Promise<JudgeEvaluation> {
  const prompt = `
    Given the query: "${query}"

    Rate each retrieved memory on a 0-3 relevance scale:
    3 = Directly answers the query
    2 = Contains useful related information
    1 = Tangentially related
    0 = Not relevant

    Memories:
    ${memories.map((m, i) => `[${i}] ${m}`).join('\n')}

    Return JSON with relevanceScore and brief reasoning for each.
  `;
  // ... LLM call with structured output
}
```

**Calibration:** Always validate LLM judge against a subset of human judgments. Target >85% agreement between human and LLM relevance labels.

### 5.5 Continuous Evaluation Pipeline

```
[Test Query Set]
    |
    v
[Run Search]  -->  [Compute NDCG@5, MRR@5, Recall@5]
    |                         |
    v                         v
[LLM Judge]           [Compare to Baseline]
    |                         |
    v                         v
[Store Results]       [Alert on Regression]
```

Run evaluation:
- After each phase implementation (regression detection)
- After reranker changes (A/B comparison)
- After dream state processing (quality monitoring over time)

### 5.6 Recommendations for Engram

1. **Create a test query set** of 30-50 diverse queries with graded relevance judgments (freeze as JSON fixture).

2. **Implement NDCG@5 as primary metric** with Recall@5 and MRR@5 as secondary diagnostics.

3. **Add LLM-as-Judge evaluation** for scalable quality assessment without exhaustive manual labeling.

4. **Track token efficiency** -- measure tokens consumed by memory context per search.

5. **Benchmark against LoCoMo** if possible (requires adapting test format to Engram's API).

6. **Target NDCG@5 >= 0.8** as the quality bar. Below 0.7 indicates retrieval needs improvement.

### 5.7 Sources

- [Label Your Data: RAG Evaluation 2026 Metrics and Benchmarks](https://labelyourdata.com/articles/llm-fine-tuning/rag-evaluation)
- [Deconvolute: Metrics for Evaluation of Retrieval in RAG](https://deconvoluteai.com/blog/rag/metrics-retrieval)
- [FutureAGI: RAG Evaluation Metrics Guide 2025](https://futureagi.com/blogs/rag-evaluation-metrics-2025)
- [GetMaxim: Complete Guide to RAG Evaluation](https://www.getmaxim.ai/articles/complete-guide-to-rag-evaluation-metrics-methods-and-best-practices-for-2025/)
- [Weaviate: Evaluation Metrics for Search and Recommendation](https://weaviate.io/blog/retrieval-evaluation-metrics)
- [Pinecone: RAG Evaluation](https://www.pinecone.io/learn/series/vector-databases-in-production-for-busy-engineers/rag-evaluation/)
- [LangCopilot: RAG Evaluation Metrics Explained](https://langcopilot.com/posts/2025-09-17-rag-evaluation-101-from-recall-k-to-answer-faithfulness)
- [LoCoMo Benchmark](https://snap-research.github.io/locomo/)
- [LongMemEval GitHub](https://github.com/xiaowu0162/LongMemEval)
- [MemBench (ICLR 2026)](https://github.com/HUST-AI-HYZ/MemoryAgentBench)
- [MemoryBench (arXiv)](https://arxiv.org/html/2510.17281v4)
- [SimpleMem (arXiv, Jan 2026)](https://arxiv.org/abs/2601.02553)

---

## 6. Dream State / Background Processing Patterns

### 6.1 Production Memory Consolidation Architecture

The consensus across production systems (Microsoft Foundry, Mem0, Cognee, SimpleMem) is a four-phase background consolidation pipeline:

1. **Extract**: Identify preferences, facts, and key context from raw conversational data
2. **Consolidate**: Merge duplicates, resolve conflicts, compress representations
3. **Index**: Update embeddings, full-text indexes, and graph structures
4. **Prune**: Decay confidence, archive low-value memories

Engram's existing five-phase pipeline (INGEST, EXTRACT, CONSOLIDATE, REFLECT, PRUNE) maps well to this pattern, with the addition of REFLECT for graph-level analysis.

### 6.2 Idempotent Pipeline Design

Production agentic systems emphasize "typed and schema-validated messages; explicit capability scopes for tools; idempotent and (where feasible) transactional semantics."

**Idempotency requirements for Engram's dream daemon:**

```typescript
// 1. Content-addressed IDs prevent duplicate creation
function computeMemoryId(content: string, source: string): string {
  return createHash('sha256')
    .update(`${source}:${content}`)
    .digest('hex')
    .slice(0, 16);
}

// 2. Upsert operations are naturally idempotent
const upsert = db.prepare(`
  INSERT INTO memories (id, content, embedding, confidence, source)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    confidence = MAX(memories.confidence, excluded.confidence),
    updated_at = unixepoch()
`);

// 3. Checkpoint tracking prevents reprocessing
const markProcessed = db.prepare(`
  INSERT OR REPLACE INTO dream_pipeline_state
  (conversation_id, phase, status, completed_at)
  VALUES (?, ?, 'completed', unixepoch())
`);
```

**Key principles:**
- **Content-addressed IDs**: Same input always produces same ID, preventing duplicates
- **Upsert semantics**: INSERT OR REPLACE / ON CONFLICT ensures re-runs don't create duplicates
- **Checkpoint per conversation per phase**: Allows resumption at exact failure point
- **Phase gates**: Each phase checks prerequisites before running

### 6.3 macOS launchd Best Practices (Updated)

Engram's existing launchd research (Phase 5) is comprehensive. Additional patterns for Phase 7:

**Conditional execution based on system state:**

```xml
<!-- Only run when on AC power and idle for 5 minutes -->
<key>KeepAlive</key>
<dict>
  <key>OtherJobEnabled</key>
  <dict>
    <key>com.apple.metadata.mds</key>
    <true/>
  </dict>
</dict>
```

**Resource-aware scheduling:**

```typescript
// Check system conditions before heavy processing
async function shouldRunFullPipeline(): Promise<boolean> {
  const battery = await getBatteryStatus();
  const load = os.loadavg()[0]; // 1-minute load average

  // Skip heavy processing on battery or under load
  if (battery.isOnBattery && battery.percentage < 30) return false;
  if (load > os.cpus().length * 0.8) return false;  // >80% CPU utilization

  return true;
}
```

### 6.4 Pipeline Phase Orchestration

```typescript
interface PipelinePhase {
  name: string;
  run: (ctx: PipelineContext) => Promise<PhaseResult>;
  canSkip: (ctx: PipelineContext) => boolean;
  rollback: (ctx: PipelineContext) => Promise<void>;
}

async function runPipeline(phases: PipelinePhase[], ctx: PipelineContext): Promise<void> {
  for (const phase of phases) {
    if (phase.canSkip(ctx)) {
      logger.info('pipeline', `Skipping ${phase.name} (already complete)`);
      continue;
    }

    try {
      logger.info('pipeline', `Starting ${phase.name}`);
      const result = await phase.run(ctx);
      await checkpoint(ctx, phase.name, result);
      logger.info('pipeline', `Completed ${phase.name}`, result.stats);
    } catch (error) {
      logger.error('pipeline', `Failed in ${phase.name}`, { error });
      await phase.rollback(ctx);
      throw error;  // Let the outer handler decide: retry or abort
    }
  }
}
```

### 6.5 Cognee's Memphis Pattern

Cognee's background consolidation algorithms ("Memphis") provide a useful model:
- **Clean unused data**: Remove entities/edges never accessed
- **Reconnect nodes**: Find new connections between previously unconnected entities
- **Improve structure**: Optimize community assignments based on access patterns

The "memify" layer refines the graph through feedback loops: responses rated positively increase the weight of edges traversed to produce them. This creates a natural quality signal that Engram could adopt.

### 6.6 Two-Stage Consolidation (SimpleMem Pattern)

SimpleMem's approach is relevant for Engram's dream daemon:
- **Stage 1 (Write phase)**: Quickly store raw facts with semantic structured compression
- **Stage 2 (Background)**: Recursively consolidate related memory units into higher-level abstractions

This maps to Engram's existing architecture:
- **Stage 1**: The `remember` MCP tool stores facts immediately (real-time)
- **Stage 2**: The dream daemon consolidates, extracts entities, builds relationships, generates summaries (background)

### 6.7 Recommendations for Engram

1. **Strengthen idempotency**: Ensure all write operations use content-addressed IDs and upsert semantics. The dream daemon should be safe to run repeatedly without side effects.

2. **Add resource-awareness**: Check battery status and system load before running heavy processing phases (especially LLM inference).

3. **Implement feedback-driven edge weighting** (Cognee's memify pattern): Track which graph edges were traversed during successful retrievals and boost their weights.

4. **Add a CLEANUP phase** after PRUNE: Run ANALYZE, WAL checkpoint, and cache invalidation.

5. **Monitor pipeline health**: Log per-phase timing, memory usage, and error rates. Write health summary to `dream-health.json`.

### 6.8 Sources

- [SimpleMem: Efficient Lifelong Memory for LLM Agents (arXiv)](https://arxiv.org/html/2601.02553v1)
- [AWS: Building Smarter AI Agents -- AgentCore Long-Term Memory](https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/)
- [Unstructured: Defining the Autonomous Enterprise](https://unstructured.io/blog/defining-the-autonomous-enterprise-reasoning-memory-and-the-core-capabilities-of-agentic-ai)
- [Practical Guide for Production-Grade Agentic AI Workflows (arXiv)](https://arxiv.org/html/2512.08769v1)
- [Cognee GitHub](https://github.com/topoteretes/cognee)
- [Cognee: From RAG to Graphs (Memgraph Blog)](https://memgraph.com/blog/from-rag-to-graphs-cognee-ai-memory)
- [Mem0: Building Production-Ready AI Agents (arXiv)](https://arxiv.org/html/2504.19413v1)
- [Microsoft Foundry: Memory in Agent Service](https://devblogs.microsoft.com/foundry/whats-new-in-microsoft-foundry-dec-2025-jan-2026/)

---

## 7. Spaced Repetition in Knowledge Systems

### 7.1 FSRS Algorithm: Current State (FSRS-6)

FSRS (Free Spaced Repetition Scheduler) is the most sophisticated memory decay model currently in production use. Developed by Jarrett Ye, it is now the default algorithm in Anki (v25.07+) and RemNote, achieving **20-30% fewer reviews** than the legacy SM-2 algorithm for the same retention level.

**FSRS-6** (latest version, 21 parameters) adds two key improvements over FSRS-5:
1. A trainable forgetting curve exponent (w20) that personalizes decay per user
2. An improved same-day review formula where stability increases faster when small and slower when large

### 7.2 Core DSR Model

The algorithm models memory through three variables:

- **Difficulty (D)**: Inherent complexity of the information (range 1-10). Affects how fast stability grows after each review.
- **Stability (S)**: Time in days for retrievability to drop from 100% to 90%. Higher stability = slower decay.
- **Retrievability (R)**: Probability of successful recall at a given moment. Decays over time.

### 7.3 Key Formulas

#### Retrievability (Forgetting Curve)

**FSRS-6:**
```
R(t, S) = (1 + factor * t/S) ^ (-w20)

where:
  factor = 0.9^(-1/w20) - 1
  t = days since last review
  S = stability
  w20 = trainable exponent (range 0.1 to 0.8, default 0.1542)
```

This ensures R(S, S) = 0.9 (by definition, stability is the time for R to reach 90%).

**FSRS-5 (simplified, no trainable exponent):**
```
R(t, S) = (1 + t/(9*S)) ^ (-1)
```

**FSRS-4.5 (original):**
```
R(t, S) = (1 + 19/81 * t/S) ^ (-0.5)
```

#### Initial Stability

When a new item is first reviewed, initial stability depends on the user's rating:
```
S0(G) = w[G-1]  where G in {1=Again, 2=Hard, 3=Good, 4=Easy}
```

Default values: `[0.212, 1.2931, 2.3065, 8.2956]` days.

#### Difficulty

Initial difficulty:
```
D0(G) = w4 - exp(w5 * (G-1)) + 1
```

Difficulty update after review:
```
D' = D + deltaD * (10 - D) / 9
where deltaD = -w6 * (G - 3)
```

Mean reversion to prevent extreme values:
```
D'' = w7 * D0(4) + (1 - w7) * D'
```

#### Stability After Successful Review

```
S'_r(D, S, R, G) = S * (exp(w8) * (11-D) * S^(-w9) * (exp(w10*(1-R)) - 1) * w[15 or 16] + 1)
```

Where w15 is used for Hard ratings and w16 for Easy ratings.

#### Stability After Forgetting (Post-Lapse)

```
S'_f(D, S, R) = w11 * D^(-w12) * ((S+1)^w13 - 1) * exp(w14 * (1 - R))
```

#### Same-Day Review (FSRS-6)

```
S' = S * exp(w17 * (G - 3 + w18)) * S^(-w19)
```

This formula ensures stability increases faster when current stability is low and slower when it is high.

### 7.4 Default Parameters (FSRS-6)

```
w = [0.212, 1.2931, 2.3065, 8.2956,  // w0-w3: initial stability per rating
     6.4133, 0.8334, 3.0194, 0.001,   // w4-w7: difficulty parameters
     1.8722, 0.1666, 0.796, 1.4835,   // w8-w11: stability update parameters
     0.0614, 0.2629, 1.6483, 0.6014,  // w12-w15: forgetting/hard parameters
     1.8729, 0.5425, 0.0912, 0.0658,  // w16-w19: easy/same-day parameters
     0.1542]                           // w20: forgetting curve exponent
```

### 7.5 Adapting FSRS for Engram's Memory Confidence

Engram does not have explicit user reviews (Again/Hard/Good/Easy). Instead, we adapt the FSRS model using **access patterns** as implicit reviews:

| FSRS Concept | Engram Adaptation |
|--------------|-------------------|
| **Review rating** | Memory access = implicit "Good" review |
| **Difficulty** | Set by LLM during extraction (0.0-1.0) |
| **Stability** | Initialized based on importance; increases on access |
| **Retrievability** | Confidence score that decays over time |

**Engram's adapted formulas:**

```typescript
// Confidence decay (adapted from FSRS retrievability)
function computeConfidence(
  initialConfidence: number,
  stability: number,
  daysSinceAccess: number,
): number {
  const factor = Math.pow(0.9, -1 / 0.5) - 1; // Using fixed exponent 0.5
  return initialConfidence * Math.pow(
    1 + factor * daysSinceAccess / stability,
    -0.5
  );
}

// Stability boost on access (adapted from FSRS stability after recall)
function boostStability(
  currentStability: number,
  difficulty: number, // 0.0-1.0 mapped to FSRS 1-10
  currentConfidence: number,
): number {
  const d = 1 + difficulty * 9; // Map to FSRS range
  const stabilityGrowth = Math.exp(0.5) * (11 - d)
    * Math.pow(currentStability, -0.1)
    * (Math.exp(0.3 * (1 - currentConfidence)) - 1)
    + 1;
  return currentStability * stabilityGrowth;
}

// Maximum stability cap (prevent memories from never decaying)
const MAX_STABILITY_DAYS = 365;
```

**Key design decisions:**
- Fixed forgetting curve exponent (0.5) rather than trainable -- we don't have explicit review data to optimize
- Stability capped at 365 days -- even frequently accessed memories should eventually decay if not accessed for a year
- Access = implicit review with "Good" rating equivalent
- Multiple accesses within a short period have diminishing returns on stability boost

### 7.6 Decay-Based Pruning Thresholds

| Confidence Range | Status | Action |
|-----------------|--------|--------|
| >= 0.5 | Active | Include in all search results |
| 0.1 - 0.5 | Fading | Include only with relevance boost (similarity > 0.8) |
| 0.01 - 0.1 | Dormant | Exclude from standard search; include in explicit recall |
| < 0.01 | Archived | Move to archive table; remove from vector index |

### 7.7 Importance-Weighted Stability

Not all memories should decay at the same rate. Use importance (set during extraction) to modulate initial stability:

```typescript
function initialStability(importance: number): number {
  // importance 0.0-1.0 maps to stability 1-90 days
  // High-importance facts start with high stability
  return 1 + importance * 89;
}
```

This means:
- A trivial observation (`importance=0.1`) starts with ~10 day stability
- A key architecture decision (`importance=0.9`) starts with ~81 day stability
- Both decay at the same rate (power law), but high-importance memories take much longer to reach the pruning threshold

### 7.8 Recommendations for Engram

1. **Upgrade to FSRS-6 decay formula**: Use `R(t,S) = (1 + factor * t/S)^(-w20)` with a fixed exponent of 0.5 (between FSRS-4.5's 0.5 and FSRS-5's 1.0, well within FSRS-6's allowed range).

2. **Implement importance-weighted initial stability**: High-importance memories should have higher initial stability (slower initial decay).

3. **Track access patterns explicitly**: Add `access_count` and `last_accessed_at` columns. Each access should boost stability following the adapted FSRS recall formula.

4. **Implement tiered retrieval**: Use confidence thresholds to filter memories at different search tiers (active/fading/dormant/archived).

5. **Run decay updates during dream processing**: Batch-update all confidence scores during the PRUNE phase rather than computing on-the-fly per query.

6. **Consider future FSRS optimizer integration**: If Engram collects enough access data, the FSRS optimizer could be trained on actual access patterns to personalize the decay curve. This is an advanced optimization for when the system has sufficient data.

### 7.9 Sources

- [FSRS Algorithm Wiki (Official)](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)
- [ABC of FSRS (Official Wiki)](https://github.com/open-spaced-repetition/fsrs4anki/wiki/abc-of-fsrs)
- [Technical Explanation of FSRS (Expertium)](https://expertium.github.io/Algorithm.html)
- [Free Spaced Repetition Scheduler GitHub](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)
- [Spaced Repetition Systems Have Gotten Way Better (Domenic Denicola)](https://domenic.me/fsrs/)
- [Implementing FSRS in 100 Lines (Borretti)](https://borretti.me/article/implementing-fsrs-in-100-lines)
- [RemNote: FSRS Spaced Repetition Algorithm](https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm)
- [FSRS Technical Principles and Application Prospects (Oreate AI)](https://www.oreateai.com/blog/technical-principles-and-application-prospects-of-the-free-spaced-repetition-scheduler-fsrs/36ee752bd462235d0d5b903059bc8684)

---

## Cross-Cutting Themes and Synthesis

### Theme 1: Selective > Comprehensive

Every production memory system has converged on the same insight: **less is more**. Mem0's 7K tokens beat Zep's 600K tokens. SimpleMem achieves 30x token compression. The three-factor scoring formula (0.6 relevance, 0.25 recency, 0.15 importance) heavily favors precision over recall.

**For Engram:** Resist the temptation to return more memories. Return fewer, higher-quality memories with strong relevance scores.

### Theme 2: Background Processing is the Differentiator

Real-time memory capture (the `remember` tool) provides basic functionality, but background consolidation is what transforms raw facts into useful knowledge. Entity resolution, community detection, conflict resolution, and confidence decay all require the time budget that only background processing provides.

**For Engram:** The dream daemon is the most important architectural component. Invest in its pipeline robustness, idempotency, and monitoring.

### Theme 3: Evaluation Drives Improvement

Without measurement, optimization is guesswork. The production systems that improve fastest are the ones with automated evaluation pipelines. NDCG@5 as the primary metric, with LoCoMo-style benchmarks and LLM-as-Judge for scalable assessment.

**For Engram:** Implement the evaluation pipeline before implementing optimizations. Measure baseline, then measure after each change.

### Theme 4: SQLite is Sufficient at Engram's Scale

For a personal memory system with <100K memories and <10K entities, SQLite with proper PRAGMA configuration, WAL mode, and composite indexes handles all workloads (vector search, FTS5, graph traversal, batch updates) with sub-100ms query latency. There is no need for Neo4j, Postgres, or dedicated vector databases at this scale.

**For Engram:** Continue with SQLite. Add the PRAGMA optimizations and composite indexes from Section 4.

### Theme 5: Plugin Packaging is Ready

Claude Code's plugin system is mature enough to package Engram as a full plugin with MCP server, skills, hooks, and agents. The main constraint is the inline `mcpServers` bug (use `.mcp.json` file instead).

**For Engram:** Package as a plugin when ready for distribution. Start with `.mcp.json` for development, add skills and hooks incrementally.

---

## Implementation Priority Matrix

| Optimization | Effort | Impact | Dependencies | Priority |
|-------------|--------|--------|-------------|----------|
| PRAGMA optimizations (4.1) | Low | High | None | **P0** |
| Batch operations in dream daemon (4.2) | Low | Medium | None | **P0** |
| Three-factor scoring formula (2.4) | Medium | High | None | **P1** |
| Cross-encoder reranking (1.5) | Medium | High | @huggingface/transformers | **P1** |
| Token budget management (2.5) | Medium | High | Token counter | **P1** |
| Evaluation pipeline (5.5) | Medium | High | Test query set | **P1** |
| FSRS-6 decay upgrade (7.8) | Low | Medium | None | **P2** |
| Graph result caching (4.4) | Medium | Medium | Cache schema | **P2** |
| Composite indexes (4.3) | Low | Medium | Migration | **P2** |
| Plugin packaging (3.8) | High | Medium | Plugin structure | **P3** |
| Feedback-driven edge weighting (6.7) | Medium | Medium | Access tracking | **P3** |
| Resource-aware scheduling (6.3) | Low | Low | System APIs | **P3** |
