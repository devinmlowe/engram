---
test_type: treatment_v4
approach: RLM with engram MCP tools + scan_file (Phase 7D)
start_time: 2026-03-10T15:00:29Z
download_complete: 2026-03-10T15:00:32Z
index_complete: 2026-03-10T15:00:51Z
end_time: 2026-03-10T15:06:53Z
---

## File Structure Index
**entities_created:** Previously indexed (file entity existed; UNIQUE constraint on re-index)
**relationships_created:** N/A (prior index)
**file_stats:** 8,784 lines, 469,086 bytes

The index revealed markdeep-v4.js is a single-file IIFE containing:
- Markdeep v1.19 (lines 1-7462) — the full markdown-to-HTML rendering engine
- highlight.js v11.11.1 (lines 7470-8775) — bundled syntax highlighting library
- 43+ top-level functions, 7+ inner function expressions
- Exported API via `window.markdeep = Object.freeze({...})` at line 7444

## Q1: Purpose, Subsystems, and Control Flow
**start:** 2026-03-10T15:00:59Z
**end:** 2026-03-10T15:01:30Z
**task_type:** architecture
**tools_used:** [scan_file for function declarations and key constants, fetch_snippets for file header/footer/exports, explore_selective for graph structure]
**segments_read:** [1-80, 3059-3120, 4640-4700, 6100-6170, 6400-6480, 7440-7476, 8750-8784]
**grep_queries:** []
**scan_file_patterns:** ["^function\\s+\\w+", "^var\\s+\\w+\\s*=\\s*function", "window\\.markdeep", "module\\.exports", "BODY_STYLESHEET", "DEFAULT_OPTIONS", "DIAGRAM_MARKER"]
**scan_file_matches:** 97 total (66 functions/exports + 31 constants)
**coverage_estimate:** ~450/8784 lines read directly (~5%), full file scanned by scan_file

### Purpose
Markdeep.js (v1.19) is a self-contained JavaScript library that transforms plain-text documents written in an extended Markdown dialect into beautifully formatted HTML, rendered directly in the browser. It requires no build step, server, or external dependencies — a document simply includes the script tag and the raw `.md.html` file renders itself.

### Major Subsystems

1. **Polyfills & Setup** (lines 39-155): IE11 polyfills (`Object.assign`, `String.includes`, `Array.includes`, `endsWith`), String prototype extensions (`.rp` = `.replace`, `.ss` = `.substring`, `.regexIndexOf`), font measurement, debug flags.

2. **Stylesheets** (lines 157-1383): `BODY_STYLESHEET` (line 157), `STYLESHEET` (line 170) — comprehensive CSS for `.md` class elements, diagrams, tables, code, admonitions, schedule lists, TOC, etc.

3. **Internationalization** (lines 1200-1453): Language tables for Russian, French, Polish, Bulgarian, German, Hungarian, Swedish, Portuguese, Japanese, Italian, Lithuanian, Czech, Spanish, Catalan with localized keywords for figure/table/listing/etc.

4. **Configuration** (lines 1384-1462): `DEFAULT_OPTIONS` object with 20+ configurable options including `mode`, `detectMath`, `tocStyle`, `tocDepth`, `smartQuotes`, `captionAbove`, `h1TitleInput/Output`, etc.

5. **Utility Functions** (lines 1466-1680): `option()`, `inputLevel()`, `outputLevel()`, `keyword()`, `escapeHTMLEntities()`, `unescapeHTMLEntities()`, `removeHTMLTags()`, `mangle()`, `mangleCode()`, stylesheet generators.

6. **Markdown Rendering Engine** (`markdeepToHTML`, lines 3059-4554): The core pipeline — protect/expose system, section headers, code fences, blockquotes, diagrams, tables, lists, schedule lists, definition lists, links, images, inline formatting, math, footnotes, TOC, section wrapping.

7. **ASCII Art Diagram Engine** (`diagramToSVG`, lines 4644-5843): Converts ASCII art to SVG. Contains Vec2 class, Grid class, Path/PathSet, DecorationSet (arrows, dots, triangles, gray blocks). Handles lines (solid/dashed, horizontal/vertical/diagonal), curves, jumps, text pass-through.

8. **Include/Insert System** (`processInsertCommands`, lines 5858-6075): Cross-document inclusion via iframe message-passing, supporting nested includes with cycle detection.

9. **Document Formatting & Bootstrap** (`formatDocument`, lines 6410-7460): Detects operating mode (markdeep/html/doxygen/script), manages MathJax loading, builds final HTML document with stylesheets, handles context menus, source view, link previews, scroll-to-anchor.

10. **Highlight.js** (lines 7470-8775): Bundled syntax highlighter (v11.11.1) with language grammars for ~30 languages.

