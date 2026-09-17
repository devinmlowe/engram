# Engram as Active Context Manager: Architecture & Design Specification

**Status:** Proposed (Design / Scaffold)  
**Author:** Subagent / Hermes Agent Task Force  
**Target Subsystem:** Engram Memory System & Hermes Agent Memory Integration  
**Date:** September 16, 2026  

---

## 1. Context & Motivation

Hermes Agent and LLM agent harnesses rely on context management to sustain multi-turn performance, maintain continuity, and prevent memory bloat over 100+ turns. Today, context reduction in Hermes is strictly passive and destructive:
1. **Passive Compression (`on_pre_compress`):** When context length exceeds a token threshold (e.g. ratio `0.5` of maximum window), Hermes truncates older turns, preserving only pinned system prompts (first 3 messages) and recent exchanges (last 20 messages).
2. **Disconnected Retrieval (`recall`):** Engram operates as an external storage system queried ad-hoc via MCP tool calls or static per-turn auto-recall prefetching (`prefetch(query)`).
3. **Loss of Ephemeral State:** Evicted context drops into black-hole deletion unless explicitly saved to semantic memory by the model calling `remember`.

Transforming **Engram into an Active Context Manager** shifts Engram from a passive database to a dynamically managed virtual context tier. In this role, Engram acts as an L2 cache and context controller: governing what remains in the active prompt window, offloading pruned conversation turns into structured episodic/semantic pointers, and offering precise retrieval interfaces to re-hydrate context without breaking model prompt caching.

---

## 2. Architecture Trade-off Analysis

We evaluate three potential architectures for Engram as Context Manager, detailing technical mechanics, cache impact against LLMs (vLLM, Anthropic, OpenAI prefix caching), and operational risks.

### Architecture Option A: Prefetch-Only Context Enrichment (Baseline / Low-Touch)

* **Mechanics:**  
  * Hermes invokes `prefetch(query)` at the start of each turn.
  * Engram runs hybrid search (`searchMultiSource`: episodic + semantic + graph RRF) and returns a formatted XML context snippet (`<engram_memory>`).
  * The context block is injected into the user turn or system state prior to generation.
* **Cache-Impact Analysis:**  
  * **Prefix Caching Invariant:** Modern LLM inference engines (vLLM, Anthropic prompt cache) require the prompt prefix (system instructions + past messages) to remain byte-identical across turns to achieve cache hits.
  * **Impact:** High cache invalidation risk if injected at the top of the prompt or dynamically changing turn-by-turn within history. Must be appended strictly to the latest user message or placed in a dedicated volatile tail slot.
* **Pros & Cons:**  
  * ✅ Non-invasive: requires no changes to Hermes context compression loops.
  * ❌ Does not solve context overflow; evicted messages are still permanently lost if not recalled.

---

### Architecture Option B: Compression-Replacement & Durable Eviction (L2 Context Offload)

* **Mechanics:**  
  * Engram overrides the native compression handler (`on_pre_compress`).
  * Before message eviction occurs (when token count > 50% window):
    1. Engram ingests all candidate evicted turns (between protected prefix 1-3 and suffix 20) into episodic memory and semantic graph structures.
    2. Engram generates lightweight, low-token **Context Pointers** (e.g., `<engram_pointer id="mem_9f82a1" summary="Discussed SQLite VEC optimization" tokens="420" />`).
    3. The evicted range in the active Hermes context array is replaced by these compact pointers rather than outright deletion.
  * When the model needs detail from a pointer, it invokes `context_memory(action="expand_pointer", pointer_id="mem_9f82a1")`.
* **Cache-Impact Analysis:**  
  * **Prefix Caching Invariant:** Compression events happen infrequently (e.g., every 15-20 turns). Replacing a contiguous chunk of 30 raw turn messages with 2 static pointer tags establishes a new, stable prefix baseline.
  * **Hit Rate:** High prefix stability post-compression. Cache invalidation occurs only on the exact turn compression fires.
* **Pros & Cons:**  
  * ✅ High recall fidelity: zero loss of conversational history.
  * ✅ Substantial token savings: 70–85% reduction in context payload per turn while preserving context awareness.
  * ⚠️ Requires stateful coordination between Hermes memory provider hooks and Engram storage.

---

### Architecture Option C: Full Virtual-Context Memory Manager (MemGPT / OS-Style Tiering)

