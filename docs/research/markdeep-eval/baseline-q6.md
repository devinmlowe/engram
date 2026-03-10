---
question: "Q6: Catalog all regex patterns used for markdown parsing. For each, state what syntax it matches."
evaluator_start: "2026-03-10T12:59:23Z"
evaluator_end: "2026-03-10T13:01:10Z"
---

# Q6: Comprehensive Regex Catalog for Markdeep Markdown Parsing

Markdeep.js contains approximately 370 unique regex patterns in its own code (lines 1-7466), plus hundreds more in the embedded highlight.js library (lines 7470-8784) used solely for syntax highlighting. This catalog covers all Markdeep-specific regex patterns organized by functional area. Patterns from the embedded highlight.js are listed in a separate section at the end.

> **Notation:** `rp()` is Markdeep's alias for `String.prototype.replace()`. All patterns listed with their exact line numbers, containing function, and purpose.

---

## 1. HTML Entity Escaping/Unescaping

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1552 | `/&/g` | `escapeHTMLEntities` | Ampersand character `&` |
| 1552 | `/</g` | `escapeHTMLEntities` | Less-than character `<` |
| 1552 | `/>/g` | `escapeHTMLEntities` | Greater-than character `>` |
| 1552 | `/"/g` | `escapeHTMLEntities` | Double-quote character `"` |
| 1564 | `/&lt;/g` | `unescapeHTMLEntities` | HTML entity `&lt;` |
| 1565 | `/&gt;/g` | `unescapeHTMLEntities` | HTML entity `&gt;` |
| 1566 | `/&quot;/g` | `unescapeHTMLEntities` | HTML entity `&quot;` |
| 1567 | `/&#39;/g` | `unescapeHTMLEntities` | HTML entity `&#39;` (apostrophe) |
| 1568 | `/&ndash;/g` | `unescapeHTMLEntities` | HTML entity `&ndash;` (en-dash) |
| 1569 | `/&mdash;/g` | `unescapeHTMLEntities` | HTML entity `&mdash;` (em-dash) |
| 1570 | `/&amp;/g` | `unescapeHTMLEntities` | HTML entity `&amp;` |

## 2. HTML Tag Processing

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1575 | `/<.*?>/g` | `removeHTMLTags` | Any HTML tag (non-greedy) |
| 1722 | `/<\/https?:.*>\|<\/ftp:.*>\|<\/[^ "\t\n>]+@[^ "\t\n>]+>/gi` | `nodeToMarkdeepSource` | Malformed closing tags that are actually URLs or emails the browser wrapped in tags |
| 1726 | `/<(https?|ftp): (.*?)>/gi` | `nodeToMarkdeepSource` | URLs the browser split into tags, e.g. `<http: //example.com>` |
| 1729 | `/=""\s/g` | `nodeToMarkdeepSource` | Browser-inserted `=""` attributes in reconstructed URLs |
| 1737 | `/"/g` | `nodeToMarkdeepSource` | Remaining double-quote artifacts from URL reconstruction |
| 1743 | `/<style class=["']fallback["']>.*?<\/style>/gmi` | `nodeToMarkdeepSource` | The Markdeep fallback style tag |
| 3418 | `/<([ \u200b\\])(\/?)script/gi` | `unescapeScriptTags` | Escaped script tags (with space, zero-width space, or backslash after `<`) |
| 3421 | `/<script\s+type\s*=\s*['"]preformatted['"]\s*>([\s\S]*?)<\/script>/gi` | `markdeepToHTML` | `<script type="preformatted">` blocks (treated as raw pass-through) |
| 3456 | `/<[a-zA-Z][^>]*>/` | `looksLikeDiagram` | Any HTML opening tag (used to detect if content is HTML, not a diagram) |
| 3659 | `/<code\s+lang\s*=\s*["']?([^"'\)\[\]\n]+)["'?]\s*>(.*)<\/code>/gi` | `markdeepToHTML` | `<code lang="...">` tags with language attribute for syntax highlighting |
| 3664 | `/(<code\b.*?<\/code>)/gi` | `markdeepToHTML` | Any `<code>...</code>` block (protected from further processing) |
| 3673 | `/<svg( .*?)?>([\s\S]*?)<\/svg>/gi` | `markdeepToHTML` | SVG elements (protected from markdown processing) |
| 3678 | `/<style>([\s\S]*?)<\/style>/gi` | `markdeepToHTML` | Style elements (protected from markdown processing) |
| 3685 | `/<img\s+src=(["'])[\s\S]*?\1\s*>/gi` | `markdeepToHTML` | Image tags with src attribute (protected) |
| 3718 | `/(<code(?: .*?)?>)([\s\S]*?)<\/code>/gi` | `markdeepToHTML` | Code blocks with optional attributes (for escaping backticks inside) |
| 3723 | `/(<pre\b[\s\S]*?<\/pre>)/gi` | `markdeepToHTML` | Pre-formatted blocks (protected) |
| 3726 | `/(<\w[^ \n<>]*?[ \t]+)(.*?)(?=\/?>)/g` | `markdeepToHTML` | HTML tag attributes (protected from markdown processing) |
| 4463 | `/^\s*<\/p>/` | `markdeepToHTML` | Leading closing `</p>` tag at start of document |
| 4524 | `/<dt><code(\b[^<>\n]*)>(<span class="[a-zA-Z\-_0-9]+">)?([A-Za-z_][A-Za-z_\.0-9:\->]*)(<\/span>)?([\(\[<])/g` | `markdeepToHTML` | Definition terms containing code identifiers like `foo(`, `bar[`, `baz<` (for API doc auto-linking) |
| 4542 | `/<h([1-9])>(.*<code\b[^<>\n]*>.*)<\/code>(.*<\/h\1>)/g` | `markdeepToHTML` | Headers containing inline code (prevents code-block styling from eating the header) |
| 4547 | `/<code(?! ignore)\b[^<>\n]*>(<span class="[a-zA-Z\-_0-9]+">)?([A-Za-z_][A-Za-z_\.0-9:\->]*)(<\/span>)?(\(\)\|[\]\])?<\/code>/g` | `markdeepToHTML` | Inline code containing identifiers with `()` or `[]` suffix (for API doc auto-linking) |
| 6437 | `/<a class="el" .*>(.*)<\/a>/g` | `formatDocument` | Doxygen-style element links (stripped for clean display) |

