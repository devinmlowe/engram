---
test_type: treatment_v2
approach: RLM context management with task classification, multi-pass grep, coverage estimation, boundary padding
start_time: 2026-03-10T14:02:43Z
download_complete: 2026-03-10T14:02:48Z
end_time: 2026-03-10T14:06:17Z
---

## Q1: Purpose, Subsystems, and Control Flow
**start:** 2026-03-10T14:03:16Z
**end:** 2026-03-10T14:03:29Z
**task_type:** architecture
**segments_read:** [1-45, 1384-1468, 6400-6520, 6518-6697]
**grep_queries:** ["function\\|var \\|/\\*\\*\\|module\\|exports" (head/tail), "^function ", "window\\.markdeep\\|window\\.alreadyProcessedMarkdeep\\|exports\\."]
**coverage_estimate:** ~530 lines read / 8784 total = ~6%. Appropriate for architecture — targeted entry points, exports, and initialization flow.

### Purpose

Markdeep.js (v1.19) is a single-file, client-side JavaScript library that transforms plain-text documents written in an extended Markdown dialect into beautifully formatted HTML directly in the browser. Created by Morgan McGuire, it extends John Gruber's Markdown with ASCII art diagrams, LaTeX math (via MathJax), code highlighting (via bundled highlight.js v11.11.1), schedule lists, definition lists, tables of contents, endnotes, citations, admonitions, and more. It requires no server-side processing — a single `<script>` tag at the bottom of a `.md.html` file is all that's needed (line 618).

### Major Subsystems

1. **Stylesheet Engine** (lines 157-618): A massive embedded CSS stylesheet (`STYLESHEET`, `BODY_STYLESHEET`) providing typography, diagram styling, admonition boxes, table formatting, and print support.

2. **Internationalization** (lines 621-1444): Language tables for 15+ languages (French, Lithuanian, Bulgarian, Portuguese, Czech, Italian, Russian, Polish, Hungarian, Japanese, German, Spanish, Swedish, Catalan) mapping keywords like "figure", "table", "section", "listing", "diagram" to localized equivalents.

3. **Configuration** (lines 1384-1410, 1466-1500): `DEFAULT_OPTIONS` object with ~20 configurable options (mode, tocStyle, tocDepth, detectMath, smartQuotes, etc.), overridable via `window.markdeepOptions`.

4. **Markdown-to-HTML Converter** (`markdeepToHTML`, lines 3059-4554): The core rendering engine — a ~1500-line function that processes markdown source through a multi-phase pipeline of regex transformations (code fences, blockquotes, headers, tables, lists, inline formatting, math, links, images, etc.).

5. **ASCII Diagram-to-SVG Engine** (`diagramToSVG`, lines 4644-5856): Converts ASCII art delimited by `*****` borders into SVG graphics, recognizing lines, arrows, curves, vertices, decorations, gray fills, and passthrough text.

6. **Include/Insert System** (`processInsertCommands`, lines 5858-6073): Supports `(insert filename.md.html here)` directives, loading child documents via iframe messaging and XHR.

7. **Document Formatter** (`formatDocument`, lines 6410-7460): The entry-point orchestrator that handles three modes: `markdeep` (full document), `html`/`doxygen` (embedded diagrams and markdeep tags), and `script` (no-op). Manages MathJax loading, source view, context menus, and link previews.

8. **Syntax Highlighting** (highlight.js, lines 7470-8775): Bundled minified highlight.js supporting dozens of languages.

### Overall Control Flow

1. The IIFE executes at script load (line 39).
2. Polyfills are installed, stylesheets built, language detected from `<meta lang>` tags.
3. `formatDocument(option('mode'))` is called (line 7459).
4. In `markdeep` mode: the document body is extracted via `nodeToMarkdeepSource()`, passed through `processInsertCommands()` for includes, then through `markdeepToHTML()` for rendering.
5. The rendered HTML replaces `document.body.innerHTML`, stylesheets are injected into `<head>`, MathJax is loaded if needed, and the body is made visible.
6. The public API is frozen onto `window.markdeep` (line 7444).

---

## Q2: Code Organization
**start:** 2026-03-10T14:03:32Z
**end:** 2026-03-10T14:03:42Z
**task_type:** architecture
**segments_read:** [44-63, 7440-7510]
**grep_queries:** ["window\\.markdeep\\|window\\.alreadyProcessedMarkdeep\\|exports\\.", "^function "]
**coverage_estimate:** ~90 lines read / 8784 total = ~1%. Sufficient for architecture — the file has a simple structure.

### Organization

The entire library is a single IIFE `(function() { ... })()` (lines 39-7462) with no module system. There are no namespaces or classes in the traditional sense. The code is organized as a flat sequence of:

1. **String prototype extensions** (lines 44-63): `.rp` (alias for `.replace`), `.ss` (alias for `.substring`), `.regexIndexOf()`, `.endsWith()` polyfill. These are used throughout for brevity (minification-friendly).

