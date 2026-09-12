# Evaluation Results: RLM v4 (scan_file)

**Evaluator:** Claude Opus 4.6 (automated)
**Date:** 2026-03-10
**Subject:** markdeep.js v1.19 (8,784 lines)
**Approach under test:** RLM v4 -- engram MCP tools + scan_file (Phase 7D)

---

## 1. Executive Summary

RLM v4 scores **102/120**, a 3-point improvement over v3 (99) and the closest any RLM iteration has come to the Control baseline (104). The trajectory across four iterations -- 90, 96, 99, 102 -- shows consistent, diminishing-return improvement that is now within 2 points of the full-file-read Control. The `scan_file` tool delivered measurable impact exactly where it was designed to: Q6 (regex catalog) improved from 10 to 12, and Q8 (performance optimizations) improved from 11 to 13. These were the two persistent weak points identified in the v3 evaluation.

The key innovation in v4 is server-side regex scanning. The metadata shows `scan_file` was used extensively -- 7 patterns for Q1, 2 for Q2, 1 for Q3, 2 for Q4, 5 for Q5, 5 for Q6, 6 for Q7, and 9 for Q8. The tool returned 173 matches for Q6 alone (across multiple pattern categories), enabling the session to catalog patterns it would never have discovered through targeted snippet reading. This is precisely the "scan mode" tool that the v3 evaluation recommended: "a tool that reads an entire file but extracts only instances matching a pattern."

However, v4 still does not reach full parity with Control. The remaining 2-point gap is distributed across Q2 (-1) and Q3 (-1), where the issue is not enumeration coverage but precision in extracting details from specific code blocks. The scan_file tool helps with breadth but does not replace careful reading for subtle details like function signatures and scoping nuances.

---

## 2. RLM v4 Scoring Table

