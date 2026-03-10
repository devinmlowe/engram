---
question: "Q8: Find any performance optimizations (caching, lazy evaluation, early exits). Describe each."
evaluator_start: "2026-03-10T12:59:30Z"
evaluator_end: "2026-03-10T13:01:27Z"
---

# Performance Optimizations in markdeep.js

## 1. String Method Aliasing for Minification and Call Overhead Reduction

**Lines 46-48:**
```js
var _ = String.prototype;
_.rp = _.replace;
_.ss = _.substring;
```
The two most frequently called string methods (`replace` and `substring`) are aliased to shorter names (`rp` and `ss`). This serves dual purposes: (a) reduces minified file size since these are called ~180+ times (`rp`) throughout the codebase, and (b) provides a marginal reduction in property lookup depth since the shorter name is resolved from the same prototype chain. The comment says "For minification. This is admittedly scary."

## 2. Math Function Hoisting

**Lines 1457-1462:**
```js
var max = Math.max;
var min = Math.min;
var abs = Math.abs;
var sign = Math.sign || function (x) { ... };
```
The core math functions `Math.max`, `Math.min`, `Math.abs`, and `Math.sign` are hoisted into local variables. This avoids repeated property lookups on the `Math` object throughout the diagram processing code (which uses these extensively in `Vec2` operations, path finding, and decoration placement). The `sign` also includes an inline polyfill for environments lacking `Math.sign`.

## 3. Protect/Expose String Interning System

**Lines 3069-3108:**
The `protect()`/`expose()` system is a central performance-and-correctness mechanism that acts as a string interning cache. It stores arbitrary strings in a `protectedStringArray` and replaces them with short fixed-length tokens (6 characters: a Unicode private-use-area character + 4 base-32 digits + the same PUA character).

Key design details:
- **Base-32 encoding** (line 3074): Uses base 32 instead of higher bases to avoid the character `x`, which would trigger Markdeep's dimension beautifier pattern `\dx\d`. This is a performance-conscious encoding choice.
- **Fixed-length tokens** (line 3078): `PROTECT_DIGITS = 4` gives 32^4 = 1,048,576 possible tokens, described as "sufficient." The fixed length means the `PROTECT_REGEXP` can use an exact quantifier `{4,4}` for efficient matching.
- **Pre-compiled regex** (line 3082): `PROTECT_REGEXP` is compiled once at the start of `markdeepToHTML` and reused in all expose passes.
- **Iterative expose with escape detection** (lines 4490-4497): The expose phase runs in a `while` loop with `maxIterations = 50` and an `exposeRan` flag. This handles nested protections (e.g., protected strings that themselves contain protected strings) without infinite loops, and the boolean flag avoids unnecessary iterations when no substitutions occurred.

## 4. Pre-compiled Regular Expression Variables

Throughout the code, complex regular expressions that are used in hot loops are compiled once and stored in variables rather than being re-created on each use:

- **Line 3082:** `PROTECT_REGEXP` -- compiled once, used in every expose pass
- **Line 1947-1950:** `TABLE_ROW`, `TABLE_SEPARATOR`, `TABLE_CAPTION`, `TABLE_REGEXP` -- table detection patterns composed from parts and compiled once
- **Line 3515:** `labeledFencePattern` -- code fence detection regex, compiled once per call to `cleanupCodeFences`
- **Line 3565:** `pattern` in `processOneFenceType` -- compiled once per fence symbol type
- **Line 2872:** `headerPattern` in `wrapHeaderSections` -- compiled once for all header scanning
- **Line 4053:** `imageLineRegex` -- compiled once for image grid detection
- **Line 6163:** `markerPattern` in `attributeSourceLines` -- compiled once for DOM walking
- **Line 4696:** `inlineCodeRegexp` -- compiled once and used potentially twice (with/without syntax highlighting)
- **Line 3784:** `OPTIONAL_LINE_NUM` -- a regex source fragment composed once and reused in 6+ header-level regex constructions

## 5. Catastrophic Backtracking Prevention

Multiple regexes are explicitly designed to prevent exponential backtracking, with comments documenting the concern:

- **Line 2871:** `wrapHeaderSections` uses a simple `<h([1-6])[^>]*>` pattern instead of nested quantifiers, with a comment: "This avoids catastrophic backtracking from nested quantifiers."
- **Line 2895:** Anchor tag scanning in `wrapHeaderSections` uses `indexOf`-based string searching instead of regex: "Find anchor tags using a simple string search instead of regex to avoid backtracking."
- **Line 2867-2868:** `wrapHeaderSections` includes an explicit safety timeout (`TIMEOUT_MS = 5000`) to abort if the function takes too long.
- **Lines 4046-4053:** The image grid regex was rewritten to avoid nested quantifiers: "CRITICAL FIX: The original regex has catastrophic backtracking due to nested quantifiers. Original: `((?:\n(?:...)+){2,}|...)` - nested + inside {2,} causes exponential backtracking." The solution uses a two-pass approach (find individual image lines, then group consecutive ones in code).
- **Lines 3984, 4028, 4108-4109, 4125, 4147:** Multiple image regex patterns use bounded quantifiers like `{0,200}` and `{0,100}` on attribute/caption matching to prevent backtracking: "Limit attribute matching to prevent catastrophic backtracking on malformed input."

## 6. Early Exit / Guard Clause Pattern

Numerous functions use early returns to avoid unnecessary processing:

- **Line 1641:** `h1TitleOutputStylesheet()` immediately returns `''` if the option is disabled.
- **Line 1788:** `extractDiagram()` defines `noDiagramResult` as a pre-allocated return object, returned on any failure path (lines 1832, 1887) to avoid constructing objects on failure.
- **Line 2853:** `isolated()` returns `false` immediately if either argument is falsy.
- **Line 3457:** `looksLikeDiagram()` returns `false` immediately if the content contains HTML tags.
- **Line 3461:** `looksLikeDiagram()` returns `false` if fewer than 3 lines.
- **Line 4618:** `removeLeadingSpace()` returns the original string immediately when `minimum === 0` (no leading space to remove).
- **Line 5005:** `backDiagonalDownEndsAt()` returns `false` immediately if `!this.isBackDiagonal()`.
- **Line 4972, 4983, 4994, 5005:** All diagonal path methods check `isDiagonal()`/`isBackDiagonal()` first and return `false` before doing any coordinate math.
- **Line 6109-6110:** `window.alreadyProcessedMarkdeep` prevents re-processing the document if the script is loaded multiple times.
- **Line 6345-6351:** Context menu handler returns early if source view is active or there is a text selection.
- **Line 6412-6417:** `formatDocument()` detects `mode === 'script'` and returns immediately without any processing.
- **Line 6520-6535:** The `noformat` URL parameter causes an early exit that skips all Markdeep processing.
- **Line 7054:** Mouse move handler returns immediately if no active link or preview container.
- **Line 7415:** `makeMarkdownCodeBrowserSafe()` returns immediately if input is falsy.
- **Line 7422:** Same function returns immediately if `DANGEROUS_CODE_RE` doesn't match, avoiding all regex work.

## 7. Lookup Table / Object-as-Dictionary Pattern

Several places use object literals as O(1) lookup tables instead of arrays or switch chains:

- **Lines 6148-6154:** `isBlockElement()` uses a dictionary of block-level HTML tag names:
  ```js
  var blockTags = {
      'P': true, 'DIV': true, 'H1': true, 'H2': true, ...
  };
  return blockTags[tagName.toUpperCase()] || false;
  ```
  This is O(1) property lookup instead of an array `indexOf` scan.

- **Lines 1912-1915:** `refCounter` and `refTable` are object-based lookup tables for figure/table/listing/diagram reference numbering. References are looked up by key rather than searched linearly.

- **Lines 3063-3066:** `endNoteTable` and `referenceLinkTable` are object-based dictionaries for O(1) lookup of footnote numbers and reference link URLs.

- **Line 4515:** `apiDefinitionCount` is an object mapping API names to overload counts for O(1) lookup.

- **Lines 2114-2116:** List bullet attributes are pre-computed into an `ATTRIBS` dictionary keyed by bullet character (`+`, `-`, `*`, checkbox characters), avoiding repeated `protect()` calls during list processing.

- **Line 5160:** Point type classification uses an object literal for O(1) mapping: `{'*':'closed', 'o':'open', ...}[decoration.type]`.

## 8. Lazy/Deferred Loading of MathJax

**Lines 6120-6134 and 6707:**
MathJax (a substantial JavaScript library) is loaded dynamically only if the document actually contains math notation. The `needsMathJax()` function (lines 6136-6141) scans the HTML for `$$...$$`, `\(...\)`, or `\begin{` patterns. Only when math is detected does `loadMathJax()` dynamically create a `<script>` element and append it to the document head. This avoids the significant overhead of loading and initializing MathJax for documents that don't contain math.