2. **Constants and configuration** (lines 66-618): Debug flags, `STROKE_WIDTH`, `DIAGRAM_MARKER`, CSS stylesheets as string constants.

3. **Language/i18n tables** (lines 621-1444): Each language is a `var FRENCH = {...}` object with keyword translations.

4. **Utility functions** (lines 88-1607): `entag()`, `measureFontSize()`, `option()`, `inputLevel()`, `outputLevel()`, `escapeHTMLEntities()`, `mangle()`, `mangleCode()`, `sectionNumberingStylesheet()`, etc.

5. **Source extraction** (`nodeToMarkdeepSource`, lines 1684-1765): Converts DOM nodes back to markdown source.

6. **Diagram extraction** (`extractDiagram`, lines 1766-1893): Finds `*****`-bordered diagram blocks.

7. **Major replace functions** (lines 1894-2864): `replaceMatched()`, `replaceTables()`, `replaceLists()`, `replaceScheduleLists()`, `replaceDefinitionLists()`, `insertTableOfContents()`, `wrapHeaderSections()`.

8. **Core converter** (`markdeepToHTML`, lines 3059-4554): Contains nested helper functions (`protect()`, `expose()`, `makeHeaderFunc()`, `replaceDiagrams()`, `cleanupCodeFences()`, etc.).

9. **Diagram-to-SVG engine** (`diagramToSVG`, lines 4644-5856): Contains `Vec2`, `makeGrid`, `Path`, `PathSet`, `DecorationSet`, `findPaths()`, `findDecorations()`, `findReplacementCharacters()` as nested functions/constructors.

10. **Insert/include system** (`processInsertCommands`, lines 5858-6073).

11. **Highlight.js stylesheet and helpers** (lines 6075-6105).

12. **Document initialization and formatting** (lines 6109-7460): `formatDocument()`, source view UI, context menu, link previews, API export via `window.markdeep = Object.freeze({...})`.

13. **Bundled highlight.js** (lines 7470-8775): Minified, self-contained syntax highlighter.

The public namespace is `window.markdeep` (line 7444), and `window.markdeepOptions` is the user-facing configuration object. `window.alreadyProcessedMarkdeep` prevents double-processing.

---

## Q3: Public/Exported API Functions
**start:** 2026-03-10T14:03:46Z
**end:** 2026-03-10T14:03:57Z
**task_type:** enumeration
**segments_read:** [7133-7163, 7156-7191, 7188-7228, 7414-7456]
**grep_queries:** ["function headerAnchor|function definitionAnchor|function generateMarkdownTable|function makeMarkdownCodeBrowserSafe"]
**coverage_estimate:** ~165 lines read / 8784 total = ~2%. Complete coverage — all 7 exported members from the `window.markdeep` object at line 7444 were traced and read.

### Exported API (`window.markdeep`)

Defined at line 7444 and frozen with `Object.freeze()`:

1. **`format(str, elementMode)`** → `markdeepToHTML` (line 3059)
   Converts a Markdown/Markdeep source string to HTML. `elementMode` (boolean, default `true`) controls whether to process as a standalone document or embedded element.

2. **`formatDiagram(diagramString, alignmentHint)`** → `diagramToSVG` (line 4644)
   Converts an ASCII art diagram string to an SVG string. `alignmentHint` can be `'floatleft'`, `'floatright'`, or `'center'`.

3. **`formatDocument(mode)`** → `formatDocument` (line 6410)
   Processes the current HTML document in the specified mode: `'markdeep'` (full document), `'html'`/`'doxygen'` (process diagram/markdeep tags), or `'script'` (no-op).

4. **`headerAnchor(headerArray)`** (line 7133)
   Takes an array of nested header title strings and returns a URL-safe anchor name by cleaning, lowercasing, mangling, and joining with `/`.

5. **`definitionAnchor(headerArray, term)`** (line 7156)
   Takes an array of header titles and a definition term, returns an anchor name like `'section/def-functionname-fcn'` using code-sensitive mangling.

6. **`generateMarkdownTable(rows, caption, outerBorder, padding, truncateSuffix)`** (line 7188)
   Generates a formatted Markdown table string from an array of row arrays. Supports column specs with `maxWidth`, `minWidth`, `halign`. First row is the header.

7. **`makeMarkdownCodeBrowserSafe(text)`** (line 7414)
   Wraps dangerous code blocks (containing `<script>` tags) in preformatted script elements to prevent browser execution. Early-exits if no `<` followed by non-whitespace is found.

8. **`stylesheet()`** (line 7453)
   Returns the combined CSS string: `STYLESHEET + sectionNumberingStylesheet() + h1TitleOutputStylesheet() + HIGHLIGHT_STYLESHEET`.

9. **`langTable`** (line 7452)
   The language table object mapping locale codes to translation objects.

---