## 3. URL and Anchor Processing

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1581 | `/[\s\(\)\[\]<>\{\}]/g` | `mangle` | Whitespace and bracket characters (removed to create URL anchors) |
| 1589 | `/^([A-Za-z_][A-Za-z_\.0-9:\->]*)([\(\[<])/` | `mangleCode` | Code identifiers followed by `(`, `[`, or `<` (for stable anchor names) |
| 5877 | `/\/[^/]+$/` | `sendContentsToMyParent` | Filename at end of URL path (to get base directory) |
| 5887 | `/^file:\/\//` | `sendContentsToMyParent` | `file://` protocol prefix |
| 5890 | `/[^:/]{3,6}:\/\/[^/]*\//` | `sendContentsToMyParent` | Protocol + hostname portion of a URL |
| 5906 | `/^[a-z]{3,6}:\/\//` | `makeAbsoluteURL` | Absolute URL with protocol prefix |
| 5916 | `/\]\([ \t]*([^#")][^ "\)]+)([ \t\)])/g` | `makeAbsoluteURL` | Markdown link URLs `](url)` for making them absolute |
| 5921 | `/\]\([ \t]*"([^#"][^"]+)"([ \t\)])/g` | `makeAbsoluteURL` | Markdown link URLs in quotes `]("url")` |
| 5926 | `/(src\|href)=(["'])([^#>][^"'\n>]+)\2/g` | `makeAbsoluteURL` | HTML `src=` or `href=` attributes with relative URLs |
| 5931 | `/(\n\[[^\]>\n \t]:[ \t]*)([^# \t][^ \t]+)"/g` | `makeAbsoluteURL` | Reference link definitions with relative URLs |

## 4. Table Parsing (`replaceTables`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1947 | `/(?:\n[ \t]*(?:(?:\|?[^\n\|]+?(?:\|[^\n\|]+?)+\|?)\|\|[^\n\|]+\|)(?=\n))/` | `replaceTables` (TABLE_ROW) | A table row: line with pipe-separated cells, or a single cell wrapped in pipes |
| 1948 | `/\n[ \t]*(?:(?:\|? *\:?-+\:?(?: *\| *\:?-+\:?)+ *\|?\|)\|\|[\:-]+\|)(?=\n)/` | `replaceTables` (TABLE_SEPARATOR) | Table separator row with dashes and optional colons for alignment (e.g. `|:---:|---:|`) |
| 1949 | `/\n[ \t]*\[[^\n\|]+\][ \t]*(?=\n)/` | `replaceTables` (TABLE_CAPTION) | Table caption in brackets on its own line, e.g. `[Table 1: Results]` |
| 1950 | `new RegExp(TABLE_ROW + TABLE_SEPARATOR + TABLE_ROW + '+(' + TABLE_CAPTION + ')?', 'g')` | `replaceTables` (TABLE_REGEXP) | Complete table: header row + separator + data rows + optional caption |
| 1953 | `/^\|\|\|$/g` | `trimTableRowEnds` | Leading/trailing pipe characters on a table row |
| 1977 | `/:?-+:?/g` | `replaceTables` | Column alignment specifiers in separator row (`:---:`, `---:`, `:---`, `---`) |
| 2006 | `/ *\| */g` | `replaceTables` | Pipe delimiters between cells (with surrounding whitespace) |

## 5. List Processing (`replaceLists`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 2040 | `/^(\s*)(?:-\s*)?(?:\[ \]\|\u2610)(\s+)/mg` | `replaceLists` | Unchecked checkbox items: `- [ ]` or `[ ]` or Unicode ballot box |
| 2041 | `/^(\s*)(?:-\s*)?(?:\[[xX]\]\|\u2611)(\s+)/mg` | `replaceLists` | Checked checkbox items: `- [x]` or `[X]` or Unicode checked ballot box |
| 2043 | `/^(\s*\d+\.\s+)(?:\[ \]\|\u2610)(\s+)/mg` | `replaceLists` | Numbered list with unchecked checkbox: `1. [ ]` |
| 2044 | `/^(\s*\d+\.\s+)(?:\[[xX]\]\|\u2611)(\s+)/mg` | `replaceLists` | Numbered list with checked checkbox: `1. [x]` |
| 2049 | `/\n\s*\n/` | `replaceLists` (BLANK_LINES) | Two or more consecutive newlines (blank line separator) |
| 2053 | `/[:,][^\n]*\n/` | `replaceLists` (PREFIX) | Line ending with colon or comma (list prefix context) |
| 2056 | `/[ \t]*(?:\d+\.|-\|\+\|\*\|\u2611\|\u2610)[ \t]+/` | `replaceLists` (LIST_ITEM_START) | List item bullet: number+dot, dash, plus, asterisk, or checkbox unicode |
| 2064 | `new RegExp('^' + LIST_ITEM_START)` | `replaceLists` (listItemRegex) | List item at start of line |
| 2065 | `/^\s*$/` | `replaceLists` (blankLineRegex) | Blank line (only whitespace) |
| 2066 | `/[:,]\s*$/` | `replaceLists` (colonEndRegex) | Line ending with colon or comma |
| 2080 | `/^[ \t]+/` | `replaceLists` | Leading whitespace (tests indentation) |
| 2109-2110 | `new RegExp('(' + PREFIX + '\|' + BLANK_LINES + '\|<p>\\s*\\n\|<br>\\s*\\n?\|\\n\u2029LISTSTART\u2029\\n)' + LIST_BLOCK_PATTERN, 'gm')` | `replaceLists` (LIST_BLOCK_REGEXP) | Complete list block: preceded by blank lines/prefix, containing list items |
| 2134 | `/^\s*/` | `replaceLists` | Leading whitespace on a line (trimming) |
| 2142 | `/^\d+\.[ \t]/` | `replaceLists` | Ordered list marker: `1. ` at start of line |
| 2144 | `/^\d+/` | `replaceLists` | Starting number of an ordered list item |
| 2197 | `/^(\d+\.|-\|\+\|\*\|\u2611\|\u2610) /` | `replaceLists` | List item marker to strip when wrapping in `<li>` |
| 2208 | `/\s+$/` | `replaceLists` | Trailing whitespace |
| 2220 | `/\n\u2029LISTSTART\u2029\n/g` | `replaceLists` | Internal list-start sentinel marker |
| 2223 | `/\n\s*\n<\/li>/g` | `replaceLists` | Blank line before closing `</li>` (converted to paragraph spacing) |