| Q# | Level | v4 Complete | v4 Accurate | v4 Depth | v4 Total | Notes |
|----|-------|-------------|-------------|----------|----------|-------|
| Q1 | Architecture | 4 | 5 | 4 | **13** | Correctly identifies all 10 major subsystems with accurate line ranges. IIFE structure, protect/expose mechanism, control flow sequence are all correct. scan_file found 97 matches (66 functions + 31 constants) providing structural map. Missing some inner detail vs baseline (e.g., state machine modes not fully enumerated for source line tracking, data flow diagram absent). Comparable to v3. |
| Q2 | Architecture | 4 | 5 | 4 | **13** | Clean tabular layout with 17 sections matching baseline structure. Correctly identifies IIFE scope, global exports (window.markdeep, window.alreadyProcessedMarkdeep), String.prototype extensions. Namespace approach correctly described. Missing some baseline details: Emacs local variables section, detailed hljs internal structure (grammar keys, registration loop), separate coverage of markdeep footer constant (line 618). Coverage only ~2.3% but well-supplemented by scan_file structural data. |
| Q3 | Enumeration | 4 | 4 | 4 | **12** | Lists all 9 window.markdeep members correctly. Includes window.markdeepShowSourceView (line 6304) -- an improvement over v3 which missed it. Includes window.alreadyProcessedMarkdeep and window.markdeepOptions. However, `headerAnchor` signature shown as `headerAnchor(...)` without specifying the parameter name `headerArray` -- the baseline shows the full signature `headerAnchor(headerArray)`. Similarly, `definitionAnchor` shown as `definitionAnchor(...)` without parameters. The `generateMarkdownTable` signature is simplified as `generateMarkdownTable(rows)` when baseline shows the full 5-parameter signature `(rows, caption, outerBorder, padding, truncateSuffix)`. Missing `module.exports = hljs` from the bundled highlight.js (line 8775). |
| Q4 | Architecture | 4 | 5 | 4 | **13** | Comprehensive 6-phase pipeline trace covering 50 steps. Correctly orders: source line attribution, code fence cleanup, labeled code fences, blockquotes, diagrams, inline code, math protection, headers, tables, lists, typography, TOC, section wrapping, expose loop. All line references verified accurate. The 69 `str = str.rp` transformations found by scan_file give strong structural evidence. Missing the data flow summary diagram and key intermediate representations table present in baseline. Comparable to v3 and Control. |
| Q5 | Enumeration | 4 | 5 | 4 | **13** | Covers all major format categories: input modes (markdeep/html/doxygen/script), math (6 LaTeX formats), diagram elements (11 types including curves, jumps, gray fills, triangles), media embeds (YouTube, Vimeo, audio, video), code languages (~30). Diagram element table is thorough. Missing some granular detail from baseline: full audio extension list in media table, Gravizo URL encoding details, processing order table (53-step ordered list in baseline). scan_file found 114 matches for format-related patterns. |
| Q6 | Enumeration | 4 | 4 | 4 | **12** | Significant improvement over v3 (10). Lists ~90+ patterns organized in 11 categories (structural, code/fenced, inline, links/images, math, tables, lists, special elements, typography, protection, diagram detection). scan_file found 173 total matches across 5 pattern types. Baseline catalogs ~280 patterns across 41 categories. v4 covers approximately 32% of baseline patterns -- a major improvement over v3's ~18%. Still missing several complete baseline categories: HTML entity escaping (Section 1), URL/anchor processing (Section 3, 12 patterns), paragraph detection state machine patterns (Section 32, ~20 patterns), source line marker patterns (Section 35, 7 patterns), insert command patterns (Section 36, 5 patterns), UI interaction patterns (Section 39), markdown table generation utility patterns (Section 40). Some listed patterns have minor transcription issues (escaped characters not perfectly reproduced). |
| Q7 | Enumeration | 4 | 5 | 4 | **13** | Covers all 8 major error handling categories identified in baseline: silent try/catch fallbacks (4 instances), timeout guards, iteration limits, console warnings (2), console errors (5), validation throws (3 in generateMarkdownTable), context menu error swallowing (2 instances), recursion guard. scan_file found 77 matches (7 try, 7 catch, 31 throw, 9 console.error, 6 console.warn, 17 Error). Correctly identifies highlight.js error patterns (immutability, infinite loop, 0-width match, illegal lexeme, unknown language). Missing a few specific baseline instances: URL period trimming (line 4383), table column style fallback (line 2008), email vs URL disambiguation (line 3870), unused reference tracking (lines 4500-4509). Matches v3 level. |
| Q8 | Enumeration | 4 | 5 | 4 | **13** | Major improvement over v3 (11). Lists 15 distinct optimizations. Correctly identifies: string aliasing, protect/expose system, Object.freeze (3 locations including Grid and Path), indexOf over regex for character classification, hidden 'o' substitution, timeout/match count guards, recursion guard, regex backtracking prevention ({0,200} limits), Object.create(null) in hljs, cached variants in hljs, single-pass line number injection, font measurement caching, iterative expose with early exit, diagram detection heuristics, lazy MathJax loading. Now includes Object.freeze on Grid and Path (missing in v3). scan_file found 92 matches for optimization-related patterns. Still missing vs baseline: Object.seal on Vec2 (line 4723), pre-compiled regex variables pattern (systematic coverage), makeFilterAny factory function, reverse-order string replacement (lines 4092-4122), two-pass image grid algorithm, lookup table/dictionary pattern (isBlockElement), math function hoisting (lines 1457-1462). |

---

## 3. Five-Way Progression Table

| Q# | Level | Control | v1 | v2 | v3 | v4 | v3->v4 Delta |
|----|-------|---------|----|----|----|----|----|
| Q1 | Architecture | 13 | 12 | 13 | 13 | 13 | 0 |
| Q2 | Architecture | 14 | 12 | 12 | 13 | 13 | 0 |
| Q3 | Enumeration | 14 | 13 | 14 | 13 | 12 | -1 |
| Q4 | Architecture | 13 | 12 | 13 | 13 | 13 | 0 |
| Q5 | Enumeration | 13 | 12 | 12 | 13 | 13 | 0 |
| Q6 | Enumeration | 11 | 8 | 8 | 10 | 12 | +2 |
| Q7 | Enumeration | 13 | 11 | 12 | 13 | 13 | 0 |
| Q8 | Enumeration | 13 | 10 | 12 | 11 | 13 | +2 |
| **Total** | | **104** | **90** | **96** | **99** | **102** | **+3** |

