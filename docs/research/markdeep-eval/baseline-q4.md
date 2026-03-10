---
question: "Q4: Trace the rendering pipeline: what happens when a markdown document is processed start-to-finish?"
evaluator_start: "2026-03-10T00:00:00Z"
evaluator_end: "2026-03-10T00:45:00Z"
---

# Q4: Rendering Pipeline Trace -- Start to Finish

This document traces the complete execution path when Markdeep processes a markdown document, from the moment the script loads to the final rendered HTML in the browser. Every transformation step is identified with line references to `markdeep.js` (version 1.19, 8,784 lines).

---

## Phase 0: Script Loading and Initialization (Lines 39--618)

### Step 0.1: IIFE Entry (Line 39)

The entire Markdeep codebase is wrapped in an immediately-invoked function expression (IIFE):
```
(function() {
'use strict';
```
This creates an isolated scope for all Markdeep internals.

### Step 0.2: String Prototype Extensions (Lines 46--63)

Two shorthand methods are added to `String.prototype` for use throughout the codebase:
- `.rp` aliases `.replace` (line 47)
- `.ss` aliases `.substring` (line 48)
- `.regexIndexOf` is added for regex-based indexOf (lines 60--63)
- `.endsWith` polyfill for IE11 (lines 50--57)

### Step 0.3: Constants and Helper Functions (Lines 67--164)

Key constants defined:
- `DIAGRAM_MARKER = '*'` (line 79), `DIAGRAM_START = '*****'` (line 85)
- `STROKE_WIDTH = 2` (line 76)
- `codeFontStack` and `codeFontSize` are measured dynamically via canvas (lines 93--103, 154--155)
- `BODY_STYLESHEET` (lines 157--164) and the main `STYLESHEET` (lines 170--599) are built as CSS strings
- `entag()` helper (lines 88--90) wraps content in an HTML tag with optional attributes
- `measureFontSize()` (lines 93--103) uses a canvas element to measure monospace font metrics

### Step 0.4: Polyfills (Lines 106--149)

IE11 polyfills for `Object.assign`, `String.prototype.includes`, `Array.prototype.includes`.

### Step 0.5: Localization Tables (Lines 1384--1454)

`DEFAULT_OPTIONS` is defined (lines 1384--1410) with defaults for mode, TOC style, math detection, smart quotes, etc. Language tables are defined for internationalization (lines 1416--1441). The document's `<meta lang>` tags are scanned to select the active language (lines 1446--1454).

### Step 0.6: Highlight.js Bundled (Lines 7470--8784)

The bundled `highlight.js` v11.11.1 is defined as `hljs`, providing syntax highlighting for code blocks.

---

## Phase 1: Entry Point and Mode Detection (Lines 6109--7462)

### Step 1.1: Guard Against Recursive Execution (Lines 6109--6110)

```javascript
if (! window.alreadyProcessedMarkdeep) {
    window.alreadyProcessedMarkdeep = true;
```
This prevents the script from running twice if included multiple times.

### Step 1.2: MathJax Configuration (Lines 6112--6141)

`MATHJAX_CONFIG` is defined as a hidden span with TeX newcommand definitions (line 6113--6116). `MATHJAX_URL` points to the CDN (line 6118). `loadMathJax()` (lines 6120--6134) dynamically injects the MathJax script. `needsMathJax()` (lines 6136--6141) tests whether the document contains `$$...$$`, `\(...\)`, or `\begin{` patterns.

### Step 1.3: Source Line Attribution Helpers (Lines 6143--6208)

`isBlockElement()` (lines 6146--6156) and `attributeSourceLines()` (lines 6159--6208) are defined. These are used post-rendering to walk the DOM, find line-number markers in text nodes, and set `data-src-line` attributes on the nearest block-level parent.

### Step 1.4: Source View Infrastructure (Lines 6226--6408)

`initializeSourceView()` sets up a full-page source viewer with line numbers and a context menu for navigating between rendered view and source.

### Step 1.5: `formatDocument()` -- The Main Dispatcher (Line 6410)

This is the central dispatcher function. It receives a `mode` parameter.

### Step 1.6: Mode Routing (Lines 6411--6486)

The mode is checked:

1. **`'script'` mode** (lines 6415--6417): Returns immediately. Nothing to do.