## 9. Grid Data Structure for Diagram Processing

**Lines 4730-4774:**
The `makeGrid()` function creates an optimized 2D character grid from a string for ASCII diagram processing:

- **Direct string indexing** (line 4740-4741): The grid function accesses characters via `str[y * (grid.width + 1) + x]`, converting 2D coordinates to a 1D index in constant time rather than splitting into a 2D array. This avoids the memory overhead of creating an array-of-arrays.
- **Bounds checking** (line 4740): Returns `' '` (space) for out-of-bounds coordinates rather than throwing, eliminating the need for callers to check bounds.
- **Boolean used-tracking** (line 4745): `grid._used` is a sparse array tracking which characters have been consumed. The `isUsed()` check (line 4773) uses `=== true` explicitly, and `setUsed()` writes directly by index.

## 10. `makeFilterAny` Factory Function for Path Queries

**Lines 5081-5102:**
Instead of defining separate methods for each path query type (upEndsAt, downEndsAt, leftEndsAt, etc.), a factory function `makeFilterAny` generates them:
```js
function makeFilterAny(method) {
    return function(x, y) {
        for (var i = 0; i < this._pathArray.length; ++i) {
            if (method.call(this._pathArray[i], x, y)) { return true; }
        }
    }
}
PS.upEndsAt = makeFilterAny(_.upEndsAt);
```
This creates closures that short-circuit on the first match (`return true`), avoiding scanning the entire path array when the answer is found early. The comment at line 5067 notes: "This was designed so that all of the methods can later be implemented in O(1) time, but it currently uses O(n) implementations for source code simplicity."

## 11. Recursive Diagram Extraction Avoidance

**Lines 1792-1794:**
The `extractDiagram()` function searches for diagram boundaries using `indexOf` (native optimized string search) rather than regex:
```js
for (var i = sourceString.indexOf(DIAGRAM_START);
     i >= 0;
     i = sourceString.indexOf(DIAGRAM_START, i + DIAGRAM_START.length))
```
This leverages the browser's native `indexOf` implementation (typically Boyer-Moore or similar) rather than constructing a regex for each search iteration.

## 12. Single-Pass SVG String Building

**Lines 5104-5111 and 5143-5187:**
The `PathSet.toSVG()` and `DecorationSet.toSVG()` methods build SVG output via string concatenation in a single loop, rather than creating intermediate DOM nodes. This avoids the overhead of DOM manipulation for diagram rendering. The entire diagram is assembled as a string and inserted into the document once (line 5773-5838).

## 13. Protection of Content Before Processing

**Lines 3663-3726:**
The processing pipeline protects already-processed content (code blocks, SVG, style blocks, raw HTML attributes, MathJax) by replacing them with short tokens before further markdown processing. This prevents:
- Re-processing of already-handled content
- Interference between processing stages
- Regex matches inside protected content (which would waste time scanning irrelevant text)

This is done in a deliberate order: code blocks first, then SVG, then style, then img tags, then inline code, then code again, then PRE, then HTML attributes. Each protection step removes content from further regex scanning, making subsequent regexes faster because they operate on shorter strings.

## 14. `Object.freeze` on Exported API

**Line 7444:**
```js
window.markdeep = Object.freeze({ ... });
```
The exported `markdeep` API object is frozen, which allows the JavaScript engine to optimize property access since the shape of the object is guaranteed not to change. This is a minor optimization that benefits repeated access to `window.markdeep.format`, etc.

## 15. Pre-computed Constant Values

- **Line 85:** `DIAGRAM_START = Array(5 + 1).join(DIAGRAM_MARKER)` -- pre-computes the `'*****'` string once rather than reconstructing it.
- **Lines 154-155:** `codeFontStack` and `codeFontSize` are computed once at script initialization.
- **Line 166:** `isFirefox` is computed once by checking the user agent string, then used in multiple conditional branches for browser-specific CSS.
- **Line 4658-4665:** Diagram constants `SCALE = 8`, `ASPECT = 2`, `DIAGONAL_ANGLE` are computed once and reused throughout the diagram-to-SVG conversion.
- **Line 4590:** In `equalizeLineLengths()`, the padding string `spaces = Array(longest + 1).join(' ')` is pre-computed once to the maximum needed length, then substrings are taken from it (line 4596) rather than creating new strings for each line.
- **Lines 4671-4683:** Character classification strings (`ARROW_HEAD_CHARACTERS`, `POINT_CHARACTERS`, `JUMP_CHARACTERS`, etc.) are pre-computed and combined into `DECORATION_CHARACTERS` once.