### Control Flow
1. IIFE executes immediately on script load
2. Polyfills install, stylesheets constructed, options loaded
3. `formatDocument(option('mode'))` is called (line 7459)
4. Based on mode: 'markdeep' processes entire `document.body`; 'html'/'doxygen' processes `<markdeep>` tags; 'script' does nothing
5. `processInsertCommands()` handles any `(insert ...)` directives
6. `markdeepToHTML()` transforms text through ~60 regex passes
7. `diagramToSVG()` converts any `*****`-bounded ASCII art to SVG
8. MathJax loaded if math detected; stylesheets injected; DOM updated

## Q2: Code Organization
**start:** 2026-03-10T15:01:30Z
**end:** 2026-03-10T15:01:40Z
**task_type:** architecture
**tools_used:** [scan_file for structural markers, fetch_snippets for key boundaries]
**segments_read:** [1384-1465, 7440-7476]
**grep_queries:** []
**scan_file_patterns:** ["// SECTION", "// Process"]
**scan_file_matches:** 22
**coverage_estimate:** ~200/8784 (~2.3%)

### Organization

The code is organized as a **single IIFE** (Immediately Invoked Function Expression) wrapping everything from line 39 to line 7462, followed by the bundled highlight.js (lines 7470-8775). There are no ES modules, classes, or explicit namespaces.

**Logical sections (sequential):**

| Section | Lines | Description |
|---------|-------|-------------|
| BOM + License | 1-38 | UTF-8 BOM, copyright, license |
| Polyfills & String extensions | 39-155 | IE11 compat, `.rp`, `.ss`, `.regexIndexOf` |
| Constants & Debug flags | 66-85 | `DEBUG_SHOW_GRID`, `STROKE_WIDTH`, `DIAGRAM_MARKER` |
| Font measurement | 93-103 | `measureFontSize()` |
| Stylesheets | 157-1383 | `BODY_STYLESHEET`, `STYLESHEET` (inline CSS strings) |
| Language tables (i18n) | 1200-1383 | `RUSSIAN`, `FRENCH`, `POLISH`, etc. + `LANG_TABLE` |
| Configuration | 1384-1462 | `DEFAULT_OPTIONS`, `LANG_TABLE`, meta-tag detection |
| Utility functions | 1466-1684 | `option()`, `escapeHTMLEntities()`, `mangle()`, etc. |
| Diagram extraction | 1766-1893 | `extractDiagram()` |
| Inline formatting | 1894-1945 | `replaceMatched()`, `createTarget()` |
| Table processing | 1946-2036 | `replaceTables()` |
| List processing | 2037-2240 | `replaceLists()` |
| Schedule lists | 2241-2540 | `replaceScheduleLists()` |
| Definition lists | 2541-2614 | `replaceDefinitionLists()` |
| Table of contents | 2615-2840 | `insertTableOfContents()` |
| Section wrapping | 2864-3058 | `wrapHeaderSections()` |
| **Core pipeline** | 3059-4554 | `markdeepToHTML()` — the main rendering function |
| Diagram-to-SVG engine | 4558-5843 | Helper functions, `diagramToSVG()` |
| Insert/Include system | 5858-6075 | `processInsertCommands()` |
| Highlight.js stylesheet | 6077-6102 | `HIGHLIGHT_STYLESHEET` |
| Document bootstrap | 6104-7460 | `formatDocument()`, MathJax, context menus, exports |
| highlight.js | 7470-8775 | Bundled highlight.js v11.11.1 |

**Namespace approach:** All functions are module-private within the IIFE closure. Only `window.markdeep` (line 7444) and `window.alreadyProcessedMarkdeep` (line 6110) are exposed globally. Minification aliases (`_.rp`, `_.ss`) are set on `String.prototype`.

## Q3: Public/Exported API Functions
**start:** 2026-03-10T15:01:40Z
**end:** 2026-03-10T15:01:50Z
**task_type:** detail
**tools_used:** [fetch_snippets for export block]
**segments_read:** [7440-7460]
**grep_queries:** []
**scan_file_patterns:** ["window\\.markdeep"]
**scan_file_matches:** 14
**coverage_estimate:** ~20/8784

The public API is exported at line 7444 via `window.markdeep = Object.freeze({...})`:

| Function | Signature | Description |
|----------|-----------|-------------|
| `format` | `markdeepToHTML(str, elementMode)` | Converts a Markdeep source string to HTML |
| `formatDiagram` | `diagramToSVG(diagramString, alignmentHint)` | Converts ASCII diagram string to SVG HTML |
| `formatDocument` | `formatDocument(mode)` | Processes the entire document in a given mode ('markdeep', 'html', 'doxygen', 'script') |
| `headerAnchor` | `headerAnchor(...)` | Generates anchor tags for headers (used by TOC) |
| `definitionAnchor` | `definitionAnchor(...)` | Generates anchor tags for definition list terms |
| `generateMarkdownTable` | `generateMarkdownTable(rows)` | Generates a markdown table string from a 2D array (line ~7190) |
| `makeMarkdownCodeBrowserSafe` | `makeMarkdownCodeBrowserSafe(text)` | Escapes code in `<script type="preformatted">` tags to be browser-safe (line ~7400) |
| `langTable` | `LANG_TABLE` (object) | Language table mapping locale codes to keyword translations |
| `stylesheet` | `function()` | Returns combined CSS: `STYLESHEET + sectionNumberingStylesheet() + h1TitleOutputStylesheet() + HIGHLIGHT_STYLESHEET` |