2. **`'html'` or `'doxygen'` mode** (lines 6419--6485):
   - Finds all elements with class `diagram` or tag `<diagram>` and converts them to SVG via `diagramToSVG()` (lines 6422--6440).
   - Finds all elements with class `markdeep` or tag `<markdeep>` (line 6443).
   - Extracts their source via `removeLeadingSpace(unescapeHTMLEntities(node.innerHTML))` (lines 6446--6448).
   - Calls `processInsertCommands()` first (line 6451), then for each node calls `markdeepToHTML(source, true)` in element mode (line 6464).
   - Replaces the original nodes with the processed HTML (line 6467).
   - Loads MathJax if needed (line 6470).
   - Prepends the Markdeep stylesheet to `document.head` (line 6473).
   - Removes fallback nodes (lines 6476--6479).

3. **`'markdeep'` mode (default)** (lines 6488 onward): This is the primary path for standalone `.md.html` documents. Described in full below.

### Step 1.7: Markdeep Mode -- Full Document Processing (Lines 6488--7123)

#### Step 1.7.1: Check for `?noformat` (Line 6495)

If `?noformat` is in the URL, the source is displayed as preformatted text and processing aborts (lines 6520--6536).

#### Step 1.7.2: Remove Recursive Script Tags (Lines 6499--6503)

All `<script>` tags matching `markdeep*.js` are removed to prevent recursive loading.

#### Step 1.7.3: Hide the Body (Lines 6513--6515)

`document.body.style.visibility = 'hidden'` prevents flash of unstyled content.

#### Step 1.7.4: Extract Source Text (Line 6518)

```javascript
var source = nodeToMarkdeepSource([document.head, document.body]);
```
`nodeToMarkdeepSource()` (lines 1684--1748) reconstructs the original Markdeep source from the DOM:
- For `HEAD`: only extracts content of `<preformatted>` children (lines 1698--1703).
- For `BODY`: uses `innerHTML` directly (lines 1704--1707).
- Removes spurious close tags from browser HTML correction of email-like syntax (line 1722).
- Fixes URLs that the browser mangled (lines 1726--1740).
- Removes fallback `<style>` tags (line 1743).
- Calls `unescapeHTMLEntities()` to restore `<`, `>`, `"`, `&` (line 1745).

#### Step 1.7.5: Process INSERT Commands (Line 7121)

```javascript
processInsertCommands([document.body], [source], function (nodeArray, sourceArray) {
    markdeepProcessor(sourceArray && sourceArray[0]);
});
```
`processInsertCommands()` (lines 5858--6073) handles `(insert X.html here)` and `(embed X.html here)` directives:
- Scans source for insert/embed patterns (line 6002).
- For non-HTML embeds: creates `<iframe>` or `<object>` tags (lines 6005--6037).
- For HTML includes: creates hidden child iframes that load the included document, which sends its contents back via `postMessage` (lines 6040--6054).
- When all children have reported back, calls `insertDoneCallback` (line 5966).
- If no inserts exist, calls the callback immediately.

#### Step 1.7.6: `markdeepProcessor()` Callback (Lines 6540--7118)

This is the function that receives the (possibly insert-expanded) source and drives the main conversion:

```javascript
var markdeepHTML = markdeepToHTML(source, false);
```

This calls the core conversion function with `elementMode = false` (full document mode). The result is the main HTML body content.

After `markdeepToHTML()` returns:

1. **Context menu setup** (lines 6551--6671): Adds right-click context menus on headers for copying section URLs and links.
2. **Context menu div** appended (line 6651).
3. **MathJax check** (lines 6675--6678): If math was detected, prepend `MATHJAX_CONFIG`.
4. **Footer** (line 6680): Append `MARKDEEP_FOOTER`.
5. **Build document head** (lines 6689--6701): Assemble META charset/viewport, `BODY_STYLESHEET`, `STYLESHEET`, `sectionNumberingStylesheet()`, `h1TitleOutputStylesheet()`, and `HIGHLIGHT_STYLESHEET`.
6. **Export mode check** (lines 6703--6710): If `?export` in URL, render the full HTML as escaped preformatted text.
7. **Normal rendering** (lines 6711--6723):
   - Set `document.head.innerHTML` to the assembled head (line 6712).
   - Set `document.body.innerHTML` to `markdeepHTML` (line 6713).
   - Load MathJax if needed (line 6714).
   - Call `attributeSourceLines(document.body)` to convert protected line markers to `data-src-line` attributes (line 6717).
   - Optionally initialize source view (lines 6720--6723).
