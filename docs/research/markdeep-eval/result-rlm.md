---
test_type: treatment
approach: RLM context management (targeted extraction, no full-file reads)
start_time: "2026-03-10T13:01:35Z"
download_complete: "2026-03-10T13:01:42Z"
end_time: "2026-03-10T13:04:57Z"
---

## Q1: Purpose, Subsystems, and Control Flow
**start:** 2026-03-10T13:01:52Z
**end:** 2026-03-10T13:02:31Z
**segments_read:** [1-50, 1384-1424, 3059-3068, 4644-4654, 6100-6150, 6410-6530, 7444-7462, 8750-8784]
**grep_queries:** ["function [a-zA-Z]", "window\\.markdeep|markdeepOptions|alreadyProcessedMarkdeep", "function formatDocument", "// PHASE|Phase"]

### Purpose
Markdeep.js (version 1.19) is a self-contained JavaScript library by Morgan McGuire that renders plain-text Markdown documents beautifully in web browsers without any preprocessing step. It extends standard Markdown with ASCII art diagrams, LaTeX math (via MathJax), schedule lists, definition lists, admonitions, figure/table/listing numbering, and automatic code syntax highlighting via an embedded copy of highlight.js. Users include a single `<script>` tag at the bottom of a `.md.html` file and the browser renders it directly (lines 36-38, 618).