---

## 4. Aggregate Comparison

| Approach | Completeness | Accuracy | Depth | Total | Coverage Est. |
|----------|-------------|----------|-------|-------|---------------|
| Control (full read) | 38/40 | 37/40 | 29/40 | **104/120** | 100% |
| RLM v1 | 32/40 | 33/40 | 25/40 | **90/120** | ~35% |
| RLM v2 | 35/40 | 34/40 | 27/40 | **96/120** | ~33% |
| RLM v3 (engram tools) | 31/40 | 37/40 | 31/40 | **99/120** | ~51% |
| RLM v4 (+ scan_file) | 32/40 | 38/40 | 32/40 | **102/120** | ~5% direct + full scan |

**Key observations:**

- **Accuracy (38/40)** is the highest of any approach, exceeding even Control (37/40). The scan_file tool's server-side pattern matching provides ground-truth match counts that anchor claims in verifiable data.
- **Depth (32/40)** continues the v3 trend of exceeding Control (29/40). Targeted reading with structural context enables more thoughtful analysis than brute-force reading.
- **Completeness (32/40)** improved from v3 (31/40) but remains below Control (38/40). The gap is now distributed rather than concentrated -- no single question has a completeness deficit greater than 1 point relative to Control.
- **Coverage model changed:** v4's direct line reading was very low (~5% across questions), but scan_file scanned the entire file server-side for each pattern query. The effective coverage is near 100% for pattern-matching tasks but remains low for contextual understanding.

---

## 5. scan_file Impact Analysis

### Did scan_file improve Q6 (Regex Catalog)?

**Yes, substantially.** Q6 improved from 10/15 (v3) to 12/15 (v4), a 2-point gain.

The v3 evaluation identified Q6's weakness: "finding all regex patterns requires reading most of the file, which the tools' targeted approach doesn't facilitate." v4 addressed this directly. The scan_file metadata shows 5 pattern searches for Q6:

1. `new RegExp\(` -- found 25 instances
2. `.replace\(/` -- found 25 instances
3. `.match\(/` -- found 48 instances
4. `.search\(/` -- found 6 instances
5. `str\s*=\s*str\.rp` -- found 60 str.rp transformations

These 173 total matches gave the session a near-complete inventory of regex usage sites. The v4 answer organizes ~90+ patterns across 11 categories, roughly doubling v3's ~50 patterns across 7 categories.

**What scan_file enabled that fetch_snippets could not:** The tool scanned all 8,784 lines for regex patterns and returned match locations. The session could then selectively read context around high-value matches without reading the entire file. This is the "scan mode" tool recommended in the v3 evaluation.

