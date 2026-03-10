# Markdeep.js Analysis: Control vs RLM Evaluation Results

## 1. Executive Summary

Both approaches produced high-quality analyses of markdeep.js, a complex 8,784-line single-file JavaScript library. The Control approach (traditional full-file reading) and the RLM approach (targeted extraction via grep and selective segment reads) each demonstrated strong comprehension of the codebase, but they diverged in important ways.

The Control approach delivered consistently thorough answers with a slight edge in holistic understanding. Having ingested the full file, it could make cross-cutting observations and catch details that emerge from reading adjacent code. Its answers for the architecture-level questions (Q1, Q2) were nearly as detailed as the baselines, and it maintained quality across all eight questions without obvious degradation -- suggesting that context pressure or compaction did not significantly impair later answers.

The RLM approach demonstrated impressive efficiency: it read only targeted segments of the file (typically 200-800 lines per question out of 8,784) yet produced answers that were 80-95% as complete as the Control on most questions. Its answers were well-structured and accurate. However, it missed certain details that only become apparent from reading surrounding code (e.g., the full scope of polyfills, the nuanced browser workarounds in error handling, some of the more obscure performance patterns). The RLM approach was notably weaker on Q6 (regex catalog) and Q8 (performance optimizations), where exhaustive enumeration requires broad file coverage rather than targeted extraction.

**Overall winner: Control**, with a narrow margin. The Control approach scored higher on completeness and depth across most questions, while accuracy was roughly equivalent. The RLM approach, however, achieved approximately 85% of the Control's quality while reading significantly less of the file, making it a strong contender for context-constrained scenarios.

---

## 2. Performance Comparison Table

### Timing

| Metric | Control | RLM |
|--------|---------|-----|
| Overall start | 13:01:24Z | 13:01:35Z |
| File download complete | 13:01:27Z | 13:01:42Z |
| Overall end | 13:02:46Z | 13:04:57Z |
| **Total elapsed** | **1m 22s** | **3m 22s** |
| Q1 start | 13:01:31Z | 13:01:52Z |
| Q1 end | 13:02:19Z | 13:02:31Z |
| Q2 start | 13:01:31Z | 13:02:31Z |
| Q2 end | 13:02:19Z | 13:02:48Z |
| Q3 start | 13:01:31Z | 13:02:48Z |
| Q3 end | 13:02:19Z | 13:03:03Z |
| Q4 start | 13:01:31Z | 13:03:03Z |
| Q4 end | 13:02:19Z | 13:03:39Z |
| Q5 start | 13:01:31Z | 13:03:39Z |
| Q5 end | 13:02:19Z | 13:04:06Z |
| Q6 start | 13:01:31Z | 13:04:06Z |
| Q6 end | 13:02:19Z | 13:04:22Z |
| Q7 start | 13:01:31Z | 13:04:22Z |
| Q7 end | 13:02:19Z | 13:04:31Z |
| Q8 start | 13:01:31Z | 13:04:31Z |
| Q8 end | 13:02:19Z | 13:04:57Z |

**Observation:** The Control processed all 8 questions in a single ~48s block (13:01:31 to 13:02:19), suggesting it read the entire file first and then answered all questions from context. The RLM processed questions sequentially over ~3 minutes, with each question requiring its own targeted reads.

### Token/Context Consumption

| Metric | Control | RLM |
|--------|---------|-----|
| File ingestion | Full 8,784 lines (~350K chars) | Selective segments per question |
| Estimated lines read | ~8,784 (full file) | ~2,800-3,500 (est. from segment metadata) |
| File coverage | 100% | ~35-40% |
| Grep queries | N/A (not used) | ~24 total across all questions |

**Context efficiency ratio:** The RLM read approximately 35-40% of the file and achieved approximately 85% of the Control's quality, giving it a superior quality-per-token ratio.

---

## 3. Quality Scoring Table

