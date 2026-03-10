---
question: "What is markdeep.js? Describe its purpose, major subsystems, and overall control flow."
evaluator_start: 2026-03-10T12:59:03Z
evaluator_end: 2026-03-10T13:14:22Z
file: markdeep.js
file_lines: 8784
version: "1.19"
author: Morgan McGuire
license: BSD-2-Clause
---

# Q1: What is markdeep.js? Describe its purpose, major subsystems, and overall control flow.

## 1. What Markdeep.js Is

Markdeep.js (v1.19) is a single-file, self-contained JavaScript library authored by Morgan McGuire (2015-2026), licensed under BSD-2-Clause. Its purpose is to render plain-text documents written in a Markdown-superset syntax directly in the browser, producing fully styled HTML output with no build step, no server, and no dependencies beyond optionally-loaded MathJax for LaTeX math. A user simply writes a `.md.html` file containing their plain-text content and a single `<script>` tag pointing at markdeep.js; on load, the script converts the entire document body in place.

The file is 8,784 lines. Lines 1-38 contain the header, copyright, version declaration, and license. The library proper is an immediately-invoked function expression (IIFE) spanning lines 39-7462. An embedded, minified copy of highlight.js v11.11.1 with ~20 language grammars occupies lines 7470-8774.

Markdeep extends standard Markdown with: ASCII-art diagram-to-SVG conversion, schedule/calendar lists, definition lists, admonitions (tip/warning/error), LaTeX math via MathJax, document includes, automatic table-of-contents generation, figure/table/listing/diagram captioning and cross-references, footnotes, endnotes, citations, smart typography (quotes, arrows, em dashes, exponents), and code syntax highlighting.

## 2. Major Subsystems

### 2.1 String Utilities and Polyfills (lines 39-64)

The IIFE opens by monkey-patching `String.prototype` with convenience methods used pervasively throughout the codebase:

- `.rp(old, new)` — alias for `replace()` (line 41)
- `.ss(start, end)` — alias for `substring()` (line 42)
- `.endsWith(suffix)` — polyfill for environments lacking it (line 44)
- `.regexIndexOf(regex, startpos)` — regex-aware indexOf (line 53)

Debug/diagnostic constants `SHOW_LINE_NUMBERS`, `WARN_ABOUT_UNDEFINED_REFERENCES`, and `SHOW_MATHJAX_WARNINGS` are defined at lines 56-64.

### 2.2 Constants and Core Helpers (lines 66-165)

Key constants:

- `STROKE_WIDTH = 2` — SVG diagram line width (line 66)
- `DIAGRAM_MARKER = '*'` — character delimiting ASCII diagram boundaries (line 67)
- `DIAGRAM_START` — regex matching diagram opening lines (line 68)

Helper functions:

- `entag(tag, content, attribs)` (line 70) — wraps content in an HTML tag; used hundreds of times throughout.
- `measureFontSize(fontStack)` (line 85) — measures rendered font metrics for diagram sizing by creating a temporary DOM element.
- IE11 polyfills for `Object.assign`, `String.includes`, `Array.includes` (lines 98-140).
- `codeFontStack` / `codeFontSize` (lines 149-155) — computed font metrics for code blocks.
- `BODY_STYLESHEET` (line 157) — base body CSS string applied to the document.

### 2.3 Stylesheet Generation (lines 166-616)

The `STYLESHEET` constant is a massive string (450+ lines) containing all CSS for Markdeep-rendered documents. It is generated procedurally, incorporating computed values like `codeFontSize`. Styles cover:

- Headers (h1-h6) with numbering hooks
- Code blocks (inline and fenced) with the computed font stack
- Tables with alternating row shading
- Diagrams (SVG containers)
- Admonitions (tip, warning, error boxes)
- Table of contents (floating sidebar and inline variants)
- Captions for figures, tables, listings, diagrams
- Fancy blockquotes (large decorative quotation marks)
- Checklists (custom checkbox styling)
- Stage directions (centered, small-caps)
- Definition lists (short/long formats)
- Schedule lists (calendar-style)
- Print media queries
- Responsive breakpoints

