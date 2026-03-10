---
question: "Q3: List all public/exported API functions with signatures and one-line descriptions."
evaluator_start: "2026-03-10T12:59:09Z"
evaluator_end: "2026-03-10T13:00:10Z"
---

# Q3: Public/Exported API Functions

Markdeep exposes its public API via two mechanisms:

1. **`window.markdeep`** -- A frozen object assigned at line 7444, containing the primary API surface.
2. **`window.markdeepShowSourceView`** -- A standalone global function assigned at line 6304.
3. **`window.alreadyProcessedMarkdeep`** -- A boolean flag (not a function) set at line 6110/6483 to prevent recursive invocation.
4. **`module.exports = hljs`** -- The bundled highlight.js library exported at line 8775 (only active in Node/CommonJS environments; not part of Markdeep's own API).

Additionally, **`window.markdeepOptions`** is a user-supplied configuration object read by Markdeep (not exported by it), documented here for completeness since it contains the `onLoad` callback hook.

## `window.markdeep` Object (line 7444)

The `window.markdeep` object is frozen (`Object.freeze`) and contains the following members:

| Member | Internal Name | Line (declaration) | Signature | Description |
|--------|--------------|-------------------|-----------|-------------|
| `format` | `markdeepToHTML` | 3059 | `markdeepToHTML(str, elementMode)` | Converts a Markdeep string (or DOM element) to HTML body content; `elementMode` (default true) suppresses title/TOC generation when processing a sub-element rather than a whole document. |
| `formatDiagram` | `diagramToSVG` | 4644 | `diagramToSVG(diagramString, alignmentHint)` | Converts an ASCII art diagram string (without surrounding asterisk fences) to an SVG HTML string; `alignmentHint` is `'floatleft'`, `'floatright'`, or `''`. |
| `formatDocument` | `formatDocument` | 6410 | `formatDocument(mode)` | Processes the current page's DOM according to the given mode (`'markdeep'`, `'html'`, `'doxygen'`, or `'script'`), applying Markdeep formatting, inserting stylesheets, and invoking MathJax if needed. |
| `headerAnchor` | `headerAnchor` | 7133 | `headerAnchor(headerArray)` | Takes an array of nested header title strings and returns a disambiguated anchor name using the full hierarchy path separated by `/` (e.g., `'introduction/formsofbeing/addendum'`). |
| `definitionAnchor` | `definitionAnchor` | 7156 | `definitionAnchor(headerArray, term)` | Takes an array of header titles and a definition term, returns the anchor name for the definition using code-sensitive mangling (e.g., `'section/def-functionname-fcn'`). |
| `generateMarkdownTable` | `generateMarkdownTable` | 7188 | `generateMarkdownTable(rows, caption, outerBorder, padding, truncateSuffix)` | Generates a formatted Markdown table string from an array of row arrays; first row is the header; supports column specs (alignment, width), outer borders, cell padding, and truncation. |
| `makeMarkdownCodeBrowserSafe` | `makeMarkdownCodeBrowserSafe` | 7414 | `makeMarkdownCodeBrowserSafe(text)` | Wraps dangerous HTML-containing fenced code blocks and inline code spans in `<script type="preformatted">` tags and escapes `<script>` tags within them to prevent browser execution. |
| `langTable` | `LANG_TABLE` | 1416 | _(object, not a function)_ | Lookup table mapping ISO 639 language codes (e.g., `'en'`, `'ru'`, `'fr'`) to language objects containing localized keyword translations for Markdeep UI strings. |
| `stylesheet` | _(inline)_ | 7453 | `stylesheet()` | Returns the complete Markdeep CSS stylesheet string by concatenating the base stylesheet, section-numbering stylesheet, h1-title output stylesheet, and syntax-highlighting stylesheet. |

## `window.markdeepShowSourceView` (line 6304)

| Function | Line | Signature | Description |
|----------|------|-----------|-------------|
| `window.markdeepShowSourceView` | 6304 | `markdeepShowSourceView()` | Triggers the Markdeep source-view overlay, showing the original Markdeep source text; used by the section header right-click context menu. |

## `window.alreadyProcessedMarkdeep` (lines 6110, 6483)

| Member | Line | Type | Description |
|--------|------|------|-------------|
| `window.alreadyProcessedMarkdeep` | 6110 | `boolean` | Guard flag set to `true` before processing begins; prevents Markdeep from processing the document more than once if the script is included multiple times. |

## `window.markdeepOptions` (read by Markdeep, not exported)

This is not exported by Markdeep but is the primary user-facing configuration interface. Markdeep reads it via the internal `option()` function (line 1466). Notable callback:

| Property | Line (usage) | Type | Description |
|----------|-------------|------|-------------|
| `markdeepOptions.onLoad` | 7111, 7113 | `function` | User-supplied callback invoked after Markdeep finishes processing and rendering the document. |

## `module.exports = hljs` (line 8775)

| Export | Line | Signature | Description |
|--------|------|-----------|-------------|
| `module.exports` (hljs) | 8775 | _(highlight.js instance)_ | The bundled highlight.js v11.11.1 library, exported for CommonJS/Node environments; not part of Markdeep's own API but included in the same file. |

## Summary Count

- **9 members** on `window.markdeep` (7 functions + 1 object + 1 inline function)
- **1 global function** (`window.markdeepShowSourceView`)
- **1 global flag** (`window.alreadyProcessedMarkdeep`)
- **1 conditional CommonJS export** (`module.exports = hljs`, from bundled highlight.js)