## Q4: Rendering Pipeline
**start:** 2026-03-10T14:04:00Z
**end:** 2026-03-10T14:04:35Z
**task_type:** detail
**segments_read:** [3059-3178, 3178-3378, 3378-3577, 3577-3776, 3776-3976, 6400-6520, 6518-6697, 4485-4560]
**grep_queries:** ["// [A-Z][A-Z]\\|str = replace\\|str = insert\\|str = wrapHeader", "// [A-Z][A-Z]\\|str = replace" (lines 3980-4560), "str = str\\.rp("]
**coverage_estimate:** ~1800 lines read / 8784 total = ~20%. Comprehensive coverage of the entire markdeepToHTML function (lines 3059-4554).

### Full Rendering Pipeline

When a Markdeep document is loaded, the pipeline proceeds as follows:

#### Entry Point: `formatDocument(mode)` (line 6410)

1. **Source extraction** (line 6518): `nodeToMarkdeepSource([document.head, document.body])` converts the DOM back to plain text source.
2. **Insert processing** (line 6540): `processInsertCommands()` resolves `(insert file.md.html here)` directives via iframe messaging.
3. **Core conversion** (line 6544): `markdeepToHTML(source, false)` transforms source to HTML.
4. **Post-processing** (lines 6548-6731): Context menu handlers, MathJax loading, stylesheet injection, source line attribution, body replacement, link previews.

#### Core Pipeline: `markdeepToHTML(str, elementMode)` (lines 3059-4554)

The function maintains a **protect/expose** system: sensitive content (code, math, HTML attributes) is replaced with encoded placeholder tokens, processed through all regex transformations without interference, then restored at the end.

**Phase 1: Source Line Tracking** (lines 3168-3407)
- State machine injects protected `⟨L:N⟩` markers into lines for source-view mapping.
- Skips fences, diagrams, `<script>`, `<style>`, `<pre>` blocks.

**Phase 2: Preformatted Script Tag Unwrapping** (line 3421)
- Removes `<script type="preformatted">` wrappers that protect `<` signs in code.

**Phase 3: Code Fence Processing** (lines 3510-3619)
- `cleanupCodeFences()`: Labels unlabeled fences (auto-detect language via hljs, detect diagrams), converts diagram fences to `*****` format.
- `processLabeledCodeFences()`: Syntax highlights all labeled code fences via highlight.js, wraps in `<pre><code>`.

**Phase 4: Blockquotes** (lines 3626-3656)
- Iteratively processes `>` prefixed lines, including nested blockquotes.
- Handles fancy quotes (`" ... "` with author attribution).

**Phase 5: Inline Code** (lines 3658-3726)
- Explicit `<code lang="...">` highlighting.
- Backtick inline code processing with optional syntax highlighting.
- Protect `<code>` and `<pre>` blocks from further processing.

**Phase 6: HTML Protection** (lines 3663-3726)
- Protect `<code>`, `<svg>`, `<style>`, `<img>`, `<pre>` blocks and raw HTML attributes.

**Phase 7: Math/LaTeX** (lines 3731-3761)
- `$$...$$` block math → protected.
- `$...$` inline math → `\(...\)` MathJax delimiters.
- `\(...\)`, `\begin{equation}`, `\begin{eqnarray}` → protected.

**Phase 8: Headers** (lines 3763-3802)
- Setext-style H1 (`=====` underline) and H2 (`-----` underline).
- ATX-style `#` through `######` headers.
- Unnumbered headers `(# ...)`.
- Each header generates an anchor target.

**Phase 9: Structural Elements** (lines 3804-3860)
- Horizontal rules (`* * *`, `- - -`, `_ _ _`).
- Page breaks (`+++++`).
- Admonitions (`!!!`).
- Footnotes/endnotes (`[^name]`).
- Citations (`[#name]`).
- Tables (via `replaceTables()`).

**Phase 10: Reference Links** (lines 3862-3877)
- Reference link definitions `[name]: url`.
- Email address auto-linking.

**Phase 11: Images and Media** (lines 3879-3955)
- Video (mp4, m4v, avi, mpg, mov, webm), audio (mp3, ogg, wav, etc.), YouTube, Vimeo embeds.
- Image grids, captioned images, simple images.
- Gravizo graph URL protection.

**Phase 12: Links** (lines 3982-4040)
- Inline links `[text](url)`.
- Empty hyperlinks `[](url)`.
- Reference links `[text][ref]`.
- Reference images `![...][ref]`.

**Phase 13: Inline Formatting** (lines 4199-4278)
- Strong (`**`, `__`), emphasis (`*`, `_`), strikethrough (`~~`).
- Stage directions `((text))`.
- Smart quotes, arrows (`→`, `←`, `⟷`, `⟹`, etc.).
- Em dash (`---`, `--`), dimension beautification (`NxN` → `N×N`).
- Minus signs, superscript exponents, page breaks.

**Phase 14: Lists and Definitions** (lines 4280-4292)
- Schedule lists (via `replaceScheduleLists()`).
- Definition lists (via `replaceDefinitionLists()`).
- Bullet/numbered lists (via `replaceLists()`).