Additionally:
- `window.markdeepOptions` — user-configurable options object (read by `option()`)
- `window.markdeepShowSourceView` — exposed at line 6304 for context menu integration
- `window.alreadyProcessedMarkdeep` — recursion guard (line 6109)

## Q4: Rendering Pipeline
**start:** 2026-03-10T15:01:50Z
**end:** 2026-03-10T15:02:00Z
**task_type:** architecture
**tools_used:** [scan_file for str= assignments in pipeline, fetch_snippets for pipeline sections]
**segments_read:** [3059-3120, 3420-3460, 3500-3700, 3620-3700]
**grep_queries:** []
**scan_file_patterns:** ["^\\s{4}str\\s*=\\s*str\\.rp", "^\\s{4}str\\s*=\\s*replace"]
**scan_file_matches:** 69 transformation steps
**coverage_estimate:** ~500/8784 (~5.7%)

When `markdeepToHTML(str, elementMode)` is called (line 3059), the source text passes through this pipeline:

### Phase 0: Setup (lines 3059-3120)
- Initialize endnote table, reference link table, protect/expose system
- `protect(s)` encodes strings using Unicode private-use character `\ue010` + base-32 index
- `expose(i)` reverses protection

### Phase 1: Source Line Attribution (lines 3200-3410)
- Inject line markers `⟨L:N⟩` into source text for each line
- Skip lines inside `<script>`, `<style>`, `<pre>`, code fences, diagram blocks
- Track mode state machine: normal → script/style/pre/fence/diagram

### Phase 2: Pre-processing & Protection (lines 3421-3761)
1. Unescape `<script type="preformatted">` tags (line 3421)
2. **Code fence cleanup** — `cleanupCodeFences()` labels unlabeled fences, auto-detects diagrams via `looksLikeDiagram()`, converts diagram fences to `*****` format (line 3621)
3. **Process labeled code fences** — `processLabeledCodeFences()` with syntax highlighting via hljs (line 3622)
4. **Blockquotes** — iterative processing of `>` prefixed lines with nested fence support (lines 3626-3656)
5. Highlight explicit inline code with lang attribute (line 3659)
6. Protect `<code>`, remove HTML comments (line 3668)
7. **Diagrams** — `replaceDiagrams(str)` recursively extracts and converts `*****`-bounded ASCII art to SVG via `diagramToSVG()` (line 3670)
8. Protect SVG, STYLE, IMG blocks (lines 3673-3688)
9. Protect inline code (backtick pairs) (lines 3690-3723)
10. Protect `<pre>` blocks, HTML attributes (lines 3723-3726)
11. Protect MathJax: `$$...$$`, `$...$` → `\(...\)`, `\begin{equation}`, `\begin{eqnarray}` (lines 3731-3761)

### Phase 3: Structural Elements (lines 3769-3870)
12. **Setext headers** — `=====` (H1), `-----` (H2) (lines 3769-3772)
13. **ATX headers** — `#` through `######` with numbered/unnumbered variants (lines 3785-3800)
14. **Horizontal rules** — `* * *`, `- - -`, `_ _ _` (line 3805)
15. **Page breaks** — `+++++` (line 3808)
16. **Admonitions** — `!!! class: title` (line 3811)
17. **Endnotes** — `[^name]` references and `[^name]: text` definitions (lines 3830-3858)
18. **Tables** — `replaceTables()` with Maruku/GitHub style (line 3860)
19. **Reference links** — `[name]: url` definitions (line 3864)

### Phase 4: Inline Elements (lines 3870-4295)
20. **Email addresses** (line 3870)
21. **Equation references** (line 3959)
22. **Gravizo graph URLs** — encode special chars (line 3978)
23. **Hyperlinks** — `[text](url)`, empty links, reference links (lines 3985-4010)
24. **Images** — `![caption](url)`, reference images, YouTube/Vimeo embeds, audio (lines 4021-4175)
25. **Bold** — `**text**`, `__text__` (lines 4201-4202)
26. **Italic** — `*text*`, `_text_` (lines 4205-4206)
27. **Strikethrough** — `~~text~~` (line 4209)
28. **Arrows** — `-->`, `<--`, `==>`, `<=>`, etc. to Unicode (lines 4232-4240)
29. **Dashes** — `---` → em-dash, `--` → en-dash (lines 4244-4248)
30. **Dimensions** — `NxM` → `N&times;M` (line 4254)
31. **Minus signs** — `-4` → `&minus;4` (line 4271)
32. **Exponents** — `^n` → superscript (line 4275)
33. **Schedule lists** — `replaceScheduleLists()` with calendar generation (line 4281)
34. **Definition lists** — `replaceDefinitionLists()` (line 4289)
35. **Lists** — `replaceLists()` with task lists, nested lists (line 4292)