### 2.4 Internationalization (lines 618-1454)

Markdeep supports 15+ languages for its UI strings (TOC headings, caption labels like "Figure", "Table", "Listing", etc.). Each language is an object mapping canonical English keys to translated strings:

- `FRENCH` (line 622), `LITHUANIAN` (line 640), `BULGARIAN` (line 658), `PORTUGUESE` (line 676), `CZECH` (line 694), `ITALIAN` (line 712), `RUSSIAN` (line 730), `POLISH` (line 748), `HUNGARIAN` (line 766), `JAPANESE` (line 784), `GERMAN` (line 802), `SPANISH` (line 820), `SWEDISH` (line 839), `CATALAN` (line 857), plus a `DEFAULT` English object.

`LANG_TABLE` (line 1416) maps two-letter language codes to these objects. Language is detected from the document's `<meta>` charset tag or `<html lang>` attribute (lines 1432-1454).

### 2.5 Options System (lines 1384-1489)

`DEFAULT_OPTIONS` (line 1384) defines all configurable knobs:

- `mode` — processing mode ('markdeep', 'script', 'html', 'doxygen')
- `detectMath` — auto-detect LaTeX math (default true)
- `lang` — language code
- `tocStyle` — TOC format ('auto', 'long', 'medium', 'short', 'none')
- `hideEmptyRecursiveIncludes` — suppress empty include placeholders
- `showLabels` — show diagram debug labels
- `sortScheduleLists` — auto-sort schedule entries
- `linkAPIDefinitions` — auto-link API terms
- `inlineCodeLang` — default language for inline code highlighting
- `scrollThreshold` — TOC scroll activation threshold
- `captionAbove` — place captions above content
- `smartQuotes` — typographic quote conversion

The `option(key, key2)` function (line 1457) reads from the global `window.markdeepOptions` object, falling back to defaults.

### 2.6 Text Processing Utilities (lines 1492-1748)

A collection of functions supporting the main conversion pipeline:

- `inputLevel()` / `outputLevel()` (lines 1492-1512) — map between input heading levels and output levels, handling `h1TitleInput`/`h1TitleOutput` options that shift heading hierarchy.
- `maybeShowLabel(s, tag)` (line 1518) — conditionally emits debug labels on elements.
- `keyword(s)` (line 1528) — wraps a string in a `<span class="keyword">`.
- `escapeHTMLEntities(str)` (line 1532) — converts `&<>"` to HTML entities.
- `unescapeHTMLEntities(str)` (line 1540) — reverses entity encoding.
- `removeHTMLTags(str)` (line 1552) — strips all HTML tags from a string.
- `mangle(str)` (line 1558) — mangles an email address into HTML entities to deter scrapers.
- `mangleCode(str)` (line 1574) — escape Markdeep-significant characters inside code blocks.
- `sectionNumberingStylesheet()` (line 1600) — generates CSS counter rules for auto-numbered sections.
- `h1TitleOutputStylesheet()` (line 1638) — generates CSS for when h1 is rendered as a document title.
- `nodeToMarkdeepSource(node)` (line 1648) — reconstructs Markdeep source text from the browser's parsed DOM; this is critical because the browser may have modified the raw text (added closing tags, re-ordered attributes) before Markdeep gets to process it.

### 2.7 Diagram Extraction (lines 1766-1888)

`extractDiagram(sourceStr)` scans the source string for ASCII art diagrams delimited by asterisk-bordered rectangles. It identifies the diagram boundaries (a line beginning with `*` characters forming a top border, matching bottom border), extracts the content between them, determines alignment hints (left/center/right based on leading whitespace), and returns a structured object `{beforeString, diagramString, alignmentHint, afterString}`. The main pipeline calls this repeatedly to extract all diagrams from the source.

