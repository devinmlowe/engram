# Evaluation Results: RLM v3 (Engram MCP Tools)

**Evaluator:** Claude Opus 4.6 (automated)
**Date:** 2026-03-10
**Subject:** markdeep.js v1.19 (8,784 lines)
**Approach under test:** RLM v3 — engram MCP tools (index_file_structure, fetch_snippets, explore_selective, explore)

---

## 1. Executive Summary

RLM v3 represents a meaningful improvement over v2 (96) and a significant recovery from v1 (90), but it does **not** reach parity with the Control (104). The final v3 score is **99/120**.

The engram tools provided structural benefits: `index_file_structure` gave the session a function-level map of the codebase, and `explore` (graph BFS) provided a complete function listing that informed the answers. `fetch_snippets` allowed targeted reading of specific line ranges. However, the tools did not overcome the fundamental challenge of enumeration-heavy questions (Q6, Q8) where exhaustive coverage requires reading large portions of the file.

The trajectory is clearly positive: 90 -> 96 -> 99. The gap to Control (104) has narrowed from 14 points (v1) to 5 points (v3). Most of this remaining gap concentrates in Q6 (regex catalog) and Q8 (performance optimizations), which are enumeration tasks requiring near-complete file coverage.

---

## 2. RLM v3 Scoring Table

| Q# | Level | v3 Complete | v3 Accurate | v3 Depth | v3 Total | Notes |
|----|-------|-------------|-------------|----------|----------|-------|
| Q1 | Architecture | 4 | 5 | 4 | **13** | Identifies all 10 subsystems correctly with line ranges. Missing some inner detail (e.g., state machine modes in source line tracking described but not fully enumerated). Coverage ~14% but well-targeted. |
| Q2 | Architecture | 4 | 5 | 4 | **13** | Clean tabular layout matches baseline structure. Correctly identifies IIFE, scoping, nested closures, `Object.freeze` export. Missing some minor subsections present in baseline (e.g., separate line for Emacs local variables, detailed hljs structure). |
| Q3 | Enumeration | 5 | 4 | 4 | **13** | Lists all 9 `window.markdeep` members correctly. Includes `window.alreadyProcessedMarkdeep` and `module.exports = hljs`. Minor inaccuracy: `headerAnchor` signature listed as `(term, headerArray)` but baseline shows `(headerArray)`. Missing `window.markdeepShowSourceView` global function. |
| Q4 | Architecture | 4 | 5 | 4 | **13** | Traces the full pipeline with correct ordering. Covers all 32 steps within markdeepToHTML. Minor ordering issue: diagram extraction listed before code fence processing (step 3 vs step 4), but this is actually debatable since `replaceDiagrams` is called at line 3670 after code fences at 3510-3622. Pipeline post-processing stage is complete. |
| Q5 | Enumeration | 4 | 5 | 4 | **13** | Covers all major format categories: input modes, media types, diagram elements, code fence languages. Diagram element table is thorough (15 element types). Missing some detail present in baseline: audio file extensions (only mentions mp4/webm for video but omits detailed audio format list), schedule list calendar details, and the full processing order table. |
| Q6 | Enumeration | 3 | 4 | 3 | **10** | Lists ~50 significant patterns organized by category. Baseline catalogs ~280 Markdeep-specific patterns across 41 categories. v3 explicitly acknowledges this is partial ("~50 most significant patterns... remaining ~125 are minor"). Missing entire categories present in baseline: HTML entity escaping (Section 1), URL/anchor processing (Section 3), section wrapping patterns (Section 9), paragraph detection patterns (Section 32), source line markers (Section 35), insert commands (Section 36), UI interaction patterns (Section 39). The coverage gap is structural, not accuracy. |
| Q7 | Enumeration | 4 | 5 | 4 | **13** | Covers all 6 major error handling categories: silent fallbacks, console warnings, console errors, throws, safety mechanisms, malformed input handling. Identifies key patterns: try/catch in font measurement, schedule parsing, code highlighting, context menus. Includes regex backtracking limits and iteration caps. Missing some specific instances from baseline (link preview cross-origin catch, highlight.js internal error classification, table column style fallback, email vs URL disambiguation). |
| Q8 | Enumeration | 3 | 4 | 4 | **11** | Lists 13 optimizations. Correctly identifies string aliasing, math hoisting, protect/expose, early returns, lazy MathJax loading, PathSet O(1) design, grid bounds checking, CSS counters. Missing several optimizations present in baseline: Object.freeze on API, Object.seal on Vec2, pre-compiled regex variables, single-pass SVG string building, reverse-order string replacement, indexOf preference over regex, pre-computed constants (DIAGRAM_START, codeFontStack), lookup table pattern (isBlockElement dictionary), two-pass image grid algorithm. |

---

## 3. Four-Way Progression Table

