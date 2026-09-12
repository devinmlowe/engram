# Markdeep.js Analysis: RLM v2 Evaluation Results

## 1. Executive Summary

The updated RLM v2 guidance produced **meaningful improvements** over v1 on most questions, with the strongest gains on the rendering pipeline (Q4) and error handling (Q7). The task classification system, multi-pass grep strategy, and coverage estimation metadata all contributed to better-targeted reads.

However, v2 still falls short of the Control on exhaustive enumeration questions (Q6 regex catalog, Q8 performance), and the gap with Control has narrowed but not closed. The key insight is that v2's improvements came primarily from **reading more of the right lines** rather than reading more lines overall -- its coverage estimate (~6-20% per question) remained lean, but targeting was sharper.

**What changed most vs v1:**
- Q4 (rendering pipeline) improved significantly -- v2 read ~1800 lines of `markdeepToHTML` versus v1's ~1500, and the result shows more micro-step detail
- Q7 (error handling) improved through better grep queries that caught more console.warn/error sites
- Q6 (regex catalog) improved moderately -- v2 acknowledged its coverage gap explicitly, which v1 did not
- Q8 (performance) improved through identification of more optimization patterns via broader grep terms

---

## 2. RLM v2 Quality Scoring Table

| Q# | Level | v2 Complete | v2 Accurate | v2 Depth | Total | Notes |
|----|-------|-------------|-------------|----------|-------|-------|
| Q1 | Architecture | 4 | 5 | 4 | **13** | Covers all 8+ major subsystems identified in baseline. Correctly identifies IIFE structure, protect/expose mechanism, all processing modes. Slight miss on some utility subsystem details (line-number ranges for polyfills) but this is minor for an architecture question. Matches Control quality. |
| Q2 | Architecture | 4 | 5 | 3 | **12** | Provides a good section-by-section table with line ranges. Identifies the key structural patterns (protect/expose, no classes, IIFE). Misses some granularity in the `markdeepToHTML` internal structure that the baseline and Control provide (the baseline breaks it into 25+ subsections). Coverage estimate of ~1% is honest but may have been too lean. |
| Q3 | Enumeration | 5 | 5 | 4 | **14** | Excellent -- identifies all 9 members of `window.markdeep`, plus `window.alreadyProcessedMarkdeep`, `window.markdeepOptions`, `window.markdeepShowSourceView`, and `module.exports = hljs`. Matches baseline completeness. The v2 task classification as "enumeration" led to focused reads of lines 7133-7456 which is exactly where all exports live. |
| Q4 | Detail | 4 | 5 | 4 | **13** | Strong improvement over v1. Traces the full pipeline through 10 numbered phases. Covers protect/expose, source line tracking state machine, all code fence processing, blockquotes, math protection, headers, block elements, links/images, inline formatting, lists, TOC, section wrapping, and the expose loop. Misses a few micro-steps the baseline covers (equation cross-reference rewriting at 3959, Gravizo URL protection at 3978, the `filterSubfigure` regex at 3967) but overall thorough. |
| Q5 | Enumeration | 4 | 5 | 3 | **12** | Covers all media formats (video, audio, YouTube, Vimeo, Gravizo, LaTeX, code). Covers all major diagram elements. Misses some of the finer diagram sub-elements the baseline catalogs: resistor patterns (5267-5278), Unicode hexagon passthrough (5813), the distinction between `isUndirectedVertex` vs `isTopVertex`/`isBottomVertex`, and the specific grid accessor methods. The `findReplacementCharacters` description is present but thin. |
| Q6 | Enumeration | 3 | 4 | 2 | **9** | Improved over v1's score of 8. v2 catalogs ~65 distinct regex patterns from `markdeepToHTML` with line references, which is a significant increase from v1. However, the baseline catalogs ~280 Markdeep-specific patterns across 40+ categories including subsidiary functions. v2 explicitly acknowledges the gap (~30-40 additional patterns in subsidiary functions), which is better than v1's silence on coverage gaps. The grep query `str = str\.rp(` was well-chosen but only catches inline replacements in `markdeepToHTML`, missing patterns inside `replaceTables`, `replaceLists`, `replaceScheduleLists`, `replaceDefinitionLists`, `insertTableOfContents`, `wrapHeaderSections`, and utility functions. Accuracy is strong for what was cataloged (no fabricated patterns). |
| Q7 | Enumeration | 4 | 5 | 3 | **12** | Solid improvement over v1. Identifies 5 try/catch blocks (same as baseline count outside hljs), 8 console.warn/error sites matching the baseline, polyfill guards, input validation in `generateMarkdownTable`, and structural safeguards (timeout, match limit, expose cap, regex backtracking prevention, double-processing guard). Misses: the `Object.assign` polyfill throw (line 111), the `String.includes` polyfill throw (line 139), link preview cross-origin catch details, some defensive null checks in `nodeToMarkdeepSource` and context menu, the unused reference tracking empty loops (lines 4500-4509), and the URL period trimming edge case. But the core philosophy and pattern identification is correct. |
| Q8 | Enumeration | 3 | 5 | 3 | **11** | Improved over v1's 10. v2 identifies 13 optimization patterns including: string aliasing, math aliasing, protect/expose system, catastrophic backtracking prevention, safety timeout, grid isUsed tracking, HIDE_O substitution, hidden fence pattern, expose iteration limit, Object.freeze, double-processing prevention, conditional MathJax loading, and font measurement caching. This is a good set. Misses: Object.seal on Vec2 (line 4723 -- the v1 evaluation specifically flagged this as a boundary padding test, and v2 still missed it), reverse-order string replacement for index stability, indexOf preference over regex, makeFilterAny factory, single-pass SVG string building, pre-compiled regex variables, and the lookup table/dictionary pattern. |