### Phase 5: Post-processing (lines 4295-4554)
36. **Line breaks** — backslash and double-space line breaks (lines 4303-4312)
37. **Paragraphs** — double newlines → `<p>` (line 4317)
38. **Footnote definitions** (line 4325)
39. **Cross-references** — figure/table/listing/diagram `[ref]` (line 4358)
40. **Bare URLs** — auto-link (line 4381)
41. **Title detection** — bold first line or `# H1` (lines 4392-4460)
42. **Table of contents** — `insertTableOfContents()` (line 4468)
43. **Section wrapping** — `wrapHeaderSections()` (line 4485)
44. **Expose protected strings** — iterative unprotection, max 50 iterations (lines 4490-4497)
45. **API definition links** — auto-link `<code>name()</code>` to `<dt><code>name(` definitions (lines 4511-4550)
46. Return wrapped in `<span class="md"><p>...</p></span>`

### Phase 6: Document Assembly (in formatDocument)
47. Inject stylesheets (`BODY_STYLESHEET + STYLESHEET + ...`)
48. Load MathJax if needed
49. Handle source view, context menus, link previews
50. Scroll to anchor if present

## Q5: Supported Formats and Diagram Types
**start:** 2026-03-10T15:02:00Z
**end:** 2026-03-10T15:02:08Z
**task_type:** enumeration
**tools_used:** [scan_file for format indicators, fetch_snippets for diagram engine and media handling]
**segments_read:** [3880-3920, 4644-4705]
**grep_queries:** []
**scan_file_patterns:** ["schedule", "gravizo", "\\bsvg\\b", "MathJax", "\\btex\\b"]
**scan_file_matches:** 114
**coverage_estimate:** ~200/8784 (~2.3%)

### Input Formats

| Format | Parser/Handler | Lines |
|--------|---------------|-------|
| **Markdeep** (extended Markdown) | `markdeepToHTML()` | 3059-4554 |
| **Standard Markdown** | Subset within `markdeepToHTML()` | Throughout |
| **LaTeX/TeX math** | Passed through to MathJax (`$...$`, `$$...$$`, `\(...\)`, `\begin{equation}`) | 3731-3761, 6118-6141 |
| **HTML** | Pass-through mode, processes `<markdeep>` and `<diagram>` tags | 6419-6482 |
| **Doxygen** | Special mode undoing Doxygen's entity conversions (`&ndash;`, `&mdash;`) | 6430-6438 |
| **Plain text includes** | `(insert filename.txt)` / `.html` / `.md.html` via iframe messaging | 5858-6075 |

### Diagram Types (all rendered via `diagramToSVG`, line 4644)

| Diagram Type | Syntax | Description |
|-------------|--------|-------------|
| **Box diagrams** | `+--+`, `|  |` with vertices `.`, `'`, `+` | Rectangular boxes with text |
| **Line art** | `-`, `|`, `/`, `\` characters | Horizontal, vertical, diagonal lines |
| **Arrow diagrams** | `>`, `v`, `<`, `^` arrow heads | Directed edges with arrow tips |
| **Curved lines** | Corner vertices with `.` (top) and `'` (bottom) | Bezier curves at corners |
| **Dashed lines** | `:` (vertical), `=` (horizontal) | Dashed/dotted line variants |
| **Jump connectors** | `(`, `)` on lines | Arc jumps where lines cross |
| **Point decorations** | `o`, `*`, `●`, `○`, `◌`, `◍` | Open/closed/shaded/dotted dots |
| **Gray fills** | `░`, `▒`, `▓`, `█` (Unicode blocks) | 4-level grayscale fills |
| **Triangle fills** | `◢`, `◣`, `◤`, `◥` (Unicode triangles) | 30-60-90 triangle decorations |
| **Text pass-through** | Regular text characters in diagram | Rendered as SVG text elements |
| **Hexagon characters** | Unicode block elements | Enlarged to fill grid cells |

### Code Block Formats (via highlight.js)
~30 languages including: JavaScript, Python, C/C++, Java, C#, Ruby, Go, Rust, TypeScript, Swift, Kotlin, GLSL, YAML, CSS, HTML, XML, JSON, SQL, Bash, Markdown, Diff, and more (registered at line 8772-8773).

### Media Embeds

| Type | Detection | Lines |
|------|-----------|-------|
| **Images** | URL ending in image extension | 3880-3906 |
| **Video (YouTube)** | `youtube.com/watch?v=` or `youtu.be/` | 3907-3914 |
| **Video (Vimeo)** | `vimeo.com/.../ID` | 3915-3917 |
| **Audio** | URL ending in `.mp3`, `.ogg`, `.wav` | 3905-3906 |
| **Gravizo graphs** | `g.gravizo.com` URLs | 3978-3980 |