## 6. Schedule/Timeline Lists (`replaceScheduleLists`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 2246 | `/^(?:[^\|<>\s-\+\*\d].*[12]\d{3}(?!\d).*?\|(?:[12]\d{3}(?!\.).*\d.*?)\|(?:\d{1,3}(?!\.).*[12]\d{3}(?!\d).*?))/` | `replaceScheduleLists` (BEGINNING) | Date line beginning: text with a 4-digit year (2000s or 1000s), or year followed by numbers |
| 2249 | `/[ \t]+([^ \t\n].*)\n/` | `replaceScheduleLists` (part of DATE_AND_TITLE) | Title text after the date's colon separator |
| 2253 | `/(?:[ \t]*\n)?((?:[ \t]+.+\n(?:[ \t]*\n){0,3})*)/` | `replaceScheduleLists` (EVENTS) | Indented event body lines following a date entry |
| 2257 | `new RegExp(ENTRY, 'gm')` | `replaceScheduleLists` (ENTRY_REGEXP) | Complete schedule entry: date + title + events |
| 2274 | `/([^\\])\./g` | `replaceScheduleLists` | Non-escaped dots in month name patterns |
| 2282 | `new RegExp(BLANK_LINE + '(' + ENTRY + '){2,}', 'gm')` | `replaceScheduleLists` | Two or more schedule entries preceded by a blank line |

## 7. Definition Lists (`replaceDefinitionLists`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 2542 | `/^.+\n:(?=[ \t])/` | `replaceDefinitionLists` (TERM) | Definition term: a non-empty line followed by `:` at start of next line |
| 2547 | `new RegExp('(' + TERM + DEFINITION + ')+', 'gm')` | `replaceDefinitionLists` | One or more term+definition pairs |
| 2562 | `/\s/` | `replaceDefinitionLists` | Whitespace character (tests if line starts with whitespace for definition body) |
| 2574 | `/\n\s*\n/` | `replaceDefinitionLists` | Blank line within a definition (triggers `<p>` wrapping) |

## 8. Table of Contents (`insertTableOfContents`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 2643 | `/<h([1-6])>(.*?)<\/h\1>/gi` | `insertTableOfContents` (headerRegex) | HTML header tags h1-h6 with their content |
| 2644 | `/<dt>(.*?)<\/dt>/gi` | `insertTableOfContents` (dtRegex) | Definition term tags (included in TOC) |
| 2703 | `/\u27E8L:\d+\u27E9/g` | `insertTableOfContents` | Line-number source markers (Unicode angle brackets around `L:nnn`) |
| 2708 | `/<a\s.*>(.*?)<\/a>/g` | `insertTableOfContents` | Anchor tags (stripped from TOC entries to get plain text) |
| 2736 | `/\u27E8L:\d+\u27E9/g` | `insertTableOfContents` | Line-number markers in definition terms |
| 2773 | `/((<a\s+\S+>&nbsp;<\/a>)\s*)*?<h\d>/i` | `insertTableOfContents` | First header in document (with possible preceding anchor tags) |
| 2781 | `/<h1>.*?<\/h1>\s*<div [^>]*><\/div>/` | `insertTableOfContents` | H1 header followed by afterTitles div (for TOC insertion point) |
| 2782 | `/<div [^>]*>.*?<\/div>\s*<div [^>]*><\/div>/` | `insertTableOfContents` | Title div followed by afterTitles div (alternative TOC insertion point) |

## 9. Header Section Wrapping (`wrapHeaderSections`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 2872 | `/<h([1-6])[^>]*>/g` | `wrapHeaderSections` | Opening header tags h1-h6 |
| 2940 | `/^\s*$/` | `wrapHeaderSections` | Empty/whitespace-only text between sections |
| 2947 | `/^\s*$/` | `wrapHeaderSections` | Empty/whitespace-only text between headers |

## 10. CSS Stylesheet Remapping (`h1TitleOutputStylesheet`)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1651 | `/\.md div\.title\{([^}]+)\}/g` | `h1TitleOutputStylesheet` | CSS rule for `.md div.title{...}` (remapped to h1) |
| 1655-1659 | `/\.md h[1-5]([,\{])/g` | `h1TitleOutputStylesheet` | CSS rules for `.md h1` through `.md h5` (shifted down one level) |
| 1662-1666 | `/\.nonumberh[1-5]\b/g` | `h1TitleOutputStylesheet` | CSS classes `.nonumberh1` through `.nonumberh5` (shifted) |
| 1669 | `/(?=\.md [h\.])/` | `h1TitleOutputStylesheet` | Split point before `.md h` or `.md .` CSS rules |
| 1671 | `/\b(h[1-6]\|nonumberh[1-6]\|tocHeader)\b/` | `h1TitleOutputStylesheet` | Header-related CSS class names (filter predicate) |

## 11. Escape/Protection Utilities

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 2842 | `/([\.\[\]\(\)\*\+\?\^\$\\\{\}\|])/g` | `escapeRegExpCharacters` | Regex metacharacters (escaped for use in dynamic RegExp) |
| 2849-2850 | `/\n/g` | `isolated` | Newline characters (counts newlines in pre/post spaces) |
| 3244 | `/[.*+?^${}()\|[\]\\]/g` | `markdeepToHTML` (paragraph detection) | Regex metacharacters (for escaping fence indent) |

