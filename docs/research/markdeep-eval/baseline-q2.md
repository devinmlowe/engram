---
question: "Q2: How is the code organized? Identify namespaces, modules, or major logical sections."
evaluator_start: "2026-03-10T12:59:05Z"
evaluator_end: "2026-03-10T12:59:56Z"
---

# Code Organization of markdeep.js

## Top-Level Structure

The entire file is wrapped in a single **Immediately Invoked Function Expression (IIFE)** beginning at line 39 and closing at line 7462. This prevents any global namespace pollution. The only intentional global exports are `window.markdeep` (line 7444) and `window.alreadyProcessedMarkdeep` (line 6110). A global `var hljs` is also created by the embedded highlight.js library (line 7476).

```
Line 39:   (function() {
Line 40:   'use strict';
  ...
Line 7462: })();
```

After the IIFE, highlight.js occupies lines 7470-8775 as a separate, self-contained block.

---

## Section-by-Section Breakdown

### 1. License Header and BOM Note (Lines 1-38)

Multi-line comment block containing version (1.19), copyright (Morgan McGuire, 2015-2026), credits (Gruber, Hollis, Fortin, Sagalaev), BSD-2 license, and a note about the invisible BOM character required for highlight.js regex compatibility.

### 2. IIFE Entry and Footer Constant (Lines 39-42)

Opens the IIFE with `'use strict'`. Defines `MARKDEEP_FOOTER` -- the HTML footer stamp appended to rendered documents.

### 3. String Prototype Extensions (Lines 44-64)

Enclosed in a bare block `{ ... }` (lines 44-64). Adds shorthand methods to `String.prototype` for minification purposes:
- `_.rp` = `_.replace`
- `_.ss` = `_.substring`
- `_.endsWith` polyfill for IE11
- `_.regexIndexOf` -- regex-based indexOf

### 4. Debug Flags and Constants (Lines 66-86)

Global configuration constants:
- `DEBUG_SHOW_GRID`, `DEBUG_SHOW_SOURCE`, `DEBUG_HIDE_PASSTHROUGH` -- diagram debugging flags
- `STROKE_WIDTH` (2px) -- diagram line width
- `DIAGRAM_MARKER` (`'*'`) and `DIAGRAM_START` (`'****'`)
- `DEBUG_VIEW_SOURCE_MENU`

### 5. Utility Functions (Lines 88-103)

- `entag(tag, content, attribs)` -- wraps content in an HTML tag (line 88)
- `measureFontSize(fontStack)` -- measures font width via canvas (line 93)

### 6. IE11 Polyfills (Lines 105-149)

- `Object.assign` polyfill (lines 106-133)
- `String.prototype.includes` polyfill (lines 136-144)
- `Array.prototype.includes` polyfill (lines 145-149)

### 7. Font and Body Stylesheet Constants (Lines 153-165)

- `codeFontStack` and `codeFontSize` -- computed monospace font metrics
- `BODY_STYLESHEET` -- default body CSS for standalone Markdeep documents

### 8. Main Stylesheet (STYLESHEET) (Lines 166-616)

A single massive string concatenation assigned to `var STYLESHEET`. Contains all CSS rules for:
- Browser feature detection (`isFirefox`, line 166)
- Print media queries
- Context menu styling (`#mdContextMenu`)
- Link preview styling (`#mdLinkPreview`)
- Code/pre formatting
- Title, subtitle, headings (h1-h6), TOC
- Diagram SVG styling
- Table styling (regular, calendar, long)
- Code listing styling (tilde fences, line numbers)
- Image captions, fancy quotes
- Admonitions (tip, warn/warning, error)
- Checklists, stage directions
- Definition lists, endnotes, bibliographic entries

### 9. Markdeep Line Constant (Line 618)

`MARKDEEP_LINE` -- the standard HTML comment/script tag line that users place at the bottom of `.md.html` files to trigger Markdeep processing.

### 10. Internationalization / Language Tables (Lines 620-1444)