---

## 3. Three-Way Comparison Table

| Q# | Level | Control Total | RLM v1 Total | RLM v2 Total | v1->v2 Delta |
|----|-------|--------------|-------------|-------------|-------------|
| Q1 | Architecture | 13 | 12 | **13** | +1 |
| Q2 | Architecture | 14 | 12 | **12** | 0 |
| Q3 | Functional | 14 | 13 | **14** | +1 |
| Q4 | Detail | 13 | 12 | **13** | +1 |
| Q5 | Functional | 13 | 12 | **12** | 0 |
| Q6 | Detail | 11 | 8 | **9** | +1 |
| Q7 | Functional | 13 | 11 | **12** | +1 |
| Q8 | Detail | 13 | 10 | **11** | +1 |
| **Total** | | **104** | **90** | **96** | **+6** |

### Score Distribution by Level

| Level | Questions | Control | RLM v1 | RLM v2 | v2 vs Control Gap |
|-------|-----------|---------|--------|--------|-------------------|
| Architecture (Q1, Q2) | 2 | 27 | 24 | **25** | -2 |
| Functional (Q3, Q5, Q7) | 3 | 40 | 36 | **38** | -2 |
| Detail (Q4, Q6, Q8) | 3 | 37 | 30 | **33** | -4 |
| **Total** | 8 | **104** | **90** | **96** | **-8** |

---

## 4. Improvement Analysis

### Which questions improved most from v1 to v2?

Five questions improved by +1 each: Q1, Q3, Q4, Q7, Q8. Two held steady (Q2, Q5). None regressed. The improvements were spread across all question types, suggesting the updated guidance had a general positive effect rather than a narrow one.

The most impactful improvements:
- **Q4 (pipeline):** v2's depth score went from 4 to 4 (same) but completeness held at 4 while accuracy improved from 4 to 5. The key difference: v2 read ~1800 lines of `markdeepToHTML` (segments 3059-3976 plus 4485-4560) compared to v1's segments that stopped at 4328. This meant v2 caught the full expose loop and API linking steps.
- **Q7 (error handling):** v2 found 8 console.warn/error sites versus v1's identification of fewer. The grep query `console\.warn|console\.error` was more systematic in v2.
- **Q3 (API):** v2 achieved a perfect completeness score of 5, matching the baseline count of all exported members.

### Did task classification help?

Yes, measurably. The v2 metadata shows explicit `task_type` tags:

| Question | v2 Task Type | Effect |
|----------|-------------|--------|
| Q1 | architecture | Read entry points + exports. Appropriate -- broad understanding from ~530 lines |
| Q2 | architecture | Minimal reads (~90 lines). Perhaps too lean -- Q2 score didn't improve |
| Q3 | enumeration | Focused on export block (7133-7456). Excellent targeting -- score improved to 14 |
| Q4 | detail | Read 1800 lines of markdeepToHTML. Correct approach for pipeline tracing |
| Q5 | enumeration | Read media format and diagram sections. Good but missed some edge cases |
| Q6 | enumeration | Relied heavily on grep `str = str\.rp(`. Correct strategy but needed broader grep |
| Q7 | enumeration | Multi-target grep for error patterns. Good improvement over v1 |
| Q8 | enumeration | Multi-target grep for performance patterns. Improved but still gaps |

The classification clearly guided v2 toward appropriate strategies. Architecture questions got broad-but-shallow reads; enumeration questions got targeted grep-first approaches; detail questions got deep sequential reads.

### Did multi-pass grep help on Q6 and Q8?

**Q6 (regex catalog):** Partially. The grep query `str = str\.rp(` captured ~80 matches across `markdeepToHTML`, giving v2 visibility into most inline regex patterns. However, this query misses patterns inside subsidiary functions (`replaceTables`, `replaceLists`, etc.) because those functions use `s = s.rp(` or `str.rp(` without the `str = str.rp(` assignment pattern. A broader grep like `\.rp\(\/` or `new RegExp\(` would have found more. v2's score improved from 8 to 9, so there was progress, but the remaining gap to the baseline (which catalogs ~280 patterns) is still large.

**Q8 (performance):** Yes. v2 used three grep queries covering `cache|lazy|early|return|timeout|performance`, `DANGEROUS_CODE_RE|Object\.freeze|PROTECT_DIGITS`, and `grid\.isUsed|setUsed|minification`. This broader net caught several patterns v1 missed, including grid isUsed tracking, HIDE_O substitution, hidden fence pattern, and conditional MathJax loading. Score improved from 10 to 11.

### Did coverage estimation work?

Yes -- v2 includes explicit `coverage_estimate` fields for each question. These show:

| Q# | Coverage Estimate | Assessment |
|----|-------------------|------------|
| Q1 | ~6% (530/8784) | Appropriate for architecture |
| Q2 | ~1% (90/8784) | Too lean -- Q2 didn't improve |
| Q3 | ~2% (165/8784) | Appropriate -- all exports found |
| Q4 | ~20% (1800/8784) | Good -- comprehensive pipeline coverage |
| Q5 | ~2% (190/8784) | Slightly lean -- missed edge cases |
| Q6 | ~5% (400/8784) | Acknowledged as moderate gap |
| Q7 | <1% (60/8784) | Compensated by thorough grep |
| Q8 | ~1% (100/8784) | Compensated by grep, but still gaps |

The coverage estimation is honest and helps the reader calibrate trust. Q2's self-assessment of "sufficient for architecture -- the file has a simple structure" was arguably overconfident (Q2 didn't improve). But Q6's admission of "moderate gap" with "~30-40 additional patterns" in subsidiary functions is genuinely useful.

### Did boundary padding help?

**Object.seal at line 4723:** v2 did NOT catch this. For Q5, v2 read lines 4644-4693, stopping 30 lines short of the `Object.seal(this)` on Vec2. For Q8, v2 read lines 4644-4656, also stopping short. The boundary padding guidance appears not to have been applied here, or the padding was insufficient (+10 lines would not reach 4723 from a read ending at 4693). This confirms that boundary padding alone cannot solve the "adjacent context" problem for items that are 30+ lines away from the nearest read boundary.

**Other boundary effects:** v2's Q4 read segments 3059-3178, 3178-3378, etc. in overlapping 200-line windows, which successfully captured the full `markdeepToHTML` pipeline. This overlapping strategy worked well for sequential code.

---

## 5. RLM v2 Methodology Analysis

### Extraction Metadata Summary