8. **Set body ID** to `'md'` (line 6729).
9. **Make body visible** (line 6730).
10. **Link preview setup** (lines 6735--7103): If `showLinkPreviews` option is enabled, adds hover preview iframes for links.
11. **Hash scrolling** (lines 7105--7116): Scrolls to URL hash anchor after a 100ms delay. Calls `window.markdeepOptions.onLoad` callback.

### Step 1.8: Export Public API (Lines 7444--7459)

```javascript
window.markdeep = Object.freeze({
    format: markdeepToHTML,
    formatDiagram: diagramToSVG,
    formatDocument: formatDocument,
    ...
});
formatDocument(option('mode'));
```
The public API is frozen and `formatDocument` is invoked with the configured mode.

---

## Phase 2: The Core Conversion -- `markdeepToHTML()` (Lines 3059--4554)

This is the heart of Markdeep. It takes a source string and returns HTML. The function operates as a sequential pipeline of regex-based transformations on a single mutable string `str`. A protection mechanism prevents already-processed content from being re-processed.

### Step 2.0: Setup and Protection System (Lines 3059--3118)

- `endNoteTable` and `endNoteCount` track footnotes (line 3063).
- `referenceLinkTable` tracks `[ref]: url` definitions (line 3066).
- **Protection mechanism**: A `PROTECT_CHARACTER` (`\ue010`) and base-32 encoding system stores strings that should not be further processed. `protect(s)` stores `s` in `protectedStringArray` and returns a short encoded placeholder. `expose(i)` reverses this. This is the fundamental mechanism that prevents Markdeep from double-processing code blocks, HTML attributes, SVG content, etc.

### Step 2.1: Source Line Tracking Injection (Lines 3167--3407)

**Only in full-document mode** (`elementMode === false`):