Each language is a `var` holding an object with `name` and `keyword` properties containing localized strings for:
- Caption types (table, figure, listing, diagram)
- Section references (sec, section, subsection, chapter)
- Day names, month names (full and abbreviated)
- Smart quote characters

Languages defined:
- `FRENCH` (lines 621-672)
- `LITHUANIAN` (lines 674-726)
- `BULGARIAN` (lines 729-782)
- `PORTUGUESE` (lines 785-837)
- `CZECH` (lines 840-893)
- `ITALIAN` (lines 896-947)
- `RUSSIAN` (lines 949-1001)
- `POLISH` (lines 1003-1055)
- `HUNGARIAN` (lines 1057-1110)
- `JAPANESE` (lines 1112-1164)
- `GERMAN` (lines 1166-1219)
- `SPANISH` (lines 1221-1273)
- `SWEDISH` (lines 1275-1327)
- `CATALAN` (lines 1330-1382)

Then:
- `DEFAULT_OPTIONS` object (lines 1384-1410) -- all configuration defaults
- `ENGLISH` and `LANG_TABLE` (lines 1415-1444) -- maps ISO codes to language objects
- Meta tag language detection loop (lines 1446-1454) -- reads `<meta lang="...">` to set default language

### 11. Math Aliases and Option System (Lines 1457-1547)

- Math shorthand aliases: `max`, `min`, `abs`, `sign` (lines 1457-1462)
- `option(key, key2)` -- option getter with `window.markdeepOptions` override support (lines 1466-1489)
- `inputLevel(markdownLevel)` / `outputLevel(internalLevel)` -- header level translation for h1TitleInput/h1TitleOutput modes (lines 1502-1531)
- `maybeShowLabel(url, tag)` -- optional label display (lines 1534-1541)
- `keyword(word)` -- localization lookup (lines 1544-1547)

### 12. HTML Utility Functions (Lines 1550-1598)

- `escapeHTMLEntities(str)` (line 1551)
- `unescapeHTMLEntities(str)` (line 1560)
- `removeHTMLTags(str)` (line 1574)
- `mangle(text)` -- URL anchor generation (line 1580)
- `mangleCode(text)` -- code-sensitive anchor mangling for API definitions (line 1587)

### 13. Section Numbering Stylesheets (Lines 1600-1675)

- `sectionNumberingStylesheet()` -- generates CSS counter rules for h1-h6 (line 1607)
- `h1TitleOutputStylesheet()` -- remaps header styles when h1TitleOutput is true (line 1640)

### 14. Source Reconstruction: nodeToMarkdeepSource (Lines 1677-1748)

Reconstructs original Markdeep source from the browser-parsed DOM. Handles:
- Array of nodes vs single node
- HEAD preformatted script children
- Fixing browser-mangled URLs (protocol reconstruction)
- Removing fallback style tags
- Unescaping HTML entities

### 15. Diagram Extraction: extractDiagram (Lines 1751-1888)

Parses source text to find `*****`-bordered diagram rectangles. Returns `{beforeString, diagramString, alignmentHint, afterString}`. Contains nested helper functions:
- `unicodeSyms(s, start, end)` -- counts wide Unicode characters
- `advance()` -- line iteration helper

Handles alignment hinting (floatleft, floatright, center) based on surrounding text.

### 16. Inline Formatting: replaceMatched (Lines 1890-1904)

Generic function for matched-delimiter formatting (bold `**`, italic `*`, etc.). Builds a flanking regex and replaces with the specified HTML tag.

### 17. Reference/Caption System (Lines 1908-1943)

- `refCounter` -- object mapping caption types to counts (line 1912)
- `refTable` -- maps `type_symbolicName` to `{number, used}` (line 1915)
- `createTarget(caption, protect)` -- processes Figure/Table/Listing/Diagram captions with numbered references (line 1918)

### 18. Table Processing: replaceTables (Lines 1945-2034)

Processes Maruku/GitHub-flavored Markdown tables. Handles:
- Column alignment (`:` markers in separator row)
- Leading/trailing bar detection
- Table captions with `[...]` syntax
- Long table sticky headers (>= 15 rows)
- Caption above/below via `captionAbove` option