* **Mechanics:**  
  * Engram maintains the full ground-truth conversation log out-of-core in SQLite.
  * The LLM active context is treated as a limited L1 cache (e.g. 8k–16k window).
  * Context operations are explicitly controlled by both LLM tool calls (`context_memory`) and automated background algorithms (Graph-aware LRU eviction, dynamic pinning, context paging).
  * Provides explicit tool interfaces: `snapshot`, `expand_pointer`, `pin`, `forget`.
* **Cache-Impact Analysis:**  
  * **Impact:** Modifying active context dynamically (pinning/unpinning, manually paging memories in and out) shifts prompt tokens frequently.
  * **Optimization:** Requires strict block-based context layout (e.g. Fixed Block Tiering: Block 0 = System/Pinned, Block 1 = Active Pointers, Block 2 = Tail Conversation) to limit cache invalidation to Block 1 & 2 boundaries.
* **Pros & Cons:**  
  * ✅ Arbitrary-length conversation scaling (1000+ turns without context degradation).
  * ✅ Complete model control over memory allocation and forgetting.
  * ❌ Complex implementation; higher latency per turn if model frequently pages context in/out.

---

### Recommended Phased Roadmap

We recommend a **Phased Implementation Strategy**:

1. **Phase 1: Option A + Tool Surface Foundation (Immediate Value)**
   * Retain static auto-recall prefetching in user turn tail slots (zero prefix cache pollution).
   * Deploy the standard MCP `context_memory` tool surface for active pointer inspection and manual memory control.
2. **Phase 2: Option B (Compression-Replacement & Durable Eviction)**
   * Implement Hermes `on_pre_compress` hook integration with Engram.
   * Store evicted turns to SQLite episodic/semantic memory and replace them in the Hermes message stream with structured `<engram_pointer>` elements.
3. **Phase 3: Option C (Full Virtual-Context Memory Tiers)**
   * Introduce active L1/L2 context paging, explicit memory block pinning, and autonomous graph-backed context summarization.

---

## 3. Tool-Surface Specification: `context_memory` MCP Tool

To support virtual-context management (Options B & C), Engram exposes a unified MCP tool named `context_memory`. Below is the TypeScript and Zod schema specification matching Engram's MCP tool server patterns (`src/interfaces/mcp/server.ts`).

### TypeScript / Zod Schema Definition

```typescript
import { z } from "zod";

/**
 * Zod schema for the context_memory MCP tool input.
 */
export const ContextMemoryInputSchema = z.object({
  action: z.enum(["snapshot", "expand_pointer", "pin", "forget"]).describe(
    "Context management operation: " +
    "'snapshot' (summarize active state), " +
    "'expand_pointer' (rehydrate detailed context from pointer ID), " +
    "'pin' (lock memory/pointer in active context window), " +
    "'forget' (prune/deactivate memory pointer from context)"
  ),
  pointer_id: z.string().optional().describe(
    "Target pointer ID (required for expand_pointer, pin, forget)"
  ),
  depth: z.enum(["summary", "full"]).optional().default("summary").describe(
    "Expansion depth for expand_pointer: 'summary' (key points) or 'full' (verbatim exchange)"
  ),
  token_budget: z.number().int().min(100).max(4000).optional().default(1000).describe(
    "Maximum token budget allowed for the output payload"
  ),
  reason: z.string().optional().describe(
    "Model rationale for pinning, expanding, or forgetting"
  ),
});

export type ContextMemoryInput = z.infer<typeof ContextMemoryInputSchema>;

/**
 * Expected JSON Response Schema for context_memory tool execution.
 */
export interface ContextMemoryResult {
  action: "snapshot" | "expand_pointer" | "pin" | "forget";
  success: boolean;
  pointer_id?: string;
  tokens_used: number;
  content: string;
  pinned_status?: boolean;
  metadata?: {
    created_at?: number;
    source_turns?: number[];
    original_token_count?: number;
  };
}
```

### Example Input/Output JSON Payloads

#### 1. Action: `expand_pointer`
**Input:**
```json
{
  "action": "expand_pointer",
  "pointer_id": "ptr_ep_9921a4",
  "depth": "full",
  "token_budget": 800,
  "reason": "Need exact code snippet discussed in turn 24 regarding SQLite vec index configuration"
}
```

