---
question: "Q5: What file formats and diagram types does markdeep support? Map each to its parser."
evaluator_start: "2026-03-10T12:59:17Z"
evaluator_end: "2026-03-10T13:01:01Z"
---

# Q5: File Formats, Diagram Types, and Their Parsers in Markdeep

## 1. Master Parser: `markdeepToHTML` (line 3059)

All format processing is orchestrated by `markdeepToHTML(str, elementMode)`. It calls sub-parsers in a specific order, using a `protect()`/`expose()` system (lines 3087-3108) to shield already-processed content from later regex passes.

---

## 2. Comprehensive Format/Type-to-Parser Mapping

### 2.1 ASCII Art Diagrams

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Diagram extraction (asterisk-bordered `*****` blocks) | `extractDiagram()` | 1766-1888 | Finds rectangles of `*` characters, extracts interior content and alignment hint (center/floatleft/floatright) |
| Diagram-to-SVG rendering | `diagramToSVG(diagramString, alignmentHint)` | 4644-5844 | Master function converting ASCII art to SVG. Calls sub-functions below |
| Diagram replacement (orchestrator) | `replaceDiagrams()` (closure inside `markdeepToHTML`) | 3423-3451 | Recursively calls `extractDiagram()` then `diagramToSVG()`, handles captions |
| Code fence diagram detection | `looksLikeDiagram()` (closure inside `markdeepToHTML`) | 3454-3508 | Heuristic detector: checks diagram character ratio (>=20-25%), pattern matches (>=30%), vertical bar lines |
| Code fence to diagram conversion | `cleanupCodeFences()` (closure inside `markdeepToHTML`) | 3510-3559 | Converts unlabeled code fences that look like diagrams (or fences explicitly labeled `diagram`) into `*****`-bordered format |
| Grid creation for diagrams | `makeGrid(str)` (inside `diagramToSVG`) | 4732-4906 | Converts diagram string into a 2D grid with methods: `isSolidVLineAt`, `isSolidHLineAt`, `isSolidBLineAt`, `isSolidDLineAt` |
| Path finding (lines) | `findPaths(grid, pathSet)` (inside `diagramToSVG`) | 5191-5593 | Finds solid vertical lines (5208-5281), solid horizontal lines (5283-5311), backslash diagonal lines (5322-5376), forward-slash diagonal lines (5387-5445), curved corners (5454-5516), underscored low horizontal lines (5518-5592) |
| Decoration finding (arrow heads, points, fills) | `findDecorations(grid, pathSet, decorationSet)` (inside `diagramToSVG`) | 5596-5740 | Identifies: jumps `()` (5614-5621), points `o*` and unicode circles (5623-5643), gray fill characters (5644-5646), triangle characters (5647-5649), arrow heads `>v<^` (5650-5736) |
| Replacement Unicode characters | `findReplacementCharacters(grid, pathSet)` (inside `diagramToSVG`) | 5745-5762 | Handles special Unicode drawing characters: `╱` (line 5751) and `╲` (line 5755) |

#### Diagram Sub-Elements Supported