### 19. List Processing: replaceLists (Lines 2037-2226)

Processes Markdown lists (ordered, unordered, task lists). Features:
- Task list checkbox normalization (Unicode ballot box characters)
- List block detection via blank-line/colon prefix patterns
- Nested list support with indent tracking via a stack
- Mixed ordered/unordered list handling
- List type change detection at same indent level
- A pre-processing pass that inserts `LISTSTART` markers for lists that start without blank-line/colon prefix

### 20. Schedule List Processing: replaceScheduleLists (Lines 2229-2519)

Processes date-keyed schedule entries into HTML tables with optional calendar views. Features:
- Multi-format date parsing (DD MONTH YYYY, YYYY MONTH DD, MONTH DD YYYY)
- Localized month/day names
- Automatic day-of-week computation
- Calendar grid generation with month headers
- Weekend hiding option
- Parenthesized (tentative) entries
- Sort by date with stable source-order tiebreaking

### 21. Definition List Processing: replaceDefinitionLists (Lines 2522-2610)

Processes term/definition pairs using `Term\n: definition` syntax. Automatically chooses between:
- Short format (table layout) for definitions under 160 characters
- Long format (dl/dt/dd) for longer or multi-paragraph definitions

### 22. Table of Contents: insertTableOfContents (Lines 2613-2838)

Generates and inserts a TOC. Features:
- Parallel processing of headers and definition terms (DTs) in document order
- Three TOC styles: short (inline), medium (floating sidebar), long (full before first header)
- Automatic style selection based on document length and header count
- Hierarchical anchor names using path notation (e.g., `section/subsection`)
- Duplicate definition term handling with count suffixes
- `tocDepth` option support

### 23. Utility Functions (Lines 2841-2855)

- `escapeRegExpCharacters(str)` (line 2841)
- `isolated(preSpaces, postSpaces)` -- checks for paragraph-isolating blank lines (line 2847)

### 24. Section Wrapping: wrapHeaderSections (Lines 2858-3045)

Wraps header sections in `<section class="hN-section">` tags. Features:
- Safety timeout (5 seconds) and match count limit (10,000)
- Backwards anchor detection to include preceding `<a>` tags
- Proper nesting: deeper sections close before same-or-lower level headers
- Reverse-order string insertion to maintain index stability

### 25. Main Processing Function: markdeepToHTML (Lines 3047-4554)

The core of Markdeep. This is the largest single function (~1500 lines). Internally organized into phases:

#### 25a. Protection System (Lines 3060-3118)

The protect/expose mechanism for shielding content from Markdown processing:
- `PROTECT_CHARACTER` (`\ue010`) -- Unicode private-use-area marker
- `protectedStringArray` -- stores protected strings
- `protect(s)` -- replaces content with encoded placeholder
- `expose(i)` -- restores original content from placeholder
- `protector(match, protectee)` / `protectorWithPrefix(match, prefix, protectee)` -- regex callback helpers

#### 25b. Header Generation (Lines 3120-3157)

- `makeHeaderFunc(level)` -- returns a replacement function that creates header tags with anchor targets. Handles title (level 0) vs regular headers.

#### 25c. Phase 1: Source Line Tracking (Lines 3167-3407)

A state machine that injects line-number markers (`protect('⟨L:N⟩')`) into source text. States:
- `normal` -- checks for opening patterns, injects markers on content lines
- `script` / `style` / `pre` -- skips until closing HTML tag
- `fence` -- skips until matching fence (indent and character aware)
- `diagram` -- skips until closing `*****` boundary

Skips structural lines: fences, setext underlines, horizontal rules, tables, blockquotes, lists, reference definitions, captions, admonitions, images.

#### 25d. Code Fence Processing (Lines 3409-3619)

- `unescapeScriptTags(s)` -- strips break characters from script tags in code (line 3417)
- `cleanupCodeFences(s)` -- labels unlabeled fences (auto-detect language or diagram), converts diagram fences to `*****` format (line 3512)
- `processLabeledCodeFences(s)` -- processes fenced code blocks through highlight.js, handles captions, multi-segment fences (line 3563)
- `looksLikeDiagram(content)` -- heuristic ASCII diagram detection using character ratios and pattern matching (line 3454)