### Major Subsystems
1. **Markdown-to-HTML converter** (`markdeepToHTML`, line 3059): The core ~1500-line function that transforms Markdeep source into HTML via sequential regex-based passes. Handles headers, lists, tables, links, images, code blocks, footnotes, citations, admonitions, smart typography, and more.
2. **ASCII diagram engine** (`diagramToSVG`, line 4644): Converts ASCII art bounded by `*****` markers into inline SVG. Recognizes lines (horizontal `-`, vertical `|`, diagonal `/\`), arrows (`>v<^`), vertices (`+.'`), points (`o*`), gray fills, triangles, rounded corners, and text passthrough.
3. **Code highlighting** (embedded highlight.js, lines 7470-7775): Full bundled copy of highlight.js 11.11.1 with language grammars for ~40 languages (lines 7788-8774).
4. **Document formatting** (`formatDocument`, line 6410): Orchestrates the full document lifecycle - detects mode (script/html/doxygen/markdeep), extracts source from the DOM, calls `markdeepToHTML`, injects stylesheets, handles MathJax loading, and manages the `<title>` tag.
5. **Include/insert system** (`processInsertCommands`, line 5858): Allows documents to include other Markdeep files via `(insert ...)` commands, using iframes and message-passing to compose multi-file documents.
6. **Internationalization** (lines 621-1382): Translation tables for 14 languages (French, Lithuanian, Bulgarian, Portuguese, Czech, Italian, Russian, Polish, Hungarian, Japanese, German, Spanish, Swedish, Catalan) with localized keywords for section/figure/table references.
7. **Stylesheet engine** (lines 157-617, 6098-6102): Embedded CSS for body layout, tables, code blocks, diagrams, admonitions, schedule lists, and highlight.js themes.
8. **Source line tracking** (Phase 1, line 3168): Injects protected line-number markers into source text before processing, enabling data-src-line attributes on rendered DOM elements.
9. **Source view & context menu** (Phase 2, line 6211): Provides a right-click context menu and source view toggle for viewing the original Markdeep source alongside rendered output.

### Overall Control Flow
1. The IIFE wrapper (line 39) executes on script load.
2. `formatDocument(option('mode'))` is called (line 7459).
3. In default `'markdeep'` mode, it extracts the document body via `nodeToMarkdeepSource` (line 6518).
4. Processes any `(insert ...)` commands for multi-file composition.
5. Calls `markdeepToHTML(source, false)` to convert the full document.
6. Injects stylesheets, handles MathJax, sets `<title>`, and makes the body visible.
7. The `window.markdeep` API object is frozen for programmatic access (line 7444).

---

## Q2: Code Organization
**start:** 2026-03-10T13:02:31Z
**end:** 2026-03-10T13:02:48Z
**segments_read:** [39-50, 88-155, 618-621, 1384-1460]
**grep_queries:** ["^function [a-zA-Z]", "^var [A-Z_]+ ", "BEGIN |END "]

### Single-File Architecture
Markdeep is a single monolithic IIFE (`(function() { ... })()`) with no module system or namespace hierarchy. All code lives within this closure. The organization is linear and section-based:

| Line Range | Section | Description |
|-----------|---------|-------------|
| 1-38 | **Header/License** | Version, copyright, credits |
| 39-46 | **IIFE & String prototype** | `_.rp` = `replace`, `_.ss` = `substring` (line 46-48) |
| 66-86 | **Constants** | Debug flags, stroke width, diagram markers |
| 88-155 | **Utility functions** | `entag()`, `measureFontSize()`, `Object.assign` polyfill, `String.includes` polyfill |
| 157-617 | **Stylesheets** | `BODY_STYLESHEET`, `STYLESHEET` (massive CSS string) |
| 618-619 | **Markdeep script line** | The `<!-- Markdeep: -->` bootstrap line |
| 621-1382 | **Language tables** | 14 locale translation objects |
| 1384-1465 | **Configuration** | `DEFAULT_OPTIONS`, `LANG_TABLE`, language detection |
| 1466-1605 | **Helper functions** | `option()`, level conversion, escaping, mangling |
| 1607-1683 | **CSS generators** | `sectionNumberingStylesheet()`, `h1TitleOutputStylesheet()` |
| 1684-1893 | **Source extraction & diagrams** | `nodeToMarkdeepSource()`, `extractDiagram()` |
| 1894-2840 | **Content replacement functions** | `replaceMatched()`, `replaceTables()`, `replaceLists()`, `replaceScheduleLists()`, `replaceDefinitionLists()`, `insertTableOfContents()` |
| 2841-3058 | **Section wrapping** | `escapeRegExpCharacters()`, `isolated()`, `wrapHeaderSections()` |
| 3059-4554 | **Core converter** | `markdeepToHTML()` - the main rendering pipeline |
| 4558-4643 | **String utilities** | `strToArray()`, `equalizeLineLengths()`, `removeLeadingSpace()`, `isASCIILetter()` |
| 4644-5857 | **Diagram engine** | `diagramToSVG()` with internal classes (Vec2, Path, DecorationSet, etc.) |
| 5858-6103 | **Insert system** | `processInsertCommands()`, highlight.js stylesheet |
| 6104-7462 | **Document processor** | `isMarkdeepScriptName()`, `formatDocument()`, source view, link preview, context menu, `window.markdeep` API |
| 7464-7775 | **highlight.js** | Bundled highlight.js 11.11.1 (minified) |
| 7776-8774 | **Language grammars** | ~40 highlight.js language definitions (minified) |
| 8775-8784 | **Footer** | Module export for Node.js, Emacs local variables |

### Key Structural Patterns
- **No classes or prototypes** for the main API; everything is procedural/functional.
- **Internal classes in diagramToSVG**: `Vec2` (line ~4710), `Path` (line ~4911), `DecorationSet` (line ~5100) use constructor functions with prototype methods.
- **protect/expose pattern**: A central mechanism where sensitive strings are replaced with indexed tokens to prevent markdown processing from mangling them, then restored at the end (lines 3069-3108).
- **Global `window.markdeep` object**: The only exported namespace (line 7444), frozen with 8 public methods/properties.

---

## Q3: Public/Exported API Functions
**start:** 2026-03-10T13:02:48Z
**end:** 2026-03-10T13:03:03Z
**segments_read:** [7444-7456, 7133-7140, 7156-7165, 7188-7195, 7414-7420, 3059-3068, 4644-4654]
**grep_queries:** ["window\\.markdeep = Object", "function headerAnchor|function definitionAnchor|function generateMarkdownTable|function makeMarkdownCodeBrowserSafe"]

The public API is exposed as `window.markdeep` (line 7444), a frozen object with the following members:

| API Member | Internal Function | Signature | Description |
|-----------|------------------|-----------|-------------|
| `format` | `markdeepToHTML` | `(str, elementMode)` | Converts a Markdeep source string to HTML. `elementMode` (default true) controls whether to process as a standalone document or an embedded element. (line 3059) |
| `formatDiagram` | `diagramToSVG` | `(diagramString, alignmentHint)` | Converts an ASCII art diagram string to an SVG string. `alignmentHint` controls centering/floating. (line 4644) |
| `formatDocument` | `formatDocument` | `(mode)` | Processes the entire current HTML document. `mode` is one of 'markdeep', 'html', 'doxygen', 'script'. (line 6410) |
| `headerAnchor` | `headerAnchor` | `(headerArray)` | Given an array of header text strings, returns HTML anchor markup for navigation targets. Returns '' if array is empty. (line 7133) |
| `definitionAnchor` | `definitionAnchor` | `(headerArray, term)` | Generates an anchor for a definition term within the context of a header hierarchy. Returns '' if term is empty. (line 7156) |
| `generateMarkdownTable` | `generateMarkdownTable` | `(rows, caption, outerBorder, padding, truncateSuffix)` | Converts a 2D array of data into a Markdown-formatted table string. `rows[0]` is the header row. Throws if rows is empty or contains null values. (line 7188) |
| `makeMarkdownCodeBrowserSafe` | `makeMarkdownCodeBrowserSafe` | `(text)` | Escapes `<` characters inside fenced and inline code blocks to prevent browser HTML parsing issues when serving .md.html files. (line 7414) |
| `langTable` | `LANG_TABLE` | (object) | The language translation table mapping locale codes to translation objects. (line 1416) |
| `stylesheet` | (inline function) | `()` | Returns the complete Markdeep stylesheet string (main + section numbering + h1 title + highlight.js). (line 7453) |

Additionally, on Node.js: `module.exports = hljs` (line 8775) exports the highlight.js instance.

Global side-effects:
- `window.alreadyProcessedMarkdeep` is set to `true` to prevent re-processing (line 6110).
- `window.markdeepOptions` is read for user configuration (line 1467).
- `window.markdeepShowSourceView` is set for source view toggling (line 6304).

---

## Q4: Rendering Pipeline
**start:** 2026-03-10T13:03:03Z
**end:** 2026-03-10T13:03:39Z
**segments_read:** [3059-3260, 3280-3530, 3530-3730, 3729-3929, 3929-4128, 4128-4328, 4328-4554, 6410-6530]
**grep_queries:** ["// PHASE", "function formatDocument", "function markdeepToHTML"]

### Full Document Processing Flow

#### Stage 1: Document Bootstrap (`formatDocument`, line 6410)
1. Check `?noformat` URL parameter (line 6412)
2. Switch on mode:
   - `'script'`: return immediately (library-only mode)
   - `'html'`/`'doxygen'`: process only `<diagram>` and `.markdeep` class elements
   - `'markdeep'` (default): full-document processing
3. For markdeep mode: extract source via `nodeToMarkdeepSource()` (line 6518)
4. Process `(insert ...)` include commands (line 6537+)
5. Call `markdeepToHTML(source, false)` (line 6545)
6. Inject stylesheets into `<head>`, load MathJax if needed, set `<title>` (lines 6573+)
7. Make body visible (was hidden during processing)

#### Stage 2: Core Conversion (`markdeepToHTML`, line 3059)
The function processes the source string through ~30 sequential regex replacement passes:

**Phase 1 - Source Line Tracking** (line 3168):
- Injects protected `<L:N>` markers at end of content lines via state machine
- State machine tracks: normal, script, style, pre, fence, diagram modes

**Phase 2 - Literal Block Protection** (lines 3409-3729):
1. Strip preformatted script tags (line 3421)
2. **Code fence cleanup** (`cleanupCodeFences`): identify unlabeled fences, auto-detect language or convert to diagrams (line 3621)
3. **Labeled code fences** (`processLabeledCodeFences`): syntax highlight via hljs, wrap in `<pre><code>` (line 3622)
4. **Blockquotes**: iterative `>` prefix processing with nested fence support (line 3628-3656)
5. Protect `<code>` blocks (line 3664)
6. Remove HTML comments (line 3668)
7. **Diagrams**: recursively extract `*****`-delimited blocks, convert via `diagramToSVG()` (line 3670)
8. Protect SVG, style, img tags (lines 3673-3688)
9. **Inline code**: backtick processing with optional syntax highlighting (lines 3690-3720)
10. Protect `<pre>`, HTML attributes (lines 3722-3727)

**Phase 3 - Math** (lines 3731-3761):
1. Protect `$$...$$` blocks
2. Convert `$...$` to MathJax `\(...\)` notation
3. Protect `\(...\)`, `\begin{equation}` blocks

**Phase 4 - Headers** (lines 3763-3802):
1. Setext H1 (`===`) and H2 (`---`) (lines 3769-3772)
2. ATX headers `#` through `######` (lines 3786-3801)
3. No-number headers `(#)` syntax

**Phase 5 - Block Elements** (lines 3804-3860):
1. Horizontal rules: `* * *`, `- - -`, `_ _ _` (line 3805)
2. Page breaks: `+++++` (line 3808)
3. Admonitions: `!!!` (line 3811)
4. Footnotes/endnotes: `[^name]` (lines 3817-3831)
5. Citations: `[#name]` (lines 3834-3855)
6. Tables (line 3860)

**Phase 6 - Links & Images** (lines 3862-4193):
1. Reference link table (line 3864)
2. Email addresses (line 3870)
3. Equation/figure/table label rewriting (lines 3957-3968)
4. Hyperlinks `[text](url)` (line 3985)
5. Reference links `[text][ref]` (line 3999)
6. Image grids (lines 4042-4122)
7. Simple images `![](url)` (line 4126)
8. Captioned images `![caption](url)` with float/center logic (line 4148)

**Phase 7 - Inline Formatting** (lines 4195-4278):
1. Bold `**text**` / `__text__` (lines 4201-4202)
2. Italic `*text*` / `_text_` (lines 4205-4206)
3. Strikethrough `~~text~~` (line 4209)
4. Stage directions `((text))` (line 4212)
5. Smart quotes (line 4226)
6. Arrow symbols: `->`, `-->`, `<->`, `==>`, etc. (lines 4232-4240)
7. Em dashes `---`/`--` (lines 4244-4248)
8. Dimension beautification `NxM` -> `N x M` (line 4254)
9. Minus signs, exponents, page breaks, degrees (lines 4271-4295)

**Phase 8 - Structural Elements** (lines 4280-4481):
1. Schedule lists (line 4281)
2. Definition lists (line 4289)
3. Bullet/numbered lists (line 4292)
4. Line breaks: `\` and trailing spaces (lines 4297-4313)
5. Paragraph wrapping (line 4317)
6. Endnote definitions (line 4325)
7. Section cross-references (line 4342)
8. Figure/table/listing references (line 4358)
9. Auto-linked URLs (line 4381)

**Phase 9 - Title & TOC** (lines 4392-4486):
1. Bold-text title detection (line 4412)
2. `h1TitleInput` processing (line 4436)
3. Table of contents insertion (line 4468)
4. Section number cross-references (line 4472)
5. Wrap headers in `<section>` tags (line 4485)

**Phase 10 - Final** (lines 4488-4553):
1. Recursively expose all protected strings (line 4493)
2. API definition auto-linking (line 4511)
3. Wrap in `<span class="md"><p>...</p></span>` (line 4553)

---

## Q5: File Formats and Diagram Types
**start:** 2026-03-10T13:03:39Z
**end:** 2026-03-10T13:04:06Z
**segments_read:** [4644-4703, 1766-1782, 3900-3920]
**grep_queries:** ["youtube|vimeo|gravizo", "DECORATION_CHARACTERS|VERTEX_CHARACTERS|ARROW_HEAD", "dashed|dotted|round.*corner|curved"]

### Supported Media Formats

| Format | Extension(s) | Parser/Handler | Line |
|--------|-------------|----------------|------|
| **Images** | (any non-video/audio URL) | `formatImage()` -> `<img>` tag | 3934 |
| **Video** | `.mp4`, `.m4v`, `.avi`, `.mpg`, `.mov`, `.webm` | `formatImage()` -> `<video>` tag with controls | 3901 |
| **Audio** | `.mp3`, `.mp2`, `.ogg`, `.wav`, `.m4a`, `.aac`, `.flac` | `formatImage()` -> `<audio>` tag with controls | 3904 |
| **YouTube** | `youtube.com/...v=ID` or `youtu.be/ID` | `formatImage()` -> `<iframe>` embed, supports `?t=` timestamps | 3907 |
| **Vimeo** | `vimeo.com/.../ID` | `formatImage()` -> `<iframe>` embed | 3915 |
| **Gravizo** | `g.gravizo.com/...` | URL-encoded and passed through as image | 3978 |
| **LaTeX/Math** | `$$...$$`, `$...$`, `\(...\)`, `\begin{equation}` | Protected and deferred to MathJax (loaded from CDN) | 3731-3761 |
| **Code** | Fenced blocks (``` or ~~~) with language label | highlight.js with ~40 languages | 3563-3619 |