### 2.8 Inline Formatting Engine (lines 1894-1943)

`replaceMatched(str, open, close, tag, protect)` (line 1894) handles paired delimiter processing for bold (`**`), italic (`_`, `*`), strikethrough (`~~`), and similar constructs. It uses character-by-character scanning to correctly handle nesting and edge cases (e.g., underscores within words). `createTarget(text, type)` (line 1932) generates captioned, numbered anchors for figures, tables, listings, and diagrams.

### 2.9 Table Processing (lines 1946-2034)

`replaceTables(str)` parses GitHub-flavored Markdown tables: pipe-delimited rows with an alignment indicator row (`:---`, `:---:`, `---:`). It generates `<table>` HTML with proper `<thead>`/`<tbody>` structure, column alignment via `text-align` styles, and support for both simple and complex table layouts.

### 2.10 List Processing (lines 2037-2226)

`replaceLists(str)` handles three list types:

- **Bullet lists** — lines starting with `- `, `+ `, or `* ` (when not a diagram)
- **Numbered lists** — lines starting with `1. `, `2. `, etc., or `#. ` for auto-numbering
- **Checklists** — lines with `[ ]`, `[x]`, or `[X]` markers

The function tracks indentation levels to produce correctly nested `<ul>`/`<ol>`/`<li>` structures. It handles continuation lines (non-blank lines at the same or greater indent) and blank-line separation between items.

### 2.11 Schedule Lists (lines 2241-2519)

`replaceScheduleLists(str)` processes date-prefixed list items into a calendar/timeline view. Each item starts with a date in various formats (ISO, US, European). The function:

- Parses dates from multiple formats
- Optionally sorts entries chronologically (`sortScheduleLists` option)
- Generates an HTML table with date, event, and optional details columns
- Supports multi-line event descriptions
- Handles date ranges and recurring events

### 2.12 Definition Lists (lines 2541-2610)

`replaceDefinitionLists(str)` processes term-definition pairs in two formats:

- **Short format** — term and definition on the same line, separated by a colon, rendered as a compact table
- **Long format** — term on one line, definition indented on the next, rendered as `<dl>`/`<dt>`/`<dd>` elements

### 2.13 Table of Contents (lines 2615-2838)

`insertTableOfContents(str, sourceStr)` generates navigation from document headings. Features:

- Four styles: `long` (full sidebar), `medium` (floating sidebar), `short` (compact inline), `none`
- Auto-detection based on heading count (line 2625): >7 headings triggers `long`, 4-7 triggers `medium`, fewer triggers `short`
- Generates anchor IDs from heading text (slug generation with collision avoidance)
- Includes definition list terms as TOC entries
- Builds nested `<ol>` structure reflecting heading hierarchy
- The `long` style includes scroll-spy behavior (highlights current section)

### 2.14 Section Wrapping (lines 2864-3045)

`wrapHeaderSections(str)` wraps content between same-level headings in `<section>` tags with generated IDs. This enables CSS and JavaScript targeting of individual sections. Includes a timeout safety mechanism to prevent infinite loops on pathological input.

### 2.15 The Core Conversion Pipeline: `markdeepToHTML()` (lines 3059-4554)

This is the central function of the entire library. It takes a Markdeep source string and an `elementMode` boolean, and returns rendered HTML. The function orchestrates all other subsystems in a carefully ordered sequence. Its internal architecture has several notable mechanisms:

#### 2.15.1 Protect/Expose Mechanism (lines 3068-3108)

The most architecturally significant pattern in Markdeep. Two closure functions are created:

- `protect(str)` — replaces a string with a unique token made of base-32 encoded indices using Unicode private-use-area characters (U+E000 range). The original string is stored in an array.
- `expose(str)` — reverses all protect tokens, restoring original strings.