#### 25e. Blockquote Processing (Lines 3624-3656)

Iterative blockquote processing supporting nesting. Includes fancy quote detection (`"quote" author` syntax).

#### 25f. Inline Code Processing (Lines 3658-3727)

- Explicit inline code with language: `<code lang="...">` (line 3659)
- Protection of raw `<code>` content (line 3664)
- HTML comment removal (line 3668)
- Diagram replacement via `replaceDiagrams()` (line 3670)
- SVG, style, img tag protection (lines 3673-3688)
- Backtick inline code with optional syntax highlighting (lines 3695-3723)
- PRE block and raw HTML attribute protection (lines 3723-3726)

#### 25g. LaTeX/MathJax Processing (Lines 3731-3761)

- `$$...$$` block protection
- Single `$...$` to `\(...\)` conversion with heuristics to avoid matching currency
- Protection of `\(...\)`, `\begin{equation}`, `\begin{eqnarray}` blocks

#### 25h. Header Processing (Lines 3763-3801)

- Setext-style H1 (`===`) and H2 (`---`) (lines 3769-3772)
- ATX-style headers (`#` through `######`) with no-number variants `(#)` (lines 3786-3801)

#### 25i. Horizontal Rules, Page Breaks, Admonitions (Lines 3804-3815)

- `* * *`, `- - -`, `_ _ _` horizontal rules
- `+++++` page break
- `!!!` admonitions with CSS class and title

#### 25j. Footnotes and Citations (Lines 3817-3855)

- Footnote references `[^name]` and definitions `[^name]: text`
- Citation definitions `[#name]: entry` and references `[#name]`

#### 25k. Tables, Reference Links, Email (Lines 3858-3877)

- Table processing delegation to `replaceTables()`
- Reference link table construction `[foo]: url`
- Email address auto-linking

#### 25l. Image Processing (Lines 3879-4193)

- `formatImage(ignore, url, attribs)` -- handles images, video, audio, YouTube, Vimeo embeds, image attribution (line 3880)
- Image grid detection and table construction (lines 4042-4122)
- Simple images `![](url)` (lines 4124-4135)
- Captioned images `![caption](url)` with float/center logic (lines 4140-4193)
- Reference images `![...][ref]` (lines 4026-4039)

#### 25m. Inline Formatting (Lines 4195-4278)

- Strong (`**`, `__`), emphasis (`*`, `_`), strikethrough (`~~`)
- Stage directions `((text))`
- Smart quotes
- Arrows (`-->`, `==>`, `<->`, etc.)
- Em dashes (`---`, `--`)
- Dimension notation (`NxN` to `N&times;N`)
- Minus signs, exponents
- Page break commands (`\pagebreak`, `\newpage`)

#### 25n. Schedule/Definition/List Delegation (Lines 4280-4292)

Calls `replaceScheduleLists()`, `replaceDefinitionLists()`, `replaceLists()`.

#### 25o. Degree Symbol, Line Breaks, Paragraphs (Lines 4294-4321)

- Degree conversion (`N degree` to `N&deg;`)
- CommonMark trailing backslash and double-space line breaks
- Paragraph detection (double newline to `</p><p>`)

#### 25p. Footnote Definitions (Lines 4324-4334)

Renders footnote content with numbered superscript links.

#### 25q. Section and Cross-Reference Links (Lines 4337-4377)

- Auto-linking section names to their headers
- Figure/Table/Listing/Diagram reference resolution

#### 25r. URL Auto-Linking (Lines 4379-4390)

Detects bare URLs and wraps in `<a>` tags.

#### 25s. Title Detection (Lines 4392-4460)

- Bold first line (`**title**`) detection and subtitle extraction
- Title tag from `#` syntax when `h1TitleInput` is true
- HTML `<title>` tag generation

#### 25t. TOC Insertion and Section Wrapping (Lines 4462-4486)