## Q6: Regex Pattern Catalog
**start:** 2026-03-10T15:02:08Z
**end:** 2026-03-10T15:02:25Z
**task_type:** enumeration
**tools_used:** [scan_file extensively for regex patterns across entire file]
**segments_read:** [various lines via scan_file context]
**grep_queries:** []
**scan_file_patterns:** ["new RegExp\\(", "\\.replace\\(/", "\\.match\\(/", "\\.search\\(/", "^\\s{4}str\\s*=\\s*str\\.rp"]
**scan_file_matches:** 173 total (25 new RegExp + 25 .replace + 48 .match + 6 .search + 60 str.rp + 9 replaceFn)
**coverage_estimate:** Full file scanned server-side

### Category 1: Structural Markdown Patterns (Headers, Rules, Breaks)

| Pattern | Line | Matches |
|---------|------|---------|
| `/(?:^\|\s*\n)(.+?)\n[ \t]*={3,}[ \t]*\n/g` | 3769 | Setext H1 (text above `===`) |
| `/(?:^\|\s*\n)(.+?)\n[ \t]*-{3,}[ \t]*\n/g` | 3772 | Setext H2 (text above `---`) |
| `new RegExp('#{N,N}(?:[ \t])([^\n]+?)#*...')` | 3789 | ATX headers (`#` through `######`) |
| `/\n[ \t]*((\*\|-\|_)[ \t]*){3,}[ \t]*\n/g` | 3805 | Horizontal rules (`* * *`, `- - -`, `_ _ _`) |
| `/\n[ \t]*\+{5,}[ \t]*\n/g` | 3808 | Page breaks (`+++++`) |

### Category 2: Code & Fenced Blocks