| Q# | Level | Control Complete | Control Accurate | Control Depth | RLM Complete | RLM Accurate | RLM Depth | Notes |
|----|-------|-----------------|-----------------|---------------|-------------|-------------|-----------|-------|
| Q1 | Architecture | 4 | 5 | 4 | 4 | 5 | 3 | Both cover all major subsystems; Control has more line-number precision; RLM slightly less depth on control flow details |
| Q2 | Architecture | 5 | 5 | 4 | 4 | 5 | 3 | Control matches baseline table structure closely; RLM solid but less granular on sub-sections within major functions |
| Q3 | Functional | 5 | 5 | 4 | 4 | 5 | 4 | Both identify all API members; Control includes `markdeepShowSourceView` and `markdeepOptions.onLoad`; RLM covers the same key facts |
| Q4 | Detail | 4 | 5 | 4 | 4 | 4 | 4 | Both trace the pipeline well; Control has more inline detail on sub-steps; RLM organizes into clear phases but misses some micro-steps |
| Q5 | Functional | 4 | 5 | 4 | 4 | 5 | 3 | Control enumerates more diagram sub-elements (resistor patterns, hexagons); RLM covers all major categories but fewer edge cases |
| Q6 | Detail | 4 | 4 | 3 | 2 | 4 | 2 | Control lists ~30 major patterns with line refs; RLM lists key patterns but claims "175 .rp() calls" without cataloging most of them. Baseline has ~370 patterns cataloged -- both fall short but Control is closer |
| Q7 | Functional | 4 | 5 | 4 | 3 | 5 | 3 | Control identifies more try/catch blocks, more fallback patterns, more browser workarounds. RLM captures the main patterns but misses several (link preview, Vec2 seal, Firefox workarounds) |
| Q8 | Detail | 4 | 5 | 4 | 3 | 4 | 3 | Control finds more optimizations (Object.seal on Vec2, Object.freeze on API, reverse-order replacement, indexOf preference). RLM hits the major ones but fewer total items |

---

## 4. Aggregate Scores

### Per-Approach Totals

| Dimension | Control Total (40 max) | Control Average | RLM Total (40 max) | RLM Average |
|-----------|----------------------|----------------|--------------------|--------------|
| Completeness | 34 | 4.25 | 28 | 3.50 |
| Accuracy | 39 | 4.88 | 37 | 4.63 |
| Depth | 31 | 3.88 | 25 | 3.13 |
| **Combined** | **104** | **4.33** | **90** | **3.75** |

### Winner Per Question

| Q# | Winner | Margin |
|----|--------|--------|
| Q1 | Control | Narrow (13 vs 12) |
| Q2 | Control | Moderate (14 vs 12) |
| Q3 | Tie | (14 vs 13, within noise) |
| Q4 | Control | Narrow (13 vs 12) |
| Q5 | Control | Narrow (13 vs 12) |
| Q6 | Control | Clear (11 vs 8) |
| Q7 | Control | Moderate (13 vs 11) |
| Q8 | Control | Moderate (13 vs 10) |

### Winner Per Level

| Level | Questions | Control Total | RLM Total | Winner |
|-------|-----------|--------------|-----------|--------|
| Architecture (Q1, Q2) | 2 | 27 | 24 | Control |
| Functional (Q3, Q5, Q7) | 3 | 40 | 36 | Control |
| Detail (Q4, Q6, Q8) | 3 | 37 | 30 | Control |

The gap is smallest at the Architecture level (where broad understanding can be reconstructed from key sections) and largest at the Detail level (where exhaustive enumeration demands full-file coverage).

---

## 5. Qualitative Analysis

### What Control Found That RLM Missed

1. **Q2 (Organization):** Control enumerated sub-sections within `markdeepToHTML` (25a through 25w) at a granularity matching the baseline. RLM provided a high-level table but did not break down the core function's internal organization at this level.

2. **Q6 (Regex Catalog):** Control listed approximately 30 distinct regex patterns with exact line numbers and descriptions. RLM noted "175 .rp() calls" but only enumerated the most prominent patterns. The baseline catalogs approximately 370 patterns -- both approaches fell short, but Control was substantially closer.

3. **Q7 (Error Handling):** Control identified the link preview cross-origin try/catch (lines 6884-6894), the Vec2 and Grid console.error patterns, the Firefox object tag workaround, the Path constructor validation, and the `DecorationSet.insert()` illegal character check. RLM identified the 5 main try/catch blocks and the structural safeguards but missed several of the console.error diagnostic patterns.

4. **Q8 (Performance):** Control found: `Object.seal` on Vec2, `Object.freeze` on the API object, reverse-order string replacement for index stability, `indexOf`-based scanning preference, single-pass TOC collection, and `makeFilterAny` factory function. RLM missed most of these, focusing on the more prominent optimizations.

5. **Browser-specific details:** Control mentioned the Firefox admonition icon sizing workaround (different font-size for Firefox), the Firefox `<object>` tag workaround for non-HTML embeds, and the IE11 polyfill inventory in more detail.

### What RLM Found That Control Missed

1. **Source line tracking skip optimization (Q8):** RLM specifically identified that the Phase 1 state machine skips structural lines to reduce protection token count, framing it as a performance optimization. Control did not explicitly call this out as an optimization.

2. **Highlight.js caching (Q8):** RLM noted that the bundled highlight.js uses internal language compilation caching. Control did not mention this.