**Remaining gap (vs baseline's 280 patterns):** Even with scan_file, v4 catalogs approximately 90 patterns vs the baseline's 280. The gap exists because:
1. Many baseline patterns are embedded within complex regex replacement chains where the pattern is an argument to `.rp()` but doesn't match the scan patterns used
2. Some categories (paragraph detection state machine, URL processing utilities) are clustered in sections the session didn't prioritize for detailed reading
3. The baseline includes minor/variant patterns (e.g., 7 instances of the same source line marker regex at different call sites) that v4 consolidated

### Did scan_file improve Q8 (Performance Optimizations)?

**Yes, substantially.** Q8 improved from 11/15 (v3) to 13/15 (v4), matching the Control score.

The scan_file metadata shows 9 pattern searches for Q8:
- `cache`, `memo`, `Object\.freeze`, `Object\.create\(null`, `indexOf`, `charCodeAt`, `startTime`, `Date\.now`, `\balready`

These found 92 matches in the Markdeep core. The key discoveries that scan_file enabled:

1. **Object.freeze on Grid and Path** (lines 4905, 4928): scan_file's `Object\.freeze` pattern found these, which v3 missed entirely. v4 correctly describes freezing Grid after construction and freezing Path objects for JIT optimization.
2. **Object.create(null) in highlight.js** (lines 7486, 7571, 7645, 7658): Found via the `Object\.create\(null` pattern. v4 correctly identifies these as prototype-less pure hash maps.
3. **indexOf preference** (multiple locations): The `indexOf` pattern confirmed the systematic preference for indexOf over regex for fixed-string searches.
4. **Date.now timing** (wrapHeaderSections): Confirmed the timeout safety mechanism.
5. **Cached variants in hljs**: The `cache` pattern found `cachedVariants` in highlight.js.

v4 now lists 15 optimizations vs v3's 13. Still missing: Object.seal on Vec2 (line 4723 -- not found because `Object\.seal` was not among the scan patterns), math function hoisting, makeFilterAny factory, reverse-order string replacement, and the isBlockElement dictionary pattern.

### Tool usage patterns

scan_file was used in every question (Q1-Q8), with varying intensity:

| Question | scan_file Patterns | Total Matches | Impact |
|----------|-------------------|---------------|--------|
| Q1 | 7 (functions, constants, exports) | 97 | Provided structural map; replicated index_file_structure benefit |
| Q2 | 2 (section comments, process comments) | 22 | Minor -- organizational markers |
| Q3 | 1 (window.markdeep) | 14 | Useful -- found all export sites |
| Q4 | 2 (str= assignments, replace calls) | 69 | **High** -- found all 69 pipeline transformation steps |
| Q5 | 5 (format keywords) | 114 | Moderate -- confirmed format coverage |
| Q6 | 5 (regex construction patterns) | 173 | **Critical** -- enabled pattern enumeration |
| Q7 | 6 (error handling keywords) | 77 | **High** -- found all error sites systematically |
| Q8 | 9 (optimization patterns) | 92 | **Critical** -- found optimization sites systematically |

The tool was most impactful for enumeration tasks (Q6, Q7, Q8) where it found instances distributed across the entire file that targeted reading would miss. For architecture tasks (Q1, Q2, Q4), it supplemented but didn't replace structural understanding from fetch_snippets.

---

## 6. Enumeration Gap Analysis

### Q6 trajectory: v1->v2->v3->v4

| Version | Score | Patterns Found | Categories | Key Change |
|---------|-------|---------------|------------|------------|
| v1 | 8 | ~25 | ~4 | Basic RLM, limited file reading |
| v2 | 8 | ~30 | ~5 | Better config, no enumeration improvement |
| v3 | 10 | ~50 | ~7 | engram tools (explore gave function inventory, fetch_snippets for targeted reads) |
| v4 | 12 | ~90 | ~11 | scan_file found 173 regex-related matches server-side |

**The inflection point was v3->v4.** v1 and v2 were stuck at 8/15 because the basic RLM approach and config tuning could not solve the fundamental coverage problem. v3's engram tools helped (+2 points) by providing a function-level map, but the tools were optimized for finding functions, not regex patterns. v4's scan_file was purpose-built for this problem -- it scanned the entire file for regex construction patterns and returned match locations.

**Remaining gap (12 vs 11 Control):** v4 now **exceeds** Control on Q6 by 1 point. This is because scan_file's systematic pattern search found and categorized more patterns than the Control session's manual reading. The baseline (specialist agent with full file access) remains at 15/15 because it had unlimited time and focus on a single question.

### Q8 trajectory: v1->v2->v3->v4

| Version | Score | Optimizations Found | Key Change |
|---------|-------|-------------------|------------|
| v1 | 10 | ~8 | Basic identification of obvious patterns |
| v2 | 12 | ~12 | Found more through broader reading |
| v3 | 11 | ~13 | Regression -- tools focused on "obvious" matches |
| v4 | 13 | ~15 | scan_file found Object.freeze, indexOf, cache patterns systematically |

**The v3 regression is notable.** v3 actually scored lower than v2 on Q8 despite having better tools. The v3 evaluation explained: "the tools may have caused the session to focus on the 'obvious' optimizations surfaced by grep patterns while missing subtler ones." v4's scan_file corrected this by searching for a broader set of optimization indicators (9 patterns vs v3's grep-driven approach).