Calls `insertTableOfContents()` and `wrapHeaderSections()`.

#### 25u. Protected String Exposure (Lines 4488-4497)

Iterative loop (up to 50 iterations) to recursively expose all protected strings.

#### 25v. API Definition Linking (Lines 4511-4551)

Finds `<dt><code>name(` patterns and creates auto-links between definitions and references to API functions, arrays, etc.

#### 25w. Return Value (Line 4553)

Returns `<span class="md"><p>...</p></span>`.

### 26. Diagram-to-SVG Engine: diagramToSVG (Lines 4557-5844)

The ASCII art diagram rendering engine. Contains these major internal components:

#### 26a. Utility Functions (Lines 4558-4636)

- `strToArray(s)` -- IE11 workaround for Array.from (line 4558)
- `equalizeLineLengths(str)` -- pads lines to equal length (line 4575)
- `removeLeadingSpace(str)` -- strips common whitespace prefix (line 4604)
- `isASCIILetter(c)` (line 4633)

#### 26b. Constants and Character Classification (Lines 4644-4706)

- `SCALE` (8px per character), `ASPECT` (2x Y scale)
- Character sets: `ARROW_HEAD_CHARACTERS`, `POINT_CHARACTERS`, `JUMP_CHARACTERS`, `VERTEX_CHARACTERS`, `GRAY_CHARACTERS`, `TRI_CHARACTERS`, `DECORATION_CHARACTERS`
- Classification functions: `isVertex()`, `isTopVertex()`, `isBottomVertex()`, `isArrowHead()`, `isGray()`, `isTri()`, `isSolidHLine()`, `isSolidVLine()`, `isSolidDLine()`, `isSolidBLine()`, `isJump()`, `isPoint()`, `isDecoration()`, `isEmpty()`

#### 26c. Vec2 Class (Lines 4710-4728)

2D vector with SVG coordinate output. Constructor supports clone and (x,y) forms.

#### 26d. Grid System: makeGrid (Lines 4732-4906)

Creates an immutable 2D character grid from a string. Methods:
- `grid(x, y)` -- character lookup with bounds checking
- `grid.setUsed(x, y)` / `grid.isUsed(x, y)` -- consumption tracking
- `grid.isSolidVLineAt()`, `grid.isSolidHLineAt()`, `grid.isSolidBLineAt()`, `grid.isSolidDLineAt()` -- line detection at coordinates

#### 26e. Path Class (Lines 4909-5063)

Represents a 1D curve (line or bezier). Properties: A, B (endpoints), C, D (control points), dashed. Methods:
- Geometric queries: `isVertical()`, `isHorizontal()`, `isDiagonal()`, `isBackDiagonal()`, `isCurved()`
- Endpoint queries: `endsAt()`, `upEndsAt()`, `downEndsAt()`, `leftEndsAt()`, `rightEndsAt()`
- Diagonal endpoint queries: `diagonalUpEndsAt()`, `diagonalDownEndsAt()`, `backDiagonalUpEndsAt()`, `backDiagonalDownEndsAt()`
- Pass-through queries: `verticalPassesThrough()`, `horizontalPassesThrough()`
- `toSVG()` -- SVG path string generation

#### 26f. PathSet Class (Lines 5066-5111)

Collection of Path objects with aggregate query methods created via `makeFilterAny()`.

#### 26g. DecorationSet Class (Lines 5114-5187)

Collection of decorations (arrows, points, jumps, gray fills, triangles). `insert()` sorts arrows before points. `toSVG()` renders each decoration type to SVG elements.

#### 26h. Path Finding: findPaths (Lines 5191-5593)

Scans the grid to identify all solid lines:
- Vertical lines (lines 5208-5281) with special circuit-diagram patterns
- Horizontal lines (lines 5283-5317) with box-drawing character detection
- Back-diagonal lines `\` (lines 5319-5381) with endpoint extension logic
- Forward-diagonal lines `/` (lines 5384-5451) with endpoint extension logic
- Curved corners (lines 5454-5516) -- `.` and `'` corner detection
- Underscored horizontal lines `_` (lines 5518-5593) with logic-gate overrun detection