This mechanism is used extensively to shield content from processing by later pipeline stages. For example, code blocks are protected early so that their contents are not interpreted as Markdown formatting. The expose step runs in a loop at the end (lines 4488-4497) because protected regions can be nested.

#### 2.15.2 Source Line Tracking (lines 3167-3407)

When `SHOW_LINE_NUMBERS` is enabled, a state machine injects invisible marker strings (e.g., `dn1234`) into the source at line boundaries. These markers survive the conversion pipeline and are later converted to `data-src-line` attributes on DOM elements by `attributeSourceLines()` (line 6146). This enables a source-view feature where clicking rendered content highlights the corresponding source line.

The state machine (lines 3181-3407) tracks whether it is inside code blocks, HTML tags, fenced regions, or other contexts where line markers should not be injected.

#### 2.15.3 Processing Order

The pipeline processes elements in a specific order designed to prevent interference between features. The sequence within `markdeepToHTML()`:

1. **Normalize line endings** (line 3115) — convert `\r\n` to `\n`
2. **Strip BOM** (line 3117) — remove byte-order mark if present
3. **Strip Markdeep script tag** (line 3121) — remove the `<script src="markdeep.js">` line
4. **Protect raw HTML** (lines 3127-3164) — shield `<script>`, `<style>`, `<svg>`, `<pre>` blocks
5. **Source line injection** (lines 3167-3407) — if enabled, inject line markers
6. **Fenced code blocks** (lines 3510-3619) — process triple-backtick and tilde fences, apply syntax highlighting via highlight.js, detect diagram fences
7. **Blockquotes** (lines 3628-3656) — process `>` prefixed lines into `<blockquote>` elements
8. **HTML comment removal** (line 3668)
9. **Diagram extraction and conversion** (line 3670) — extract ASCII diagrams and convert to SVG via `diagramToSVG()`
10. **Protect SVG/style/img** (lines 3672-3688) — shield generated SVG and other sensitive elements
11. **Inline code** (lines 3690-3720) — process backtick-delimited inline code
12. **LaTeX math** (lines 3731-3761) — detect and protect `$$...$$` and `$...$` expressions for MathJax
13. **Headers** (lines 3763-3802) — process both Setext-style (underline with `===`/`---`) and ATX-style (`#` prefix) headers
14. **Horizontal rules and page breaks** (lines 3804-3808)
15. **Admonitions** (line 3811) — process `!!!` prefixed blocks (tip, warning, error)
16. **Footnotes and endnotes** (lines 3817-3831)
17. **Citations** (lines 3834-3855) — `[#name]` citation references
18. **Tables** (line 3860) — call `replaceTables()`
19. **Reference-style links** (line 3864) — `[text][ref]` and `[ref]: url` definitions
20. **Email obfuscation** (line 3870) — mangle email addresses
21. **Images** (lines 3880-4193) — extensive image handling:
    - Simple inline images `![alt](url)`
    - Captioned images with figure numbering
    - Image grids (multiple images on one line)
    - Reference-style images `![alt][ref]`
    - Video embeds (YouTube, Vimeo detection)
22. **Bold, italic, strikethrough** (lines 4199-4209) — paired delimiter processing
23. **Stage directions** (lines 4211-4222) — `[[centered small-caps text]]`
24. **Smart typography** (lines 4224-4278) — arrows (`-->`, `<--`, `<-->`), em dashes (`---`), en dashes (`--`), dimension `x` (`80x24`), minus signs, exponents, smart quotes
25. **Schedule lists** (line 4281)
26. **Definition lists** (line 4284)
27. **Bullet/numbered/check lists** (line 4292)
28. **Line breaks** (lines 4297-4313) — trailing backslash or two-space line breaks
29. **Paragraphs** (lines 4315-4321) — wrap remaining text blocks in `<p>` tags
30. **Endnote definitions** (lines 4324-4334) — collect and format endnote content
31. **Cross-references** (lines 4337-4377) — resolve `[Section Name]`, `[Figure 1]`, `[Table 2]` etc. to internal links
32. **URL auto-linking** (lines 4379-4390) — bare URLs become clickable links
33. **Title detection** (lines 4392-4460) — detect if the first element is a title-level heading, apply special formatting
34. **TOC insertion** (lines 4466-4481) — call `insertTableOfContents()`
35. **Section wrapping** (lines 4483-4486) — call `wrapHeaderSections()`
36. **Recursive expose** (lines 4488-4497) — iteratively restore all protected content until no tokens remain
37. **API definition linking** (lines 4511-4551) — optionally auto-link code identifiers to their definitions