| Diagram Element | Characters | Detected By | Line Numbers |
|---|---|---|---|
| Horizontal lines | `-`, `+` | `isSolidHLine()`, `isSolidHLineAt()` | 4697, 4813-4845 |
| Vertical lines | `\|`, `+` | `isSolidVLine()`, `isSolidVLineAt()` | 4699, 4777-4808 |
| Forward diagonal lines | `/`, `+` | `isSolidDLine()`, `isSolidDLineAt()` | 4700, 4875-4901 |
| Backslash diagonal lines | `\\`, `+` | `isSolidBLine()`, `isSolidBLineAt()` | 4701, 4849-4871 |
| Underscored horizontal lines | `_` | Direct detection in `findPaths()` | 5518-5592 |
| Arrow heads | `>`, `v`, `<`, `^` | `isArrowHead()` in `findDecorations()` | 4691, 5650-5736 |
| Solid/closed points | `*`, `●` | `isPoint()` in `findDecorations()` | 4703, 5623-5643 |
| Open points | `o`, `○` | `isPoint()` in `findDecorations()` | 4703, 5623-5643 |
| Dotted points | `◌` | `isPoint()` in `findDecorations()` | 4703, 5160 |
| Shaded points | `◍` | `isPoint()` in `findDecorations()` | 4703, 5160 |
| Jump crossings | `(`, `)` | `isJump()` in `findDecorations()` | 4702, 5614-5621 |
| Gray fill blocks | `░▒▓█` (Unicode block elements) | `isGray()` in `findDecorations()` | 4692, 4678, 5644-5646, 5163-5166 |
| Triangle fills | `◢◣◤◥` (Unicode triangles) | `isTri()` in `findDecorations()` | 4693, 4681, 5647-5649, 5168-5177 |
| Curved corners (Bezier curves) | `.` (top), `'` (bottom) with adjacent `-` and `\|` | `findPaths()` curved corner section | 5454-5516 |
| Vertices (undirected) | `+` | `isUndirectedVertex()` | 4674, 4685 |
| Top vertices | `+`, `.` | `isTopVertex()` | 4687 |
| Bottom vertices | `+`, `'` | `isBottomVertex()` | 4688 |
| Dashed paths | `Path(A, B, C, D, dashed)` | `Path.toSVG()` with `stroke-dasharray` | 4911-4926, 5058-5060 |
| Resistor patterns | `.╱`, `╱'-` | `findPaths()` special cases | 5267-5278 |
| Hexagons (Unicode) | `⬡`, `⬢` | Passthrough text rendering | 5813-5815 |
| Passthrough text | Any non-consumed character | Final grid sweep in `diagramToSVG()` | 5808-5821 |