## 16. Two-Pass Image Grid Processing

**Lines 4053-4122:**
Instead of using a single complex regex with nested quantifiers to match multi-line image grids (which caused catastrophic backtracking), the code uses a two-pass strategy:
1. **Pass 1** (lines 4056-4064): Find all individual image lines with a simple regex, collecting their positions.
2. **Pass 2** (lines 4067-4090): Group consecutive image lines by comparing their indices in linear time.
3. **Apply replacements in reverse order** (lines 4092-4122): String replacements are applied from end to start to maintain correct indices.

This transforms an O(2^n) worst-case regex into an O(n) algorithm.

## 17. Short-Circuit Boolean Evaluation in Diagram Character Classification

**Lines 4685-4705:**
Character classification functions like `isSolidHLine`, `isSolidVLine`, `isVertex`, etc. use `indexOf` on pre-built character strings for O(k) classification where k is very small (typically 1-6 characters). These are called thousands of times during diagram processing. The functions also use short-circuit `||` operators so that the most common case (matching the primary character) is checked first:
```js
function isSolidHLine(c) { return (c === '-') || isUndirectedVertex(c) || isJump(c); }
```

## 18. `Object.seal` on Vec2 Instances

**Line 4723:**
```js
Object.seal(this);
```
Every `Vec2` instance is sealed immediately after construction. This tells the JavaScript engine that no new properties will be added, enabling the engine to use a fixed hidden class / shape for all `Vec2` objects. Since thousands of `Vec2` instances are created during diagram processing, this can significantly improve property access speed through monomorphic inline caches.

## 19. Duplicate Processing Prevention

**Lines 6109-6110:**
```js
if (! window.alreadyProcessedMarkdeep) {
    window.alreadyProcessedMarkdeep = true;
```
A global flag prevents the entire Markdeep processing pipeline from running more than once, which is critical because the script tag may be included multiple times (e.g., via `(insert here)` includes). Lines 6496-6503 also remove recursive references to the markdeep script itself from the DOM to prevent the cost of recursive loading.

## 20. `makeHeaderFunc` Factory for Header Processing

**Lines 3123-3153:**
Instead of defining separate functions for each header level (1-6), a single factory `makeHeaderFunc(level)` generates level-specific closures. This avoids code duplication and ensures the level-dependent logic (option lookups, tag construction) is computed once per closure creation rather than per invocation. The generated functions are then used in regex replacements at lines 3769-3801.

## 21. Hidden Fence Array Pattern for Multi-Pass Processing

**Lines 3512-3535:**
The `cleanupCodeFences` function uses a "hide and restore" pattern: labeled code fences are temporarily replaced with short placeholder tokens (`\ue000FENCE0\ue001`) before processing unlabeled fences. This ensures that the unlabeled fence regex (line 3523) doesn't accidentally match content inside already-labeled fences, and it makes the regex operate on a shorter string. The placeholders are restored afterward (line 3533).

## 22. Reverse-Order String Replacement for Index Stability

**Lines 4092-4122 and 3013-3042:**
When multiple replacements need to be applied to a string at known positions, the code processes them in reverse index order. This maintains correct indices without needing to recalculate positions after each insertion, avoiding an O(n^2) recomputation problem.

## 23. `indexOf`-Based Scanning Over Regex Where Possible

Throughout the code, `indexOf` is preferred over regex when searching for fixed strings:
- **Line 1792:** `sourceString.indexOf(DIAGRAM_START)` to find diagram boundaries
- **Lines 2902-2917:** Anchor tag scanning in `wrapHeaderSections` uses chained `indexOf` calls
- **Line 3204:** `window.location.search.indexOf('id=')` for URL parameter detection
- **Lines 3254, 3306, 3311:** `line.indexOf('*****')` for diagram boundary detection in the line tracker
- **Line 4493:** `str.indexOf(PROTECT_CHARACTER)` to check if any protected strings remain

`indexOf` is typically faster than regex for fixed-string searches because it can use optimized native string search algorithms without the overhead of regex compilation and state machine execution.