### 2.16 ASCII Diagram-to-SVG Engine (lines 4558-5844)

This is the second-largest subsystem after the core pipeline. It converts ASCII art within asterisk-bordered rectangles into SVG graphics.

#### 2.16.1 Grid System (lines 4644-4906)

The diagram string is parsed into a 2D grid where each character can be queried and classified:

- `strToArray(str)` (line 4558) — splits string into array of character arrays
- `equalizeLineLengths(grid)` (line 4572) — pads all rows to equal length
- `removeLeadingSpace(grid)` (line 4597) — strips common leading whitespace
- Grid accessor methods check character types: `isBoxDrawing()`, `isSolidHLine()`, `isSolidVLine()`, `isSolidDLine()` (diagonal), `isSolidBLine()` (back-diagonal), `isJunction()`, `isPoint()`, `isGray()`, `isArrowHead()`, `isEmpty()`

Characters are classified into categories for path finding:
- Box-drawing: `-`, `|`, `+`, `/`, `\`, `_`
- Decorations: `<`, `>`, `^`, `v`, `V` (arrows), `.`, `o` (points)
- Gray fill: `:` characters form shaded regions
- Junction: `+` where horizontal and vertical lines meet
- Curves: `.` and `'` at corners create rounded paths (Bezier curves)

#### 2.16.2 Vector Math (lines 4710-4728)

`Vec2` class with `x`, `y` properties and a `toString()` method that generates SVG coordinate strings. Used for all geometric calculations in path and decoration rendering.

#### 2.16.3 Path System (lines 4911-5063)

The `Path` class represents a connected series of line segments and cubic Bezier curves:

- `moveTo(coord)` — start a new subpath
- `lineTo(coord)` — add a line segment
- `curveTo(c1, c2, end)` — add a cubic Bezier curve
- `verticalLineTo(y)`, `horizontalLineTo(x)` — axis-aligned segments
- `toSVG()` — serialize to SVG `<path>` element with stroke, fill, and optional dashing
- Supports dashed lines (detected from `-.-` or similar patterns)

#### 2.16.4 PathSet (lines 5066-5111)

Collection class for paths. Manages multiple paths and serializes them all to SVG. Handles deduplication and merging of connected path segments.

#### 2.16.5 DecorationSet (lines 5114-5187)

Manages non-path visual elements:

- Arrow heads (triangle markers at line endpoints)
- Points (filled/open circles at `.` and `o` characters)
- Gray-filled regions (shaded rectangles for `:` areas)
- Triangles (standalone `<`, `>`, `^`, `v` arrow shapes)

Each decoration type has its own SVG rendering method.

#### 2.16.6 Path Finding: `findPaths()` (lines 5191-5593)

The core algorithm that traces connected paths through the character grid. It scans the grid in reading order (top-to-bottom, left-to-right) and for each unvisited line character, traces a complete path by following connected characters. Path types:

- **Horizontal lines** — sequences of `-`, `+`, with optional arrow endpoints
- **Vertical lines** — sequences of `|`, `+`, with optional arrow endpoints
- **Diagonal lines** — sequences of `/` characters
- **Back-diagonal lines** — sequences of `\` characters
- **Curved corners** — `.` at top corners, `'` at bottom corners generate Bezier curves connecting horizontal and vertical segments
- **Underscore lines** — `_` characters forming underlined paths