**Output:**
```json
{
  "action": "expand_pointer",
  "success": true,
  "pointer_id": "ptr_ep_9921a4",
  "tokens_used": 342,
  "content": "<expanded_context id=\"ptr_ep_9921a4\" source_turns=\"[24,25]\">\nUser: How did we configure sqlite-vec embeddings?\nAssistant: We initialized sqlite-vec using `sqliteVec.load(db)` and set dimension to 384 for sentence-transformers/all-MiniLM-L6-v2.\n</expanded_context>",
  "metadata": {
    "created_at": 1773665400,
    "source_turns": [24, 25],
    "original_token_count": 450
  }
}
```

#### 2. Action: `pin`
**Input:**
```json
{
  "action": "pin",
  "pointer_id": "ptr_sem_7730bf",
  "reason": "Keep active DB schema decision pinned across upcoming refactoring turns"
}
```

**Output:**
```json
{
  "action": "pin",
  "success": true,
  "pointer_id": "ptr_sem_7730bf",
  "tokens_used": 45,
  "content": "Pointer ptr_sem_7730bf successfully pinned to active context system tier.",
  "pinned_status": true
}
```

---

## 4. Empirical Evaluation Protocol & Metrics

To prove the efficacy of Engram as Context Manager, we define a benchmark simulation harness evaluating three core metrics over a standard **100-turn synthetic multi-topic scenario**.

### Target Metrics & Verification Benchmarks

| Metric | Definition & Formula | Target Benchmark Goal |
| :--- | :--- | :--- |
| **Context Token Size per Turn** | Average and peak context token payload fed to model prompt across turns $t_1 \dots t_{100}$. | $\le 30\%$ of uncompressed token growth; flat baseline after turn 20 ($\le 4,000$ tokens). |
| **Recall Fidelity @ Turn N** | Ability to answer needle-in-haystack factual questions asked at turn 100 regarding information disclosed at turn $X$ ($X \in [5, 50]$). | $\ge 90\%$ accuracy on key fact extraction tests post-compression. |
| **Prefix Cache Hit Rate** | Percentage of prompt tokens matching the shared KV-cache prefix across sequential turns: $\frac{\text{Cached Tokens}}{\text{Total Prompt Tokens}}$. | $\ge 80\%$ average cache hit rate across a 100-turn run. |

### 100-Turn Simulation Protocol Specification

1. **Scenario Generation:**
   * Script generates 100 consecutive turns covering 5 shifting technical domains (e.g., SQLite optimization, API design, Auth setup, UI layout, Fleet deployment).
   * At turns 12, 34, 58, and 79, specific unique "needle facts" are introduced (e.g., `Secret key: XK9-alpha-99`).
2. **Execution Runs:**
   * **Control Group:** Native Hermes passive compression (Truncation of turns past threshold 0.5 ratio, preserving first 3 + last 20 messages).
   * **Test Group A (Phase 1):** Option A (Engram prefetch injection per turn).
   * **Test Group B (Phase 2):** Option B (Engram compression-replacement with pointer offloading via `on_pre_compress`).
3. **Evaluation Probes:**
   * At turn 100, execute 10 probe questions targeting facts from early/mid turns.
   * Calculate exact token usage log from prompt metrics.
   * Calculate KV-cache prefix overlap using tokenizer prefix comparison.

---

## 5. Implementation Considerations & Open Questions

### Integration Points in Engram / Hermes Codebase
* `src/_core/search/orchestrator.ts`: Extend `searchMultiSource` to support pointer lookup and context hydration routines.
* `src/interfaces/mcp/server.ts`: Register `context_memory` tool definition and dispatch handlers.
* `interfaces/hermes-plugin/`: Implement `on_pre_compress` handler bridging Hermes message state to Engram HTTP MCP server.

### Open Questions for Review (Devin Lowe)

1. **Pointer Ingestion Policy:** Should pointer creation during compression happen inline synchronously inside `on_pre_compress` or asynchronously via background queue to prevent blocking turn execution?
2. **Scope Isolation:** Should context pointers respect `ENGRAM_SCOPE` / `ENGRAM_READ_SCOPES` multi-tenant scoping, or inherit the scope of the parent conversation profile automatically?
3. **Eviction Thresholds:** Should pointer replacement trigger at a strict 50% window token budget or dynamically scale based on conversation velocity (e.g., token delta per turn)?