### 2.2 Code Blocks and Syntax Highlighting

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Labeled code fences (`~~~lang` / `` ```lang ``) | `processLabeledCodeFences()` / `processOneFenceType()` (closures) | 3561-3619 | Processes tilde fences (line 3616) and backtick fences (line 3617) separately. Uses `hljs.highlight()` for known languages (line 3595), `hljs.highlightAuto()` for detection (line 3592) |
| Unlabeled code fences | `cleanupCodeFences()` (closure) | 3510-3559 | Auto-detects language via `hljs.highlightAuto()` (line 3527) or diagram via `looksLikeDiagram()` (line 3524) |
| Inline code (backtick) | Regex in `markdeepToHTML` | 3695-3720 | Pattern: `` `code` `` with optional `inlineCodeLang` option for syntax highlighting |
| Explicit inline code with language | Regex in `markdeepToHTML` | 3659-3661 | Pattern: `<code lang="...">code</code>` - uses `hljs.highlight()` |
| Preformatted script blocks | Regex in `markdeepToHTML` | 3421 | Pattern: `<script type="preformatted">...</script>` - strips wrapper tags |
| Code browser safety | `makeMarkdownCodeBrowserSafe()` | 7414-7427 | Wraps code fences containing `<` in preformatted script blocks |
| Script tag unescaping | `unescapeScriptTags()` (closure) | 3417-3419 | Removes break characters inserted to prevent premature script tag closure |

#### Highlight.js Integration

| Component | Location | Line Numbers |
|---|---|---|
| Highlight.js library (minified, v11.11.1) | Embedded in file | 7476-8714+ |
| Highlight stylesheet (xcode theme) | `HIGHLIGHT_STYLESHEET` variable | 6076-6102 |
| Auto-detection | `hljs.highlightAuto()` | Called at 3527, 3590, 3592 |
| Explicit language highlighting | `hljs.highlight(code, {language: lang})` | Called at 3595, 3660, 3706 |

Supported languages include (from the embedded hljs): C/C++, Java, JavaScript, Python, Ruby, Go, Rust, Swift, Kotlin, Scala, Haskell, Lua, Perl, PHP, R, MATLAB, Shell/Bash, SQL, HTML/XML, CSS, JSON, YAML, TOML, Markdown, LaTeX/TeX, Diff, Makefile, GLSL, and many more (40+ languages in the embedded bundle).

### 2.3 LaTeX / MathJax Math

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Display math `$$...$$` | Regex + `protect()` in `markdeepToHTML` | 3733 | Protected from Markdown processing, passed to MathJax |
| Inline math `$...$` (tight) | Regex in `markdeepToHTML` | 3745 | Converted to `\(...\)` for MathJax; excludes US$/Can$ patterns |
| Inline math `$ ... $` (spaced) | Regex in `markdeepToHTML` | 3755 | Spaced dollar signs converted to `\(...\)` |
| `\(...\)` inline math | Regex + `protect()` in `markdeepToHTML` | 3758 | Protected from further processing |
| `\begin{equation}...\end{equation}` | Regex + `protect()` in `markdeepToHTML` | 3759 | Protected block equation |
| `\begin{eqnarray}...\end{eqnarray}` | Regex + `protect()` in `markdeepToHTML` | 3760 | Protected equation array |
| `\begin{equation*}...\end{equation*}` | Regex + `protect()` in `markdeepToHTML` | 3761 | Protected unnumbered equation |
| Equation cross-references | Regex in `markdeepToHTML` | 3959-3961 | `eqn [foo]` -> `eqn \ref{foo}` for MathJax |
| MathJax loading | `loadMathJax()` | 6120-6134 | Dynamically loads MathJax 3 from CDN |
| MathJax detection | `needsMathJax()` | 6136-6141 | Checks if document contains math syntax |
| MathJax custom commands | `MATHJAX_CONFIG` | 6113-6116 | Pre-defines shortcuts: `\n`, `\d`, `\wi`, `\wo`, `\Real`, `\Complex`, etc. |

### 2.4 Tables

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| GitHub-style Markdown tables | `replaceTables(s, protect)` | 1946-2034 | Pipe-delimited tables with header separator row (`---|---`). Supports left/center/right alignment via colons. Adds `longtable` class for tables with 15+ rows |
| Table captions | `createTarget()` called from `replaceTables()` | 1918-1943, 2020-2028 | Pattern: `[caption text]` below or above table. Supports numbered references: `Table [ref]: caption` |
| Calendar tables (from schedule lists) | `replaceScheduleLists()` | 2396-2503 | Auto-generated monthly calendar view with day headers, event links, weekend hiding |
| Definition list tables (short form) | `replaceDefinitionLists()` | 2585-2594 | Short definitions (<160 chars) rendered as two-column tables |
| Image grid tables | Image grid processing in `markdeepToHTML` | 4042-4122 | Multiple images on consecutive lines rendered as HTML tables |
| Markdown table generation | `generateMarkdownTable()` | 7188-7394 | Programmatic table generation utility with column specs (alignment, max width, truncation) |

### 2.5 Lists

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Unordered lists (`-`, `+`, `*`) | `replaceLists(s, protect)` | 2037-2239 | Nested lists with CSS classes: `plus`, `minus`, `asterisk` |
| Ordered lists (`1.`, `2.`, etc.) | `replaceLists(s, protect)` | 2037-2239 | Supports custom start numbers via `start=` attribute |
| Task/checkbox lists (unchecked) | `replaceLists(s, protect)` | 2040, 2043 | Patterns: `- [ ]` or `☐` -> class `unchecked` |
| Task/checkbox lists (checked) | `replaceLists(s, protect)` | 2041, 2044 | Patterns: `- [x]` or `☑` -> class `checked` |
| Schedule lists (date-based) | `replaceScheduleLists(str, protect)` | 2241-2519 | Date:title format with indented body. Generates schedule table + optional calendar. Parses DD/MONTH/YYYY, YYYY/MONTH/DD, MONTH/DD/YYYY formats |
| Definition lists | `replaceDefinitionLists(s, protect)` | 2541-2610 | `Term\n: definition` syntax. Short definitions become tables; long ones become `<dl>/<dt>/<dd>` |

### 2.6 Headers and Document Structure

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Setext H1 (`===` underline) | Regex + `makeHeaderFunc()` in `markdeepToHTML` | 3769 | Text followed by `===` line |
| Setext H2 (`---` underline) | Regex + `makeHeaderFunc()` in `markdeepToHTML` | 3772 | Text followed by `---` line |
| ATX headers (`# ` through `###### `) | Regex + `makeHeaderFunc()` in `markdeepToHTML` | 3786-3802 | Standard ATX headers with optional closing `#` |
| No-number headers (`(# )` through `(###### )`) | Regex in `markdeepToHTML` | 3796-3801 | Parenthesized headers get `nonumberh1`-`nonumberh6` class |
| Title (bold first line) | Regex in `markdeepToHTML` | 4407-4431 | First `**bold**` line becomes `<div class="title">` with `<title>` tag |
| Title (H1 when `h1TitleInput`) | Option-driven in `markdeepToHTML` | 4436-4458 | `#` becomes title, `##` becomes H1, etc. |
| Subtitles | Regex in `markdeepToHTML` | 4408, 4421 | Indented lines below title become `<div class="subtitle">` |
| Table of contents | `insertTableOfContents(s, protect, exposer)` | 2615-2838 | Auto-generated TOC with styles: `none`, `short`, `medium`, `long`, `auto` |
| Section numbering | `sectionNumberingStylesheet()` | 1607-1633 | CSS counters for hierarchical section numbering |
| Section wrapping | `wrapHeaderSections(str)` | 2864-3057 | Wraps header sections in `<section>` tags with classes `h1-section` through `h6-section` |
| `makeHeaderFunc(level)` | Helper closure in `markdeepToHTML` | 3123-3153 | Creates header replacement functions with level translation |
| `inputLevel(markdownLevel)` | Level translator | 1502-1510 | Translates markdown `#` level to internal level |
| `outputLevel(internalLevel)` | Level translator | 1523-1531 | Translates internal level to HTML output level |

### 2.7 Inline Formatting

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Bold (`**text**`, `__text__`) | `replaceMatched()` called from `markdeepToHTML` | 1894-1904, 4201-4202 | Produces `<strong>` with class `asterisk` or `underscore` |
| Italic (`*text*`, `_text_`) | `replaceMatched()` called from `markdeepToHTML` | 1894-1904, 4205-4206 | Produces `<em>` with class `asterisk` or `underscore` |
| Strikethrough (`~~text~~`) | Regex in `markdeepToHTML` | 4209 | Produces `<del>` tags |
| Stage directions (`((text))`) | Regex in `markdeepToHTML` | 4211-4222 | Block-level (line 4217) and inline (line 4220). Enabled via `enableStageDirections` option |
| Smart double quotes | Regex in `markdeepToHTML` | 4226-4229 | `"` -> `&ldquo;`/`&rdquo;` when `smartQuotes` option is true |
| Unicode arrows | Regex chain in `markdeepToHTML` | 4232-4240 | `<==`, `->`, `-->`, `==>`, `<-`, `<--`, `<==>`, `<->` |
| Em dash | Regex in `markdeepToHTML` | 4244, 4248 | `---` and `--` -> `&mdash;` |
| Dimension (NxM) | Regex in `markdeepToHTML` | 4254-4268 | `720x360` -> `720&times;360` (with smart exclusions for hex, IDs) |
| Minus sign | Regex in `markdeepToHTML` | 4271-4272 | `-4` or `2 - 1` -> `&minus;` in appropriate contexts |
| Exponents | Regex in `markdeepToHTML` | 4275 | `^2` -> `<sup>2</sup>` |
| Degree symbol | Regex in `markdeepToHTML` | 4295 | `90 degree` / `90-degree` -> `90&deg;` |

### 2.8 Links, Images, and Media

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Hyperlinks `[text](url)` | Regex in `markdeepToHTML` | 3985-3990 | Standard Markdown links with optional attributes |
| Empty hyperlinks `[](url)` | Regex in `markdeepToHTML` | 3993-3995 | URL displayed as link text |
| Reference links `[text][ref]` | Regex in `markdeepToHTML` | 3998-4015 | Uses `referenceLinkTable` |
| Reference link definitions `[ref]: url` | Regex in `markdeepToHTML` | 3864-3867 | Populates `referenceLinkTable` |
| Auto-linked URLs | Regex in `markdeepToHTML` | 4381-4390 | `http://...`, `<http://...>` (excludes svn, p4, quad URLs) |
| Email addresses | Regex in `markdeepToHTML` | 3870-3877 | `foo@bar.com` or `<foo@bar.com>` -> `mailto:` link |
| Simple image `![](url)` | `formatImage()` + regex in `markdeepToHTML` | 3880-3955, 4126-4135 | Centers block images, inline otherwise |
| Captioned image `![caption](url)` | `formatImage()` + regex in `markdeepToHTML` | 3880-3955, 4148-4193 | Floating or centered with caption. Supports figure numbering |
| Reference image `![caption][ref]` | Regex in `markdeepToHTML` | 4028-4039 | Rewritten to standard image syntax for further processing |
| Image grids (multiple images per line) | Multi-pass processing in `markdeepToHTML` | 4042-4122 | Consecutive lines of images rendered as HTML table grid |
| Video (mp4/m4v/avi/mpg/mov/webm) | `formatImage()` | 3901-3903 | Detected by file extension, rendered as `<video>` with controls |
| Audio (mp3/mp2/ogg/wav/m4a/aac/flac) | `formatImage()` | 3904-3906 | Detected by file extension, rendered as `<audio>` with controls |
| YouTube embeds | `formatImage()` | 3907-3914 | URL pattern detection, rendered as `<iframe>` with YouTube embed URL. Supports timestamps |
| Vimeo embeds | `formatImage()` | 3915-3917 | URL pattern detection, rendered as `<iframe>` with Vimeo player URL |
| Gravizo graph URLs | Regex in `markdeepToHTML` | 3978-3980 | Special URL encoding for Gravizo diagram service |
| Image attribution | `formatImage()` | 3889-3951 | `attrib="..."` and `attrib-url="..."` attributes |
| Section links | Regex in `markdeepToHTML` | 4342-4355 | `Header section`, `section Header` -> auto-linked |
| Figure/Table/Listing references | Regex in `markdeepToHTML` | 4358-4377 | `Figure [ref]`, `Table [ref]`, `Listing [ref]`, `Diagram [ref]` -> numbered links |
| Section number references | Regex in `markdeepToHTML` | 4472-4480 | `sec. [X]`, `section [X]`, `chapter [X]` -> linked section numbers |

### 2.9 Blockquotes

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Standard blockquotes (`>`) | Iterative regex in `markdeepToHTML` | 3628-3656 | Nested blockquote support via iterative processing |
| Fancy quotes (`" ... "` with author) | Regex inside blockquote handler | 3645-3652 | `"quote"\n  author` -> styled blockquote with `fancyquote` class |

### 2.10 Footnotes, Endnotes, and Citations

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Footnote/endnote references `[^name]` | `endNote()` closure + regex in `markdeepToHTML` | 3819-3831 | Numbered superscript links |
| Footnote/endnote definitions `[^name]: text` | Regex in `markdeepToHTML` | 4325-4334 | Rendered as `<div class="endnote">` |
| Citation definitions `[#name]: text` | Regex in `markdeepToHTML` | 3836-3840 | Rendered as `<div class="bib">` |
| Citation references `[#name]` | Regex in `markdeepToHTML` | 3844-3855 | Multiple citations: `[#a, #b]` -> linked references |

### 2.11 Admonitions

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Admonition blocks `!!!` | Regex in `markdeepToHTML` | 3811-3815 | Pattern: `!!! class: Title\n   body`. Rendered as `<div class="admonition class">` with optional title |

### 2.12 Horizontal Rules and Page Breaks

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Horizontal rule (`* * *`, `- - -`, `_ _ _`) | Regex in `markdeepToHTML` | 3805 | 3+ of `*`, `-`, or `_` with spaces -> `<hr>` |
| Page break (`+++++`) | Regex in `markdeepToHTML` | 3808 | 5+ `+` characters -> `<hr class="pagebreak">` |
| `\pagebreak` / `\newpage` | Regex in `markdeepToHTML` | 4278 | LaTeX-style page break commands |

### 2.13 Line Breaks

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Backslash line break (`\` at EOL) | Regex in `markdeepToHTML` | 4303-4306 | CommonMark `\` before newline. Enabled via `enableBackslashLineBreak` option |
| Trailing-space line break (2+ spaces at EOL) | Regex in `markdeepToHTML` | 4308-4313 | CommonMark hidden line break. Enabled via `enableHiddenLineBreak` option |

### 2.14 Document Include/Embed System

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Insert Markdeep files `(insert file.md.html here)` | `processInsertCommands()` | 5858-6073 | Loads child HTML documents via iframes, receives content via `postMessage`, merges into parent |
| Embed non-HTML files `(embed file.txt here)` | `processInsertCommands()` | 6005-6037 | Embeds via `<iframe>` (or `<object>` on Firefox). Supports height parameter |
| Insert HTML files | `processInsertCommands()` | 6039-6054 | Recursive Markdeep processing via child frames |

### 2.15 API Definition Links

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| API definition targets `<dt><code>name(` | Regex in `markdeepToHTML` | 4524-4536 | Detects function, array, and template definitions in `<dt>` blocks |
| API definition auto-links `<code>name()</code>` | Regex in `markdeepToHTML` | 4547-4550 | Automatically links code spans to matching API definitions |

### 2.16 HTML and SVG Passthrough

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Raw HTML tags | Attribute protection regex in `markdeepToHTML` | 3726 | HTML attributes protected from Markdown processing |
| SVG blocks | Regex + `protect()` in `markdeepToHTML` | 3673-3675 | `<svg>...</svg>` bodies and attributes protected |
| Style blocks | Regex + `protect()` in `markdeepToHTML` | 3678-3680 | `<style>...</style>` bodies protected |
| HTML comments | Regex in `markdeepToHTML` | 3668 | `<!-- ... -->` stripped entirely |
| Preformatted blocks `<pre>` | Regex + `protect()` in `markdeepToHTML` | 3723 | Protected from all further processing |
| Image tags with newlines (Gravizo) | Regex + `protect()` in `markdeepToHTML` | 3685-3688 | Special handling for `<img>` tags with complex src attributes |

### 2.17 Paragraph Processing

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Paragraph breaks (blank lines) | Regex in `markdeepToHTML` | 4317-4318 | Double newlines -> `</p><p>` |
| Empty paragraph cleanup | Regex in `markdeepToHTML` | 4321 | Removes `<p></p>` artifacts |

### 2.18 Source Line Tracking (Phase 1)

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Line number marker injection | State machine in `markdeepToHTML` | 3167-3407 | Injects protected `⟨L:N⟩` markers for source line attribution. State machine modes: `normal`, `script`, `style`, `pre`, `fence`, `diagram` |
| DOM source line attribution | `attributeSourceLines(rootElement)` | 6159-6172+ | Walks DOM text nodes, extracts `⟨L:N⟩` markers, sets `data-src-line` attributes |

### 2.19 Reference Numbering System

| Format/Element | Parser Function(s) | Line Numbers | Description |
|---|---|---|---|
| Figure/Table/Listing/Diagram captions | `createTarget(caption, protect)` | 1918-1943 | Pattern: `Type [ref]: caption text`. Manages `refCounter` and `refTable` for cross-references |
| Caption localization | `keyword()` function | 1545-1549 | Supports localized caption keywords (Figure, Table, Listing, Diagram) in 15+ languages |

### 2.20 Localization

| Component | Location | Line Numbers |
|---|---|---|
| Language table | `LANG_TABLE` | 1416-1444 |
| Supported languages | English, Russian, French, Polish, Bulgarian, German, Hungarian, Swedish, Portuguese, Japanese, Italian, Lithuanian, Czech, Spanish, Catalan | 1416-1441 |
| Keyword localization | `keyword()` function | 1545-1549 |

---

## 3. Processing Order in `markdeepToHTML`

The formats are processed in this specific order (critical for correct output):

1. **Line tracking markers** (lines 3167-3407) - Phase 1 state machine
2. **Preformatted script blocks** (line 3421) - `<script type="preformatted">`
3. **Code fence cleanup and labeling** (line 3621) - `cleanupCodeFences()`
4. **Labeled code fence processing** (line 3622) - `processLabeledCodeFences()`
5. **Blockquotes with nested fences and fancy quotes** (lines 3628-3656)
6. **Inline code with explicit language** (lines 3659-3661)
7. **Protect raw `<code>` content** (line 3664)
8. **Remove HTML comments** (line 3668)
9. **ASCII art diagrams** (line 3670) - `replaceDiagrams()`
10. **Protect SVG blocks** (lines 3673-3675)
11. **Protect style blocks** (lines 3678-3680)
12. **Protect img tags** (lines 3685-3688)
13. **Inline code (backtick)** (lines 3695-3720)
14. **Protect code and pre blocks** (lines 3718-3723)
15. **Protect HTML attributes** (line 3726)
16. **LaTeX/MathJax protection** (lines 3733-3761) - `$$`, `$`, `\(`, `\begin{equation}`, etc.
17. **Headers** (lines 3769-3802) - Setext and ATX
18. **Horizontal rules** (lines 3805-3808)
19. **Admonitions** (lines 3811-3815)
20. **Footnotes/endnotes** (lines 3819-3831)
21. **Citations** (lines 3836-3855)
22. **Tables** (line 3860) - `replaceTables()`
23. **Reference link definitions** (lines 3864-3867)
24. **Email addresses** (lines 3870-3877)
25. **Equation references** (lines 3959-3961)
26. **Hyperlinks** (lines 3985-4015)
27. **Image captions protection** (lines 4021-4024)
28. **Reference images** (lines 4029-4039)
29. **Image grids** (lines 4042-4122)
30. **Simple images** (lines 4126-4135)
31. **Captioned images** (lines 4148-4193)
32. **Bold/strong** (lines 4201-4202)
33. **Italic/emphasis** (lines 4205-4206)
34. **Strikethrough** (line 4209)
35. **Stage directions** (lines 4212-4222)
36. **Smart quotes** (lines 4226-4229)
37. **Arrows, em dashes, dimensions, minus, exponents** (lines 4232-4275)
38. **Page breaks** (line 4278)
39. **Schedule lists** (line 4281) - `replaceScheduleLists()`
40. **Definition lists** (line 4289) - `replaceDefinitionLists()`
41. **Bullet/numbered lists** (line 4292) - `replaceLists()`
42. **Degree symbols** (line 4295)
43. **Line breaks** (lines 4303-4313)
44. **Paragraphs** (lines 4317-4321)
45. **Endnote definitions** (lines 4325-4334)
46. **Section links** (lines 4342-4355)
47. **Figure/Table/Listing references** (lines 4358-4377)
48. **Auto-linked URLs** (lines 4381-4390)
49. **Title detection** (lines 4392-4458)
50. **Table of contents** (line 4468) - `insertTableOfContents()`
51. **Section wrapping** (line 4485) - `wrapHeaderSections()`
52. **Expose all protected values** (lines 4490-4497)
53. **API definition links** (lines 4511-4550)

---

## 4. File Format Support Summary

| Input Format | Output Format | Key Parser |
|---|---|---|
| Markdeep (`.md.html`) | HTML | `markdeepToHTML()` (line 3059) |
| ASCII art diagrams (`*****` bordered) | SVG | `extractDiagram()` (1766) + `diagramToSVG()` (4644) |
| Code fence diagrams (` ```diagram `) | SVG (via conversion) | `cleanupCodeFences()` (3510) -> `*****` -> SVG |
| Markdown tables | HTML `<table>` | `replaceTables()` (1946) |
| LaTeX math | MathJax-processed HTML | Regex protection (3733-3761) + MathJax 3 CDN |
| Source code (40+ languages) | Syntax-highlighted HTML | `processLabeledCodeFences()` (3561) via highlight.js 11.11.1 |
| Schedule data (dates) | HTML table + calendar | `replaceScheduleLists()` (2241) |
| Embedded files `(insert ... here)` | Inline HTML | `processInsertCommands()` (5858) |
| Video URLs (mp4, mov, etc.) | `<video>` element | `formatImage()` (3901) |
| Audio URLs (mp3, ogg, etc.) | `<audio>` element | `formatImage()` (3904) |
| YouTube/Vimeo URLs | `<iframe>` embed | `formatImage()` (3907, 3915) |
| Raw HTML/SVG | Passthrough | Various `protect()` calls |