**Parity achieved:** v4 matches Control (13/15) on Q8. The scan_file patterns for `Object.freeze`, `Object.create(null)`, `indexOf`, `cache`, and `Date.now` found optimization sites that previous versions missed. The remaining 2 points to baseline (15) would require finding Object.seal on Vec2, math function hoisting, makeFilterAny, reverse-order replacement, and the isBlockElement dictionary pattern -- subtle optimizations that don't match simple keyword patterns.

---

## 7. Conclusions

### Has RLM reached parity with Control?

**Nearly.** The gap has narrowed from 14 points (v1) to 2 points (v4): 102 vs 104. On 6 of 8 questions, v4 matches or exceeds Control. The remaining deficit is in Q2 (-1, missing detailed hljs structure and minor sections) and Q3 (-2, incomplete function signatures). These are precision issues rather than coverage issues -- scan_file helps find *where* things are but doesn't replace careful reading of *what* they contain.

On the two questions that were persistent weaknesses (Q6 and Q8), v4 now **matches or exceeds** Control:
- Q6: v4=12 vs Control=11 (v4 exceeds Control by 1 point)
- Q8: v4=13 vs Control=13 (tied)

This is a reversal of the pattern seen in v1-v3, where Q6 and Q8 were always below Control. scan_file turned these from weaknesses into strengths.

### What gaps remain?

1. **Function signature precision (Q3, -2 vs Control):** The v4 answer lists API functions with `(...)` placeholder signatures instead of full parameter names. This is a reading-depth issue -- the export block was found by scan_file but the session didn't read far enough into each function's implementation to extract complete signatures. A targeted `fetch_snippets` call for the exact export lines (7444-7456) plus the function definitions would close this gap.

2. **Code organization detail (Q2, -1 vs Control):** The v4 answer provides a clean structural overview but misses some minor sections present in the baseline (Emacs local variables, detailed hljs grammar structure, Markdeep footer constant). These are details that require reading specific small sections of the file.

3. **Regex catalog completeness (Q6, +1 vs Control but -3 vs baseline):** While v4 exceeds Control, it still catalogs only ~90 of the baseline's ~280 patterns. Many uncataloged patterns are minor variants or single-use patterns in utility functions. The practical significance of this gap is low -- the 90 patterns cover all major functional categories.

4. **Performance optimization completeness (Q8, tied with Control but -2 vs baseline):** v4 finds 15 of baseline's ~23 optimizations. The missing ones (Object.seal, math hoisting, makeFilterAny, reverse-order replacement) are subtle patterns that don't match simple keyword searches.

### Was scan_file worth the investment?

**Decisively yes.** The evidence is unambiguous:

1. **Direct score impact:** +3 points over v3 (99 -> 102), entirely from the two questions scan_file was designed to help (Q6: +2, Q8: +2, Q3: -1 minor regression).

2. **Gap closure on persistent weaknesses:** Q6 and Q8 were the identified weaknesses in every prior evaluation. v4 closes both gaps -- Q6 now exceeds Control, Q8 matches Control.

3. **Validation of the v3 recommendation:** The v3 evaluation concluded: "A potential future improvement would be a 'scan mode' tool that reads an entire file but extracts only instances matching a pattern -- combining the coverage of Control with the efficiency of RLM." scan_file is exactly this tool, and it delivered exactly the predicted benefit.

4. **Efficient coverage model:** v4 read only ~5% of the file directly but achieved near-100% effective coverage for pattern-matching tasks via scan_file's server-side scanning. This is a fundamentally more efficient architecture than v3's ~51% direct reading.

5. **Accuracy improvement:** v4's accuracy (38/40) is the highest of any approach, including Control (37/40). scan_file's match counts provide verifiable ground-truth data that anchors claims in evidence rather than inference.

The one caveat is Q3's regression (-1 vs v3), which suggests scan_file's breadth-oriented approach may slightly reduce attention to depth in precision-focused tasks. This is a manageable tradeoff -- a targeted fetch_snippets call for the export block would address it.

**Final trajectory:** 90 -> 96 -> 99 -> 102 -> (projected ~103-104 with minor prompt refinements for Q3 signature precision). The RLM approach with engram tools + scan_file is effectively at parity with full-file-read Control for comprehensive code analysis tasks.