The algorithm marks visited characters to prevent double-processing and handles junction points where multiple paths intersect.

#### 2.16.7 Decoration Finding: `findDecorations()` (lines 5596-5740)

After path finding, this function scans for remaining decoration characters:

- Arrow heads not consumed by paths
- Point markers (`.` and `o` in non-path contexts)
- Gray fill regions (contiguous `:` blocks)
- Standalone triangles

#### 2.16.8 Replacement Characters: `findReplacementCharacters()` (lines 5745-5762)

Handles Unicode box-drawing characters (e.g., `─`, `│`, `┌`, `└`) that may appear in the source. These are mapped to their ASCII equivalents for processing.

#### 2.16.9 SVG Assembly (lines 5773-5843)

After path finding and decoration extraction, the function:

1. Calculates SVG viewport dimensions from grid size and font metrics
2. Renders all paths via `PathSet.toSVG()`
3. Renders all decorations via `DecorationSet.toSVG()`
4. Extracts remaining text (characters not consumed by paths/decorations) and renders them as SVG `<text>` elements at their grid positions
5. Wraps everything in an `<svg>` element with appropriate viewBox, class, and style attributes

### 2.17 Document Include System (lines 5858-6073)

`processInsertCommands(str, currentRecursionDepth)` handles two directives:

- `(insert filename.html here)` — includes another Markdeep document
- `(embed filename here)` — embeds content as an inline frame

Implementation uses `<iframe>` elements with `postMessage` communication:

1. An iframe is created pointing at the included URL
2. A message listener receives the included document's processed HTML
3. The iframe is replaced with the received content
4. Recursion depth is tracked to prevent infinite include loops (max depth enforced)

### 2.18 Syntax Highlighting CSS (lines 6076-6102)

`HIGHLIGHT_STYLESHEET` provides an Xcode-inspired color theme for highlight.js output. Colors are mapped to hljs token classes: keywords, strings, numbers, comments, types, built-ins, etc.

### 2.19 MathJax Integration (lines 6112-6141)

When LaTeX math is detected (or `detectMath` is enabled), Markdeep:

1. Configures MathJax's TeX input processor and SVG output renderer
2. Sets delimiters: `$$...$$` for display math, `$...$` for inline math, plus `\begin{}`/`\end{}` environments
3. Dynamically loads MathJax from CDN via script injection
4. Protected math expressions are exposed after MathJax loads

### 2.20 Source Line Attribution (lines 6146-6208)

`attributeSourceLines(node)` is a DOM tree walker that:

1. Traverses the rendered DOM post-conversion
2. Finds injected line marker strings (the `dn1234` tokens from the source-line-tracking state machine)
3. Converts them to `data-src-line` attributes on the nearest element ancestor
4. Removes the marker text from visible content

This enables the source view feature to map rendered elements back to their source lines.

### 2.21 Source View UI (lines 6226-6408)

`initializeSourceView()` creates an interactive debugging/editing interface:

- Right-click context menu with "View Markdeep Source" option
- Split-pane view: rendered document on left, syntax-highlighted source on right
- Click-to-highlight: clicking a rendered element highlights the corresponding source line (using `data-src-line` attributes)
- Source is displayed in a `<pre>` block with line numbers

### 2.22 Document Formatting Entry Point: `formatDocument()` (lines 6410-7124)

This is the top-level orchestrator that handles the full document lifecycle. It operates in four modes:

#### Mode: `'markdeep'` (default)
1. Read the document body's text content (already parsed by browser)
2. Optionally reconstruct source via `nodeToMarkdeepSource()` if needed
3. Call `markdeepToHTML()` to convert the source
4. Inject the result into `document.body.innerHTML`
5. Apply stylesheets (`STYLESHEET`, `BODY_STYLESHEET`, `HIGHLIGHT_STYLESHEET`)
6. Process include commands via `processInsertCommands()`
7. Run `attributeSourceLines()` if line tracking is enabled
8. Set up `initializeSourceView()` if enabled
9. Load MathJax if math was detected
10. Set the document title from the first heading