| Q# | task_type | segments_read | grep_queries | coverage_estimate | lines_read_est |
|----|-----------|--------------|--------------|-------------------|----------------|
| Q1 | architecture | 4 segments | 3 queries | ~6% | ~530 |
| Q2 | architecture | 2 segments | 2 queries | ~1% | ~90 |
| Q3 | enumeration | 4 segments | 1 query | ~2% | ~165 |
| Q4 | detail | 8 segments | 3 queries | ~20% | ~1800 |
| Q5 | enumeration | 3 segments | 2 queries | ~2% | ~190 |
| Q6 | enumeration | 1 segment | 2 queries | ~5% | ~400* |
| Q7 | enumeration | 4 segments | 3 queries | <1% | ~60 |
| Q8 | enumeration | 3 segments | 3 queries | ~1% | ~100 |

*Q6 coverage is mostly from grep output rather than segment reads

### Total Lines Read and File Coverage

**Estimated total unique lines read (across all questions):** ~2,700-3,100 (accounting for segment overlaps, especially in Q4).

**File coverage percentage:** ~31-35% of 8,784 lines.

**Comparison to v1:** v1 was estimated at ~2,800-3,200 lines (~32-36% coverage). v2 is in a similar range. The improvement came not from reading more lines but from reading better-targeted lines.

### Grep Query Effectiveness