### ASCII Diagram Elements (diagramToSVG, line 4644)

The diagram engine converts `*****`-delimited ASCII art blocks into SVG. Supported elements:

| Element | Characters | Description | Line |
|---------|-----------|-------------|------|
| **Horizontal lines** | `-` | Solid horizontal lines | 4697 |
| **Vertical lines** | `\|` | Solid vertical lines | 4699 |
| **Diagonal lines** | `/` | Forward diagonal | 4700 |
| **Backslash lines** | `\` | Backward diagonal | 4701 |
| **Arrow heads** | `>`, `v`, `<`, `^` | Directional arrow tips | 4671 |
| **Vertices** | `+`, `.`, `'` | Line junction points; `.` = top corner, `'` = bottom corner | 4674-4675 |
| **Points/dots** | `o`, `*`, `circled-variants` | Open circle, closed dot, dotted, shaded, filled | 4672 |
| **Jumps** | `(`, `)` | Line crossover jumps (arc over another line) | 4673 |
| **Gray fills** | `U+2591`-`U+2588` | Quarter/half/three-quarter/full block fills | 4678 |
| **Triangles** | `U+25E2`-`U+25E5` | Right triangles at 4 rotations | 4681 |
| **Dashed lines** | Via `Path(..., dashed)` | Dashed line variants | 4911, 4926 |
| **Rounded corners** | Detected contextually | Curved corners at `.` and `'` vertices | 5454 |
| **Text passthrough** | Any non-diagram characters | Text that doesn't match diagram patterns is rendered as-is in the SVG | (throughout) |
| **Diagram fences** | ````diagram` or `*****` borders | Two syntax forms to delimit diagram regions | 3537, 1766 |

---

## Q6: Regex Patterns for Markdown Parsing
**start:** 2026-03-10T13:04:06Z
**end:** 2026-03-10T13:04:22Z
**segments_read:** [3659-3870, 3985-4029, 4126-4278, 4295-4325]
**grep_queries:** ["str = str\\.rp\\(", "{0,200}|{0,100}"]

There are **175 total `.rp()` (replace) calls** in the file. Below are the key markdown parsing regexes in `markdeepToHTML` (listed in processing order):

### Literal Block Protection
| Line | Pattern | Matches |
|------|---------|---------|
| 3421 | `/<script\s+type\s*=\s*['"]preformatted['"]\s*>([\s\S]*?)<\/script>/gi` | Preformatted script blocks (legacy protection for `<` in code) |
| 3631 | `/(?:\n>.*){2,}/g` | Blockquote blocks (2+ consecutive `>` lines) |
| 3659 | `/<code\s+lang\s*=\s*["']?([^"'\)\[\]\n]+)["'?]\s*>(.*)<\/code>/gi` | Explicit language-tagged inline code |
| 3664 | `/(<code\b.*?<\/code>)/gi` | All code blocks (for protection) |
| 3668 | `/<!--((?!->|>)[\s\S]*?)-->/g` | HTML comments |
| 3673 | `/<svg( .*?)?>([\s\S]*?)<\/svg>/gi` | SVG blocks |
| 3678 | `/<style>([\s\S]*?)<\/style>/gi` | Style blocks |
| 3685 | `/<img\s+src=(["'])[\s\S]*?\1\s*>/gi` | Image tags (especially Gravizo with newlines) |
| 3696 | `/(^|[^\\])` `` ` `` `(.*?(?:\n.*?)?[^\n\\` `` ` `` `])` `` ` `` `(?!\d)/g` | Inline code (single backticks, allow one newline) |
| 3718 | `/(<code(?: .*?)?>)([\s\S]*?)<\/code>/gi` | Code blocks (for entity escaping + protection) |
| 3723 | `/(<pre\b[\s\S]*?<\/pre>)/gi` | Pre blocks |
| 3726 | `/(<\w[^ \n<>]*?[ \t]+)(.*?)(?=\/?>)/g` | HTML tag attributes |

### Math
| Line | Pattern | Matches |
|------|---------|---------|
| 3733 | `/(\$\$[\s\S]+?\$\$)/g` | Display math `$$...$$` |
| 3745 | `/((?:[^\w\d]))\$(\S(?:[^\$]*?\S(?!US|Can))??)\$(?![\w\d])/g` | Inline math `$...$` (excludes US$/Can$) |
| 3755 | `/((?:[^\w\d]))\$([ \t][^\$]+?[ \t])\$(?![\w\d])/g` | Inline math with spaces `$ ... $` |
| 3758 | `/(\\\([\s\S]+?\\\))/g` | LaTeX inline `\(...\)` |
| 3759 | `/(\\begin\{equation\}[\s\S]*?\\end\{equation\})/g` | LaTeX equation environments |

### Headers
| Line | Pattern | Matches |
|------|---------|---------|
| 3769 | `/(?:^|\s*\n)(.+?)\n[ \t]*={3,}[ \t]*\n/g` | Setext H1 (text + `===` underline) |
| 3772 | `/(?:^|\s*\n)(.+?)\n[ \t]*-{3,}[ \t]*\n/g` | Setext H2 (text + `---` underline) |
| 3789 | `/^\s*#{N,N}(?:[ \t])([^\n]+?)#*[ \t]*\n/gm` | ATX headers `# ... #` (N=1-6) |
| 3796 | `/^\s*\(#{N,N}\)(?:[ \t])([^\n]+?)\(?#*\)?\n/gm` | No-number headers `(#) ...` |

### Block Elements
| Line | Pattern | Matches |
|------|---------|---------|
| 3805 | `/\n[ \t]*((\*|-|_)[ \t]*){3,}[ \t]*\n/g` | Horizontal rules (`* * *`, `---`, `___`) |
| 3808 | `/\n[ \t]*\+{5,}[ \t]*\n/g` | Page breaks (`+++++`) |
| 3811 | `/^!!![ \t]*([^\s"'><&\:]*)\:?(.*)\n([ \t]{3,}.*\s*\n)*/gm` | Admonitions `!!! type: title` |
| 3830 | `/[ \t]*\[\^([^\]\n\t ]+)\](?!:)/g` | Footnote references `[^name]` |
| 3836 | `/\n\[#(\S+)\]:[ \t]+((?:[ \t]*\S[^\n]*\n?)*)/g` | Bibliography definitions `[#name]: ...` |
| 3844 | `/\[(#[^\)\(\[\]\.#\s]+(?:\s*,\s*#(?:[^\)\(\[\]\.#\s]+))*)\]/g` | Citation references `[#name]` |
| 3864 | `/^\[([^\^#].*?)\]:(.*?)$/gm` | Reference link definitions `[name]: url` |

### Links & Images
| Line | Pattern | Matches |
|------|---------|---------|
| 3870 | `/(?:<|(?!<)\b)(\S+@(\S+\.)+?\S{2,}?)(?:$|>|(?=<)|(?=\s)(?!>))/g` | Email addresses |
| 3985 | `/(^|[^!])\[((?:[^\[\]\\]|\\[\[\]])+?)\]\(("?)([^<>\s"\)]+)\3(\s+[^\)]{0,200})?\)/g` | Inline links `[text](url attribs)` |
| 3993 | `/(^|[^!])\[[ \t]*?\]\(("?)([^<>\s"\)]+)\2\)/g` | Empty links `[](url)` |
| 3999 | `/(^|[^!])\[((?:[^\[\]\\]|\\[\[\]])+)\]\[([^\[\]]*)\]/g` | Reference links `[text][ref]` |
| 4126 | `/(\s*)!\[\]\(("?)([^"<>\s\)]+)\2(\s[^\)]{0,200})?\)(\s*)/g` | Simple images `![](url)` |
| 4148 | `/(\s*)!\[((?:[^\[\]\\]|\\[\[\]])+?)\]\(("?)([^"<>\s\)]+)\3(\s[^\)]{0,200})?\)(\s*)/` | Captioned images `![caption](url)` |
| 4381 | `/(?:<|(?!<)\b)(\w{3,6}:\/\/.+?)(?:$|>|(?=<)|(?=\s|\u00A0)(?!<))/g` | Bare URLs |

### Inline Formatting
| Line | Pattern | Matches |
|------|---------|---------|
| 4201 | `/\*\*/` (via `replaceMatched`) | Bold `**text**` |
| 4202 | `/__/` (via `replaceMatched`) | Bold `__text__` |
| 4205 | `/\*/` (via `replaceMatched`) | Italic `*text*` |
| 4206 | `/_/` (via `replaceMatched`) | Italic `_text_` |
| 4209 | `/\~\~([^~].*?)\~\~/g` | Strikethrough `~~text~~` |
| 4220 | `/\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g` | Stage directions `((text))` |

### Typography
| Line | Pattern | Matches |
|------|---------|---------|
| 4227 | `/(^|[ \t->])(")(?=\w)/gm` | Opening smart quotes |
| 4228 | `/([A-Za-z\.,:;\?!=<])(")(?=$|\W)/gm` | Closing smart quotes |
| 4232-4240 | `/(\s|^)<==(\s)/g` etc. | Arrow symbols (`->`, `-->`, `<->`, `==>`, etc.) |
| 4244 | `/([^-!\:\|])---([^->\:\|])/g` | Em dash `---` |
| 4254 | (complex NxM pattern) | Dimension beautification `720x360` -> `720x360` |
| 4271 | `/([\s\(\[<\|])-(\d)/g` | Minus sign before digit |
| 4275 | `/\^([-+]?\d+)\b/g` | Superscript exponents `^2` |
| 4295 | `/(\d+?)[ \t-]?\n?degree(?:s?)/g` | Degree symbol `90 degrees` -> `90deg` |
| 4317 | `/(?:<p>)?\n\s*\n+(?!<\/p>)/gi` | Paragraph breaks (double newline) |

---

## Q7: Error Handling Patterns
**start:** 2026-03-10T13:04:22Z
**end:** 2026-03-10T13:04:31Z
**segments_read:** [2864-2893, 3594-3598, 4490-4497, 7188-7240]
**grep_queries:** ["try\\s*\\{|catch\\s*\\(|console\\.(warn|error|log)|throw |Error\\("]

### Error Handling Strategy

Markdeep uses a **defensive, fail-soft approach** -- it avoids crashing and instead degrades gracefully. There are very few try/catch blocks in the core code; most error handling is structural (guards, fallbacks, timeouts).

#### 1. Try/Catch Blocks (5 in Markdeep code, many more in hljs)

| Line | Context | Handling |
|------|---------|----------|
| 94-99 | `measureFontSize()` | Catches canvas/font measurement errors; returns default `10` on failure |
| 2280/2513 | `replaceScheduleLists()` | Wraps entire schedule parsing in try/catch; on any error, returns original string unchanged (line 2513: `catch (ignore)`) |
| 3594-3598 | Code fence syntax highlighting | If `hljs.highlight()` throws for an unknown language, falls back to `hljs.highlightAuto(sourceCode, [])` (no highlighting) |
| 6554/6645 | Source view line highlighting | Catches errors in DOM range operations for source-to-rendered mapping |
| 6884/6892 | Link preview fetch | Catches fetch errors silently (preview just doesn't appear) |

#### 2. Console Warnings/Errors (Soft Failures)

| Line | Message | Trigger |
|------|---------|---------|
| 1486 | `'Illegal option: "' + key + '"'` | Unknown key in `window.markdeepOptions` |
| 2965 | `'[wrapHeaderSections] Timeout after...'` | Header section wrapping exceeds 5-second safety timeout |
| 2969 | `'[wrapHeaderSections] Too many matches, aborting'` | Excessive header matches (safety valve) |
| 3405 | `'[MDVIEW] WARNING: Document ended in mode...'` | Source line tracking state machine ended inside an unclosed block (fence, script, etc.) |
| 4719 | `'Vec2 requires one Vec2 or (x, y)...'` | Invalid constructor arguments to Vec2 in diagram engine |
| 4737/4760/4771 | `'grid requires either a Vec2 or (x, y)'` | Invalid arguments to grid methods |
| 4913 | `'Path constructor requires at least two Vec2s'` | Diagram path with insufficient points |
| 5128 | `'Illegal decoration character: ' + type` | Unknown decoration in diagram |

#### 3. Input Validation in Public API (line 7188+)

The `generateMarkdownTable()` function has the strictest validation:
- Throws `Error("rows cannot be empty")` if `rows` is empty (line 7195)
- Throws `Error("null/undefined values not allowed")` for null cells (line 7204)
- Throws `Error("Row N has X cols, but header has Y")` for ragged rows (line 7230)

`headerAnchor()` and `definitionAnchor()` return empty string for invalid input rather than throwing (lines 7134, 7157).

#### 4. Structural Safeguards

| Pattern | Location | Purpose |
|---------|----------|---------|
| **Timeout guard** | `wrapHeaderSections` (line 2867) | 5-second `TIMEOUT_MS` prevents runaway regex on pathological input |
| **Match count guard** | `wrapHeaderSections` (line 2969) | Aborts if too many header matches found |
| **Max iterations** | `expose` loop (line 4490) | Caps recursive expose at 50 iterations to prevent infinite loops |
| **Regex backtrack prevention** | Lines 3985, 4029, 4053, 4110, 4126, 4148 | `{0,200}` and `{0,100}` quantifier limits on attribute matching to prevent catastrophic backtracking |
| **Protect/expose pattern** | Lines 3069-3108 | Prevents markdown processing from corrupting code, HTML, math, or SVG content |
| **alreadyProcessedMarkdeep** | Line 6109 | Global flag prevents recursive execution when multiple script tags are present |
| **Recursive include guard** | Line 6496-6503 | Removes recursive Markdeep script references to prevent infinite loading |
| **Sentinel newlines** | Line 3637 | Adds sentinel `\n` for blockquote fence processing, removes after |

#### 5. Fallback Behaviors

- **Unknown code language**: Falls back to `hljs.highlightAuto()` with empty language list (no highlighting) (line 3597)
- **Missing reference link**: Returns `'?'` literal (lines 4010, 4032)
- **Missing figure/table reference**: Returns `_type + ' ?'` (line 4375)
- **Missing section reference**: Returns `prefix + ' ?'` (line 4478)
- **Invalid schedule dates**: Entire schedule list reverts to original text via catch block (line 2513)
- **Canvas unavailable**: `measureFontSize` returns 10 (line 99)

---

## Q8: Performance Optimizations
**start:** 2026-03-10T13:04:31Z
**end:** 2026-03-10T13:04:57Z
**segments_read:** [2864-2893, 4490-4497, 4644-4656]
**grep_queries:** ["cache|early.*return|lazy|memoiz|optimi|fast|performance|timeout|maxIteration", "MAX_MATCH|abort|break.*loop|skip|sentinel", "{0,200}|{0,100}"]

### Performance Optimizations Catalog

#### 1. Protect/Expose Substitution System (lines 3069-3108, 4490-4497)
The most significant optimization: instead of complex negative lookaheads to avoid processing code/math/HTML blocks, Markdeep replaces them with short indexed tokens (`\ue010XXXX\ue010`) using base-32 encoding. This turns O(n^2) nested-regex problems into O(n) simple substitutions. The expose phase runs in a loop capped at 50 iterations for nested protections.

#### 2. Catastrophic Backtracking Prevention (lines 3985, 4029, 4053, 4110, 4126, 4148)
Multiple regex patterns use `{0,200}` or `{0,100}` quantifier limits on attribute matching:
- Link attributes: `(\s+[^\)]{0,200})?` (line 3985)
- Reference image attributes: `([ \t][^\n\[\]]{0,200})?` (line 4029)
- Image line regex: `[^\]]{0,100}` for captions, `[^\n\)]{0,200}` for attributes (line 4053)
- Image grid row parsing: `[^\)]{0,200}` (line 4110)

These prevent exponential-time regex matching on malformed input.

#### 3. Safety Timeout in wrapHeaderSections (lines 2865-2968)
A 5-second `TIMEOUT_MS` guard with `Date.now()` checks prevents pathological documents from hanging the browser. Also has a match count limit. On timeout, the function aborts and returns the partially-processed string.

#### 4. String Prototype Aliasing (lines 46-48)
```javascript
var _ = String.prototype;
_.rp = _.replace;
_.ss = _.substring;
```
Short aliases for the two most-called string methods, reducing minified code size and providing marginally faster property lookup through shorter names.

#### 5. 'o' Character Pre-substitution in Diagrams (lines 4648-4655)
Before diagram processing, lowercase 'o' surrounded by text is temporarily replaced with a Unicode private-use character (`\ue004`). This avoids expensive per-character neighborhood checks during the main diagram scan, which would otherwise need to determine if each 'o' is a circle decoration or part of text.

#### 6. Two-Pass Image Grid Processing (lines 4056-4122)
Instead of a single complex regex to match multi-line image grids (which caused catastrophic backtracking due to nested quantifiers), the code:
1. First pass: finds all individual image lines with positions (line 4058)
2. Second pass: groups consecutive lines in plain JavaScript (line 4068)
3. Applies replacements in reverse order to maintain indices (line 4093)

This converts an O(2^n) regex problem into O(n) procedural code.

#### 7. Early Returns and Short-Circuit Guards
- `formatDocument` returns immediately for `'script'` mode (line 6417)
- `nodeToMarkdeepSource` skips processing for empty/null nodes
- `diagramToSVG` pre-equalizes line lengths once (line 4646) rather than checking per-character
- `replaceMatched` uses a do/while with early exit when no more matches found (line 1894)
- `markdeepToHTML` skips title processing when `elementMode` is true (line 4392)
- Source line tracking skips entirely for included documents (line 3205)

#### 8. Iterative vs Recursive Processing
- Blockquote processing uses a do/while loop instead of recursion (line 3629)
- Captioned image processing uses a while loop with flag (line 4140-4143)
- Expose uses a bounded while loop with `maxIterations = 50` (line 4490)

#### 9. Fixed-Length Protection Tokens (lines 3074-3078)
Protection tokens use exactly `PROTECT_DIGITS = 4` base-32 characters, giving 1M possible tokens. Fixed length enables a precise regex (`[0-9a-w]{4,4}`) that matches in constant time per character, avoiding variable-length alternation costs.

#### 10. Highlight.js Caching
The bundled highlight.js uses internal language compilation caching -- languages are compiled once on first use and the compiled grammar is reused for subsequent highlights (inherent to hljs architecture, visible in minified code around line 7476+).

#### 11. Skipping Structural Lines in Source Line Tracking (lines 3349-3367)
The Phase 1 state machine skips injecting line markers on lines that are structural (tables, lists, fences, diagram boundaries, blockquotes, reference definitions, etc.), reducing the number of protected tokens and the work needed in the expose phase.