| Q# | Level | Control | v1 | v2 | v3 | v1->v3 Delta |
|----|-------|---------|----|----|----|--------------|
| Q1 | Architecture | 13 | 12 | 13 | 13 | +1 |
| Q2 | Architecture | 14 | 12 | 12 | 13 | +1 |
| Q3 | Enumeration | 14 | 13 | 14 | 13 | 0 |
| Q4 | Architecture | 13 | 12 | 13 | 13 | +1 |
| Q5 | Enumeration | 13 | 12 | 12 | 13 | +1 |
| Q6 | Enumeration | 11 | 8 | 8 | 10 | +2 |
| Q7 | Enumeration | 13 | 11 | 12 | 13 | +2 |
| Q8 | Enumeration | 13 | 10 | 12 | 11 | +1 |
| **Total** | | **104** | **90** | **96** | **99** | **+9** |

---

## 4. Aggregate Comparison

| Approach | Completeness | Accuracy | Depth | Total | Coverage Est. | Quality/% |
|----------|-------------|----------|-------|-------|---------------|-----------|
| Control (full read) | 38/40 | 37/40 | 29/40 | **104/120** | 100% | 1.04 |
| RLM v1 | 32/40 | 33/40 | 25/40 | **90/120** | ~35% | 2.57 |
| RLM v2 | 35/40 | 34/40 | 27/40 | **96/120** | ~33% | 2.91 |
| RLM v3 (engram tools) | 31/40 | 37/40 | 31/40 | **99/120** | ~51%* | 1.94 |

*v3 coverage is reported as ~51% of the file across all questions, though per-question coverage varies from <1% (Q3) to ~20% (Q4).

**Key observation:** v3's accuracy (37/40) matches Control and exceeds v1 and v2. The engram tools appear to improve targeting precision. However, completeness (31/40) is actually lower than v2 (35/40), suggesting the tools helped find the *right* content but did not cast as wide a net. Depth (31/40) is the highest of any approach, exceeding even Control (29/40), indicating the targeted reading enabled more thoughtful analysis.

---

## 5. Tool Impact Analysis

### Did `index_file_structure` help understand code structure?

**Yes, clearly.** The v3 session's Q1 and Q2 answers demonstrate awareness of 50+ top-level functions from the graph index. The function list in the metadata section names entities that directly appear in answers. Q2's tabular layout with precise line ranges suggests the index provided scaffolding that the session used to organize its reading. v3's Q2 score (13) exceeds both v1 (12) and v2 (12).

### Did `fetch_snippets` reduce tool call overhead?

**Partially.** The metadata shows targeted reads of specific line ranges (e.g., "lines 3059-3400" for markdeepToHTML entry, "lines 7444-7462" for API exports). This is more efficient than sequential file reading. However, the per-question coverage estimates are modest (2-20%), and for enumeration questions (Q6, Q8) the tool didn't read enough of the file to capture all instances.

### Did `explore_selective` help find relevant code?

**The metadata shows `explore` (graph BFS) was used rather than `explore_selective`.** The graph traversal provided the function inventory used across all questions. This was the most impactful tool contribution — it gave the session a structural map without reading the full file.

### Which questions benefited most?

- **Q6 (+2 vs v2):** The regex catalog improved from 8/15 to 10/15. The tools helped find more pattern categories, though still fell short of exhaustive enumeration.
- **Q7 (+1 vs v2):** Error handling improved to match Control (13/15). Targeted grep queries for `catch|error|throw` efficiently located all major error handling sites.
- **Q5 (+1 vs v2):** Format/diagram enumeration benefited from the function index, which listed diagram-related functions.
- **Q2 (+1 vs v2):** Code organization improved with the graph-derived function inventory.

---

## 6. Enumeration Gap Analysis

### Q6 (Regex Catalog): 8 -> 8 -> 10

This was the persistent weak point. v3 improved by 2 points over v1/v2, reaching 10/15. The improvement came from:
- Better category organization (7 categories vs less structured lists in v1/v2)
- Inclusion of protection patterns as a distinct category
- More accurate line references

However, the baseline catalogs ~280 patterns across 41 categories. v3 explicitly states it covers "~50 most significant patterns." The gap is fundamentally about coverage volume — finding all regex patterns requires reading most of the file, which the tools' targeted approach doesn't facilitate. The 7% coverage estimate for Q6 confirms this limitation.

**Remaining gap (5 points):** Would require 2-3x more file reading in the regex-dense sections (lines 1500-4600, 5800-6500).

### Q8 (Performance): 10 -> 12 -> 11

Interestingly, v3 (11) slightly regressed from v2 (12). v3 identifies 13 optimizations while v2 likely found more through different reading strategies. v3 missed several significant optimizations that require reading specific implementation details:
- `Object.seal` on Vec2 (line 4723) — a subtle but impactful JIT optimization
- Pre-compiled regex variables pattern (scattered throughout)
- `indexOf`-based scanning preference (multiple locations)
- Reverse-order string replacement pattern (lines 4092-4122, 3013-3042)

The 3% coverage for Q8 is too low for an enumeration task that requires spotting optimizations distributed across the entire file.

---

## 7. Coverage Analysis