| Pattern | Line | Matches |
|---------|------|---------|
| `/\n([ \t]*)(`{3,}\|~{3,})([ \t]*[^~`\s]\S*...)\n([\s\S]+?)\n\1\2/g` | 3515 | Labeled code fences |
| `/\n([ \t]*)(`{3,}\|~{3,})[ \t]*\n([\s\S]+?)\n\1\2[ \t]*\n/g` | 3523 | Unlabeled code fences |
| `/\n([ \t]*)(`{3,}\|~{3,})[ \t]*diagram[ \t]*\n([\s\S]+?)\n\1\2/g` | 3538 | Diagram code fences |
| `/(^\|[^\\])`(.*?(?:\n.*?)?[^\n\\`])`(?!\d)/g` | 3696 | Inline code (backticks) |
| `/(<pre\b[\s\S]*?<\/pre>)/gi` | 3723 | Pre blocks |
| `/(<code\b.*?<\/code>)/gi` | 3664 | Code blocks |

### Category 3: Inline Formatting

| Pattern | Line | Matches |
|---------|------|---------|
| `/\*\*/` (via `replaceMatched`) | 4201 | Bold (`**text**`) |
| `/__/` (via `replaceMatched`) | 4202 | Bold (`__text__`) |
| `/\*/` (via `replaceMatched`) | 4205 | Italic (`*text*`) |
| `/_/` (via `replaceMatched`) | 4206 | Italic (`_text_`) |
| `/\~\~([^~].*?)\~\~/g` | 4209 | Strikethrough (`~~text~~`) |
| `/\^([-+]?\d+)\b/g` | 4275 | Exponents (`^n`) |

### Category 4: Links & Images

| Pattern | Line | Matches |
|---------|------|---------|
| `/(^\|[^!])\[((?:[^\[\]\\]\|\\[\[\]])+?)\]\(("?)([^<>\s"\\)]+)\3(\s+[^\)]{0,200})?\)/g` | 3985 | Inline links `[text](url)` |
| `/(^\|[^!])\[[ \t]*?\]\(("?)([^<>\s"\\)]+)\2\)/g` | 3993 | Empty links `[](url)` |
| `/(^\|[^!])\[((?:[^\[\]\\]\|\\[\[\]])+)\]\[([^\[\]]*)\]/g` | 3999 | Reference links `[text][ref]` |
| `/!\[(.*?)\]\[(.*?)\]/g` | 4029 | Reference images `![cap][ref]` |
| `/(\s*)!\[\]\(("?)([^"<>\s\)]+)\2(\s[^\)]{0,200})?\)(\s*)/g` | 4126 | Inline images `![](url)` |
| YouTube: `/^https:\/\/(?:www\.)?(?:youtube\.com\/\S*?v=\|youtu\.be\/)([\w\d-]+).*?$/i` | 3907 | YouTube embed detection |
| Vimeo: `/^https:\/\/(?:www\.)?vimeo.com\/\S*?\/([\w\d-]+)$/i` | 3915 | Vimeo embed detection |

### Category 5: Math/LaTeX

| Pattern | Line | Matches |
|---------|------|---------|
| `/(\$\$[\s\S]+?\$\$)/g` | 3733 | Display math `$$...$$` |
| `/((?:[^\w\d]))\$(\S(?:[^\$]*?\S(?!US\|Can))??\$(?![\w\d])/g` | 3745 | Inline math `$...$` |
| `/(\\\\([\s\S]+?\\\\))/g` | 3758 | LaTeX inline `\(...\)` |
| `/(\\begin\{equation\}[\s\S]*?\\end\{equation\})/g` | 3759 | Equation environments |
| `/(\\begin\{eqnarray\}[\s\S]*?\\end\{eqnarray\})/g` | 3760 | Eqnarray environments |
| `/(?:\$\$[\s\S]+\$\$)\|(?:\\begin\{)/m` | 6139 | MathJax detection |

### Category 6: Tables

| Pattern | Line | Matches |
|---------|------|---------|
| `/(?:\n[ \t]*(?:(?:\|?[^\n\|]+?(?:\|[^\n\|]+?)+\|?)\|\|[^\n\|]+\|)(?=\n))/.source` | 1947 | Table row |
| Table separator: alignment detection with `:` | 1975-1980 | Column alignment (left/right/center) |
| `new RegExp(TABLE_ROW + TABLE_SEPARATOR + TABLE_ROW + '+(TABLE_CAPTION)?', 'g')` | 1950 | Complete table |

### Category 7: Lists

| Pattern | Line | Matches |
|---------|------|---------|
| `LIST_ITEM_START` = `/(?:\d+\.|-|\+|\*|\u2611|\u2610)(?:[ \t])` | 2040-2064 | List item bullets/numbers |
| `/^\s*(?:\d+\.|-|\+|\*|\u2611|\u2610)(?:[ \t]+.+\n...)+/gm` | 2109-2110 | Full list blocks |
| Task list markers: `\u2611` (checked), `\u2610` (unchecked) | 2038-2060 | Task list checkboxes |

### Category 8: Special Elements

| Pattern | Line | Matches |
|---------|------|---------|
| `/^!!![ \t]*([^\s"'><&\:]*)...$/gm` | 3811 | Admonitions |
| `/[ \t]*\[\^([^\]\n\t ]+)\](?!:)/g` | 3830 | Endnote references |
| `/\n\[\^(\S+)\]: ((?:.+?\n?)*)/g` | 4325 | Footnote definitions |
| `/\[#(\S+)\]:[ \t]+.../g` | 3836 | Bibliography entries |
| `/\[(#[^\)\(\[\]\.#\s]+(?:\s*,\s*#(?:[^\)\(\[\]\.#\s]+))*)\]/g` | 3844 | Bibliography citations |
| Schedule entry pattern (ENTRY_REGEXP) | 2257 | Schedule list entries |
| Definition list: `/^.+\n:(?=[ \t])/.source` | 2542 | Definition terms |

### Category 9: Typography & Symbols

| Pattern | Line | Matches |
|---------|------|---------|
| `/(\s\|^)<==/g`, `/(\s\|^)->/g`, etc. | 4232-4240 | Arrow symbols |
| `/([^-!\:\|])---([^->\:\|])/g` | 4244 | Em-dash |
| `/([^-!\:\|])--([^->\:\|])/g` | 4248 | En-dash |
| `/(\d+?)[ \t-]?\n?degree/g` | 4295 | Degree symbol |
| `/([\s\(\[\<\|])-(\d)/g` | 4271 | Minus sign |
| Dimension pattern: `/(number|key...)(\d+)(x)(\d+)/gi` | 4254 | Multiplication sign |

### Category 10: Protection System

| Pattern | Line | Matches |
|---------|------|---------|
| `PROTECT_REGEXP = /\ue010[0-9a-w]{4,4}\ue010/g` | 3082 | Protected string markers |
| `/<svg( .*?)?>([\s\S]*?)<\/svg>/gi` | 3673 | SVG protection |
| `/<style>([\s\S]*?)<\/style>/gi` | 3678 | Style protection |
| `/(<\w[^ \n<>]*?[ \t]+)(.*?)(?=\/?>)/g` | 3726 | HTML attribute protection |
| `/<!--((?!->\|>)[\s\S]*?)-->/g` | 3668 | HTML comment removal |

### Category 11: Diagram Detection (in `looksLikeDiagram`)

| Pattern | Line | Matches |
|---------|------|---------|
| `/<[a-zA-Z][^>]*>/` | 3456 | HTML tag detection (not a diagram) |
| `/--\+\|\+--\|--\.\|\.--\|'--\|--'\|<--\|-->\|\|.*\|\|^\s*[|+.'v^*]\s*$/` | 3488 | Diagram character patterns |

**Total unique regex patterns in Markdeep core (excluding hljs):** ~90+ distinct patterns across 60+ transformation steps and 25 `new RegExp()` constructions.

## Q7: Error Handling Patterns
**start:** 2026-03-10T15:02:25Z
**end:** 2026-03-10T15:02:33Z
**task_type:** enumeration
**tools_used:** [scan_file for try/catch/throw/console.error/console.warn]
**segments_read:** [scan_file context lines]
**grep_queries:** []
**scan_file_patterns:** ["try\\s*\\{", "catch\\s*\\(", "throw\\s", "console\\.error", "console\\.warn", "Error\\("]
**scan_file_matches:** 77 total (7 try, 7 catch, 31 throw, 9 console.error, 6 console.warn, 17 Error)
**coverage_estimate:** Full file scanned server-side

### Error Handling Patterns in Markdeep Core

1. **Silent fallback with try/catch** (most common):
   - `measureFontSize()` (line 94): `try { canvas.getContext('2d')... } catch(e) { return 10; }` — Falls back to default font size if canvas unavailable (Firefox includes)
   - `replaceScheduleLists()` (line 2280): Wraps entire schedule parsing in try/catch. On failure (unparseable date), silently returns original string with comment "Maybe this wasn't a schedule after all" (line 2514)
   - Code highlighting (line 3594): `try { hljs.highlight(...) } catch(e) { hljs.highlightAuto(...) }` — Falls back to auto-detection if specified language fails

2. **Timeout safety guards**:
   - `wrapHeaderSections()` (line 2864): Has `TIMEOUT_MS = 5000` safety timeout and `matchCount > 10000` limit, both abort with `console.error` and return unmodified string (lines 2965-2970)

3. **Iterative convergence limits**:
   - Protect/expose cycle (line 4490): `maxIterations = 50` prevents infinite loops when exposing nested protected strings

4. **Console warnings (non-fatal)**:
   - Illegal option key: `console.warn('Illegal option: "' + key + '"')` (line 1486)
   - Unclosed blocks: `console.warn('[MDVIEW] WARNING: Document ended in mode "' + mode + '"...')` (line 3405)

5. **Console errors (non-fatal)**:
   - `Vec2` constructor: `console.error("Vec2 requires one Vec2 or (x, y)")` (line 4719)
   - Grid accessor: `console.error('grid requires either a Vec2 or (x, y)')` (lines 4737, 4760, 4771)
   - Path constructor: `console.error('Path constructor requires at least two Vec2s')` (line 4913)
   - Illegal decoration: `console.error('Illegal decoration character: ' + type)` (line 5128)

6. **Validation throws (in `generateMarkdownTable`)**:
   - Empty rows: `throw new Error("rows cannot be empty")` (line 7195)
   - Null/undefined cells: `throw new Error("null/undefined values not allowed")` (lines 7204, 7238)
   - Column count mismatch: `throw new Error("Row N has M cols, but header has K")` (line 7230)

7. **Context menu error swallowing**:
   - `onContextMenu` handler (line 6554): Entire handler in try/catch; on error, hides menu (line 6645-6647)
   - Cross-origin iframe access (line 6892): `try {...} catch(e) { // Cross-origin iframe, cannot access }`

8. **Recursion guard**:
   - `window.alreadyProcessedMarkdeep` (line 6109): Prevents double-processing when script is loaded multiple times

### Error Handling in highlight.js (lines 7476-8775)

- **Immutability enforcement**: `Object.freeze` on language definitions with `throw Error("map is read-only")` / `throw Error("set is read-only")` (lines 7478-7479)
- **Infinite loop detection**: `if(D>1e5&&D>3*i.index) throw Error("potential infinite loop")` (line 7706)
- **0-width match detection**: `Error("0 width match regex")` (line 7695)
- **Illegal lexeme handling**: Returns `{illegal: true, relevance: 0}` instead of crashing (line 7717)
- **Unknown language**: `throw Error('Unknown language: "'+e+'"')` (line 7708)
- **Language registration failure**: Logs error, falls back to plain text (lines 7761-7763)
- **Unescaped HTML security warning**: `console.warn` + optional `throw` based on `throwUnescapedHTML` config (lines 7736-7739)

### Overall Pattern
Markdeep favors **graceful degradation** — most errors result in the original text passing through unmodified rather than crashing. The pattern is: try to parse → on failure, return input unchanged. This is essential for a document renderer that processes arbitrary user text.

## Q8: Performance Optimizations
**start:** 2026-03-10T15:02:33Z
**end:** 2026-03-10T15:02:45Z
**task_type:** enumeration
**tools_used:** [scan_file for caching, Object.freeze, indexOf, charCodeAt, Date.now, early returns]
**segments_read:** [scan_file context + fetch_snippets for wrapHeaderSections]
**grep_queries:** []
**scan_file_patterns:** ["cache", "memo", "Object\\.freeze", "Object\\.create\\(null", "indexOf", "charCodeAt", "startTime", "Date\\.now", "\\balready"]
**scan_file_matches:** 92 in markdeep core (excluding hljs keyword lists)
**coverage_estimate:** Full file scanned server-side

### 1. String Prototype Aliases for Minification (line 46-47)
```javascript
_.rp = _.replace;
_.ss = _.substring;
```
Every call to `.rp()` and `.ss()` saves characters in the minified version and avoids prototype chain lookup overhead. Used ~200+ times throughout the code.

### 2. Protect/Expose System (lines 3069-3108)
Rather than processing content that shouldn't be transformed (code, math, SVG, HTML attributes), Markdeep replaces them with short Unicode-encoded tokens (`\ue010` + 4-digit base-32 index). This avoids:
- Regex backtracking through protected content
- Multiple passes over unchanged content
- Interference between different parsing stages
The encode/decode uses `parseInt`/`toString` with base 32 for compact encoding.

### 3. Object.freeze for Immutability (lines 4905, 4928, 7444)
- **Grid object** (line 4905): `Object.freeze(grid)` after construction prevents accidental mutation during the multi-pass diagram analysis
- **Path objects** (line 4928): `Object.freeze(this)` makes paths immutable
- **Public API** (line 7444): `window.markdeep = Object.freeze({...})` prevents external code from modifying the API

### 4. indexOf over Regex for Character Classification (lines 4685-4704)
The diagram engine uses `indexOf` on character strings instead of regex for single-character classification:
```javascript
function isArrowHead(c) { return ARROW_HEAD_CHARACTERS.indexOf(c) + 1; }
function isGray(c)       { return GRAY_CHARACTERS.indexOf(c) + 1; }
function isJump(c)       { return JUMP_CHARACTERS.indexOf(c) + 1; }
```
The `+1` trick converts -1 (not found) to 0 (falsy), avoiding boolean conversion overhead.

### 5. Hidden Character Substitution for 'o' (lines 4648-4655)
```javascript
var HIDE_O = '\ue004';
diagramString = diagramString.rp(/([a-zA-Z]{2})o/g, '$1' + HIDE_O);
```
Temporarily replaces 'o' characters surrounded by text to avoid processing them as point decorations. Described as "faster than checking each neighborhood each time" (line 4651).

### 6. Timeout & Match Count Safety Guards (lines 2865-2971)
`wrapHeaderSections()` has:
- `TIMEOUT_MS = 5000` — aborts after 5 seconds (line 2868)
- `matchCount > 10000` — aborts if too many matches (line 2968)
- Uses `indexOf` string search instead of regex for finding anchor tags to avoid catastrophic backtracking (lines 2895-2926)

### 7. Recursion Guard (line 6109)
```javascript
if (! window.alreadyProcessedMarkdeep) {
    window.alreadyProcessedMarkdeep = true;
```
Prevents re-processing if the script is loaded multiple times, avoiding O(n) repeated work.

### 8. Regex Backtracking Prevention (lines 3984-3985, 4028-4029)
```javascript
// Limit attribute matching to prevent catastrophic backtracking on malformed input
str = str.rp(/(^|[^!])\[((?:[^\[\]\\]|\\[\[\]])+?)\]\(("?)([^<>\s"\)]+)\3(\s+[^\)]{0,200})?\)/g, ...
```
Multiple link/image patterns include `{0,200}` limits on attribute matching to prevent ReDoS attacks.

### 9. Object.create(null) for Hash Maps (highlight.js, lines 7486, 7571, 7645, 7658)
```javascript
const t = Object.create(null);
```
Creates prototype-less objects used as pure hash maps, avoiding prototype chain pollution and slightly faster property lookups.

### 10. Cached Variants in highlight.js (line 7634-7635)
```javascript
e.cachedVariants = e.variants.map(...)
```
Language grammar variants are computed once and cached, avoiding recomputation on every highlight call.

### 11. Single-Pass Line Number Injection (lines 3200-3410)
Source line attribution is done in a single pass through the document before any markdown processing, using a state machine that tracks mode (normal/script/style/pre/fence/diagram). This avoids multiple passes for line tracking.

### 12. Font Measurement Caching (lines 93-103, 154-155)
```javascript
var codeFontSize = Math.round(6.5 * 105.1316178 / measureFontSize(codeFontStack)) + '%';
```
Font size is measured once at initialization and stored in a variable, avoiding repeated DOM/canvas measurements.

### 13. Iterative Expose with Early Exit (lines 4490-4497)
```javascript
while ((str.indexOf(PROTECT_CHARACTER) + 1) && exposeRan && (maxIterations > 0)) {
    exposeRan = false;
    str = str.rp(PROTECT_REGEXP, expose);
}
```
Three-condition loop: stops when no protected characters remain, when no replacements were made, or after 50 iterations — whichever comes first.

### 14. Diagram Detection Heuristics (lines 3453-3508)
`looksLikeDiagram()` uses a lightweight character-counting heuristic (ratio of diagram chars to total chars) rather than attempting to parse the diagram, providing O(n) classification vs. the O(n^2) full parse.

### 15. Lazy MathJax Loading (lines 6136-6141, 6470)
```javascript
var needsMathJax = function(html) { ... }
if (needsMathJax) { loadMathJax(); }
```
MathJax (a heavy external library) is only loaded if the document actually contains math notation, detected via simple regex rather than full parsing.