#### Mode: `'script'`
The Markdeep source is inside a `<script type="text/x-markdeep">` tag rather than bare in the body. The function extracts content from script tags, processes them individually, and injects results.

#### Mode: `'html'`
Markdeep processes only within designated elements (those with class `markdeep`), leaving the rest of the HTML untouched.

#### Mode: `'doxygen'`
Special handling for Doxygen-generated documentation: processes Markdeep syntax within Doxygen's output structure.

### 2.23 Public API (lines 7444-7456)

The library exports `window.markdeep` with these methods:

- `format(src, elementMode)` — convert Markdeep string to HTML (alias for `markdeepToHTML`)
- `formatDiagram(diagramSrc, alignmentHint)` — convert ASCII diagram to SVG (alias for `diagramToSVG`)
- `formatDocument(mode)` — trigger full document processing
- `headerAnchor(text)` — generate anchor ID for a heading
- `definitionAnchor(text)` — generate anchor ID for a definition term
- `generateMarkdownTable(data, options)` — programmatically generate a Markdown table string
- `makeMarkdownCodeBrowserSafe(code)` — escape code for safe inclusion in HTML
- `langTable` — the language translation table
- `stylesheet` — the generated stylesheet string

### 2.24 Embedded highlight.js (lines 7470-8774)

A complete minified copy of highlight.js v11.11.1 with language grammars for: JavaScript, TypeScript, CSS, HTML/XML, SQL, Swift, Python, Java, C, C++, Go, Rust, Ruby, Shell/Bash, YAML, JSON, Markdown, Scheme, SML, WGSL, and others. This provides syntax highlighting for fenced code blocks without requiring any external dependency.

## 3. Overall Control Flow

### 3.1 Script Load and Initialization

1. **Browser loads `markdeep.js`** — either via `<script>` tag at the end of a `.md.html` file, or referenced from any HTML page.

2. **IIFE executes** (line 39) — the entire library runs inside `(function() { ... })();`, keeping all internals private except the explicit `window.markdeep` export.

3. **String polyfills install** (lines 41-54) — `.rp`, `.ss`, `.endsWith`, `.regexIndexOf` are added to String.prototype.

4. **Constants and helpers initialize** (lines 66-165) — diagram constants, `entag()`, font measurement, polyfills.

5. **Stylesheet string builds** (lines 166-616) — CSS is generated as a string incorporating computed font metrics.

6. **Language tables populate** (lines 618-1454) — all i18n translation objects are created.

7. **Options system initializes** (lines 1384-1489) — defaults are set, `option()` accessor is defined.

8. **All processing functions are defined** (lines 1492-6073) — the entire function library is created but not yet called.

9. **Guard check** (line 6104) — `if (!window.alreadyProcessedMarkdeep)` prevents double-processing if the script is loaded twice.

10. **`window.alreadyProcessedMarkdeep = true`** is set.

11. **`formatDocument(option('mode'))` is called** (line 7459) — this triggers the actual document processing.

### 3.2 Document Processing Flow (within `formatDocument`)

1. **Mode dispatch** — based on the `mode` option, the function determines how to extract source text from the page.

2. **Source extraction** — in `'markdeep'` mode, the raw text content of `document.body` is captured. The function calls `nodeToMarkdeepSource()` to reconstruct the original Markdeep source from the browser's DOM (since the browser may have modified the raw text by interpreting HTML-like constructs).

3. **`markdeepToHTML(source, false)` is called** — the core conversion begins.