#### 26i. Decoration Finding: findDecorations (Lines 5596-5740)

Identifies decorations on the grid:
- Jump characters `()` -- validated against path endpoints
- Point characters `o*` etc. -- validated against line adjacency
- Gray fill characters
- Triangle characters
- Arrow heads `> < ^ v` -- with 8-direction angle computation including diagonal angles

#### 26j. Replacement Characters: findReplacementCharacters (Lines 5745-5762)

Handles Unicode box-drawing characters (`╱`, `╲`) that should be rendered as diagram paths.

#### 26k. SVG Assembly (Lines 5764-5843)

Orchestrates the full pipeline: `makeGrid()` -> `findPaths()` -> `findReplacementCharacters()` -> `findDecorations()` -> SVG string assembly with optional debug overlays.

### 27. Insert Command Processing: processInsertCommands (Lines 5847-6073)

Handles `(insert file.html here)` and `(embed file.ext here)` commands. Features:
- Parent/child iframe communication via `postMessage`
- URL resolution (relative to absolute)
- Firefox-specific workarounds for non-HTML embeds (XMLHttpRequest fallback)
- Recursive include support with child counting
- `documentReady()` callback coordination

### 28. Highlight.js Stylesheet (Lines 6076-6102)

`HIGHLIGHT_STYLESHEET` -- CSS string for syntax highlighting colors (xcode theme, modified).

### 29. Document Formatting Entry Point (Lines 6104-7461)

Wrapped in `if (! window.alreadyProcessedMarkdeep)` guard (line 6109).

#### 29a. MathJax Integration (Lines 6112-6141)

- `MATHJAX_CONFIG` -- custom LaTeX macros (line 6113)
- `MATHJAX_URL` -- CDN URL (line 6118)
- `loadMathJax()` -- dynamic script injection (line 6120)
- `needsMathJax(html)` -- detection via regex (line 6136)

#### 29b. Source Line Attribution: Phase 1 Helpers (Lines 6143-6208)

- `isBlockElement(tagName)` -- block-level tag check (line 6146)
- `attributeSourceLines(rootElement)` -- DOM tree walker that converts `⟨L:N⟩` markers to `data-src-line` attributes (line 6159)

#### 29c. Source View: Phase 2 (Lines 6210-6408)

`initializeSourceView(originalSource)` -- creates a full-document source viewer:
- `createSourceViewUI()` -- builds fixed-position overlay with line-numbered source display
- `showSourceView(lineNumber, clickY)` -- scrolls to specified line
- `hideSourceView()` -- hides overlay
- Custom context menu with "View Document Markdeep Source" option
- Click-to-line navigation using `data-src-line` attributes

#### 29d. formatDocument(mode) (Lines 6410-7124)

The main document formatting dispatcher. Handles three modes:

**script mode** (line 6416): No-op return.

**html/doxygen mode** (lines 6419-6486): Processes `<diagram>`, `<markdeep>`, and `.markdeep`/`.diagram` class elements within an existing HTML document. Calls `markdeepToHTML()` in element mode.

**markdeep mode** (lines 6488-7124): Full-document processing:
- Removes recursive script references
- Scroll event handler
- Source extraction via `nodeToMarkdeepSource()`
- noformat mode (raw source display)
- `markdeepProcessor()` inner function:
  - Context menu for headers and definition terms (lines 6551-6671)
  - MathJax injection
  - Document head assembly (META, stylesheets)
  - Export mode support
  - Phase 1 source line attribution
  - Phase 2 source view initialization
  - Link preview on hover system (lines 6735-7103)
  - Hash-based scroll restoration

#### 29e. Public API: headerAnchor / definitionAnchor (Lines 7126-7176)

- `headerAnchor(headerArray)` -- generates hierarchical anchor from header path
- `definitionAnchor(headerArray, term)` -- generates definition anchor with code-sensitive mangling

#### 29f. Markdown Table Generator: generateMarkdownTable (Lines 7178-7394)