## 12. Diagram Detection and Processing

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1781 | `/\S/` | `advance` (in `extractDiagram`) | Any non-whitespace character (detects text left of diagram) |
| 1785 | `/[^ *\t\n\r]/` | `advance` (in `extractDiagram`) | Non-space/non-asterisk/non-whitespace character (detects text right of diagram) |
| 1816 | `/[ \t]+$/` | `advance` (in `extractDiagram`) | Trailing whitespace on diagram line |
| 1863 | `/^[ \t]*[ \t]/` | `advance` (in `extractDiagram`) | Leading whitespace (collapsed in diagram after-string) |
| 1863 | `/[ \t][ \t]*$/` | `advance` (in `extractDiagram`) | Trailing whitespace (collapsed in diagram after-string) |
| 3426 | `/^[ \n]*[ \t]*\[[^\n]+\][ \t]*(?=\n)/` | `replaceDiagrams` (CAPTION_REGEXP) | Caption after a diagram: `[caption text]` on its own line |
| 3488 | `/--\+\|\+--\|--\.\|\.--\|'--\|--'\|<--\|-->\|\|.*\|\|^\s*[\|+.'v^*]\s*$/` | `looksLikeDiagram` | ASCII art characters: corners (`--+`, `+--, `--.'`, etc.), arrows, pipes, vertices |
| 4653 | `/([a-zA-Z]{2})o/g` | `diagramToSVG` | Letter 'o' preceded by two letters (hidden to prevent false circle detection) |
| 4654 | `/o([a-zA-Z]{2})/g` | `diagramToSVG` | Letter 'o' followed by two letters |
| 4655 | `/([a-zA-Z\ue004])o([a-zA-Z\ue004])/g` | `diagramToSVG` | Letter 'o' between two letters (hidden) |
| 5597 | `/[^a-zA-Z0-9]\|[ov]/` | `isEmptyOrVertex` | Non-alphanumeric characters or 'o'/'v' (vertex/empty detection in diagrams) |
| 5813 | `/[\u2B22\u2B21]/` | `findReplacementCharacters` | Unicode hexagon characters (black/white hexagon used as diagram markers) |
| 5840 | `new RegExp(HIDE_O, 'g')` | `findReplacementCharacters` | Hidden 'o' placeholder (restored after diagram processing) |

## 13. Code Fence Processing

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3515 | `/\n([ \t]*)(\`{3,}\|~{3,})([ \t]*[^~\`\s]\S*(?:[ \t]+.+)?)\n([\s\S]+?)\n\1\2[ \t]*\n/g` | `cleanupCodeFences` (labeledFencePattern) | Labeled fenced code block: opening fence with language, content, matching closing fence |
| 3523 | `/\n([ \t]*)(\`{3,}\|~{3,})[ \t]*\n([\s\S]+?)\n\1\2[ \t]*\n/g` | `cleanupCodeFences` | Unlabeled fenced code block (no language specified) |
| 3533 | `/\n\ue000FENCE(\d+)\ue001\n/g` | `cleanupCodeFences` | Fence placeholder sentinel (restored after processing) |
| 3538 | `/\n([ \t]*)(\`{3,}\|~{3,})[ \t]*diagram[ \t]*\n([\s\S]+?)\n\1\2[ \t]*\n/g` | `cleanupCodeFences` | Fenced block with "diagram" label (processed as ASCII art) |
| 3539 | `new RegExp('(^\|\n)' + indent, 'g')` | `cleanupCodeFences` | Indentation prefix to strip from fenced content |
| 3565 | `new RegExp('\n([ \\t]*)(' + symbol + '{3,})([ \\t]*[^~\`\\s]\\S*)([ \\t]+.+)?\n([\\s\\S]+?)\n\\1\\2[ \t]*\n([ \\t]*\\[.+(?:\n.+){0,3}\\])?', 'g')` | `processLabeledCodeFences` | Labeled fenced code block with optional trailing caption |
| 3575 | `new RegExp('(^\|\n)' + indent, 'g')` | `processLabeledCodeFences` | Indentation stripping for labeled fences |
| 3581 | `new RegExp('\\n([ \\t]*)' + symbol + '{3,}([ \\t]*\\S+)([ \\t]+.+)?\n([\\s\\S]*)')` | `processLabeledCodeFences` | Nested fence within a labeled fence |
| 3601 | `/^(.*)$/gm` | `processLabeledCodeFences` | Every line of code (wrapped in span for line-number display) |
| 7417 | `/<\S/` | `makeMarkdownCodeBrowserSafe` (DANGEROUS_CODE_RE) | HTML-like content inside code (`<` followed by non-space) |
| 7418 | `new RegExp('^(\`\`\`+\|~~~+)[^\\n]*\\n([\\s\\S]*?)^\\1[ \\t]*$', 'mg')` | `makeMarkdownCodeBrowserSafe` (FENCED_BLOCK_RE) | Fenced code blocks (for pre-escaping dangerous HTML inside code) |
| 7419 | `/(?<!\`)\`(?!\`)([^\`\n]+)\`(?!\`)/g` | `makeMarkdownCodeBrowserSafe` (INLINE_CODE_RE) | Inline code spans (single backtick, not double) |
| 7420 | `/<([ \u200b\\])(\/?)script/gi` | `makeMarkdownCodeBrowserSafe` (SCRIPT_TAG_RE) | Escaped script tags inside code |

## 14. Inline Code

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3696 | `/(^\|[^\\])\`(.*?(?:\n.*?)?[^\n\\\`])\`(?!\d)/g` | `markdeepToHTML` (inlineCodeRegexp) | Inline code: backtick-delimited text, allowing one line break, not followed by digit |
| 3700 | `/^[a-zA-Z]:\\\|^\/[a-zA-Z_\.]\|^[a-z]{3,5}:\/\//` | `markdeepToHTML` (filenameRegexp) | File paths (`C:\...`, `/path`, `http://`) to detect if inline code is a filename |
| 3714 | `/\\\`/g` | `markdeepToHTML` | Escaped backtick `\`` (restored after inline code processing) |

## 15. LaTeX/Math

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3733 | `/(\$\$[\s\S]+?\$\$)/g` | `markdeepToHTML` | Display math: `$$...$$` |
| 3745 | `/((?:[^\w\d]))\$(\S(?:[^\$]*?\S(?!US\|Can))??)\$(?![\w\d])/g` | `markdeepToHTML` | Inline math: `$...$` with non-word boundaries, excluding `$US` and `$Can` |
| 3755 | `/((?:[^\w\d]))\$([ \t][^\$]+?[ \t])\$(?![\w\d])/g` | `markdeepToHTML` | Inline math with spaces: `$ ... $` |
| 3758 | `/(\\\([\s\S]+?\\\))/g` | `markdeepToHTML` | LaTeX inline math: `\(...\)` |
| 3759 | `/(\\begin\{equation\}[\s\S]*?\\end\{equation\})/g` | `markdeepToHTML` | LaTeX equation environment |
| 3760 | `/(\\begin\{eqnarray\}[\s\S]*?\\end\{eqnarray\})/g` | `markdeepToHTML` | LaTeX eqnarray environment |
| 3761 | `/(\\begin\{equation\*\}[\s\S]*?\\end\{equation\*\})/g` | `markdeepToHTML` | LaTeX unnumbered equation environment |
| 6115 | `/NC/g` | `(top-level MathJax setup)` | `NC` placeholder replaced with `\newcommand` in MathJax preamble |
| 6139 | `/(?:\$\$[\s\S]+\$\$)\|(?:\\begin{)/m` | `needsMathJax` | Display math or LaTeX begin-environment (detects if MathJax is needed) |
| 6140 | `/\\\(.*\\\)/` | `needsMathJax` | Inline LaTeX math `\(...\)` |

## 16. Headers (ATX and Setext)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3769 | `/(?:^\|\s*\n)(.+?)\n[ \t]*={3,}[ \t]*\n/g` | `markdeepToHTML` | Setext H1: text followed by line of `===` |
| 3772 | `/(?:^\|\s*\n)(.+?)\n[ \t]*-{3,}[ \t]*\n/g` | `markdeepToHTML` | Setext H2: text followed by line of `---` |
| 3789 | `new RegExp(/^\s*/.source + '#{' + i + ',' + i + '}(?:[ \t])([^\n]+?)#*[ \t]*' + OPTIONAL_LINE_NUM + '\n', 'gm')` | `markdeepToHTML` | ATX headers: `#` through `######` with optional trailing `#`s and line number |
| 3796-3799 | `new RegExp(/^\s*/.source + '\\(#{' + i + ',' + i + '}\\)(?:[ \t])([^\n]+?)\\(?#*\\)?' + OPTIONAL_LINE_NUM + '\\n[ \t]*\n', 'gm')` | `markdeepToHTML` | Parenthesized non-numbered headers: `(#)` through `(######)` |
| 3332 | `/^[ \t]*=+[ \t]*$/` | `markdeepToHTML` (paragraph detection) | Setext underline with equals signs (detects non-paragraph lines) |
| 3332 | `/^[ \t]*-+[ \t]*$/` | `markdeepToHTML` (paragraph detection) | Setext underline with dashes |
| 3346 | `/^#{1,6}\s/` | `markdeepToHTML` (paragraph detection) | ATX header prefix |

## 17. Horizontal Rules and Page Breaks

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3805 | `/\n[ \t]*((\*\|-\|_)[ \t]*){3,}[ \t]*\n/g` | `markdeepToHTML` | Horizontal rule: 3+ of `*`, `-`, or `_` with optional spaces |
| 3808 | `/\n[ \t]*\+{5,}[ \t]*\n/g` | `markdeepToHTML` | Page break: 5+ `+` characters on a line |
| 3352 | `/^[ \t]*[-*_]{3,}[ \t]*$/` | `markdeepToHTML` (paragraph detection) | Horizontal rule pattern (non-paragraph detection) |

## 18. Admonitions

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3811 | `/^!!![ \t]*([^\s"'><&\:]*)\:?(.*)\n([ \t]{3,}.*\s*\n)*/gm` | `markdeepToHTML` | Admonition block: `!!!` followed by optional CSS class and title, with indented body lines |

## 19. Blockquotes

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3631 | `/(?:\n>.*){2,}/g` | `markdeepToHTML` | Blockquote: 2+ lines starting with `>` |
| 3634 | `/\n>/g` | `markdeepToHTML` | Leading `>` on blockquote lines (stripped) |
| 3645 | `/\n[ \t]*"(.*(?:\n.*)*)"[ \t]*(?:\n[ \t]*)?\n([ \t]{2,}\S.*)?\n/g` | `markdeepToHTML` | Blockquote attribution: quoted text followed by indented author name |
| 3357 | `/^[ \t]*>/` | `markdeepToHTML` (paragraph detection) | Blockquote line prefix |

## 20. Footnotes and Endnotes

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3830 | `/[ \t]*\[\^([^\]\n\t ]+)\](?!:)/g` | `markdeepToHTML` | Footnote reference: `[^name]` (not followed by `:` which would be a definition) |
| 3831 | `/(\S)[ \t]*\[\^([^\]\n\t ]+)\]/g` | `markdeepToHTML` | Footnote reference after non-whitespace character |
| 4325 | `/\n\[\^(\S+)\]: ((?:.+?\n?)*)/g` | `markdeepToHTML` | Footnote definition: `[^name]: content` |

## 21. Citation/Bibliography References

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3836 | `/\n\[#(\S+)\]:[ \t]+((?:[ \t]*\S[^\n]*\n?)*)/g` | `markdeepToHTML` | Bibliography entry definition: `[#name]: text` |
| 3844 | `/\[(#[^\)\(\[\]\.#\s]+(?:\s*,\s*#(?:[^\)\(\[\]\.#\s]+))*)\]/g` | `markdeepToHTML` | Citation reference(s): `[#name]` or `[#name1, #name2]` |
| 3850 | `/#\| /g` | `markdeepToHTML` | Hash and space characters (stripped from citation names) |

## 22. Reference Links

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3864 | `/^\[([^\^#].*?)\]:(.*?)$/gm` | `markdeepToHTML` | Reference link definition: `[name]: url` (not footnotes or citations) |
| 3360 | `/^[ \t]*\[[^\]]+\]:[ \t]+\S/` | `markdeepToHTML` (paragraph detection) | Reference definition lines |
| 3361 | `/^[ \t]*\[[^\]]+\][ \t]*$/` | `markdeepToHTML` (paragraph detection) | Caption lines (bracket text alone on a line) |

## 23. Email Auto-Linking

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3870 | `/(?:<\|(?!<)\b)(\S+@(\S+\.)+?\S{2,}?)(?:$\|>\|(?=<)\|(?=\s)(?!>))/g` | `markdeepToHTML` | Email addresses: `user@domain.tld` optionally in angle brackets |
| 3871 | `/http:\|ftp:\|https:\|svn:\|:\/\/\|\.html\|\(\|\)\|\]/` | `markdeepToHTML` | URL-like patterns (used to reject false email matches) |

## 24. URL Auto-Linking

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 4381 | `/(?:<\|(?!<)\b)(\w{3,6}:\/\/.+?)(?:$\|>\|(?=<)\|(?=\s\|\u00A0)(?!<))/g` | `markdeepToHTML` | Bare URLs with protocol: `http://...`, `https://...`, etc. |

## 25. Image and Media Processing

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3889 | `/attrib\s*=\s*(?<quote>['"])(([^\n'"])*)\k<quote>/` | `formatImage` | Image `attrib` attribute in markdown image syntax |
| 3895 | `/attrib-url\s*=\s*(?<quote>['"]?)(([^\n'"])*)\k<quote>/` | `formatImage` | Image `attrib-url` attribute |
| 3901 | `/\.(mp4\|m4v\|avi\|mpg\|mov\|webm)$/i` | `formatImage` | Video file extensions |
| 3904 | `/\.(mp3\|mp2\|ogg\|wav\|m4a\|aac\|flac)$/i` | `formatImage` | Audio file extensions |
| 3907 | `/^https:\/\/(?:www\.)?(?:youtube\.com\/\S*?v=\|youtu\.be\/)([\w\d-]+).*?(?:\?t=(\d*))?(&.*)?$/i` | `formatImage` | YouTube video URLs (extracts video ID and optional timestamp) |
| 3915 | `/^https:\/\/(?:www\.)?vimeo.com\/\S*?\/([\w\d-]+)$/i` | `formatImage` | Vimeo video URLs (extracts video ID) |
| 3925 | `/class *= *(["'])([^'"]+)\1/` | `formatImage` | CSS class attribute with quotes |
| 3929 | `/class *= *([^"' ]+)/` | `formatImage` | CSS class attribute without quotes |
| 3978 | `/\(http:\/\/g.gravizo.com\/(.*g)\?((?:[^\(\)]\|\([^\(\)]*\))*)\)/gi` | `markdeepToHTML` | Gravizo diagram URLs |
| 4021 | `/!\[((?:[^\n\]\\\]\|\\[\[\]]).*?\n?.*?\n?.*?\n?.*?\n?.*?)\]([[\(])/g` | `markdeepToHTML` | Multi-line image caption: `![caption spanning up to 5 lines](` or `![...][` |
| 4029 | `/(!\[.*?\])\[([^<>\[\]\s]+?)([ \t][^\n\[\]]{0,200})?\]/g` | `markdeepToHTML` | Image with reference link: `![alt][ref]` with optional attributes |
| 4053 | `/\n((?:[ \t]*!\[[^\]]{0,100}\]\([^<>\s\)]+(?:[^\n\)]{0,200})?\))+[ \t]*(?:\ue010[0-9a-w]{4}\ue010)?)(?=\n)/g` | `markdeepToHTML` (imageLineRegex) | Line(s) of images for grid layout detection |
| 4110 | `/[ \t]*!\[[^\]]{0,100}\]\([^\)\s]+([^\)]{0,200})?\)/g` | `markdeepToHTML` | Individual images within an image grid row |
| 4126 | `/(\s*)!\[\]\(("?)([^"<>\s\)]+)\2(\s[^\)]{0,200})?\)(\s*)/g` | `markdeepToHTML` | Captionless image: `![](url)` |
| 4148 | `/(\s*)!\[((?:[^\[\]\\]\|\\[\[\]])+?)\]\(("?)([^"<>\s\)]+)\3(\s[^\)]{0,200})?\)(\s*)/` | `markdeepToHTML` | Captioned image: `![caption](url)` |
| 4151 | `/\\([\[\]])/g` | `markdeepToHTML` | Escaped brackets in image captions |
| 4158 | `/((?:max-)?width)\s*:\s*[^;'"]*/g` | `markdeepToHTML` | CSS `width` or `max-width` style in image attributes |
| 4164 | `/((?:max-)?width)\s*=\s*('\S+?'\|"\S+?")/g` | `markdeepToHTML` | HTML `width` or `max-width` attribute on images |
| 3363 | `/^[ \t]*!\[/` | `markdeepToHTML` (paragraph detection) | Image line start |
| 3364 | `/\]\([^"<>\s)]+[^)]*\)\s*$/` | `markdeepToHTML` (paragraph detection) | Image URL closing `](url...)` |
| 3365 | `/^[ \t]*(?:!\[[^\]]*\]\([^)]*\)[ \t]*)+[ \t]*$/` | `markdeepToHTML` (paragraph detection) | Image grid lines |

## 26. Standard Markdown Links

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3985 | `/(^\|[^!])\[((?:[^\[\]\\]\|\\[\[\]])+?)\]\(("?)([^<>\s"\)]+)\3(\s+[^\)]{0,200})?\)/g` | `markdeepToHTML` | Inline link: `[text](url "title")` (not preceded by `!`) |
| 3988 | `/\\([\[\]])/g` | `markdeepToHTML` | Escaped brackets in link text |
| 3993 | `/(^\|[^!])\[[ \t]*?\]\(("?)([^<>\s"\)]+)\2\)/g` | `markdeepToHTML` | Empty-text link: `[](url)` |
| 3999 | `/(^\|[^!])\[((?:[^\[\]\\]\|\\[\[\]])+)\]\[([^\[\]]*)\]/g` | `markdeepToHTML` | Reference-style link: `[text][ref]` |
| 4001 | `/\\([\[\]])/g` | `markdeepToHTML` | Escaped brackets in reference link text |

## 27. Cross-References

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3959 | `/\b(equation\|eqn\.\|eq\.)\s*\[([^\s\]]+)\]/gi` | `markdeepToHTML` | Equation cross-reference: `equation [label]`, `eqn. [label]`, `eq. [label]` |
| 3966 | `/\b(figure\|fig\.\|table\|tbl\.\|listing\|lst\.)\s*\[([^\s\]]+)\](?=\()/gi` | `markdeepToHTML` | Figure/table/listing cross-reference followed by `(`: `figure [label](` |
| 3366 | `/\b(figure\|fig\.\|table\|tbl\.\|listing\|lst\.\|diagram\|section\|subsection\|chapter\|sec\.)\s+\[/i` | `markdeepToHTML` (paragraph detection) | Cross-reference keyword followed by `[` |

## 28. Inline Formatting

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1901 | `new RegExp(pattern, 'g')` | `replaceMatched` | Generic delimiter-based matching (used for bold, italic, etc.) |
| 4201 | `/\*\*/` | `markdeepToHTML` (via `replaceMatched`) | Bold delimiter: `**` |
| 4202 | `/__/` | `markdeepToHTML` (via `replaceMatched`) | Bold delimiter: `__` |
| 4205 | `/\*/` | `markdeepToHTML` (via `replaceMatched`) | Italic delimiter: `*` |
| 4206 | `/_/` | `markdeepToHTML` (via `replaceMatched`) | Italic delimiter: `_` |
| 4209 | `/\~\~([^~].*?)\~\~/g` | `markdeepToHTML` | Strikethrough: `~~text~~` |

## 29. Smart Typography

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 4220 | `/\(\(([^)]*(?:\([^)]*\))*[^)]*)\)\)/g` | `markdeepToHTML` | Marginal note / aside: `((text))` |
| 4227 | `/(^\|[ \t->])(")(?=\w)/gm` | `markdeepToHTML` | Opening smart quote: `"` preceded by start/space/tab/dash/greater-than, followed by word char |
| 4228 | `/([A-Za-z\.,:;\?!=<])(")(?=$\|\W)/gm` | `markdeepToHTML` | Closing smart quote: `"` preceded by letter/punctuation, followed by end/non-word |
| 4232 | `/(\s\|^)<==(\s)/g` | `markdeepToHTML` | Left double arrow: `<==` surrounded by whitespace |
| 4233 | `/(\s\|^)->(\s)/g` | `markdeepToHTML` | Right arrow: `->` surrounded by whitespace |
| 4235 | `/(\s\|^)-->(\s)/g` | `markdeepToHTML` | Long right arrow: `-->` |
| 4236 | `/(\s\|^)==>(\s)/g` | `markdeepToHTML` | Right double arrow: `==>` |
| 4237 | `/(\s\|^)<-(\s)/g` | `markdeepToHTML` | Left arrow: `<-` |
| 4238 | `/(\s\|^)<--(\s)/g` | `markdeepToHTML` | Long left arrow: `<--` |
| 4239 | `/(\s\|^)<==>(\s)/g` | `markdeepToHTML` | Bi-directional double arrow: `<==>` |
| 4240 | `/(\s\|^)<->(\s)/g` | `markdeepToHTML` | Bi-directional arrow: `<->` |
| 4244 | `/([^-!\:\|])---([^->\:\|])/g` | `markdeepToHTML` | Em-dash: `---` (not in table/diagram context) |
| 4248 | `/([^-!\:\|])--([^->\:\|])/g` | `markdeepToHTML` | Em-dash: `--` (not in table/diagram context) |
| 4254 | `/((?:^\|[^a-zA-Z0-9])(?:(?:number\|key\|sku\|id\|hash\|commit\|git)[:\*]*[ \t]*)?)([1-9]\d*[a-z]*)([ \t]?)x([ \t]?)(\d+)/gi` | `markdeepToHTML` | Multiplication sign: `NxM` converted to `N&times;M` (unless preceded by identifier keywords) |
| 4256 | `/(?:number\|key\|sku\|id\|hash\|commit\|git)[:\*]*\s*$/i` | `markdeepToHTML` | Identifier keyword prefix (prevents `x` -> `&times;` conversion) |
| 4271 | `/([\s\(\[<\|])-(\d)/g` | `markdeepToHTML` | Minus sign: `-` before a digit after whitespace/bracket |
| 4272 | `/(\d) - (\d)/g` | `markdeepToHTML` | Minus sign: digit ` - ` digit |
| 4275 | `/\^([-+]?\d+)\b/g` | `markdeepToHTML` | Superscript number: `^42`, `^-1` |
| 4295 | `/(\d+?)[ \t-]?\n?degree(?:s?)/g` | `markdeepToHTML` | Degree symbol: `90 degrees` or `90degree` |

## 30. Line Breaks and Paragraphs

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 4278 | `/(^\|\s\|\b)\\(pagebreak\|newpage)(\b\|\s\|$)/gi` | `markdeepToHTML` | Page break command: `\pagebreak` or `\newpage` |
| 4304 | `new RegExp('(^\|[^\\\\])\\\\' + defined_optional_marker + '\\n', 'gm')` | `markdeepToHTML` | Hard line break: backslash at end of line `\` + newline |
| 4311 | `new RegExp('(\\S)  +' + defined_optional_marker + '\\n(?![ \\t]*\\n)(?![ \\t]*(?:-\|\\+\|\\*\|\\d+\\.\|\\u2610\|\\u2611)[ \\t])', 'g')` | `markdeepToHTML` | Soft line break: two+ trailing spaces before newline (not before blank line or list item) |
| 4317 | `/(?:<p>)?\n\s*\n+(?!<\/p>)/gi` | `markdeepToHTML` | Paragraph break: blank line(s) between content |
| 4321 | `/<p>(?:\s\n)*<\/p>/gi` | `markdeepToHTML` | Empty paragraphs (removed) |

## 31. Title/Subtitle Detection

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 4407 | `/^\s*(?:<\/p><p>)?\s*<strong.*?>([^ \t\*].*?[^ \t\*])<\/strong>[^\n]*\n/` | `markdeepToHTML` (TITLE_PATTERN) | Title: bold text at document start |
| 4408 | `/([ {4,}\t][ \t]*\S.*\n)*/` | `markdeepToHTML` (ALL_SUBTITLES_PATTERN) | Subtitle lines: indented text following title |
| 4413 | `new RegExp(TITLE_PATTERN + ALL_SUBTITLES_PATTERN, 'g')` | `markdeepToHTML` | Complete title block: title + subtitles |
| 4421 | `/[ \t]*(\S.*?)\n/g` | `markdeepToHTML` | Individual subtitle lines |
| 4426 | `/[\u0009\u0020\u00A0\u2000-\u200A\u3000]/g` | `markdeepToHTML` | Various whitespace characters (normalized to space in title tag) |
| 4447-4448 | `new RegExp('(<a [^>]*>&nbsp;<\\/a>)<' + titleTag + '>(.*?)<\\/' + closingTag + '>')` | `markdeepToHTML` | Title header tag with preceding anchor (for removal after title extraction) |

## 32. Paragraph Detection (Non-Paragraph Line Classification)

These patterns in `markdeepToHTML` (around lines 3296-3385) classify lines as "structural" (non-paragraph) during the paragraph-wrapping phase:

| Line | Pattern | What It Matches |
|------|---------|-----------------|
| 3222 | `/^[ \t]*<\/script>/i` | Closing script tag |
| 3229 | `/^[ \t]*<\/style>/i` | Closing style tag |
| 3236 | `/^[ \t]*<\/pre>/i` | Closing pre tag |
| 3265 | `/^[ \t]*<script[\s>]/i` | Opening script tag |
| 3268 | `/<\/script>/i` | Closing script tag (inline) |
| 3276 | `/^[ \t]*<style[\s>]/i` | Opening style tag |
| 3278 | `/<\/style>/i` | Closing style tag (inline) |
| 3286 | `/^[ \t]*<pre[\s>]/i` | Opening pre tag |
| 3288 | `/<\/pre>/i` | Closing pre tag (inline) |
| 3296 | `/^([ \t]*)(~{3,}\|\`{3,})/` | Fence opening: 3+ tildes or backticks |
| 3315 | `/^[ \t]*\*/` | Asterisk-prefixed lines (potential diagram/list) |
| 3332 | `/^[ \t]*=+[ \t]*$/` | Setext H1 underline (equals) |
| 3332 | `/^[ \t]*-+[ \t]*$/` | Setext H2 underline (dashes) |
| 3334 | `/[\|:]/` | Pipe or colon on underline (indicates table, not setext) |
| 3346 | `/^#{1,6}\s/` | ATX header |
| 3350 | `/^[ \t]*[~\`]{3,}/` | Code fence |
| 3351 | `/^[ \t]*=+[ \t]*$/` | Setext underline (=) |
| 3352 | `/^[ \t]*[-*_]{3,}[ \t]*$/` | Horizontal rule |
| 3354 | `/^[ \t]*\|/` | Table row (starts with pipe) |
| 3356 | `/^[ \t]*:?-+:?[ \t]*\|/` | Table separator row |
| 3357 | `/^[ \t]*>/` | Blockquote |
| 3358 | `/^[ \t]*\d+\.[ \t]/` | Numbered list item |
| 3359 | `/^[ \t]*[-+*][ \t]/` | Bullet list item |
| 3360 | `/^[ \t]*\[[^\]]+\]:[ \t]+\S/` | Reference link definition |
| 3361 | `/^[ \t]*\[[^\]]+\][ \t]*$/` | Caption line |
| 3362 | `/^[ \t]*!!!/` | Admonition |
| 3363 | `/^[ \t]*!\[/` | Image |
| 3364 | `/\]\([^"<>\s)]+[^)]*\)\s*$/` | Image URL closing |
| 3365 | `/^[ \t]*(?:!\[[^\]]*\]\([^)]*\)[ \t]*)+[ \t]*$/` | Image grid |
| 3366 | `/\b(figure\|fig\.\|table\|tbl\.\|listing\|lst\.\|diagram\|section\|subsection\|chapter\|sec\.)\s+\[/i` | Cross-reference keywords |
| 3373 | `/[A-Za-z0-9]/` | Any alphanumeric character (detects text content for paragraph) |
| 3385 | `/\S/` | Any non-whitespace (finds first non-whitespace position) |

## 33. Caption Processing

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 1919 | `/\s+\[(?<ref>.+?)\]:(?<text>.*[^\]])\]?/` | `createTarget` (part of pattern) | Caption with reference: `[refname]: caption text` |
| 3426 | `/^[ \n]*[ \t]*\[[^\n]+\][ \t]*(?=\n)/` | `replaceDiagrams` (CAPTION_REGEXP) | Standalone caption line after a diagram |

## 34. Comments

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 3668 | `/<!--((?!->\|>)[\s\S]*?)-->/g` | `markdeepToHTML` | HTML comments `<!-- ... -->` (removed; carefully avoids matching arrows `-->` or `>`) |

## 35. Source Line Markers

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 6163 | `/\u27E8L:(\d+)\u27E9/g` | `attributeSourceLines` | Line-number markers `<<L:nnn>>` (Unicode angle brackets) |
| 6206 | `/\u27E8L:\d+\u27E9/g` | `attributeSourceLines` | Same markers for cleanup from text nodes |
| 3141 | `/\u27E8L:\d+\u27E9/g` | `markdeepToHTML` (makeHeaderFunc) | Line markers in headers (cleaned for anchor generation) |
| 3148 | `/\u27E8L:\d+\u27E9/g` | `markdeepToHTML` (makeHeaderFunc) | Same (for numbered headers) |
| 7141 | `/\u27E8L:\d+\u27E9/g` | `headerAnchor` | Same (for header anchor generation) |
| 7161 | `/\u27E8L:\d+\u27E9/g` | `definitionAnchor` | Same (for definition anchor generation) |
| 7171 | `/\u27E8L:\d+\u27E9/g` | `definitionAnchor` | Same (for definition anchor header context) |

## 36. Include/Insert Commands

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 5859 | `/([^?]+)(?:\?id=(inc\d+)&p=([^&]+))?/` | `processInsertCommands` | URL parsing: base path + optional `?id=incN&p=path` query params |
| 5973 | `/^(inc\d+)=/` | `messageCallback` | Include ID prefix in postMessage data |
| 6002 | `/(?:^\|\s)\((insert\|embed)[ \t]+(\S+\.\S*)[ \t]+(height=[a-zA-Z0-9.]+[ \t]+)?here\)\s/g` | `messageCallback` | Include/embed commands: `(insert file.ext here)` or `(embed file.html height=400px here)` |
| 6004 | `/\?.*$/` | `messageCallback` | Query string on included file URL (stripped for extension detection) |
| 6009 | `/=/g` | `messageCallback` | Equals signs in params (converted to colons for CSS style) |

## 37. Document Format Detection

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 6104 | `/markdeep\S*?\.js$/i` | `isMarkdeepScriptName` | Markdeep script filename |
| 6412 | `/\?.*noformat.*/i` | `formatDocument` | `?noformat` URL query parameter |
| 6522 | `/<!-- Markdeep:.+$/gm` | `formatDocument` | Markdeep comment line at end of document |
| 6703 | `/\?.*export.*/i` | `formatDocument` | `?export` URL query parameter |

## 38. Source Cleanup

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 6263 | `/&/g`, `/</g`, `/>/g` | `createSourceViewUI` | HTML entities in source view (escaped for display) |
| 6428 | `/(:?^[ \t]*\n)\|(:?\n[ \t]*)$/g` | `formatDocument` | Leading/trailing blank lines in source |
| 6433 | `new RegExp('\u2013', 'g')` | `formatDocument` | En-dash character (restored to `--`) |
| 6434 | `new RegExp('\u2014', 'g')` | `formatDocument` | Em-dash character (restored to `---`) |

## 39. UI Interaction

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 6357 | `/^H\d$/` | `updateMenuItemText` | Header tag name (H1-H6) for context menu |
| 6556 | `/^H(\d)$/` | `onContextMenu` | Header tag name with level capture |
| 6974 | `/^(mailto\|javascript\|tel\|data):/i` | `hidePreview` | Non-navigable URL schemes |

## 40. Markdown Table Generation (Utility)

| Line | Pattern | Function | What It Matches |
|------|---------|----------|-----------------|
| 7252 | `/\n/g` | `generateMarkdownTable` | Newlines in table cells (converted to `<br>`) |

## 41. Minified highlight.js Regexes (Lines 7470-8784)

The embedded highlight.js library (minified) contains approximately 870 regex patterns used exclusively for **syntax highlighting** of code blocks. These are NOT used for markdown parsing. They cover language grammars for: JavaScript, Bash, C, C++, CoffeeScript, C#, CSS, Go, Haskell, HTTP, Java, JSON, Kotlin, Lisp, Julia, and others.

Key categories within highlight.js:

| Category | Example Patterns | Purpose |
|----------|-----------------|---------|
| String literals | `/"/`, `/'/`, `/"""/`, `/\`/` | Match string delimiters in code |
| Comments | `/#.*$/`, `/\/\*\*(?!\/)/`, `/\{-/` | Match comment syntax per language |
| Numbers | `/\b(0b[01']+)/`, `/-?\b\d(_?\d)*/` | Match numeric literals |
| Keywords | `/\bclass/`, `/\bfunction/`, `/\bimport/` | Match language keywords |
| Operators | `/=\s*/`, `/:=/`, `/<:/` | Match operators |
| Types | `/\b[A-Z][a-z]+([A-Z][a-z]*\|\d)*/` | Match type names (PascalCase) |
| Preprocessor | `/#\s*[a-z]+\b/` | Match preprocessor directives |
| Regex engine | `/\[(?:[^\\\]]\|\\.)*\]\|\\(\\?\|\\([1-9][0-9]*)\|\\./` | highlight.js internal regex parsing |
| Language detection | `/^(no-?highlight)$/i`, `/\blang(?:uage)?-([\w-]+)\b/i` | Detect language class names |
| Common patterns | `/\b\B/`, `/\w+/`, `/\s+/` | Word boundaries, whitespace |

These are not cataloged individually as they serve syntax highlighting, not markdown/document structure parsing.

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Markdeep markdown parsing regexes | ~280 unique patterns |
| Markdeep utility/HTML regexes | ~50 patterns |
| Markdeep diagram detection regexes | ~15 patterns |
| highlight.js syntax highlighting regexes | ~870 patterns |
| **Total regex patterns in file** | **~1,215** |

The most regex-dense function is `markdeepToHTML` (lines 3059-4560), which contains approximately 160 regex operations covering: headers, code fences, blockquotes, links, images, footnotes, citations, inline formatting, smart typography, arrows, dashes, math, paragraphs, titles, and API documentation formatting.
