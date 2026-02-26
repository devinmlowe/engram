# Phase 6: Temporal Analysis & MCP Tooling Research

**Date:** 2026-02-26
**Scope:** Temporal pattern analysis, MCP tool design, graph-based reflection algorithms, incremental graph analysis
**Target stack:** TypeScript, Node.js (>=22), SQLite (better-sqlite3), graphology, MCP SDK
**Builds on:** graph-analysis-research.md, phase-6-emergence-patterns.md

---

## Table of Contents

1. [Temporal Pattern Analysis Implementation](#1-temporal-pattern-analysis-implementation)
2. [MCP Tool Design Patterns](#2-mcp-tool-design-patterns)
3. [Graph-Based Reflection Algorithms](#3-graph-based-reflection-algorithms)
4. [Incremental Graph Analysis](#4-incremental-graph-analysis)

---

## 1. Temporal Pattern Analysis Implementation

### 1.1 Reference Architectures

#### Graphiti (Zep) -- Bi-Temporal Knowledge Graph

Graphiti is the most relevant reference architecture for engram's temporal needs. It implements a **bi-temporal model** with four timestamps per edge:

| Timestamp | Timeline | Purpose |
|---|---|---|
| `valid_at` | Event time (T) | When the fact became true in the real world |
| `invalid_at` | Event time (T) | When the fact stopped being true |
| `created_at` | System time (T') | When the system ingested the fact |
| `expired_at` | System time (T') | When the fact was superseded in the system |

This dual-timeline approach enables:
- **Point-in-time queries:** "What did we know about X on date Y?"
- **Contradiction detection:** New facts that conflict with existing ones trigger invalidation via `invalid_at`
- **Provenance tracing:** Episodes (raw data) connect to entities via `MENTIONS` and `HAS_EPISODE` edges

Graphiti classifies temporal facts into three categories:
- **Static:** Single point-in-time events (e.g., "project was created on Feb 1")
- **Dynamic:** Period-bound relationships with validity windows (e.g., "user prefers Fish shell" -- valid from first mention until contradicted)
- **Atemporal:** Universally true statements without temporal bounds (e.g., "TypeScript is a programming language")

**Key takeaway for engram:** The current schema already stores `first_seen` and `last_seen` on entities and `created_at`/`updated_at` on relationships. Adding `valid_at`/`invalid_at` to relationships would enable Graphiti-style temporal queries without a major schema change.

Sources: [Graphiti GitHub](https://github.com/getzep/graphiti), [Zep Paper](https://arxiv.org/html/2501.13956v1), [Graphiti DeepWiki](https://deepwiki.com/getzep/graphiti)

#### GraphRAG (Microsoft) -- Hierarchical Community Summarization

GraphRAG's contribution to temporal analysis is indirect but important: its hierarchical community structure reveals **thematic evolution** over time when communities are compared across dream cycles.

Key pattern: community summaries at different hierarchy levels create a multi-resolution view:
- **Root (C0):** Broad themes (97% fewer tokens than source text)
- **Intermediate (C1-C2):** Mid-level topic groupings
- **Leaf (C3+):** Fine-grained sub-topics

By tracking which communities exist at each hierarchy level across dream generations, engram can detect:
- New themes emerging (community appearing at generation N that wasn't at N-1)
- Themes merging (two communities at N-1 becoming one at N)
- Themes splitting (one community fragmenting into sub-communities)

Sources: [GraphRAG Paper](https://arxiv.org/html/2404.16130v2), [GraphRAG Project](https://www.microsoft.com/en-us/research/project/graphrag/)

### 1.2 Time-Windowed Co-occurrence Analysis in Graphs

Co-occurrence analysis answers: "Which entities appear together within the same time windows?"

#### SQLite Implementation Pattern

Engram's existing schema supports temporal co-occurrence through the `source_memories` field on relationships (linking relationships to the exchanges/memories where they were extracted) and timestamps on entities.

```sql
-- Time-windowed co-occurrence: entities mentioned together within the same conversations
-- during a given time period
WITH time_window AS (
  SELECT id, conversation_id, timestamp
  FROM exchanges
  WHERE timestamp BETWEEN ? AND ?
),
-- Find entities mentioned in exchanges within this window
entity_mentions AS (
  SELECT DISTINCT
    e.id AS entity_id,
    e.name AS entity_name,
    tw.conversation_id,
    tw.timestamp
  FROM entities e
  JOIN relationships r ON (r.source_entity_id = e.id OR r.target_entity_id = e.id)
  JOIN time_window tw ON json_extract(r.source_memories, '$') LIKE '%' || tw.id || '%'
)
-- Self-join to find co-occurring entity pairs
SELECT
  a.entity_id AS entity_a,
  b.entity_id AS entity_b,
  a.entity_name AS name_a,
  b.entity_name AS name_b,
  COUNT(DISTINCT a.conversation_id) AS co_occurrence_count,
  MIN(a.timestamp) AS first_co_occurrence,
  MAX(a.timestamp) AS last_co_occurrence
FROM entity_mentions a
JOIN entity_mentions b ON a.conversation_id = b.conversation_id AND a.entity_id < b.entity_id
GROUP BY a.entity_id, b.entity_id
ORDER BY co_occurrence_count DESC;
```

#### Practical TypeScript Implementation

A more efficient approach uses entity timestamps directly, avoiding the costly JSON parsing of `source_memories`:

```typescript
interface TemporalCoOccurrence {
  entityA: string;
  entityB: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  windowDays: number;
}

/**
 * Find entity pairs that co-occur within a time window.
 * Uses the relationship table as evidence of co-occurrence,
 * with temporal filtering on entity timestamps.
 */
function findTemporalCoOccurrences(
  db: Database.Database,
  windowStart: number,
  windowEnd: number,
): TemporalCoOccurrence[] {
  const rows = db.prepare(`
    SELECT
      r.source_entity_id AS entity_a,
      r.target_entity_id AS entity_b,
      e1.name AS name_a,
      e2.name AS name_b,
      r.weight,
      r.created_at,
      r.updated_at
    FROM relationships r
    JOIN entities e1 ON e1.id = r.source_entity_id
    JOIN entities e2 ON e2.id = r.target_entity_id
    WHERE r.created_at BETWEEN ? AND ?
       OR r.updated_at BETWEEN ? AND ?
    ORDER BY r.weight DESC
  `).all(windowStart, windowEnd, windowStart, windowEnd);

  return rows.map(r => ({
    entityA: r.entity_a,
    entityB: r.entity_b,
    count: 1,  // Aggregate in caller if needed
    firstSeen: r.created_at,
    lastSeen: r.updated_at ?? r.created_at,
    windowDays: (windowEnd - windowStart) / 86400,
  }));
}
```

### 1.3 Detecting "Project Phases" from Temporal Entity Clustering

Project phases manifest as shifts in entity activity patterns -- clusters of concepts pulse with activity during specific development phases, then quiet as focus shifts elsewhere.

#### Detection Algorithm

```typescript
interface ProjectPhase {
  startDate: number;       // Unix timestamp
  endDate: number;
  dominantEntities: Array<{
    entityId: string;
    name: string;
    activityScore: number; // Relative activity in this phase
  }>;
  dominantCommunity?: number;  // Community ID most active in this phase
  label?: string;              // LLM-generated phase label
}

/**
 * Detect project phases by analyzing entity activity density
 * across sliding time windows.
 *
 * Algorithm:
 * 1. Divide timeline into overlapping windows
 * 2. For each window, compute entity activity scores
 * 3. Cluster windows by their activity profiles
 * 4. Phase boundaries occur where activity profiles shift significantly
 */
function detectProjectPhases(
  db: Database.Database,
  windowSizeDays: number = 7,
  overlapDays: number = 3,
): ProjectPhase[] {
  // Get timeline bounds
  const bounds = db.prepare(`
    SELECT MIN(first_seen) AS earliest, MAX(last_seen) AS latest
    FROM entities
  `).get() as { earliest: number; latest: number };

  const windowSize = windowSizeDays * 86400;
  const step = (windowSizeDays - overlapDays) * 86400;
  const windows: Array<{ start: number; end: number; profile: Map<string, number> }> = [];

  // Build activity profiles per window
  for (let start = bounds.earliest; start < bounds.latest; start += step) {
    const end = start + windowSize;
    const profile = computeActivityProfile(db, start, end);
    windows.push({ start, end, profile });
  }

  // Detect phase boundaries via cosine distance between consecutive profiles
  const phases: ProjectPhase[] = [];
  let currentPhaseStart = windows[0]?.start ?? bounds.earliest;
  let currentEntities = windows[0]?.profile ?? new Map();

  for (let i = 1; i < windows.length; i++) {
    const distance = cosineDistance(windows[i - 1].profile, windows[i].profile);

    if (distance > 0.5) {  // Significant shift threshold
      phases.push({
        startDate: currentPhaseStart,
        endDate: windows[i - 1].end,
        dominantEntities: topEntities(currentEntities, 10),
      });
      currentPhaseStart = windows[i].start;
      currentEntities = windows[i].profile;
    } else {
      // Merge profiles
      mergeProfiles(currentEntities, windows[i].profile);
    }
  }

  // Close final phase
  if (windows.length > 0) {
    phases.push({
      startDate: currentPhaseStart,
      endDate: windows[windows.length - 1].end,
      dominantEntities: topEntities(currentEntities, 10),
    });
  }

  return phases;
}

/**
 * Compute entity activity within a time window.
 * Activity = new relationships created + entity mentions updated.
 */
function computeActivityProfile(
  db: Database.Database,
  start: number,
  end: number,
): Map<string, number> {
  const profile = new Map<string, number>();

  // Entities with recent activity
  const entities = db.prepare(`
    SELECT id, name, mention_count
    FROM entities
    WHERE last_seen BETWEEN ? AND ?
  `).all(start, end) as Array<{ id: string; name: string; mention_count: number }>;

  for (const e of entities) {
    profile.set(e.id, e.mention_count);
  }

  // Relationships created/updated in this window
  const rels = db.prepare(`
    SELECT source_entity_id, target_entity_id
    FROM relationships
    WHERE created_at BETWEEN ? AND ? OR updated_at BETWEEN ? AND ?
  `).all(start, end, start, end) as Array<{ source_entity_id: string; target_entity_id: string }>;

  for (const r of rels) {
    profile.set(r.source_entity_id, (profile.get(r.source_entity_id) ?? 0) + 1);
    profile.set(r.target_entity_id, (profile.get(r.target_entity_id) ?? 0) + 1);
  }

  return profile;
}
```

#### SQLite Window Functions for Temporal Analysis

SQLite window functions are powerful for temporal aggregation without loading data into memory:

```sql
-- Entity activity rate: rolling 7-day entity creation count
SELECT
  date(created_at, 'unixepoch') AS day,
  COUNT(*) AS entities_created,
  SUM(COUNT(*)) OVER (
    ORDER BY date(created_at, 'unixepoch')
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS rolling_7day_count,
  AVG(COUNT(*)) OVER (
    ORDER BY date(created_at, 'unixepoch')
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS rolling_7day_avg
FROM entities
GROUP BY date(created_at, 'unixepoch')
ORDER BY day;

-- Relationship growth rate with lag comparison
SELECT
  date(created_at, 'unixepoch') AS day,
  COUNT(*) AS rels_created,
  LAG(COUNT(*), 1) OVER (ORDER BY date(created_at, 'unixepoch')) AS prev_day_count,
  CAST(COUNT(*) AS REAL) / NULLIF(
    LAG(COUNT(*), 1) OVER (ORDER BY date(created_at, 'unixepoch')), 0
  ) AS growth_ratio
FROM relationships
GROUP BY date(created_at, 'unixepoch')
ORDER BY day;

-- Community stability: entities per community across dream generations
SELECT
  tc.generation,
  tc.name,
  json_array_length(tc.entity_ids) AS entity_count,
  tc.coherence_score,
  LAG(tc.coherence_score) OVER (
    PARTITION BY tc.name ORDER BY tc.generation
  ) AS prev_coherence,
  tc.coherence_score - COALESCE(
    LAG(tc.coherence_score) OVER (PARTITION BY tc.name ORDER BY tc.generation),
    tc.coherence_score
  ) AS coherence_delta
FROM topic_clusters tc
ORDER BY tc.generation, tc.name;
```

### 1.4 Representing Temporal Patterns as Structured Data

Drawing from Graphiti's approach and temporal knowledge graph research, here is a recommended structure for temporal pattern data:

```typescript
/**
 * Temporal pattern types that the dream cycle's reflect phase
 * can detect and store.
 */
type TemporalPatternType =
  | "entity_burst"        // Sudden increase in entity activity
  | "community_shift"     // Community membership changed significantly
  | "relationship_surge"  // Rapid relationship creation between entities
  | "phase_transition"    // Shift from one project phase to another
  | "topic_emergence"     // New topic cluster appearing
  | "topic_decay"         // Topic cluster losing coherence/activity
  | "bridge_formation"    // New bridge entity connecting previously separate communities
  | "seasonal_recurrence" // Pattern that repeats at regular intervals

interface TemporalPattern {
  id: string;
  type: TemporalPatternType;
  detectedAt: number;           // When the pattern was detected (dream cycle timestamp)
  timespan: {
    start: number;
    end: number;
  };
  affectedEntities: string[];   // Entity IDs involved
  affectedCommunities?: number[]; // Community IDs involved
  metrics: Record<string, number>; // Type-specific metrics
  description: string;           // LLM-generated human-readable description
  confidence: number;            // 0-1 confidence in the pattern
  generation: number;            // Dream generation when detected
}

/**
 * Schema addition for temporal_patterns table.
 * Complements the existing topic_clusters table.
 */
const TEMPORAL_PATTERNS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS temporal_patterns (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    timespan_start INTEGER NOT NULL,
    timespan_end INTEGER NOT NULL,
    affected_entities TEXT,      -- JSON array of entity IDs
    affected_communities TEXT,   -- JSON array of community IDs
    metrics TEXT,                -- JSON object of type-specific metrics
    description TEXT,
    confidence REAL,
    generation INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_temporal_patterns_type ON temporal_patterns(type);
  CREATE INDEX IF NOT EXISTS idx_temporal_patterns_generation ON temporal_patterns(generation);
  CREATE INDEX IF NOT EXISTS idx_temporal_patterns_timespan
    ON temporal_patterns(timespan_start, timespan_end);
`;
```

### 1.5 Recommended Approach for Engram

**Phase 1 (Minimal viable temporal analysis):**
1. Add `valid_at` and `invalid_at` columns to the relationships table (nullable, defaulting to `created_at` and NULL respectively)
2. Track community membership changes across dream generations by comparing topic_clusters between consecutive generations
3. Detect entity bursts via simple threshold on `mention_count` growth rate

**Phase 2 (Full temporal patterns):**
1. Add the `temporal_patterns` table
2. Implement the project phase detection algorithm using entity activity profiles
3. Use SQLite window functions for rolling aggregates
4. Generate temporal pattern descriptions via LLM during the reflect phase

**Phase 3 (Bi-temporal model):**
1. Full Graphiti-style bi-temporal model on edges
2. Point-in-time queries for historical graph state
3. Temporal contradiction detection during entity extraction

Sources: [Graphiti Architecture](https://deepwiki.com/getzep/graphiti), [Temporal Agents Cookbook](https://developers.openai.com/cookbook/examples/partners/temporal_agents_with_knowledge_graphs/temporal_agents), [SQLite Window Functions](https://sqlite.org/windowfunctions.html), [Temporal Community Evolution](https://appliednetsci.springeropen.com/articles/10.1007/s41109-023-00592-1)

---

## 2. MCP Tool Design Patterns

### 2.1 Current Engram Tool Inventory

Engram currently exposes four MCP tools:

| Tool | Type | Purpose | Annotations |
|---|---|---|---|
| `recall` | Read-only | Hybrid search across memory stores | readOnlyHint=true, idempotentHint=true |
| `remember` | Write | Store new semantic memory with dedup | readOnlyHint=false, idempotentHint=false |
| `show` | Read-only | Read conversation content by path | readOnlyHint=true, idempotentHint=true |
| `explore` | Read-only | Graph neighborhood traversal | readOnlyHint=true, idempotentHint=true |

### 2.2 Tool Annotations Best Practices (2025-11 MCP Spec)

The MCP 2025-11-25 specification defines five annotation properties:

| Annotation | Type | Default | When to Use |
|---|---|---|---|
| `title` | string | - | Always. Human-readable name for UI display |
| `readOnlyHint` | boolean | false | Set true for tools that don't modify state |
| `destructiveHint` | boolean | true | Set false for non-destructive write tools (only meaningful when readOnlyHint=false) |
| `idempotentHint` | boolean | false | Set true only if repeated calls with same args truly have no additional effect |
| `openWorldHint` | boolean | true | Set false for tools that only interact with local/closed systems |

**Critical guidance from the spec:** Tool annotations are *hints* and MUST NOT be relied upon for security decisions. Clients MUST consider annotations untrusted unless from a trusted server.

**How clients use annotations:**
- ChatGPT Developer Mode treats tools with `readOnlyHint=true` as non-write for UI confirmation purposes, reducing friction for benign operations
- Claude Code uses annotations to categorize tool risk levels
- IDE integrations may auto-approve idempotent read-only tools

**Engram-specific recommendations:**
- All engram tools operate on a local SQLite database: `openWorldHint: false` for all
- `recall` and `explore` are genuinely idempotent read-only operations
- `remember` is non-destructive (inserts or updates) but not idempotent (dedup may merge differently based on state)
- Future tools like `reflect` (triggering dream analysis) should be `readOnlyHint: false, destructiveHint: false, idempotentHint: true` since re-running produces the same analysis state

Sources: [MCP Tools Spec (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [MCP Annotations Guide](https://blog.marcnuri.com/mcp-tool-annotations-introduction)

### 2.3 Output Formatting: XML vs JSON vs Markdown

Research from Block's MCP server design playbook and the MCP community provides clear guidance:

#### Format Comparison

| Format | Token Efficiency | LLM Parse Reliability | Machine Readability | Recommended For |
|---|---|---|---|---|
| **Markdown** | Best | Excellent | Low | Narrative results, descriptions |
| **XML** | Good | Excellent | Good | Structured hierarchical data for LLM consumption |
| **JSON** | Worst | Good (but grammar errors common) | Excellent | Machine-to-machine, structured content |

**Block's guidance:** "Prefer Markdown or XML over raw JSON since they're typically more token efficient." LLMs can struggle with strict JSON grammar (missing quotes, commas), while XML and Markdown are more forgiving for both generation and parsing.

**MCP 2025-11 Structured Content:** The spec now supports `structuredContent` alongside `content`, allowing tools to return both a machine-readable JSON object and a human/LLM-readable text representation:

```typescript
// New pattern: dual output for machine and LLM consumption
return {
  content: [
    { type: "text", text: formattedXmlOutput }  // For LLM
  ],
  structuredContent: jsonPayload  // For programmatic consumers
};
```

#### Engram's Current Approach (Analysis)

Engram currently uses:
- **recall:** XML-formatted output via `formatRecallXml()` -- good choice, provides structured hierarchy
- **explore:** XML-formatted output with entity/relationship hierarchy -- good choice
- **show:** Markdown-formatted output -- appropriate for conversation display
- **remember:** Plain text response -- sufficient for simple confirmation

**Recommendation:** Keep XML for structured graph/memory data (recall, explore). Add `structuredContent` JSON for programmatic consumers when the MCP SDK is updated. Consider adding `outputSchema` definitions per the 2025-11 spec for tools that return structured data.

Sources: [Block's MCP Playbook](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers), [MCP Output Formatting](https://nodecodestudio.com/the-best-way-to-format-mcp-tool-output-for-multi-call-prompting-mcp/), [MCP Tools Spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

### 2.4 Tool Composition Patterns

#### Pattern 1: Workflow-First Design (Block)

Block's key insight: "Design top-down from workflows, not bottom-up from API endpoints." Rather than exposing granular graph operations, combine multiple internal steps into cohesive tools that map to user tasks.

Engram already does this well -- `recall` combines embedding, vector search, FTS, RRF fusion, and formatting. `explore` combines entity lookup, traversal, and community context.

#### Pattern 2: Consolidated Read Tools with Categorical Parameters

Instead of separate tools for each data source, use a single tool with a category parameter:

```typescript
// Instead of: search_episodic, search_semantic, search_graph
// Use: recall with sources parameter
{
  name: "recall",
  inputSchema: {
    properties: {
      sources: {
        type: "array",
        items: { enum: ["episodic", "semantic", "graph"] },
        default: ["episodic", "semantic"],
      }
    }
  }
}
```

Engram already implements this pattern with the `sources` parameter on `recall`.

#### Pattern 3: Single Risk Level Per Tool

Block recommends: "Build tools with one risk level only: either read-only or non-read." Never mix read and write operations in the same tool, as this confuses permission management.

Current engram tools follow this pattern -- `recall`/`explore`/`show` are read-only, `remember` is write.

#### Pattern 4: Token-Conscious Output with Budget Parameter

Engram's `budget` parameter on `recall` is an exemplary pattern. Block also recommends:
- Pre-check output size before returning
- Provide alternatives when output exceeds budget ("Use `show` with startLine/endLine for full content")
- Implement truncation with clear notes about omitted content

#### Pattern 5: Tool Output as Context for Other Tools

Design tool outputs to be useful as inputs to subsequent tool calls:

```
recall("graph analysis patterns") -> returns entity IDs
explore(entity: "graphology") -> uses entity from recall results
show(path: "/path/from/recall") -> drills into specific conversation
```

Engram's tools already support this workflow naturally.

### 2.5 Proposed New Tools for Phase 6

Based on the temporal analysis and reflection capabilities being added:

```typescript
// 1. Graph Health / Status Tool
{
  name: "graph_status",
  title: "Knowledge Graph Status",
  description: "Show knowledge graph statistics, recent changes, community structure, " +
    "and health metrics. Use to understand the current state of accumulated knowledge.",
  inputSchema: {
    type: "object",
    properties: {
      aspect: {
        type: "string",
        enum: ["overview", "communities", "temporal", "health"],
        default: "overview",
        description: "Which aspect of the graph to report on"
      }
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Knowledge Graph Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

// 2. Temporal Patterns Tool
{
  name: "timeline",
  title: "Knowledge Timeline",
  description: "View temporal patterns in knowledge evolution. Shows project phases, " +
    "entity activity trends, community changes, and emerging topics over time.",
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: "Optional entity name to focus the timeline on"
      },
      days: {
        type: "number",
        minimum: 1,
        maximum: 365,
        default: 30,
        description: "Number of days to look back"
      }
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Knowledge Timeline",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}
```

**Design rationale:**
- Both are read-only, idempotent, and closed-world (local SQLite only)
- `graph_status` consolidates multiple read operations into one tool with an `aspect` parameter (following Block's consolidation pattern)
- `timeline` provides temporal analysis without requiring the caller to understand the underlying implementation
- Neither tool triggers computation -- they report on pre-computed results from dream cycles

### 2.6 Error Handling Best Practices

The MCP spec distinguishes two error types:

1. **Protocol errors** (JSON-RPC level): For unknown tools, malformed requests. Clients MAY surface these to models.
2. **Tool execution errors** (`isError: true` in result): For business logic failures. Clients SHOULD surface these for model self-correction.

**Actionable error pattern (from Block):**

```typescript
// Bad: vague error
return { content: [{ type: "text", text: "Entity not found" }], isError: true };

// Good: actionable error with recovery guidance
return {
  content: [{
    type: "text",
    text: `Entity not found: "${query}". Try exploring related terms with recall, ` +
      `or check if the entity exists under an alias.`
  }],
  isError: true
};
```

Engram's current error handling returns `error.message` directly. This could be improved with recovery suggestions.

Sources: [Block's MCP Playbook](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers), [MCP Spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/)

---

## 3. Graph-Based Reflection Algorithms

### 3.1 Generating Higher-Order Observations from Graph Topology

The goal of graph reflection is to produce "insights about insights" -- observations about the structure and evolution of the knowledge graph itself, rather than about the raw data.

#### GraphRAG's Community Report Pattern

GraphRAG generates structured community reports that include:
1. **Title:** Representative named entities
2. **Executive summary:** Structure and relationship overview
3. **Impact severity rating:** 0-10 scale
4. **Key findings:** 5-10 insights, each with summary and grounded explanations
5. **Citation references:** Record IDs for provenance

The generation process prioritizes elements by combined node degree (source + target), ensuring the most connected entities get described first.

**Applicable pattern for engram:** During the reflect phase, for each community detected by Louvain, generate a structured report that includes:
- Community statistics (size, density, coherence)
- Bridge entities connecting to other communities
- Temporal dynamics (growth rate, recent additions)
- Notable patterns (entity clusters, relationship types)

#### Reflection Prompt Pattern

```typescript
interface ReflectionInput {
  // Community topology metrics
  communitySize: number;
  coherenceScore: number;
  modularity: number;

  // Community content
  entities: Array<{ name: string; type: string; mentions: number }>;
  relationships: Array<{ source: string; target: string; type: string; weight: number }>;

  // Bridge connections to other communities
  bridges: Array<{ entity: string; connectedCommunities: string[] }>;

  // Temporal context
  newEntitiesSinceLastCycle: string[];
  removedEntitiesSinceLastCycle: string[];
  growthRate: number;  // % change in entity count
}
```

**LLM prompt for higher-order observations:**

```
You are analyzing a knowledge graph community to identify higher-order patterns
and insights. Given the following community data, generate observations about:

1. **Thematic coherence:** Is this a well-defined topic or a grab-bag? Why?
2. **Evolution trajectory:** Based on growth rate and recent additions,
   where is this topic heading?
3. **Cross-domain connections:** What do the bridge entities reveal about
   how this topic relates to others?
4. **Knowledge gaps:** What entities or relationships seem to be missing
   based on the existing structure?
5. **Actionable insights:** What should the user know about this topic area?

Community data:
{{communityData}}

Respond in JSON:
{
  "observations": [
    {
      "type": "coherence|evolution|cross_domain|gap|insight",
      "observation": "...",
      "confidence": 0.0-1.0,
      "affected_entities": ["entity1", "entity2"]
    }
  ]
}
```

### 3.2 Emergent Theme Detection

Emergent themes are topics that the knowledge graph "discovers" through structural analysis rather than explicit labeling.

#### Detection Algorithm

```typescript
interface EmergentTheme {
  id: string;
  name: string;
  description: string;
  evidence: {
    communityId: number;
    entityIds: string[];
    coherenceScore: number;
    bridgeEntities: string[];
  };
  noveltyScore: number;   // How different from previous generations
  stabilityScore: number; // Consistency across recent generations
}

/**
 * Detect emergent themes by comparing current community structure
 * to previous generations.
 *
 * A theme is "emergent" if:
 * 1. Its community is new (not present in previous generation), OR
 * 2. It has grown significantly (>30% entity increase), OR
 * 3. Its coherence has improved (crossing a threshold)
 */
function detectEmergentThemes(
  db: Database.Database,
  currentCommunities: CommunityResult[],
  previousCommunities: CommunityResult[],
): EmergentTheme[] {
  const themes: EmergentTheme[] = [];

  for (const community of currentCommunities) {
    // Find best matching previous community (by entity overlap)
    const overlap = previousCommunities.map(prev => ({
      prev,
      jaccard: jaccardSimilarity(
        new Set(community.entityIds),
        new Set(prev.entityIds)
      ),
    }));
    overlap.sort((a, b) => b.jaccard - a.jaccard);

    const bestMatch = overlap[0];

    if (!bestMatch || bestMatch.jaccard < 0.3) {
      // New community -- fully emergent
      themes.push({
        id: crypto.randomUUID(),
        name: `New theme (${community.entityIds.length} entities)`,
        description: "",  // Filled by LLM
        evidence: {
          communityId: community.communityId,
          entityIds: community.entityIds,
          coherenceScore: community.coherenceScore,
          bridgeEntities: [],
        },
        noveltyScore: 1.0,
        stabilityScore: 0.0,
      });
    } else {
      // Check growth
      const growth = community.entityIds.length / bestMatch.prev.entityIds.length;
      const coherenceImprovement = community.coherenceScore - bestMatch.prev.coherenceScore;

      if (growth > 1.3 || coherenceImprovement > 0.15) {
        themes.push({
          id: crypto.randomUUID(),
          name: `Growing theme (${Math.round((growth - 1) * 100)}% growth)`,
          description: "",
          evidence: {
            communityId: community.communityId,
            entityIds: community.entityIds,
            coherenceScore: community.coherenceScore,
            bridgeEntities: [],
          },
          noveltyScore: 1 - bestMatch.jaccard,
          stabilityScore: bestMatch.jaccard,
        });
      }
    }
  }

  return themes;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? intersection.size / union.size : 0;
}
```

### 3.3 Quality Metrics for Topic Clusters and MOCs

#### Cluster Quality Metrics

Drawing from graph clustering evaluation research and the GraphRAG approach:

```typescript
interface ClusterQualityMetrics {
  // Structural metrics
  coherence: number;        // Internal/total edge ratio (already implemented)
  density: number;          // Actual edges / possible edges
  conductance: number;      // Cut edges / min(total degree inside, outside)
  modularity: number;       // Contribution to overall modularity

  // Content metrics
  entityTypeHomogeneity: number;  // Entropy-based type diversity
  descriptionCoverage: number;    // % of entities with descriptions
  averageMentionCount: number;    // Activity level

  // Temporal metrics
  ageSpan: number;          // Days between oldest and newest entity
  recentActivityRatio: number; // % of entities active in last 7 days
  growthRate: number;       // % change since last generation

  // Composite
  overallQuality: number;   // Weighted combination
}

function computeClusterQuality(
  graph: Graph,
  communityNodes: string[],
  db: Database.Database,
): ClusterQualityMetrics {
  const nodeSet = new Set(communityNodes);
  const n = communityNodes.length;

  // Density: actual edges / maximum possible edges
  let internalEdges = 0;
  for (const node of communityNodes) {
    if (!graph.hasNode(node)) continue;
    graph.forEachEdge(node, (_e, _a, source, target) => {
      if (nodeSet.has(source) && nodeSet.has(target)) {
        internalEdges += 0.5; // Undirected: count each edge once
      }
    });
  }
  const maxEdges = n * (n - 1) / 2;
  const density = maxEdges > 0 ? internalEdges / maxEdges : 0;

  // Conductance: cut edges / min volume
  let cutEdges = 0;
  let internalDegree = 0;
  for (const node of communityNodes) {
    if (!graph.hasNode(node)) continue;
    graph.forEachEdge(node, (_e, _a, source, target) => {
      const neighbor = source === node ? target : source;
      if (nodeSet.has(neighbor)) {
        internalDegree++;
      } else {
        cutEdges++;
      }
    });
  }
  const externalDegree = graph.size * 2 - internalDegree - cutEdges;
  const conductance = Math.min(internalDegree + cutEdges, externalDegree + cutEdges) > 0
    ? cutEdges / Math.min(internalDegree + cutEdges, externalDegree + cutEdges)
    : 0;

  // Entity type homogeneity (inverse entropy)
  const typeCounts = new Map<string, number>();
  for (const nodeId of communityNodes) {
    if (!graph.hasNode(nodeId)) continue;
    const type = graph.getNodeAttribute(nodeId, "type") as string;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of typeCounts.values()) {
    const p = count / n;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(typeCounts.size || 1);
  const entityTypeHomogeneity = maxEntropy > 0 ? 1 - (entropy / maxEntropy) : 1;

  return {
    coherence: computeCoherence(graph, communityNodes),
    density,
    conductance,
    modularity: 0, // Computed at graph level
    entityTypeHomogeneity,
    descriptionCoverage: 0, // Computed from DB
    averageMentionCount: 0, // Computed from DB
    ageSpan: 0,
    recentActivityRatio: 0,
    growthRate: 0,
    overallQuality: 0, // Weighted combination
  };
}
```

#### Composite Quality Score

```typescript
function computeOverallQuality(metrics: ClusterQualityMetrics): number {
  return (
    0.30 * metrics.coherence +
    0.15 * metrics.density +
    0.15 * (1 - metrics.conductance) +  // Lower conductance is better
    0.10 * metrics.entityTypeHomogeneity +
    0.15 * metrics.descriptionCoverage +
    0.15 * metrics.recentActivityRatio
  );
}
```

### 3.4 Graph Evolution Metrics

These metrics track how the graph changes over time, providing input for the reflection phase:

```typescript
interface GraphEvolutionMetrics {
  // Growth metrics
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  netGrowthRate: number;     // (added - removed) / previous total

  // Structural stability
  communityCount: number;
  communityCountDelta: number;
  averageCoherence: number;
  averageCoherenceDelta: number;
  modularityDelta: number;

  // Entity dynamics
  mostActiveEntities: Array<{ id: string; name: string; newConnections: number }>;
  newBridgeEntities: Array<{ id: string; name: string; communitySpan: number }>;
  isolatedEntities: string[];  // Entities with no relationships

  // Attention signals
  regionsNeedingAttention: Array<{
    communityId: number;
    reason: "rapid_growth" | "low_coherence" | "high_conductance" | "stale";
    severity: number;  // 0-1
    details: string;
  }>;
}
```

### 3.5 Detecting When a Graph Region "Needs Attention"

A graph region needs attention when it exhibits one or more of:

1. **Rapid growth without coherence gain:** Many entities added but coherence score unchanged or declining. Suggests the community is becoming a grab-bag.

2. **Low coherence:** Below a threshold (e.g., 0.3), the community may not represent a real topic.

3. **High conductance:** Too many connections leaving the community relative to internal connections. May indicate the community should be split.

4. **Staleness:** No activity within the community for N dream cycles.

5. **Bridge overload:** A single entity bridges 4+ communities, suggesting it may need disambiguation or the communities need restructuring.

```typescript
function identifyAttentionRegions(
  currentAnalysis: GraphAnalysisResult,
  previousAnalysis: GraphAnalysisResult | null,
): Array<{ communityId: number; reason: string; severity: number; details: string }> {
  const alerts: Array<{ communityId: number; reason: string; severity: number; details: string }> = [];

  for (const community of currentAnalysis.communities) {
    // Low coherence
    if (community.coherenceScore < 0.3) {
      alerts.push({
        communityId: community.communityId,
        reason: "low_coherence",
        severity: 1 - community.coherenceScore,
        details: `Community ${community.communityId} has coherence ${community.coherenceScore.toFixed(3)} ` +
          `(${community.entityIds.length} entities). May not represent a well-defined topic.`,
      });
    }

    // Rapid growth without coherence gain
    if (previousAnalysis) {
      const prev = previousAnalysis.communities.find(c =>
        jaccardSimilarity(new Set(c.entityIds), new Set(community.entityIds)) > 0.5
      );
      if (prev) {
        const growth = community.entityIds.length / prev.entityIds.length;
        const coherenceChange = community.coherenceScore - prev.coherenceScore;
        if (growth > 1.5 && coherenceChange < 0.05) {
          alerts.push({
            communityId: community.communityId,
            reason: "rapid_growth",
            severity: Math.min(1, (growth - 1) * 0.5),
            details: `Community grew ${Math.round((growth - 1) * 100)}% but coherence ` +
              `changed only ${coherenceChange.toFixed(3)}. May be accumulating unrelated entities.`,
          });
        }
      }
    }
  }

  // Bridge overload detection
  for (const bridge of currentAnalysis.bridgeEntities) {
    if (bridge.communitySpan >= 4) {
      alerts.push({
        communityId: -1,
        reason: "bridge_overload",
        severity: Math.min(1, bridge.communitySpan / 6),
        details: `Entity ${bridge.entityId} spans ${bridge.communitySpan} communities. ` +
          `May need disambiguation or community restructuring.`,
      });
    }
  }

  return alerts.sort((a, b) => b.severity - a.severity);
}
```

Sources: [GraphRAG Paper](https://arxiv.org/html/2404.16130v2), [Knowledge Graph Quality Metrics](https://arxiv.org/abs/2211.10011), [Cluster Quality Evaluation](https://www.researchgate.net/publication/310048843_Defining_Quality_Metrics_for_Graph_Clustering_Evaluation), [Community Stability (PNAS)](https://www.pnas.org/doi/10.1073/pnas.0903215107)

---

## 4. Incremental Graph Analysis

### 4.1 The Problem

When new entities and relationships are added during dream-state extraction, the question is whether to recompute all communities from scratch or update them incrementally.

For engram's current scale (100-10K nodes), full Louvain recomputation is fast (50-100ms). However, as the graph grows, incremental approaches become important for two reasons:
1. **Performance:** Full recomputation becomes expensive at 100K+ nodes
2. **Stability:** Incremental updates preserve community identity across generations, making temporal tracking meaningful

### 4.2 DF Louvain: State of the Art for Incremental Community Detection

The Dynamic Frontier (DF) Louvain algorithm (2024) is the most recent and performant approach for incremental community detection.

#### Algorithm Overview

Given a batch update of edge deletions and insertions:

1. **Mark affected vertices:** Endpoints of edge deletions within the same community and endpoints of edge insertions across different communities are marked as affected.

2. **Frontier expansion:** When a vertex changes communities during processing, all its neighbors are marked as affected. The migrated vertex itself is pruned from the affected set.

3. **Incremental weight updates:** Previous weighted-degrees and total edge weights of communities are incrementally adjusted based on the batch update, rather than recomputed from scratch.

4. **Single-pass processing:** The dynamic frontier approach is applied exclusively to Louvain's first pass, where most community changes occur.

#### Performance

On real-world dynamic graphs:
- **179x speedup** vs. Static Louvain
- **7.2x speedup** vs. Naive-dynamic Louvain
- **5.3x speedup** vs. Delta-screening

These benchmarks are on billion-scale graphs. For engram's scale, the absolute speedup is less dramatic (since static Louvain is already fast), but the approach becomes valuable as the graph grows beyond 50K nodes.

#### Applicability to Engram

DF Louvain is not available as a JavaScript library. However, its principles can be adapted:

```typescript
/**
 * Simplified incremental community update inspired by DF Louvain.
 *
 * Strategy:
 * 1. Track which entities/relationships changed since last analysis
 * 2. Identify affected communities (those containing changed entities)
 * 3. For small changes (<10% of graph), use label propagation on affected regions
 * 4. For large changes (>10% of graph), do full Louvain recomputation
 */
function incrementalCommunityUpdate(
  graph: Graph,
  previousCommunities: Map<string, number>,
  changedNodes: Set<string>,
  changedEdges: Set<string>,
): { communities: Map<string, number>; wasFullRecompute: boolean } {
  const totalNodes = graph.order;
  const changeRatio = changedNodes.size / totalNodes;

  if (changeRatio > 0.1 || previousCommunities.size === 0) {
    // Full recomputation
    const result = detectCommunities(graph);
    return { communities: result.communities, wasFullRecompute: true };
  }

  // Incremental: label propagation on affected neighborhoods
  const communities = new Map(previousCommunities);
  const affected = new Set<string>();

  // Mark changed nodes and their neighbors as affected
  for (const nodeId of changedNodes) {
    affected.add(nodeId);
    if (graph.hasNode(nodeId)) {
      graph.forEachNeighbor(nodeId, (neighbor) => {
        affected.add(neighbor);
      });
    }
  }

  // Label propagation on affected nodes only
  let changed = true;
  let iterations = 0;
  const maxIterations = 10;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const nodeId of affected) {
      if (!graph.hasNode(nodeId)) continue;

      // Count community labels in neighborhood
      const labelCounts = new Map<number, number>();
      graph.forEachNeighbor(nodeId, (neighbor) => {
        const label = communities.get(neighbor);
        if (label !== undefined) {
          const weight = graph.hasEdge(nodeId, neighbor)
            ? (graph.getEdgeAttribute(graph.edge(nodeId, neighbor), "weight") as number ?? 1)
            : 1;
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + weight);
        }
      });

      // Adopt majority label
      let bestLabel = communities.get(nodeId) ?? 0;
      let bestCount = 0;
      for (const [label, count] of labelCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestLabel = label;
        }
      }

      if (bestLabel !== communities.get(nodeId)) {
        communities.set(nodeId, bestLabel);
        changed = true;
        // Expand affected set to neighbors of changed node
        graph.forEachNeighbor(nodeId, (neighbor) => {
          affected.add(neighbor);
        });
      }
    }
  }

  return { communities, wasFullRecompute: false };
}
```

Sources: [DF Louvain Paper](https://arxiv.org/html/2404.19634v3), [Delta-Screening](https://www.researchgate.net/publication/350335965_Delta-Screening_A_Fast_and_Efficient_Technique_to_Update_Communities_in_Dynamic_Graphs), [Incremental Community Discovery](https://link.springer.com/article/10.1007/s10115-019-01422-6)

### 4.3 Graphiti's Incremental Community Approach

Graphiti uses a pragmatic two-tier approach:

1. **Full rebuild:** `build_communities()` uses the Leiden algorithm to create optimal communities from scratch. Removes all existing communities first.

2. **Incremental update:** When `update_communities=True` is passed to `add_episode()`, new nodes are assigned to communities using label propagation -- the node surveys its neighbors' communities and adopts the plurality assignment.

3. **Periodic refresh:** They recommend periodically calling `build_communities()` because incremental updates gradually drift from optimal configurations.

**Direct parallel to engram:**
- Full Louvain runs during dream cycles (~every night)
- If real-time community assignment is needed (during `remember` or entity extraction), use label propagation to assign new entities to existing communities
- The dream cycle's reflect phase serves as the periodic full refresh

### 4.4 Efficient Bridge Detection Updates

Bridge detection currently requires full betweenness centrality computation (O(n*m)). For incremental updates:

#### Strategy 1: Cached Betweenness with Lazy Invalidation

```typescript
/**
 * Maintain a cached betweenness map. Invalidate only when
 * the set of changed nodes/edges exceeds a threshold.
 */
class IncrementalBridgeDetector {
  private cachedBetweenness: Map<string, number> = new Map();
  private lastComputeGeneration: number = 0;
  private dirtyNodes: Set<string> = new Set();

  markDirty(nodeId: string): void {
    this.dirtyNodes.add(nodeId);
  }

  getBridgeEntities(
    graph: Graph,
    communities: Map<string, number>,
    currentGeneration: number,
  ): Array<{ entityId: string; bridgeScore: number }> {
    const dirtyRatio = this.dirtyNodes.size / graph.order;

    if (dirtyRatio > 0.1 || currentGeneration > this.lastComputeGeneration + 3) {
      // Full recompute
      this.cachedBetweenness = computeBetweenness(graph);
      this.dirtyNodes.clear();
      this.lastComputeGeneration = currentGeneration;
    }
    // Use cached values, even if slightly stale
    return detectBridgeEntities(graph, communities);
  }
}
```

#### Strategy 2: Approximate Bridge Detection via Community Boundary

For real-time queries (not dream cycles), a faster approximation:

```typescript
/**
 * Approximate bridge detection: nodes whose neighbors
 * span multiple communities, weighted by degree.
 * O(n) instead of O(n*m).
 */
function approximateBridgeEntities(
  graph: Graph,
  communities: Map<string, number>,
  topK: number = 20,
): Array<{ entityId: string; communitySpan: number; degree: number }> {
  const candidates: Array<{ entityId: string; communitySpan: number; degree: number }> = [];

  graph.forEachNode((nodeId) => {
    const nodeCommunity = communities.get(nodeId);
    if (nodeCommunity === undefined) return;

    const neighborCommunities = new Set<number>();
    neighborCommunities.add(nodeCommunity);

    graph.forEachNeighbor(nodeId, (neighbor) => {
      const nc = communities.get(neighbor);
      if (nc !== undefined) neighborCommunities.add(nc);
    });

    if (neighborCommunities.size > 1) {
      candidates.push({
        entityId: nodeId,
        communitySpan: neighborCommunities.size,
        degree: graph.degree(nodeId),
      });
    }
  });

  // Sort by community span * degree (proxy for bridge importance)
  candidates.sort((a, b) => (b.communitySpan * b.degree) - (a.communitySpan * a.degree));

  return candidates.slice(0, topK);
}
```

### 4.5 Graphology Event System for Change Tracking

Graphology's event system can track graph mutations for incremental analysis:

```typescript
import Graph from "graphology";

const graph = new Graph({ type: "undirected" });
const changedNodes = new Set<string>();
const changedEdges = new Set<string>();

// Track all mutations
graph.on("nodeAdded", ({ key }) => {
  changedNodes.add(key);
});

graph.on("edgeAdded", ({ key, source, target }) => {
  changedEdges.add(key);
  changedNodes.add(source);
  changedNodes.add(target);
});

graph.on("nodeDropped", ({ key }) => {
  changedNodes.add(key);
});

graph.on("edgeDropped", ({ key, source, target }) => {
  changedEdges.add(key);
  changedNodes.add(source);
  changedNodes.add(target);
});

// After processing a batch of updates:
function getAndResetChanges(): { nodes: Set<string>; edges: Set<string> } {
  const result = {
    nodes: new Set(changedNodes),
    edges: new Set(changedEdges),
  };
  changedNodes.clear();
  changedEdges.clear();
  return result;
}
```

This event-driven approach integrates naturally with engram's existing `loadGraph()` pattern. The graph can be kept in memory between dream phases (ingest -> extract -> consolidate -> reflect) with change tracking active, then the reflect phase uses the accumulated change set to decide between incremental and full recomputation.

### 4.6 Delta-Based Graph Analysis Patterns

#### Change Detection via SQLite

Track modifications since the last dream cycle using the checkpoint system:

```sql
-- New entities since last analysis
SELECT id, name, type, created_at
FROM entities
WHERE created_at > (
  SELECT MAX(processed_at) FROM dream_checkpoints
  WHERE phase = 'reflect'
);

-- Modified relationships since last analysis
SELECT id, source_entity_id, target_entity_id, type, weight
FROM relationships
WHERE updated_at > (
  SELECT MAX(processed_at) FROM dream_checkpoints
  WHERE phase = 'reflect'
)
OR created_at > (
  SELECT MAX(processed_at) FROM dream_checkpoints
  WHERE phase = 'reflect'
);
```

#### Warm-Start Louvain Pattern

Graphology's Louvain does not natively support warm-starting from previous assignments. However, a warm-start effect can be achieved by pre-assigning community attributes:

```typescript
/**
 * Warm-start Louvain by initializing nodes with previous community
 * assignments. While graphology-communities-louvain doesn't read
 * initial assignments, this helps with consistent community IDs
 * across generations.
 *
 * Strategy: after Louvain runs, remap new community IDs to best-match
 * previous IDs using Jaccard similarity on membership sets.
 */
function stableLouvain(
  graph: Graph,
  previousCommunities?: Map<string, number>,
  resolution?: number,
): { communities: Map<string, number>; count: number; modularity: number } {
  const result = detectCommunities(graph, resolution);

  if (!previousCommunities || previousCommunities.size === 0) {
    return result;
  }

  // Build current and previous community membership sets
  const currentGroups = groupByCommunity(result.communities);
  const previousGroups = groupByCommunity(previousCommunities);

  // Find best mapping from new IDs to old IDs
  const idMapping = new Map<number, number>();
  const usedPreviousIds = new Set<number>();

  for (const [newId, newMembers] of currentGroups) {
    let bestPrevId = -1;
    let bestJaccard = 0;

    for (const [prevId, prevMembers] of previousGroups) {
      if (usedPreviousIds.has(prevId)) continue;
      const j = jaccardSimilarity(new Set(newMembers), new Set(prevMembers));
      if (j > bestJaccard) {
        bestJaccard = j;
        bestPrevId = prevId;
      }
    }

    if (bestPrevId >= 0 && bestJaccard > 0.3) {
      idMapping.set(newId, bestPrevId);
      usedPreviousIds.add(bestPrevId);
    }
  }

  // Remap community IDs for stability
  const stableCommunities = new Map<string, number>();
  let nextNewId = Math.max(...previousGroups.keys(), ...currentGroups.keys()) + 1;

  for (const [nodeId, communityId] of result.communities) {
    const mappedId = idMapping.get(communityId) ?? nextNewId++;
    if (!idMapping.has(communityId)) {
      idMapping.set(communityId, mappedId);
    }
    stableCommunities.set(nodeId, idMapping.get(communityId)!);
  }

  return {
    communities: stableCommunities,
    count: result.count,
    modularity: result.modularity,
  };
}
```

### 4.7 Recommended Incremental Strategy for Engram

```
Decision tree for graph analysis during dream cycle:

1. Load previous communities from topic_clusters table
2. Query changed entities/relationships since last reflect phase
3. Compute change ratio = changed_nodes / total_nodes

If change_ratio < 0.05 (< 5% change):
  -> Use label propagation on affected neighborhoods only
  -> Skip betweenness recomputation (use cached values)
  -> Update only affected topic_clusters rows
  -> Duration: ~10ms for 10K node graph

If change_ratio between 0.05 and 0.30:
  -> Run full Louvain with stable ID mapping
  -> Use approximate bridge detection (community boundary method)
  -> Full topic_clusters update
  -> Duration: ~100ms for 10K node graph

If change_ratio > 0.30 or no previous analysis exists:
  -> Full Louvain + full betweenness centrality
  -> Complete topic_clusters rebuild
  -> Duration: ~300-700ms for 10K node graph

Always:
  -> Compute and store graph evolution metrics
  -> Detect emergent themes via generation comparison
  -> Run attention signal detection
  -> Generate temporal patterns for significant changes
```

Sources: [DF Louvain](https://arxiv.org/html/2404.19634v3), [Graphiti Communities](https://help.getzep.com/graphiti/core-concepts/communities), [Graphology Events](https://github.com/graphology/graphology/blob/master/docs/events.md), [Delta-Screening](https://www.researchgate.net/publication/350335965_Delta-Screening_A_Fast_and_Efficient_Technique_to_Update_Communities_in_Dynamic_Graphs)

---

## Summary: Key Recommendations for Engram Phase 6

### Temporal Analysis
1. **Schema:** Add `valid_at`/`invalid_at` to relationships; add `temporal_patterns` table
2. **Detection:** Use entity activity profiles with sliding windows + cosine distance for phase detection
3. **Storage:** Eight temporal pattern types covering bursts, shifts, surges, transitions, emergence, decay, bridge formation, and recurrence
4. **Queries:** SQLite window functions (LAG, rolling aggregates) for efficient temporal aggregation

### MCP Tools
1. **Annotations:** Set `openWorldHint: false` for all tools; use `readOnlyHint` and `idempotentHint` accurately
2. **Output:** Keep XML for structured data (recall, explore); add `structuredContent` JSON when SDK supports it
3. **New tools:** `graph_status` (consolidated read) and `timeline` (temporal patterns) as read-only idempotent tools
4. **Errors:** Return actionable error messages with recovery suggestions

### Graph Reflection
1. **Higher-order observations:** LLM-generated community reports with coherence/evolution/gap analysis
2. **Emergent themes:** Compare communities across generations using Jaccard similarity; flag new, growing, or splitting communities
3. **Quality metrics:** Coherence, density, conductance, type homogeneity, activity ratio; composite quality score
4. **Attention signals:** Detect rapid growth without coherence, low coherence, high conductance, staleness, bridge overload

### Incremental Analysis
1. **Community updates:** Full Louvain for large changes (>30%), label propagation for small changes (<5%), stable Louvain for medium changes
2. **Bridge detection:** Cached betweenness with lazy invalidation; approximate bridge detection for real-time queries
3. **Change tracking:** Graphology events for in-memory tracking; SQLite timestamps for cross-cycle tracking
4. **ID stability:** Remap community IDs across generations using Jaccard similarity for meaningful temporal tracking

### Library Dependencies (No New Additions Needed)
All patterns use existing dependencies:
- `graphology` + algorithm packages (already installed)
- `better-sqlite3` with window functions (already available)
- `@modelcontextprotocol/sdk` (already installed)
- Local LLM via Ollama / Claude API (already configured)