Programmatic Markdown table generation:
- Column specs with `maxWidth`, `minWidth`, `halign`
- Cell padding and truncation
- Separator row alignment markers
- Caption support

#### 29g. Code Safety: makeMarkdownCodeBrowserSafe (Lines 7396-7441)

Wraps code blocks/spans containing `<` followed by non-whitespace in `<script type="preformatted">` blocks. Escapes `<script` patterns within.

#### 29h. window.markdeep Export (Lines 7443-7456)

Frozen object exposing the public API:
- `format` = `markdeepToHTML`
- `formatDiagram` = `diagramToSVG`
- `formatDocument` = `formatDocument`
- `headerAnchor`, `definitionAnchor`
- `generateMarkdownTable`
- `makeMarkdownCodeBrowserSafe`
- `langTable` = `LANG_TABLE`
- `stylesheet()` -- returns combined CSS

#### 29i. Auto-Execution (Line 7459)

`formatDocument(option('mode'))` -- triggers processing immediately.

### 30. Highlight.js (Lines 7464-8775)

Embedded highlight.js v11.11.1, minified. Assigned to `var hljs` (global within the IIFE but also exported via `module.exports` at line 8775).

Structure of the minified hljs:
- **Core engine** (lines 7476-7777): The `ee` function containing the full highlight.js runtime -- lexer, parser, language compiler, auto-detection, plugin system.
- **Language grammar definitions** (lines 7778-8773): Object `Pe` containing `grmr_*` functions for each bundled language. Languages included based on the grammar keys visible in the minified code:
  - `grmr_armasm` (ARM Assembly)
  - `grmr_xml` (HTML/XML)
  - `grmr_yaml` (YAML)
  - `grmr_wgsl` (WGSL)
  - JavaScript/TypeScript (via `ye` function at line 7788 and TypeScript variant around line 8700)
  - Java number patterns (via `he` at line 7779)
  - Swift (identifiable by keywords at lines 7866+)
  - Plus many others in the minified block (CSS, C/C++, Python, Ruby, Go, Rust, etc.)
- **Language registration loop** (lines 8772-8773): Iterates `Pe` keys, strips `grmr_` prefix, and calls `ze.registerLanguage()`.
- **Module export** (line 8775): `module.exports=hljs` for Node.js compatibility.

### 31. Emacs Local Variables (Lines 8776-8783)

File-local variables for Emacs: JavaScript mode, UTF-8 with BOM signature encoding.

---

## Summary of Namespaces and Scoping

| Scope | Mechanism | Key Contents |
|-------|-----------|-------------|
| Global | `window.markdeep` (frozen object) | `format`, `formatDiagram`, `formatDocument`, `headerAnchor`, `definitionAnchor`, `generateMarkdownTable`, `makeMarkdownCodeBrowserSafe`, `langTable`, `stylesheet()` |
| Global | `window.alreadyProcessedMarkdeep` | Boolean guard against recursive execution |
| Global | `window.markdeepOptions` | User configuration (read by `option()`) |
| Global | `window.markdeepShowSourceView` | Source view trigger (set at line 6304) |
| Global | `var hljs` | Highlight.js library instance |
| IIFE-local | Top-level vars | All language tables, DEFAULT_OPTIONS, LANG_TABLE, STYLESHEET, constants, utility functions |
| Function-local | `markdeepToHTML` closures | `protect()`, `expose()`, `protector()`, `protectedStringArray`, `endNoteTable`, `referenceLinkTable`, `refCounter`, `refTable` |
| Function-local | `diagramToSVG` closures | `Vec2`, `makeGrid`, `Path`, `PathSet`, `DecorationSet`, `findPaths`, `findDecorations`, `findReplacementCharacters` |
| Function-local | `formatDocument` closures | `markdeepProcessor`, `initializeSourceView`, `attributeSourceLines`, MathJax loaders |

There are no ES6 modules, no CommonJS require/exports within the Markdeep code itself (only hljs uses `module.exports`), and no class-based architecture. The code uses a purely functional/procedural style with closures for encapsulation, all within a single IIFE.