A state machine iterates through all lines of the source and injects protected line-number markers (`protect('..L:N...')`) at the end of "normal" text lines. The state machine has modes:
- `'normal'`: Check for opening patterns (script/style/pre/fence/diagram), inject markers on text lines.
- `'script'`/`'style'`/`'pre'`: Skip until closing HTML tag.
- `'fence'`: Skip until matching closing fence (``` or ~~~) with same indent.
- `'diagram'`: Skip until closing `*****` boundary.

Lines that are structural (table rows, list items, blockquotes, horizontal rules, reference definitions, image lines, admonitions, etc.) are NOT marked (lines 3350--3367). Only lines containing alphanumeric characters that are not structural elements get markers (lines 3370--3376).

The marker is appended at end of line: `lines[i] = line + protect('..L:' + lineNum + '..')` (line 3391).

Lines are rejoined: `str = lines.join('\n')` (line 3401).

### Step 2.2: Preformatted Script Tags (Line 3421)

Strip `<script type="preformatted">...</script>` wrappers, leaving only their content:
```javascript
str = str.rp(/<script\s+type\s*=\s*['"]preformatted['"]\s*>([\s\S]*?)<\/script>/gi, '$1');
```

### Step 2.3: Code Fence Cleanup and Labeling -- `cleanupCodeFences()` (Lines 3510--3559)

Called at line 3621: `str = cleanupCodeFences(str)`.

This two-pass function:
1. **Hides labeled fences** by replacing them with placeholders (lines 3514--3520).
2. **Labels unlabeled fences**: For each unlabeled fence (``` or ~~~), calls `looksLikeDiagram()` (lines 3454--3508) to detect ASCII art. If diagram-like, labels it `diagram`. Otherwise, calls `hljs.highlightAuto()` to auto-detect language (line 3527--3528).
3. **Restores hidden labeled fences** (lines 3533--3535).
4. **Converts diagram fences to star-bordered format**: Rewrites fences labeled `diagram` into `*****`-bordered blocks that the diagram processor will recognize (lines 3537--3556).

### Step 2.4: Labeled Code Fence Processing -- `processLabeledCodeFences()` (Lines 3561--3619)

Called at line 3622: `str = processLabeledCodeFences(str)`.

Processes tilde-fences and backtick-fences separately via `processOneFenceType()`:
1. Matches the fence pattern including optional language, CSS subclass, and caption.
2. Calls `hljs.highlight()` or `hljs.highlightAuto()` for syntax highlighting (lines 3589--3599).
3. Wraps each line in a `<span class="line">` for line numbering (line 3601).
4. Handles multi-language fences (consecutive fences sharing a single code block) via a do-while loop (lines 3579--3609).
5. Creates captions via `createTarget()` if present (lines 3569--3573).
6. Outputs as `<pre class="listing ..."><code>...</code></pre>`, protected to prevent further processing (line 3611).

### Step 2.5: Blockquote Processing (Lines 3626--3656)

Iterative processing (do-while loop) to support nested blockquotes:
1. Matches consecutive lines starting with `>` (line 3631).
2. Strips leading `>` characters (line 3634).
3. Recursively processes code fences within blockquotes (line 3639).
4. Processes fancy quotes (`"...\n  author"` syntax) (lines 3645--3652).
5. Wraps in `<blockquote>` tags (line 3654).

### Step 2.6: Explicit Inline Code Highlighting (Lines 3658--3661)

Processes `<code lang="X">...</code>` syntax with hljs highlighting.

### Step 2.7: Protect Raw Code Content (Line 3664)

All `<code>...</code>` blocks are protected from further processing.

### Step 2.8: Remove HTML Comments (Line 3668)

```javascript
str = str.rp(/<!--((?!->|>)[\s\S]*?)-->/g, '');
```

### Step 2.9: Diagram Processing -- `replaceDiagrams()` (Lines 3423--3451, 3670)

Called at line 3670: `str = replaceDiagrams(str)`.

This is a recursive function:
1. Calls `extractDiagram()` (lines 1766--1888) to find the first `*****`-bordered rectangle in the source.
2. `extractDiagram()` scans for `DIAGRAM_START` (`*****`), then verifies a rectangular border of `*` characters with consistent column alignment. Returns `{beforeString, diagramString, alignmentHint, afterString}`.
3. Processes optional caption below the diagram via `createTarget()` (lines 3427--3438).
4. Calls `diagramToSVG()` on the extracted diagram content (line 3440).
5. Recursively processes `afterString` for additional diagrams (line 3447).

### Step 2.10: Diagram-to-SVG Conversion -- `diagramToSVG()` (Lines 4644--5843)

This is a ~1200-line function that converts ASCII art to SVG:
1. **Equalize line lengths** via `equalizeLineLengths()` (line 4646).
2. **Hide 'o' in text** to prevent false decoration matches (lines 4652--4655).
3. **Create grid** via `makeGrid()` (line 5764): Converts the string into a 2D character array with boundary checking, used/unused tracking.
4. **`findPaths(grid, pathSet)`** (line 5769, defined at 5191): Scans the grid for solid vertical lines, horizontal lines, diagonal lines, curved corners, and dashed lines. Builds a `PathSet` of line segments and curves.
5. **`findReplacementCharacters(grid, pathSet)`** (line 5770): Processes box-drawing Unicode characters and other replacement characters.
6. **`findDecorations(grid, pathSet, decorationSet)`** (line 5771, defined at 5596): Finds arrow heads (`>v<^`), point decorations (`o*`), jump characters `()`, gray blocks, and triangle characters. Builds a `DecorationSet`.
7. **Build SVG** (lines 5773--5838): Constructs the SVG element with proper dimensions, alignment style, paths (via `pathSet.toSVG()`), decorations (via `decorationSet.toSVG()`), and remaining passthrough text characters.
8. **Restore hidden 'o'** (line 5840).

### Step 2.11: Protect SVG, Style, and Image Blocks (Lines 3672--3688)

- SVG blocks: attributes and body protected (lines 3673--3675).
- Style blocks: body protected (lines 3678--3680).
- Image tags with complex attributes (Gravizo graphs): interior protected (lines 3685--3688).

### Step 2.12: Inline Code Processing (Lines 3690--3723)

1. Backtick-delimited inline code is matched (line 3696).
2. If `inlineCodeLang` option is set, syntax highlighting is applied (lines 3697--3711).
3. Otherwise, simple `<code>` wrapping (line 3710).
4. Escaped backticks are unescaped (line 3714).
5. Angle brackets inside code are HTML-escaped, then entire code blocks are protected (lines 3718--3720).

### Step 2.13: Protect Pre Blocks and HTML Attributes (Lines 3722--3727)

- `<pre>` blocks protected (line 3723).
- Raw HTML attributes (inside tags) protected (line 3726).

### Step 2.14: LaTeX/MathJax Protection (Lines 3731--3761)

1. `$$...$$` blocks protected (line 3733).
2. Single `$...$` converted to `\(...\)` MathJax delimiters, with heuristics to avoid matching dollar-sign currency (lines 3745, 3755).
3. `\(...\)`, `\begin{equation}...`, `\begin{eqnarray}...`, `\begin{equation*}...` all protected (lines 3758--3761).

### Step 2.15: Header Processing (Lines 3763--3802)

1. **Setext H1**: Text followed by `===` line (line 3769).
2. **Setext H2**: Text followed by `---` line (line 3772).
3. **ATX headers** `# through ######` (lines 3786--3802): Processed from h6 down to h1 to avoid greedy matching. Each header:
   - Passes through `inputLevel()` and `outputLevel()` for h1-as-title remapping.
   - Is wrapped via `makeHeaderFunc()` (lines 3123--3153) which creates anchor targets and appropriate `<h1>`-`<h6>` or `<div class="title">` tags.
4. **No-number headers** `(# ...) through (######...)` processed similarly with `nonumberh*` classes (lines 3793--3801).

### Step 2.16: Horizontal Rules (Lines 3804--3808)

- `* * *`, `- - -`, `_ _ _` patterns become `<hr>` (line 3805).
- `+++++` becomes `<hr class="pagebreak">` (line 3808).

### Step 2.17: Admonitions (Lines 3810--3815)

`!!! class: title` followed by indented body becomes `<div class="admonition CLASS">` with optional title.

### Step 2.18: Footnotes/Endnotes (Lines 3817--3831)

`[^name]` references are matched and converted to superscript links. An `endNoteTable` maps symbolic names to sequential numbers.

### Step 2.19: Citations (Lines 3834--3855)

- Bibliography entries `[#name]: text` become `<div class="bib">` (lines 3836--3840).
- Citation references `[#name1, #name2]` become links to the bibliography entries (lines 3844--3855).

### Step 2.20: Table Processing -- `replaceTables()` (Lines 1946--2034, called at 3860)

Matches Maruku/GitHub-style tables (header row + separator row + data rows):
1. Parses separator row for column alignment (`:---:` = center, `---:` = right, etc.) (lines 1977--1981).
2. Iterates rows, splitting cells on `|` delimiters (lines 1989--2016).
3. Wraps in `<table class="table">` (long tables get `longtable` class) (line 2018).
4. Processes optional caption via `createTarget()` (lines 2020--2028).

### Step 2.21: Reference Link Table (Lines 3862--3867)

`[name]: url` definitions are extracted into `referenceLinkTable` and removed from the source.

### Step 2.22: Email Addresses (Lines 3869--3877)

`<foo@bar.com>` or bare email addresses become `mailto:` links.

### Step 2.23: Image Formatting Setup (Lines 3879--3955)

`formatImage()` handles URL-to-HTML conversion:
- Video files (`.mp4`, `.webm`, etc.) become `<video>` tags (line 3902).
- Audio files (`.mp3`, `.ogg`, etc.) become `<audio>` tags (line 3904).
- YouTube/Vimeo URLs become `<iframe>` embeds (lines 3907--3917).
- Regular images become `<img>` tags with optional auto-linking (lines 3923--3951).
- Attribution text/URLs are wrapped in overlay divs (lines 3939--3951).

### Step 2.24: Equation and Figure Link Reformatting (Lines 3957--3968)

- `eqn [foo]` becomes `eqn \ref{foo}` for MathJax processing (line 3959).
- Figure references with parenthesized subfigure labels get a `<span></span>` inserted to prevent link parsing (line 3967).

### Step 2.25: Hyperlink Processing (Lines 3982--4015)

1. **Inline links** `[text](url attribs)` (line 3985).
2. **Empty links** `[](url)` (line 3993).
3. **Reference links** `[text][ref]` looked up in `referenceLinkTable` (lines 3999--4015).

### Step 2.26: Image Processing (Lines 4017--4193)

1. **Protect image captions** from premature processing (lines 4021--4024).
2. **Reference images** `![...][ref]` rewritten to inline form (lines 4029--4039).
3. **Image grids**: Consecutive lines of images are detected and wrapped in `<table>` for grid layout (lines 4042--4122).
4. **Simple images** `![](url)` (lines 4124--4135): Centered if isolated on their own line.
5. **Captioned images** `![caption](url)` (lines 4142--4193): Processed in a while loop. Isolated images are centered; embedded images float right. Captions are processed via `createTarget()` for numbered figure references.

### Step 2.27: Text Formatting (Lines 4195--4222)

1. **Bold**: `**text**` and `__text__` become `<strong>` (lines 4201--4202).
2. **Italic**: `*text*` and `_text_` become `<em>` (lines 4205--4206).
3. **Strikethrough**: `~~text~~` becomes `<del>` (line 4209).
4. **Stage directions**: `((text))` becomes `<div class="stage-direction">` or `<span class="stage-direction">` (lines 4212--4222).

### Step 2.28: Smart Typography (Lines 4224--4278)

1. **Smart quotes**: Opening and closing double quotes (lines 4227--4229).
2. **Arrows**: `-->`, `<--`, `==>`, `<==`, `<->`, `<==>` converted to Unicode arrows (lines 4232--4240).
3. **Em dashes**: `---` and `--` become `&mdash;` (lines 4244--4248).
4. **Dimensions**: `NxN` becomes `N&times;N` (lines 4254--4268).
5. **Minus sign**: Leading `-` before digits becomes `&minus;` (lines 4271--4272).
6. **Exponents**: `^N` becomes `<sup>N</sup>` (line 4275).
7. **Page break**: `\pagebreak` or `\newpage` (line 4278).

### Step 2.29: Schedule Lists -- `replaceScheduleLists()` (Lines 2241--2540, called at 4281)

Detects date-colon-title patterns with indented event bodies. Parses dates in multiple formats (DD MONTH YYYY, YYYY MONTH DD, MONTH DD YYYY). Generates calendar HTML tables with day-of-week headers, today highlighting, and weekend handling.

### Step 2.30: Definition Lists -- `replaceDefinitionLists()` (Lines 2541--2610, called at 4289)

Matches `term\n: definition` patterns:
- Short definitions (< 160 chars): rendered as a two-column `<table>` (lines 2586--2594).
- Long definitions: rendered as `<dl><dt>...<dd>...` (lines 2597--2602).

### Step 2.31: Lists -- `replaceLists()` (Lines 2037--2226, called at 4292)

Processes ordered (`1.`), unordered (`-`, `+`, `*`), and task list (`[ ]`, `[x]`) items:
1. Normalizes task list syntax to Unicode ballot characters (lines 2040--2044).
2. Pre-processes to detect list starts without preceding blank line or colon (lines 2062--2106).
3. Main processing loop uses a stack-based indent tracker (lines 2120--2217):
   - Tracks indent level to create nested `<ul>`/`<ol>` structures.
   - Handles list type changes at the same indent level.
   - Adds CSS classes based on bullet type (checked, unchecked, plus, minus, asterisk, number).

### Step 2.32: Additional Typographic Conversions (Lines 4294--4313)

- **Degree symbol**: `N degree` becomes `N&deg;` (line 4295).
- **CommonMark line breaks**: Trailing `\` or two+ trailing spaces before newline become `<br>` (lines 4297--4313).

### Step 2.33: Paragraph Breaks (Lines 4315--4321)

Double newlines are converted to `</p><p>` paragraph breaks (line 4317--4318). Empty paragraphs are removed (line 4321).

### Step 2.34: Endnote Definitions (Lines 4324--4334)

`[^name]: note text` is matched and converted to `<div class="endnote">` with backlink anchor.

### Step 2.35: Section Cross-References (Lines 4337--4377)

1. **Section links**: All headers are collected. "Header Name section" or "section Header Name" text is converted to hyperlinks pointing to the header's anchor (lines 4342--4354).
2. **Figure/Table/Listing/Diagram references**: `Figure [ref]`, `Table [ref]`, etc. are resolved against `refTable` and converted to numbered links (lines 4358--4377).

### Step 2.36: Bare URL Detection (Lines 4379--4390)

`http://...`, `https://...`, etc. are converted to `<a>` links. SVN/Perforce/Quadplay URLs are excluded from hyperlinking.

### Step 2.37: Title Detection (Lines 4392--4459)

Only in full-document mode (`! elementMode`):
1. **Bold title detection**: A bold first line (`<strong>...</strong>`) becomes `<div class="title">` with optional subtitles from indented lines below (lines 4407--4431).
2. **h1TitleInput mode**: When enabled, the first `#` header becomes the title, and a `<title>` tag is generated for the browser tab (lines 4436--4459).

### Step 2.38: Table of Contents -- `insertTableOfContents()` (Lines 2615--2838, called at 4468)

Only in full-document mode:
1. Scans all `<h1>`--`<h6>` and `<dt>` tags in document order (lines 2643--2656).
2. Builds hierarchical numbering (1, 1.1, 1.2, 2, etc.) via `headerCounter` stack (lines 2627--2696).
3. Generates both `shortTOC` (level-1 headers only, inline) and `fullTOC` (all levels, indented) (lines 2717--2723).
4. Inserts anchor tags before each header for TOC linking (lines 2726--2728).
5. Inserts definition term anchors using `mangleCode()` for API-friendly names (lines 2731--2754).
6. Auto-selects TOC style based on document length and header count (lines 2795--2812): `none`, `short`, `medium` (floating), or `long` (full-width before first header).
7. Returns `[modifiedString, tableOfNumberMappings]`.

After TOC insertion, section references like `sec. [X]` are resolved to numbered links (lines 4471--4480).

### Step 2.39: Wrap Header Sections -- `wrapHeaderSections()` (Lines 2864--3045, called at 4485)

Only in full-document mode:
1. Finds all `<h1>`--`<h6>` tags and their positions (lines 2872--2972).
2. Looks backwards from each header to find preceding anchor tags (lines 2892--2955).
3. Determines section boundaries: each section starts at its header and ends at the next same-or-lower-level header (lines 2983--3010).
4. Inserts `<section class="hN-section">` opening and `</section>` closing tags at computed positions (lines 3035--3042).

### Step 2.40: Expose All Protected Strings (Lines 4488--4497)

Iteratively replaces all protection placeholders with their original content:
```javascript
while ((str.indexOf(PROTECT_CHARACTER) + 1) && exposeRan && (maxIterations > 0)) {
    exposeRan = false;
    str = str.rp(PROTECT_REGEXP, expose);
    --maxIterations;
}
```
This runs up to 50 iterations to handle nested protections (e.g., a protected attribute inside a protected code block).

### Step 2.41: API Definition Linking (Lines 4511--4551)

If `linkAPIDefinitions` option is enabled:
1. Finds `<dt><code>name(` patterns and inserts named anchors (lines 4524--4537).
2. Finds `<code>name</code>` patterns elsewhere and links them to the definitions (lines 4547--4550).

### Step 2.42: Final Wrapping (Line 4553)

```javascript
return '<span class="md">' + entag('p', str) + '</span>';
```
The entire output is wrapped in `<span class="md"><p>...</p></span>`.

---

## Phase 3: Post-Processing in the Browser (Lines 6711--7118)

After `markdeepToHTML()` returns:

### Step 3.1: Document Assembly (Lines 6689--6713)

The document head is built from:
- META tags (charset, viewport) (line 6689)
- `BODY_STYLESHEET` (body max-width, margin, font) (line 6697)
- `STYLESHEET` (all `.md` class styles) (line 6697)
- `sectionNumberingStylesheet()` (CSS counter-based section numbers) (line 6697)
- `h1TitleOutputStylesheet()` (header style remapping when h1 is title) (line 6697)
- `HIGHLIGHT_STYLESHEET` (syntax highlighting colors) (line 6697)

### Step 3.2: DOM Replacement (Lines 6712--6713)

```javascript
document.head.innerHTML = head + document.head.innerHTML;
document.body.innerHTML = markdeepHTML;
```

### Step 3.3: Source Line Attribution (Line 6717)

`attributeSourceLines(document.body)`:
1. Creates a DOM TreeWalker for text nodes (lines 6166--6171).
2. For each text node containing a `..L:N..` marker, finds the nearest block-level parent and sets `data-src-line="N"` (lines 6176--6201).
3. Removes marker text from the DOM (lines 6204--6207).

### Step 3.4: MathJax Loading (Line 6714)

If math notation was detected, MathJax 3 is loaded from CDN and processes all `$$`, `\(`, `\begin{equation}` blocks.

### Step 3.5: Body Reveal (Line 6730)

```javascript
document.body.style.visibility = 'visible';
```

### Step 3.6: Link Previews (Lines 6735--7103)

If enabled, sets up hover-triggered iframe previews for links within `.md` content.

### Step 3.7: Hash Navigation and onLoad Callback (Lines 7105--7116)

Scrolls to hash anchor if present. Calls `window.markdeepOptions.onLoad` callback.

---

## Summary: Complete Pipeline Sequence

For a standalone Markdeep document (`mode = 'markdeep'`):

```
1.  Script loads, IIFE executes
2.  Polyfills, constants, stylesheets, highlight.js initialized
3.  Guard: window.alreadyProcessedMarkdeep check
4.  formatDocument('markdeep') called
5.  Body hidden for FOUC prevention
6.  nodeToMarkdeepSource() extracts raw text from DOM
7.  processInsertCommands() handles (insert ... here) directives
8.  markdeepToHTML(source, false) -- the core pipeline:
    a.  Source line tracking markers injected
    b.  Preformatted script tags stripped
    c.  Code fences: labeled, auto-detected, diagram fences -> star format
    d.  Labeled code fences: syntax highlighted, wrapped in <pre><code>
    e.  Blockquotes (iterative, nested)
    f.  Inline code highlighted and protected
    g.  HTML comments removed
    h.  Diagrams extracted and converted to SVG
    i.  SVG, style, img, code, pre blocks protected
    j.  LaTeX/MathJax blocks protected
    k.  Headers (Setext + ATX) converted
    l.  Horizontal rules
    m.  Admonitions
    n.  Footnotes/endnotes (references)
    o.  Citations (bibliography)
    p.  Tables
    q.  Reference link table populated
    r.  Email addresses
    s.  Hyperlinks (inline, empty, reference)
    t.  Image grids, simple images, captioned images
    u.  Bold, italic, strikethrough, stage directions
    v.  Smart quotes, arrows, em dashes, dimensions, minus, exponents
    w.  Schedule lists
    x.  Definition lists
    y.  Bullet/numbered lists
    z.  Degree symbols, line breaks, paragraph breaks
    aa. Endnote definitions
    ab. Section cross-references, figure/table/listing references
    ac. Bare URL detection
    ad. Title detection
    ae. Table of contents insertion
    af. Section wrapping in <section> tags
    ag. Expose all protected strings (up to 50 iterations)
    ah. API definition linking
    ai. Final wrap in <span class="md"><p>...</p></span>
9.  Context menu handlers attached
10. MathJax config prepended if needed
11. Footer appended
12. Document <head> assembled with all stylesheets
13. document.head and document.body innerHTML replaced
14. Source line markers converted to data-src-line attributes
15. MathJax loaded if needed
16. Body made visible
17. Link previews initialized if enabled
18. Hash navigation and onLoad callback
```

---

## Key Intermediate Representations

| Stage | Representation |
|-------|---------------|
| Input | Raw text from DOM (browser-corrected HTML → unescaped) |
| After line tracking | Text with `\ue010XXXX\ue010` protection markers at line ends |
| After code fences | Code blocks replaced with protected `<pre><code>` HTML |
| After diagrams | Diagram rectangles replaced with SVG strings |
| After protections | LaTeX, code, SVG, attributes stored in `protectedStringArray`, replaced with short encoded tokens |
| During markdown processing | String being progressively transformed with HTML tags |
| After expose | All protection tokens replaced with original content |
| Output of markdeepToHTML | Complete HTML fragment wrapped in `<span class="md"><p>...</p></span>` |
| Final document | Full HTML page with `<head>` (stylesheets) and `<body>` (rendered content) |

---

## Key Design Patterns

1. **Protect/Expose**: The fundamental mechanism preventing double-processing. Content that should not be touched by later regex passes is stored aside and replaced with opaque tokens.

2. **Sequential regex pipeline**: The entire conversion is a long sequence of `str = str.rp(regex, replacement)` calls. Order matters critically -- code/diagram/math protection must happen before markdown formatting.

3. **Recursive diagram extraction**: `replaceDiagrams()` calls itself on the `afterString` to handle multiple diagrams.

4. **Stack-based list processing**: Nested lists use an explicit indent-level stack.

5. **Two-phase DOM processing**: First, `markdeepToHTML()` produces an HTML string. Then, after insertion into the DOM, a second pass (`attributeSourceLines`) walks the DOM tree to clean up line markers.