3. **Organization clarity:** RLM's answers were generally more crisply organized with clearer phase/stage numbering in Q4. While the content was less exhaustive, the presentation was arguably more digestible.

### How Context Pressure Affected Control's Later Answers

There is no clear evidence of quality degradation in Control's later answers. Q7 and Q8, which come last, are scored at 13/15 each -- equal to or better than Q1's 13/15. This suggests either: (a) the full file fit within context without compaction, or (b) if compaction occurred, it did not significantly impair the answers. The fact that all Control answers share the same timestamp range (13:01:31 to 13:02:19) suggests they were generated in a single pass from full context, not sequentially with growing pressure.

### How Targeted Extraction Affected RLM's Holistic Understanding

The RLM's targeted approach had measurable impacts:

1. **Missing adjacency context:** Some patterns are only visible when reading surrounding code. For example, the `Object.seal` on Vec2 at line 4723 would only be found by reading the Vec2 constructor -- the RLM read lines 4644-4703 for Q5 but stopped short of 4723.

2. **Enumeration gaps:** Questions requiring exhaustive enumeration (Q6's regex catalog, Q8's full optimization list) suffered most. The RLM's grep queries were well-chosen but could not replace a full read for comprehensive cataloging.

3. **Cross-referencing limitations:** The Control could see that `formatImage()` handles video, audio, YouTube, Vimeo, and Gravizo in a single function, while the RLM had to piece this together from separate grep results and segment reads.

---

## 6. Key Observations

### Context Efficiency

The RLM approach achieved approximately 85% of the Control's quality (90/104 combined score) while reading approximately 35-40% of the file. This translates to:

- **Control:** 104 quality points / ~8,784 lines read = 0.012 quality per line
- **RLM:** 90 quality points / ~3,200 lines read = 0.028 quality per line

The RLM was approximately **2.4x more context-efficient**, producing more quality per line of input consumed.

### The Compaction Event

There is no evidence that a compaction event occurred during the Control run. All eight answers appear to have been generated from a single full-context read. If the file had exceeded context limits, we would expect to see later answers degrade -- they did not.

### RLM Coverage

Based on the `segments_read` metadata across all questions, the RLM accessed approximately:
- Q1: ~370 lines (8 segments)
- Q2: ~130 lines (4 segments)
- Q3: ~130 lines (7 segments)
- Q4: ~1,500 lines (8 segments, large contiguous reads of `markdeepToHTML`)
- Q5: ~140 lines (3 segments)
- Q6: ~460 lines (4 segments)
- Q7: ~100 lines (4 segments)
- Q8: ~90 lines (3 segments)

**Total estimated unique lines:** ~2,800-3,200 (accounting for overlap between questions)
**File coverage:** ~32-36%

The RLM's Q4 (rendering pipeline) required the most reading, which makes sense -- tracing a pipeline requires following sequential code. Its weakest questions (Q6, Q8) had the fewest lines read, confirming that breadth-of-reading correlates with completeness for enumeration questions.

---

## 7. Conclusions and Recommendations

### Findings

1. **The Control approach wins on absolute quality** across all question types, with the largest advantage on detail-oriented enumeration questions (Q6, Q8).

2. **The RLM approach wins on context efficiency**, achieving 85% quality at 35% file coverage. This is the correct trade-off when context windows are constrained.

3. **Accuracy is comparable** (4.88 vs 4.63 average). The RLM rarely fabricated information -- it simply found less of it.

4. **The quality gap is smallest for architecture questions** and largest for exhaustive enumeration questions. This suggests RLM is best suited for understanding *what* a system does and *how* it is organized, rather than cataloging *every instance* of a pattern.

5. **No compaction penalty was observed** for the Control approach on this file size (8,784 lines). The file appears to fit within the model's effective context window.

### Recommendations

- **For files within context limits (~10K lines):** The traditional full-read approach produces better results and is faster (1.5 min vs 3.5 min). Use it when possible.

- **For larger files or context-constrained scenarios:** The RLM approach is viable and efficient. Expect 80-90% quality at 30-40% file coverage. Supplement with additional targeted reads for enumeration questions.

- **Hybrid approach:** For maximum quality on large files, use RLM for architecture/functional questions and targeted full-section reads for detail questions (regex catalogs, error handling inventories, performance pattern lists).

- **RLM grep query design matters:** The RLM's grep queries were generally well-designed but could be improved for exhaustive enumeration. For Q6 (regex), a grep for `new RegExp\(` and `/[^/]+/[gim]` would have found more patterns. For Q8, searching for `Object.seal|Object.freeze|indexOf|===` would have found additional optimizations.