**Phase 15: Paragraphs and Cross-References** (lines 4295-4486)
- Degree symbols, line breaks (`\` or trailing spaces).
- Paragraph wrapping (double newlines → `<p>`).
- Endnote definitions.
- Section cross-references (`Section [name]`).
- Figure/table/listing/diagram cross-references with auto-numbering.
- URL auto-linking.
- Table of contents insertion (via `insertTableOfContents()`).
- Title extraction and `<title>` tag generation.
- Section link resolution.
- Header section wrapping (via `wrapHeaderSections()`).

**Phase 16: Expose and API Links** (lines 4488-4553)
- Recursively expose all protected strings (up to 50 iterations).
- API definition linking: `<dt><code>name(` creates link targets; `<code>name()</code>` elsewhere links to them.
- Final wrap in `<span class="md"><p>...</p></span>`.

---

## Q5: File Formats and Diagram Types
**start:** 2026-03-10T14:04:39Z
**end:** 2026-03-10T14:05:08Z
**task_type:** enumeration
**segments_read:** [3879-3955, 4644-4693, 5764-5823]
**grep_queries:** ["mp4\\|mp3\\|video\\|audio\\|youtube\\|vimeo\\|gravizo", "findPaths\\|findDecorations\\|findReplace\\|passthrough\\|toSVG"]
**coverage_estimate:** ~190 lines read / 8784 total = ~2%. Complete for this question — all media format detection is in `formatImage()` (lines 3879-3955) and diagram processing in `diagramToSVG()` (4644-5856).

### Media Formats Supported

| Format | Extensions/URLs | Parser/Handler | Line |
|--------|----------------|----------------|------|
| **Video** | `.mp4`, `.m4v`, `.avi`, `.mpg`, `.mov`, `.webm` | `formatImage()` → `<video>` tag | 3901 |
| **Audio** | `.mp3`, `.mp2`, `.ogg`, `.wav`, `.m4a`, `.aac`, `.flac` | `formatImage()` → `<audio>` tag | 3904 |
| **YouTube** | `youtube.com/...v=ID` or `youtu.be/ID` | `formatImage()` → `<iframe>` embed | 3907-3914 |
| **Vimeo** | `vimeo.com/.../ID` | `formatImage()` → `<iframe>` embed | 3915-3917 |
| **Images** | All other URLs (`.png`, `.jpg`, `.gif`, `.svg`, `.bmp`, etc.) | `formatImage()` → `<img>` tag | 3918-3934 |
| **Gravizo** | `g.gravizo.com` URLs | Protected and passed through as `<img>` | 3978 |

### Document Formats

| Format | Description | Handler |
|--------|-------------|---------|
| **Markdeep** | Full extended Markdown with all features | `markdeepToHTML()` (line 3059) |
| **LaTeX/MathJax** | `$...$`, `$$...$$`, `\(...\)`, `\begin{equation}` | Protected and passed to MathJax (lines 3731-3761) |
| **HTML** | Raw HTML tags pass through (with attribute protection) | Protected by `protectorWithPrefix` (line 3726) |

### Diagram Types

All ASCII diagrams are parsed by `diagramToSVG()` (line 4644). The diagram engine uses a character-grid approach with these recognized elements:

| Element | Characters | Description |
|---------|-----------|-------------|
| **Horizontal lines** | `-`, `+`, `(`, `)` | Solid horizontal paths |
| **Vertical lines** | `\|`, `+` | Solid vertical paths |
| **Diagonal lines** | `/` | Forward diagonal paths |
| **Back-diagonal lines** | `\\` | Backward diagonal paths |
| **Arrow heads** | `>`, `v`, `<`, `^` | Directional arrow tips (line 4671) |
| **Points/dots** | `o`, `*`, `◌`, `○`, `◍`, `●` | Open/closed/shaded dot decorations (line 4672) |
| **Jumps** | `(`, `)` | Line crossover jumps (line 4673) |
| **Vertices** | `+`, `.`, `'` | Line connection/corner points (lines 4674-4675) |
| **Gray fills** | `░`, `▒`, `▓`, `█` | Quarter/half/three-quarter/full gray blocks (line 4678) |
| **Triangles** | `◢`, `◣`, `◤`, `◥` | Right-triangle corners at 0/90/180/270° (line 4681) |
| **Dashed lines** | `:` (vertical), `=` (horizontal) | Dashed path variants |
| **Curved corners** | `.` (top), `'` (bottom) | Rounded corner vertices |
| **Hexagons** | `⬡`, `⬢` | Enlarged hexagon passthrough characters (line 5813) |
| **Text labels** | Any alphanumeric | Passthrough text rendered as SVG `<text>` elements |

The diagram processing pipeline (lines 5764-5823):
1. `makeGrid(str)` — Parse ASCII into 2D grid with neighbor-aware line detection methods
2. `findPaths(grid, pathSet)` — Trace all connected line segments (vertical, horizontal, diagonal, curved)
3. `findReplacementCharacters(grid, pathSet)` — Identify text passthrough characters
4. `findDecorations(grid, pathSet, decorationSet)` — Find arrows, dots, jumps, gray fills, triangles
5. `pathSet.toSVG()` + `decorationSet.toSVG()` — Generate SVG output
6. Remaining unmatched characters rendered as passthrough text

---

## Q6: Regex Patterns for Markdown Parsing
**start:** 2026-03-10T14:05:12Z
**end:** 2026-03-10T14:05:22Z
**task_type:** enumeration
**segments_read:** [4199-4278]
**grep_queries:** ["str = str\\.rp("]
**coverage_estimate:** ~80 grep matches across lines 3421-4472, covering the bulk of markdeepToHTML. Most regexes were visible from the grep output itself (single-line patterns). ~400 lines read in detail / 8784 = ~5%. For an enumeration question this is a moderate gap; however, most regex replacements in markdeepToHTML are on single lines and were captured by grep. Subsidiary functions (replaceTables, replaceLists, etc.) contain additional regexes not fully cataloged here — estimated ~30-40 additional patterns in those ~1200 lines.

### Core Markdown Parsing Regexes in `markdeepToHTML()`

| Line | Regex | Matches |
|------|-------|---------|
| 3421 | `/<script\s+type\s*=\s*['"]preformatted['"]\s*>([\s\S]*?)<\/script>/gi` | Preformatted script wrappers |
| 3515 | `/\n([ \t]*)(`{3,}\|~{3,})([ \t]*[^~`\s]\S*...)\n([\s\S]+?)\n\1\2[ \t]*\n/g` | Labeled code fences |
| 3523 | `/\n([ \t]*)(`{3,}\|~{3,})[ \t]*\n([\s\S]+?)\n\1\2[ \t]*\n/g` | Unlabeled code fences |
| 3538 | Diagram fence pattern | Code fences labeled `diagram` |
| 3631 | `/(?:\n>.*){2,}/g` | Blockquote blocks (2+ `>` lines) |
| 3645 | `/\n[ \t]*"(.*(?:\n.*)*)"[ \t]*(?:\n[ \t]*)?\n([ \t]{2,}\S.*)?\n/g` | Fancy quotes with author |
| 3659 | `/<code\s+lang\s*=\s*["']?([^"'\)\[\]\n]+)["'?]\s*>(.*)<\/code>/gi` | Explicit lang code blocks |
| 3664 | `/(<code\b.*?<\/code>)/gi` | All code blocks (for protection) |
| 3668 | `/<!--((?!->\|>)[\s\S]*?)-->/g` | HTML comments |
| 3673 | `/<svg( .*?)?>([\s\S]*?)<\/svg>/gi` | SVG blocks |
| 3678 | `/<style>([\s\S]*?)<\/style>/gi` | Style blocks |
| 3685 | `/<img\s+src=(["'])[\s\S]*?\1\s*>/gi` | Image tags (with newlines) |
| 3696 | `/(^\|[^\\])`(.*?(?:\n.*?)?[^\n\\`])`(?!\d)/g` | Inline code (backtick) |
| 3718 | `/(<code(?: .*?)?>)([\s\S]*?)<\/code>/gi` | Code block content (for escaping) |
| 3723 | `/(<pre\b[\s\S]*?<\/pre>)/gi` | Pre blocks |
| 3726 | `/(<\w[^ \n<>]*?[ \t]+)(.*?)(?=\/?>)/g` | HTML tag attributes |
| 3733 | `/(\$\$[\s\S]+?\$\$)/g` | Block math (`$$...$$`) |
| 3745 | `/((?:[^\w\d]))\$(\S(?:[^\$]*?\S(?!US\|Can))??)\$(?![\w\d])/g` | Inline math (`$...$`) |
| 3755 | `/((?:[^\w\d]))\$([ \t][^\$]+?[ \t])\$(?![\w\d])/g` | Spaced inline math |
| 3758 | `/(\\\([\s\S]+?\\\))/g` | MathJax `\(...\)` |
| 3759 | `/(\\begin\{equation\}[\s\S]*?\\end\{equation\})/g` | LaTeX equation environment |
| 3760 | `/(\\begin\{eqnarray\}[\s\S]*?\\end\{eqnarray\})/g` | LaTeX eqnarray environment |
| 3761 | `/(\\begin\{equation\*\}[\s\S]*?\\end\{equation\*\})/g` | LaTeX equation* environment |
| 3769 | `/(?:^\|\s*\n)(.+?)\n[ \t]*={3,}[ \t]*\n/g` | Setext H1 (`====` underline) |
| 3772 | `/(?:^\|\s*\n)(.+?)\n[ \t]*-{3,}[ \t]*\n/g` | Setext H2 (`----` underline) |
| 3789 | `/^\s*#{N,N}(?:[ \t])([^\n]+?)#*[ \t]*\n/gm` (for N=1-6) | ATX headers (`#` through `######`) |
| 3796 | `/^\s*\(#{N,N}\)(?:[ \t])([^\n]+?)\(?#*\)?\n/gm` | Unnumbered ATX headers `(# ...)` |
| 3805 | `/\n[ \t]*((\*\|-\|_)[ \t]*){3,}[ \t]*\n/g` | Horizontal rules (`---`, `***`, `___`) |
| 3808 | `/\n[ \t]*\+{5,}[ \t]*\n/g` | Page breaks (`+++++`) |
| 3811 | `/^!!![ \t]*([^\s"'><&\:]*)\:?(.*)\n([ \t]{3,}.*\s*\n)*/gm` | Admonitions (`!!!`) |
| 3830 | `/[ \t]*\[\^([^\]\n\t ]+)\](?!:)/g` | Footnote references (`[^name]`) |
| 3836 | `/\n\[#(\S+)\]:[ \t]+((?:[ \t]*\S[^\n]*\n?)*)/g` | Citation definitions (`[#name]:`) |
| 3844 | `/\[(#[^\)\(\[\]\.#\s]+(?:\s*,\s*#(?:...))*)\]/g` | Citation references (`[#name]`) |
| 3864 | `/^\[([^\^#].*?)\]:(.*?)$/gm` | Reference link definitions (`[name]: url`) |
| 3870 | `/(?:<\|(?!<)\b)(\S+@(\S+\.)+?\S{2,}?)(?:$\|>\|(?=<)\|(?=\s)(?!>))/g` | Email addresses |
| 3959 | `/\b(equation\|eqn\.\|eq\.)\s*\[([^\s\]]+)\]/gi` | Equation cross-references |
| 3966 | `/\b(figure\|fig\.\|table\|...\|lst\.)\s*\[([^\s\]]+)\](?=\()/gi` | Figure/table cross-refs with parens |
| 3985 | `/(^\|[^!])\[((?:[^\[\]\\]\|\\[\[\]])+?)\]\(("?)([^<>\s"\)]+)\3(\s+[^\)]{0,200})?\)/g` | Inline links `[text](url)` |
| 3993 | `/(^\|[^!])\[[ \t]*?\]\(("?)([^<>\s"\)]+)\2\)/g` | Empty hyperlinks `[](url)` |
| 3999 | `/(^\|[^!])\[((?:[^\[\]\\]\|\\[\[\]])+)\]\[([^\[\]]*)\]/g` | Reference links `[text][ref]` |
| 4029 | `/(!\[.*?\])\[([^<>\[\]\s]+?)([ \t][^\n\[\]]{0,200})?\]/g` | Reference images `![...][ref]` |
| 4126 | `/(\s*)!\[\]\(("?)([^"<>\s\)]+)\2(\s[^\)]{0,200})?\)(\s*)/g` | Simple images `![](url)` |
| 4148 | `/(\s*)!\[((?:[^\[\]\\]\|\\[\[\]])+?)\]\(("?)([^"<>\s\)]+)\3(\s[^\)]{0,200})?\)(\s*)/` | Captioned images `![caption](url)` |
| 4201 | `/\*\*/g` (via `replaceMatched`) | Bold `**text**` |
| 4202 | `/__/g` (via `replaceMatched`) | Bold `__text__` |
| 4205 | `/\*/g` (via `replaceMatched`) | Italic `*text*` |
| 4206 | `/_/g` (via `replaceMatched`) | Italic `_text_` |
| 4209 | `/\~\~([^~].*?)\~\~/g` | Strikethrough `~~text~~` |
| 4227 | `/(^\|[ \t->])(")(?=\w)/gm` | Opening smart quote |
| 4228 | `/([A-Za-z\.,:;\?!=<])(")(?=$\|\W)/gm` | Closing smart quote |
| 4232-4240 | Arrow patterns (`<==`, `->`, `-->`, `==>`, `<-`, `<--`, `<==>`, `<->`) | Unicode arrow replacements |
| 4244 | `/([^-!\:\|])---([^->\:\|])/g` | Em dash (triple hyphen) |
| 4248 | `/([^-!\:\|])--([^->\:\|])/g` | Em dash (double hyphen) |
| 4254 | Dimension pattern `NxN` | Multiplication sign `×` |
| 4271-4272 | `/([\\s\\(\\[<\\|])-(\d)/g`, `/(\d) - (\d)/g` | Minus sign `−` |
| 4275 | `/\^([-+]?\d+)\b/g` | Superscript exponents |
| 4278 | `/(^\|\s\|\b)\\(pagebreak\|newpage)(\b\|\s\|$)/gi` | Page break commands |
| 4295 | `/(\d+?)[ \t-]?\n?degree(?:s?)/g` | Degree symbol `°` |
| 4317 | `/(?:<p>)?\n\s*\n+(?!<\/p>)/gi` | Paragraph breaks |
| 4381 | URL auto-linking pattern | Bare URLs (`http://...`) |

**Coverage note:** The subsidiary functions `replaceTables()` (~90 lines), `replaceLists()` (~200 lines), `replaceScheduleLists()` (~300 lines), `replaceDefinitionLists()` (~75 lines), and `insertTableOfContents()` (~225 lines) contain additional regex patterns not individually cataloged above. Estimated ~30-40 additional patterns in those functions.

---

## Q7: Error Handling Patterns
**start:** 2026-03-10T14:05:26Z
**end:** 2026-03-10T14:05:48Z
**task_type:** enumeration
**segments_read:** [94-103, 2510-2519, 2960-2972, 6880-6899]
**grep_queries:** ["catch\\|throw\\|error\\|Error\\|warning\\|console\\.warn\\|console\\.error\\|try\\b\\|fallback\\|typeof\\|undefined", "catch\\|try {", "console\\.warn\\|console\\.error"]
**coverage_estimate:** ~60 lines read (targeted around 6 try/catch blocks + console warnings) / 8784 = <1%. However, the grep queries captured ALL error-handling sites outside highlight.js — complete coverage.

### Error Handling Patterns

Markdeep takes a **graceful degradation** approach — it prioritizes rendering something reasonable over throwing errors.

#### 1. Try/Catch with Silent Fallback (6 instances outside highlight.js)

| Location | Lines | Pattern | Recovery |
|----------|-------|---------|----------|
| `measureFontSize()` | 94-102 | Canvas font measurement fails (Firefox includes) | Returns default `10` pixels |
| `replaceScheduleLists()` | 2280-2516 | Date parsing fails (`throw "Could not parse date"` at line 2331) | Entire schedule regex silently caught; returns unmodified string |
| Code fence highlighting | 3594-3598 | `hljs.highlight()` throws for unknown language | Falls back to `hljs.highlightAuto(sourceCode, [])` (no highlighting) |
| Context menu handler | 6554-6648 | Any error in context menu construction | Hides menu, silently continues |
| Link preview iframe scroll | 6884-6894 | Cross-origin iframe access | Silently ignores (cannot scroll to anchor) |

#### 2. Console Warnings/Errors (non-highlight.js)

| Location | Line | Trigger | Message |
|----------|------|---------|---------|
| `option()` | 1486 | Unknown option key passed | `'Illegal option: "' + key + '"'` |
| `wrapHeaderSections()` | 2965 | Processing exceeds 5000ms timeout | `'[wrapHeaderSections] Timeout after N ms, aborting'` |
| `wrapHeaderSections()` | 2969 | More than 10,000 header matches | `'[wrapHeaderSections] Too many matches, aborting'` |
| Source line tracking | 3405 | Document ends inside unclosed block (fence, script, etc.) | `'[MDVIEW] WARNING: Document ended in mode "X"'` |
| `Vec2` constructor | 4719 | Invalid arguments | `'Vec2 requires one Vec2 or (x, y) as an argument'` |
| `makeGrid` / `setUsed` | 4737, 4760, 4771 | Invalid grid coordinates | `'grid requires either a Vec2 or (x, y)'` |
| `Path` constructor | 4913 | Fewer than 2 Vec2 arguments | `'Path constructor requires at least two Vec2s'` |
| `DecorationSet` | 5128 | Unrecognized decoration character | `'Illegal decoration character: ' + type` |

#### 3. Polyfill Guards

| Location | Lines | Pattern |
|----------|-------|---------|
| `String.endsWith` | 49-57 | Check `if (!_.endsWith)` before polyfilling (IE11) |
| `Object.assign` | 106-130 | Check `typeof Object.assign !== 'function'` before polyfilling |
| `String.includes` | 135-143 | Check before polyfilling |
| `Array.includes` | 145-152 | Check before polyfilling |
| `Math.sign` | 1460-1462 | Inline fallback `Math.sign \|\| function(x){...}` |
| `Array.from` | 4558-4573 | Fallback to manual string-to-array conversion |

#### 4. Defensive Input Handling

- **Null/undefined guards**: `option()` checks `window.markdeepOptions` existence, key existence, and nested key existence before accessing (lines 1467-1487).
- **Type checking**: `headerAnchor()` checks `Array.isArray(headerArray)` (line 7134); `definitionAnchor()` checks `typeof term !== 'string'` (line 7157); `generateMarkdownTable()` throws on null/undefined cell values (line 7204).
- **Recursion protection**: The expose loop has a `maxIterations = 50` guard (lines 4490-4497) to prevent infinite recursion in protected string restoration.
- **Double-processing guard**: `window.alreadyProcessedMarkdeep` flag (lines 6109-6110, 6483) prevents the script from running twice.
- **Fallback display**: The Markdeep boilerplate line (line 618) includes a `<style class="fallback">` that shows the raw text in monospace if the script fails to load.

#### 5. Timeout/Safety Limits

- `wrapHeaderSections()` has a 5-second timeout (line 2868) and a 10,000-match limit (line 2968) to prevent catastrophic backtracking or runaway processing on malformed documents.

---

## Q8: Performance Optimizations
**start:** 2026-03-10T14:05:51Z
**end:** 2026-03-10T14:06:12Z
**task_type:** enumeration
**segments_read:** [44-63, 7414-7423, 2868-2972]
**grep_queries:** ["cache\\|Cache\\|lazy\\|early\\|return str\\|return match\\|setTimeout\\|alreadyProcessed\\|TIMEOUT\\|performance\\|optimi", "DANGEROUS_CODE_RE\\|\\.test(\\|HIDE_O\\|hiddenFence\\|alreadyProcessed\\|Object\\.freeze\\|longDocument\\|PROTECT_DIGITS\\|PROTECT_RADIX", "grid\\.isUsed\\|setUsed\\|minification"]
**coverage_estimate:** ~100 lines read / 8784 total = ~1%. Grep output provided sufficient context to identify optimization patterns across the file. Some optimizations may exist in helper functions not fully explored.

### Performance Optimizations

#### 1. String Prototype Aliasing for Minification (lines 44-48)
```javascript
var _ = String.prototype;
_.rp = _.replace;
_.ss = _.substring;
```
Used thousands of times throughout the file. Reduces minified size and provides marginal call-site optimization. The comment admits this is "admittedly scary."

#### 2. Math Function Aliasing (lines 1457-1462)
```javascript
var max = Math.max;
var min = Math.min;
var abs = Math.abs;
var sign = Math.sign || ...;
```
Avoids repeated property lookups on the `Math` object in hot loops (especially in `diagramToSVG`).

#### 3. Protect/Expose System with Base-32 Encoding (lines 3069-3108)
The protection mechanism uses base-32 encoded indices (4 digits = 1M+ possible slots) stored in the Unicode private use area (`\ue010`). This is more compact than UUID-style placeholders and allows efficient regex matching with a single fixed-width pattern (`PROTECT_REGEXP`).

#### 4. Early Exit in `makeMarkdownCodeBrowserSafe()` (lines 7415-7422)
```javascript
if (!text) { return text; }
if (!DANGEROUS_CODE_RE.test(text)) { return text; }
```
Skips expensive regex processing entirely when no dangerous `<` characters exist. Most documents won't have `<script>` tags inside code blocks.

#### 5. Timeout and Iteration Limits in `wrapHeaderSections()` (lines 2868-2971)
```javascript
var TIMEOUT_MS = 5000;
if (Date.now() - startTime > TIMEOUT_MS) { return str; }
if (matchCount > 10000) { return str; }
```
Prevents catastrophic backtracking or runaway processing on pathological documents by bailing out and returning the partially processed string.

#### 6. Grid `isUsed` Tracking in Diagram Processing (lines 4757-4771)
The diagram grid maintains a parallel boolean array tracking which characters have been "consumed" by path finding. This prevents the same character from being processed multiple times by different path-finding passes, reducing O(n²) scanning to closer to O(n).

#### 7. `HIDE_O` Character Substitution (lines 4648-4655)
```javascript
var HIDE_O = '\ue004';
diagramString = diagramString.rp(/([a-zA-Z]{2})o/g, '$1' + HIDE_O);
```
Temporarily replaces `o` characters surrounded by text with a Unicode private-use character before diagram processing. This avoids expensive per-character neighborhood checks at every grid position, as the comment states: "faster than checking each neighborhood each time."

#### 8. Hidden Fence Array Pattern (lines 3512-3535)
In `cleanupCodeFences()`, labeled fences are hidden with placeholder tokens before processing unlabeled fences, then restored. This prevents O(n²) interference between fence patterns and avoids catastrophic regex backtracking.

#### 9. Recursion Limit on Expose (lines 4490-4497)
```javascript
var maxIterations = 50;
while (str.indexOf(PROTECT_CHARACTER) + 1 && exposeRan && maxIterations > 0) {
```
The expose loop checks if any protect characters remain AND if the previous pass actually made substitutions before continuing. This short-circuits when all protections have been resolved.

#### 10. `Object.freeze()` on Public API (line 7444)
Freezing `window.markdeep` prevents accidental modification and allows the JS engine to optimize property access on the frozen object.

#### 11. Double-Processing Prevention (lines 6109-6110)
```javascript
if (! window.alreadyProcessedMarkdeep) {
    window.alreadyProcessedMarkdeep = true;
```
The flag is checked at both entry (line 6109) and after HTML/doxygen mode processing (line 6483), preventing the expensive rendering pipeline from running twice when the script is included multiple times.

#### 12. Conditional MathJax Loading (lines 6675-6678, 6714)
MathJax (a large external library) is only loaded when the rendered HTML actually contains math constructs, checked via `needsMathJax(markdeepHTML)`. This avoids loading ~500KB of JavaScript for documents without math.

#### 13. Font Measurement Caching (lines 93-103)
`measureFontSize()` is called once at load time for the code font stack. The result is stored in `codeFontSize` (line 155) and reused throughout the stylesheet generation.