4. **Within `markdeepToHTML()`:**
   - The protect/expose mechanism is initialized
   - Raw HTML blocks (`<script>`, `<style>`, `<svg>`, `<pre>`) are protected
   - Source line markers are injected (if enabled)
   - Processing proceeds through the 37-step pipeline described in Section 2.15.3
   - The recursive expose loop restores all protected content
   - The final HTML string is returned

5. **DOM replacement** — the converted HTML replaces `document.body.innerHTML`.

6. **Stylesheet injection** — `STYLESHEET`, `BODY_STYLESHEET`, and `HIGHLIGHT_STYLESHEET` are injected as `<style>` elements.

7. **Post-processing:**
   - `processInsertCommands()` handles document includes
   - `attributeSourceLines()` converts line markers to DOM attributes
   - `initializeSourceView()` sets up the source-view UI
   - MathJax is loaded and configured if math was detected
   - Document title is set from the first heading

8. **Highlight.js executes** (lines 7470-8774) — the embedded highlight.js library initializes, making `window.hljs` available. (Note: highlight.js is actually invoked during step 4 above when processing code fences; it is defined after the IIFE but loaded synchronously by the browser before `formatDocument` runs because it is part of the same `<script>` tag's source text. In practice, the code fence processor at line 3580 calls `hljs.highlight()` which requires highlight.js to be defined. The actual execution order is: the entire file is parsed first, then the IIFE executes. highlight.js self-registers on `window.hljs` during parsing of lines 7470-8774, which happens before the IIFE's `formatDocument()` call at line 7459 — actually this is incorrect. Since highlight.js is *outside* the IIFE and *after* it in source order, it executes after the IIFE. The resolution is that highlight.js is loaded as a separate mechanism or the IIFE defers code highlighting. Looking more carefully: the IIFE at line 7459 calls `formatDocument()` synchronously, but `hljs` is referenced inside `markdeepToHTML` with a guard check `if (typeof hljs !== 'undefined')` — if hljs is not yet available, code blocks are left unhighlighted and rendered as plain `<pre><code>` blocks.)

### 3.3 Data Flow Summary

```
Raw .md.html file
    |
    v
Browser loads page, sees <script src="markdeep.js">
    |
    v
markdeep.js IIFE executes
    |
    v
formatDocument() extracts source text from DOM
    |
    v
nodeToMarkdeepSource() reconstructs original text
    |
    v
markdeepToHTML() runs the 37-step pipeline:
    |
    +-- protect/expose mechanism shields sensitive content
    +-- code fences processed + highlighted (hljs)
    +-- ASCII diagrams extracted + converted to SVG (diagramToSVG)
    +-- Markdown syntax converted to HTML
    +-- Smart typography applied
    +-- TOC generated
    +-- Sections wrapped
    +-- All protected content exposed
    |
    v
HTML injected into document.body
    |
    v
Stylesheets injected
    |
    v
Post-processing: includes, source attribution, MathJax, title
    |
    v
Rendered document visible to user
```

### 3.4 Key Architectural Patterns

1. **Single-pass streaming with protection** — Rather than building an AST, Markdeep processes the document as a string through sequential regex transformations. The protect/expose mechanism prevents earlier transformations from corrupting content that should be processed by later stages (or not at all).

2. **Progressive enhancement** — The raw `.md.html` file is readable as plain text. Markdeep enhances it into styled HTML. If JavaScript fails, the content is still legible.

3. **Zero-dependency design** — Everything needed (CSS, highlight.js, diagram rendering, typography) is embedded in the single file. Only MathJax is loaded externally, and only when math is detected.

4. **Closure-based encapsulation** — The IIFE keeps all internals private. Only the `window.markdeep` API object and `window.alreadyProcessedMarkdeep` flag leak to global scope.

5. **Regex-driven transformation** — Nearly all processing is done via `String.replace()` with regular expressions (via the `.rp()` alias). This is both the library's strength (simplicity, speed) and its constraint (no formal grammar, order-dependent processing).