### Raw Coverage Numbers

| Approach | Coverage | Total Score | Quality-per-% |
|----------|----------|-------------|----------------|
| Control | 100% | 104 | 1.04 |
| RLM v1 | ~35% | 90 | 2.57 |
| RLM v2 | ~33% | 96 | 2.91 |
| RLM v3 | ~51% | 99 | 1.94 |

### Efficiency Analysis

v3 read approximately 51% of the file (per the metadata's aggregate coverage estimates) and scored 99/120 (82.5% of maximum). This is less efficient per-line than v2 (33% coverage for 96/120 = 80% of max), suggesting the additional reading in v3 provided diminishing returns.

However, the quality-per-percent metric is misleading here. v3's higher coverage was strategic — it read more of the file in areas that mattered (the core pipeline, API exports, error handling sites). The accuracy score (37/40) proves the reading was well-targeted.

The real question is: was reading 51% better than reading 33%? The answer is yes in absolute terms (+3 points) but the marginal cost was high (18% more coverage for only 3 more points). The engram tools appear to have hit a plateau where further targeted reading yields diminishing returns. To close the remaining 5-point gap to Control would likely require near-complete file reading, which defeats the purpose of the RLM approach.

### Per-Question Coverage Distribution

| Q# | v3 Coverage | Score | Notes |
|----|------------|-------|-------|
| Q1 | ~14% | 13 | Architecture questions need breadth — well-served by graph index |
| Q2 | ~9% | 13 | Reused Q1 data efficiently |
| Q3 | <1% | 13 | Highly targeted — only needed the export block |
| Q4 | ~20% | 13 | Pipeline tracing requires the most reading |
| Q5 | ~5% | 13 | Format enumeration from targeted sections |
| Q6 | ~7% | 10 | **Insufficient for exhaustive regex catalog** |
| Q7 | ~2% | 13 | Grep-driven approach was very efficient |
| Q8 | ~3% | 11 | **Insufficient for distributed optimization patterns** |

This distribution reveals the core tradeoff: architecture and targeted enumeration questions (Q1-Q5, Q7) can be answered efficiently with <20% coverage, but exhaustive enumeration (Q6, Q8) requires substantially more.

---

## 8. Conclusions

### Trajectory: 90 -> 96 -> 99

The RLM approach has shown consistent improvement across three iterations:
- **v1 (90/120, 75%):** Baseline RLM with standard context management
- **v2 (96/120, 80%):** Configuration improvements (likely better chunking/session parameters)
- **v3 (99/120, 82.5%):** Engram MCP tools (index_file_structure, fetch_snippets, explore)

Each iteration closed ~40-50% of the remaining gap to Control.

### Has RLM reached parity with Control (104)?

**No.** The gap is 5 points (99 vs 104), concentrated in Q6 (-1) and Q8 (-2) relative to Control. These are enumeration tasks requiring exhaustive file coverage. The RLM approach, by design, trades coverage for efficiency — it cannot match brute-force completeness on tasks that require brute-force completeness.

However, v3 **matches or exceeds** Control on 5 of 8 questions (Q1, Q4, Q5, Q7 are tied; no question exceeds Control). The approach is effectively at parity for architecture and moderate-enumeration tasks.

### What gaps remain?

1. **Exhaustive enumeration** (Q6, Q8): Tasks requiring catalog-level completeness across an entire file remain the primary weakness. The tools help find *more* instances but cannot guarantee *all* instances without full file reading.

2. **Q3 regression** (13 vs 14 in Control and v2): The API enumeration missed `window.markdeepShowSourceView` and had a minor signature inaccuracy. This is a precision issue, not a coverage issue — the relevant code block was read but not fully extracted.

3. **Q8 slight regression from v2** (11 vs 12): The tools may have caused the session to focus on the "obvious" optimizations surfaced by grep patterns while missing subtler ones (Object.seal, reverse-order replacement) that require reading implementation details.

### Were the Phase 7 engram features worth the investment?

**Yes, with caveats.**

**Benefits realized:**
- `index_file_structure` provided a structural map that improved Q1, Q2, and Q5 answers
- `explore` (graph BFS) gave a complete function inventory without reading the full file
- `fetch_snippets` enabled precise, targeted reading
- Accuracy (37/40) matched Control — the tools helped find the *right* content

**Limitations observed:**
- The tools are optimized for targeted retrieval, not exhaustive enumeration
- 51% coverage for 99 points vs 33% coverage for 96 points shows diminishing returns
- The tools didn't help with Q6 (regex catalog) where the baseline advantage comes from sheer volume of patterns cataloged

**Net assessment:** The engram tools moved RLM from "good enough for architecture questions" (v1-v2) to "competitive across most question types" (v3). The remaining gap is in a question category (exhaustive enumeration) where targeted retrieval is structurally disadvantaged. A potential future improvement would be a "scan mode" tool that reads an entire file but extracts only instances matching a pattern — combining the coverage of Control with the efficiency of RLM.