v2 used approximately 19 grep queries across all questions (vs v1's ~24). Fewer queries, but more deliberate:

**Best grep queries:**
- Q3: `function headerAnchor|function definitionAnchor|function generateMarkdownTable|function makeMarkdownCodeBrowserSafe` -- surgically found all API function definitions
- Q7: `catch|throw|error|Error|warning|console\.warn|console\.error|try\b|fallback|typeof|undefined` -- comprehensive error pattern sweep
- Q8: `DANGEROUS_CODE_RE|\.test(|HIDE_O|hiddenFence|alreadyProcessed|Object\.freeze|longDocument|PROTECT_DIGITS|PROTECT_RADIX` -- targeted known optimization indicators

**Weakest grep queries:**
- Q6: `str = str\.rp(` -- too narrow; missed subsidiary function regexes
- Q2: `^function [a-zA-Z]` -- too generic; doesn't reveal organization structure

---

## 6. Context Efficiency

### Token Consumption Estimates

| Approach | Lines Read | Quality Score | Quality/Line | Time |
|----------|-----------|--------------|-------------|------|
| Control | ~8,784 | 104 | 0.012 | 1m 22s |
| RLM v1 | ~3,200 | 90 | 0.028 | 3m 22s |
| RLM v2 | ~3,000 | 96 | 0.032 | 3m 34s |

### Quality-Per-Token Ratio

- **Control:** 104 / 8784 = 0.012 quality points per line
- **RLM v1:** 90 / 3200 = 0.028 quality points per line (2.4x more efficient than Control)
- **RLM v2:** 96 / 3000 = 0.032 quality points per line (2.7x more efficient than Control)

v2 is **14% more context-efficient than v1** and **2.7x more efficient than Control**, while narrowing the absolute quality gap from 14 points to 8 points.

### Time-Quality Trade-off

v2 took slightly longer than v1 (3m 34s vs 3m 22s) due to the additional methodology overhead (task classification, coverage estimation, multi-pass grep planning). However, the quality improvement of +6 points justifies this modest time increase.

---

## 7. Remaining Gaps

### What v2 Still Misses That Control Catches

1. **Object.seal on Vec2 (line 4723):** A key V8 optimization that neither v1 nor v2 caught. The Vec2 constructor is at 4710-4728 -- v2 reads stopped at 4693 or 4656. This requires reading the full Vec2 constructor.

2. **Reverse-order string replacement (lines 4092-4122, 3013-3042):** An O(n) technique for maintaining index stability during multi-replacement. Only visible when reading the image grid processing or section wrapping in full.

3. **indexOf preference over regex (throughout):** A pattern where `indexOf` is used instead of regex for fixed-string searches. This requires noticing the pattern across multiple locations -- hard to catch with targeted reads.

4. **makeFilterAny factory (lines 5081-5102):** A performance pattern in PathSet that creates short-circuit filter closures. Located in the diagram engine between findPaths and findDecorations.

5. **Detailed subsidiary function regexes (Q6):** The ~30-40 patterns in `replaceTables`, `replaceLists`, `replaceScheduleLists`, `replaceDefinitionLists`, and `insertTableOfContents` that v2 acknowledged but did not catalog.

6. **Browser-specific error handling details:** Firefox `<object>` tag workaround, Firefox admonition icon sizing, specific defensive null checks in `nodeToMarkdeepSource` and context menu handlers.

7. **Unused reference tracking (lines 4500-4509):** Empty loops that iterate over unused references -- a noteworthy error handling pattern that suggests future warning functionality.

### Are Remaining Gaps Addressable by Planned Phase 7 Engram Features?

Several gaps map to capabilities that RLM improvements could address:

| Gap | Addressable By | How |
|-----|---------------|-----|
| Object.seal at 4723 | Wider boundary padding (20+ lines) | Read full function bodies, not just headers |
| Subsidiary function regexes | Multi-hop exploration | When `replaceTables()` is found, follow into its definition |
| indexOf pattern | Cross-file pattern detection | Semantic search for "optimization" patterns |
| Browser workarounds | Better grep templates | `isFirefox|IE11|polyfill|workaround` as standard queries |
| Unused reference tracking | Contextual expansion | When reading expose loop (4488-4497), expand to 4509 |

The most impactful improvement would be **automatic function-body expansion**: when a function call like `replaceTables()` is identified, automatically read its full definition. This would address the Q6 gap (subsidiary regexes) and several Q7/Q8 gaps without dramatically increasing total reads.

---

## 8. Conclusions

### Is the updated RLM guidance a meaningful improvement?

**Yes.** The +6 point improvement (90 to 96, a 6.7% gain) is significant given that:
- No additional lines were read (coverage remained ~31-35%)
- The improvement came from better targeting, not more reading
- Five of eight questions improved, zero regressed
- The absolute quality gap with Control narrowed from 14 to 8 points

### What is the new quality ceiling for RLM on this file size?

Based on v2's results, the apparent ceiling is approximately **96-100 out of 120** (80-83% of baseline) at ~35% file coverage. To reach the Control's 104, RLM would likely need to increase coverage to ~50-60% of the file, primarily by expanding reads into subsidiary functions for enumeration questions.

The quality curve appears to be:
- 35% coverage: ~96 points (92% of Control)
- 50% coverage (projected): ~100 points (96% of Control)
- 70% coverage (projected): ~103 points (99% of Control)
- 100% coverage: ~104 points (Control baseline)

### Recommendations for Further Improvement

1. **Function-body expansion:** When a function call is identified in a read segment, queue its definition for reading. This would catch `replaceTables()` internals, the full Vec2 constructor, etc.

2. **Better enumeration grep patterns:** For regex catalogs, use `\.rp\(\/|new RegExp\(` instead of `str = str\.rp(`. For performance patterns, add `Object\.seal|Object\.freeze|indexOf.*instead|\.indexOf\(`.

3. **Wider boundary padding for constructors/classes:** When reading a constructor function (like Vec2 at 4710), always read to the closing brace rather than a fixed line count. The `Object.seal(this)` at 4723 is only 13 lines from the constructor start.

4. **Coverage-aware backfill:** When a question's coverage estimate is below 5% for an enumeration task, trigger additional reads. Q2 at 1% and Q7/Q8 at <1% were under-served.

5. **Cross-question context reuse:** Lines read for Q4 (the full pipeline) contain information relevant to Q6, Q7, and Q8. A mechanism to carry forward knowledge from earlier questions would reduce redundant reads.

### Final Assessment

| Metric | Control | RLM v1 | RLM v2 |
|--------|---------|--------|--------|
| Total Score (of 120) | 104 | 90 | **96** |
| % of Baseline | 86.7% | 75.0% | **80.0%** |
| File Coverage | 100% | ~35% | ~33% |
| Context Efficiency | 0.012 | 0.028 | **0.032** |
| Time | 1m 22s | 3m 22s | 3m 34s |

The RLM v2 guidance represents a solid improvement over v1, achieving 80% of baseline quality at one-third file coverage. It demonstrates that **smarter targeting beats broader reading** for context-constrained analysis. The remaining 20% gap is addressable with function-body expansion and better enumeration grep patterns, which should be priorities for the next iteration of RLM guidance.
