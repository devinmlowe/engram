# Dream Cycle: OpenRouter Integration Results

**Date:** 2026-02-27
**Run ID:** `23226cf5-cbbd-4327-8145-a25783e7c7c0`
**Model:** `google/gemini-2.5-flash-lite` via OpenRouter
**Cost:** ~$11 estimated (vs ~$90-120 for Anthropic Haiku)

## Run Summary

| Phase | Result | Duration |
|-------|--------|----------|
| Ingest | 727 conversations loaded | — |
| Extract | 73 conversations extracted, 654 failed | ~2.5 hrs |
| Consolidate | 38 items processed, 0 errors | 53s |
| Reflect | 758 communities, 369 bridges, 1,719 nodes, 1,466 edges | ~12 min |
| Prune | 387 memories scanned, 0 pruned | <1s |

**Final stats:** 359 new memories, 130 new entities, modularity 0.78

## Extraction Coverage

- **Success rate:** 73/727 conversations = **10% coverage**
- **Failure mode:** `OpenRouter response contained no tool_calls or content` — Gemini returned empty responses for the function-calling format
- **Pre-existing failures:** 717 conversations failed on an earlier run that fell through to Anthropic (no API credits), consuming the retry budget before OpenRouter was wired in

### Failure Breakdown

| Error Type | Count | Notes |
|------------|-------|-------|
| Anthropic "credit balance too low" | 717 | From pre-OpenRouter run at 13:03 UTC |
| OpenRouter empty response (fatal) | ~10 | All extraction tiers exhausted |
| OpenRouter empty response (graph only) | ~21 | Non-fatal, fact extraction succeeded |
| Successful fact extraction | 73 | Via OpenRouter |
| Successful graph extraction | 50 | Via OpenRouter |

## Recall Quality Assessment

Compared episodic-only recall vs full multi-source recall (episodic + semantic + graph) across 4 queries.

### Query: "home network infrastructure"

| Source | Results | Top Hits |
|--------|---------|----------|
| Episodic only | 3 snippets | LIFX smart home docs, Hetzner/MacBook architecture |
| Full recall | 7 results | Same episodic + semantic (layered architecture) + graph (streaming UI design, hardware architecture docs) |

### Query: "voice AI pipeline architecture"

| Source | Results | Top Hits |
|--------|---------|----------|
| Episodic only | 1 snippet | talk-assistant MVP email (weak match) |
| Full recall | 5+ results | Semantic (engram architecture, migration, FSRS) + same episodic |

### Query: "user preferences for shell and terminal"

| Source | Results | Top Hits |
|--------|---------|----------|
| Episodic only | 3 snippets | Fish config sourcing, config inquiry, FreeCAD/zsh issue |
| Full recall | 7 results | Semantic (work-log tmux config) + same episodic + graph (tmux-default-session-init.sh, chatterbox repo) |

### Query: "[redacted personal query]"

| Source | Results | Top Hits |
|--------|---------|----------|
| Episodic only | 3 snippets | [redacted personal result] |
| Full recall | 6 results | [redacted personal result] |

### Assessment

**Strengths:**
- Full recall finds ~2x more total results by combining three stores
- Graph results surface tangentially related entities missed by text search (e.g., `tmux-default-session-init.sh` for "shell preferences")
- Semantic memories capture distilled facts and conventions

**Weaknesses:**
- Semantic memories often match on generic architecture terms rather than the specific query intent
- Only 10% extraction coverage means most conversation knowledge is not yet in the semantic/graph stores
- Graph results have low relevance scores (10-28%), acting as suggestions rather than strong matches
- Episodic store alone is often more *precise* for direct recall

**Root causes of low quality:**
1. Only 73/727 conversations extracted — most failed with empty Gemini responses
2. Gemini 2.5 Flash Lite may prioritize technical/architectural facts over personal preferences and decisions
3. The 717 Anthropic failures consumed the retry budget in the checkpoint system, so those conversations were marked "attempted" even though they never reached OpenRouter

## Explore Tool Optimization

The dream cycle's graph (1,719 nodes, 1,466 edges) exposed a supernode problem in the `explore` MCP tool. Hub entities like "engram" at depth-2 returned 160+ relationships in an unbounded response.

**Fix applied (commit `3ec9565`):**
- Added `limit` parameter (default 25, max 50) — sorts neighbors by relationship weight descending
- Added `budget` parameter (default 1500 tokens) — stops emitting XML when token estimate exceeds budget
- Result: depth-2 query on "engram" went from 160+ relationships to 25 highest-weight connections

## Next Steps

### Critical: Re-run extraction with clean state

The 717 Anthropic failures poisoned the checkpoint table — those conversations are marked as "attempted" under run `23226cf5` and won't be retried. Options:

1. **Clear checkpoints for failed conversations** — Delete checkpoint rows where the conversation was never successfully extracted, then resume
2. **Start a fresh run** — New run ID means new checkpoints, all 727 conversations re-attempted via OpenRouter
3. **Fix the retry logic** — Ensure that Anthropic failures when `ANTHROPIC_API_KEY` has no credits don't consume retries that should go to OpenRouter

Option 1 is the most efficient (avoids re-extracting the 73 that succeeded).

### Improve extraction success rate

- **Investigate empty Gemini responses** — Are they caused by conversations that are too long, too short, or contain specific content patterns?
- **Add retry with backoff** — The current single-attempt model means transient Gemini failures are permanent
- **Try a different OpenRouter model** — `google/gemini-2.0-flash` or `google/gemini-2.5-flash` (non-lite) may handle function calling more reliably
- **Add content-based responses as fallback** — When tool_calls are empty, try parsing the response content as JSON (some models return structured data in content instead of tool_calls)

### Improve semantic memory quality

- **Tune the extraction prompt** (`prompts/extract-facts.md`) to better capture user preferences, decisions, and personal context — not just technical architecture
- **Add a "preference extraction" pass** — Separate prompt focused on identifying user preferences, habits, and workflow patterns
- **Confidence scoring** — Weight semantic memories by extraction confidence so low-quality extractions don't dilute recall

### Graph quality

- **Entity deduplication** — Many entities are near-duplicates (e.g., file paths vs module names referring to the same thing)
- **Relationship context quality** — Some context strings are misleading (e.g., "FreeCAD is related to SQLite" when the actual connection is tenuous)
- **Prune low-weight relationships** — The 0.55 floor means many weak relationships survive that add noise
