---
question: "Q7: Identify error handling patterns — how does the code handle malformed input, missing resources, edge cases?"
evaluator_start: 2026-03-10T12:59:26Z
evaluator_end: 2026-03-10T13:01:08Z
---

# Q7: Error Handling Patterns in markdeep.js

## 1. Try/Catch Blocks

### 1.1 measureFontSize — Canvas Measurement Fallback (lines 94-102)

```js
try {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    ctx.font = '10pt ' + fontStack;
    return ctx.measureText("M").width;
} catch (e) {
    // Needed for Firefox include...canvas doesn't work for some reason
    return 10;
}
```

The function attempts to measure font size using an offscreen canvas. If the canvas API is unavailable or fails (documented as a Firefox issue), it silently returns a hardcoded fallback value of `10`. This is a graceful degradation pattern — the page will still render, just with a potentially inaccurate font size estimate.

### 1.2 replaceScheduleLists — Schedule Parsing Recovery (lines 2280-2516)

```js
try {
    var scheduleNumber = 0;
    str = str.rp(new RegExp(BLANK_LINE + '(' + ENTRY + '){2,}', 'gm'),
                 function (schedule) { ... });
} catch (ignore) {
    // Maybe this wasn't a schedule after all, since we couldn't parse a date. Don't alarm
    // the user, though
}
```

The entire schedule-parsing block (approximately 230 lines of complex date parsing, calendar generation, and table construction) is wrapped in a single try/catch. The catch variable is named `ignore`, and the comment explicitly states the philosophy: if date parsing fails, the content was probably not a schedule at all, so failing silently is the correct behavior. The original `str` is returned unmodified because the regex replacement callback threw before completing. Inside this block, an explicit `throw "Could not parse date"` (line 2331) is the mechanism that triggers this catch when none of the three date format patterns (DD MONTH YYYY, YYYY MONTH DD, MONTH DD YYYY) match.

### 1.3 Code Fence Highlighting — Language Fallback (lines 3594-3598)

```js
try {
    result = hljs.highlight(sourceCode, {language: lang, ignoreIllegals: true});
} catch (e) {
    result = hljs.highlightAuto(sourceCode, []);
}
```

When the user specifies an explicit language for a fenced code block, Markdeep attempts to use that language for syntax highlighting. If `hljs.highlight` throws (e.g., the language name is unrecognized or the grammar fails), it falls back to `hljs.highlightAuto` with an empty language list — effectively producing unhighlighted output rather than crashing.

### 1.4 Context Menu Handler — UI Error Suppression (lines 6554-6648)

```js
try {
    var match = event.target.tagName.match(/^H(\d)$/);
    var isDT = event.target.tagName === 'DT';
    if (!match && !isDT) { return; }
    // ... ~90 lines of DOM traversal, anchor finding, clipboard integration ...
    event.preventDefault();
    return false;
} catch (e) {
    if (menu) { menu.style.visibility = 'hidden'; }
}
```

The entire right-click context menu handler for section headers and definition terms is wrapped in try/catch. On any failure (null element, missing sibling, DOM structure mismatch), the menu is hidden and the error is swallowed. The user simply sees no context menu appear, which is an acceptable degradation.

### 1.5 Link Preview Cross-Origin Iframe (lines 6884-6894)

```js
try {
    var hash = url.split('#')[1];
    if (hash && previewIframe.contentDocument) {
        var target = previewIframe.contentDocument.getElementsByName(hash)[0];
        if (target) {
            target.scrollIntoView();
        }
    }
} catch(e) {
    // Cross-origin iframe, cannot access
}
```

When showing link previews, Markdeep tries to scroll an iframe to a hash target. Cross-origin iframes throw security exceptions when accessing `contentDocument`. The comment documents the expected failure mode; the catch simply lets the iframe display at its default scroll position.

### 1.6 Highlight.js Internal Try/Catch (lines 7711-7720)

Within the minified highlight.js code embedded in markdeep.js, the main `highlight` function has its own try/catch:

```js
try {
    // ... token matching loop ...
} catch(n) {
    if(n.message && n.message.includes("Illegal"))
        return {language:e, value:Y(t), illegal:true, relevance:0, _illegalBy:{...}, _emitter:k};
    if(s)
        return {language:e, value:Y(t), illegal:false, relevance:0, errorRaised:n, _emitter:k, _top:A};
    throw n;
}
```

This discriminates between "illegal lexeme" errors (which are expected and produce a result object with `illegal: true`), safe-mode errors (which produce a result with `errorRaised` set), and truly unexpected errors (which are re-thrown). This is a structured error classification pattern.

## 2. Explicit Throw Statements

### 2.1 Object.assign Polyfill — Null Guard (line 111)

```js
if (target === null || target === undefined) {
    throw new TypeError('Cannot convert undefined or null to object');
}
```

The IE11 polyfill for `Object.assign` follows the ECMAScript specification by throwing a `TypeError` for null/undefined targets.

### 2.2 String.includes Polyfill — RegExp Guard (line 139)

```js
if (search instanceof RegExp) {
    throw TypeError('first argument must not be a RegExp');
}
```

Per the spec, `String.prototype.includes` must reject RegExp arguments.

### 2.3 Date Parsing Bail-Out (line 2331)

```js
throw "Could not parse date";
```

Throws a raw string (not an Error object) when no date format matches. This is caught by the wrapping try/catch in the schedule parser (section 1.2 above). Throwing a string rather than an Error loses stack trace information, but since the catch intentionally ignores the value, this is functionally harmless.

### 2.4 generateMarkdownTable — Input Validation (lines 7195, 7204, 7230, 7238)

```js
if (!rows || rows.length === 0) {
    throw new Error("rows cannot be empty");
}
// ...
if (cell === null || cell === undefined) {
    throw new Error("null/undefined values not allowed (clean data before calling)");
}
// ...
if (row.length > numCols) {
    throw new Error("Row " + rowIdx + " has " + row.length + " cols, but header has " + numCols);
}
```

This function uses strict pre-condition validation with descriptive error messages. It throws `Error` objects (not strings) for: empty input, null/undefined cell values, and column count mismatches. The parenthetical "(clean data before calling)" in the null check message places responsibility on the caller.

### 2.5 Highlight.js Internal Throws (lines 7478-7479, 7562-7593, 7695-7708)

The embedded highlight.js has multiple defensive throws:

- **Read-only map/set protection** (lines 7478-7479): `throw Error("map is read-only")` / `throw Error("set is read-only")` when attempting to mutate frozen grammar structures.
- **Grammar validation** (lines 7562-7593): Throws when `match` is combined with `begin`/`end`, when `beforeMatch` is combined with `starts`, when `skip`/`excludeBegin`/`returnBegin` appear with array-form `beginScope`, and similar constraint violations. These use a sentinel error `Z = Error()` combined with a logging call `j()`.
- **Infinite loop detection** (line 7706): `throw Error("potential infinite loop, way more iterations than matches")` when iteration count exceeds 100,000 and is 3x the match index.
- **Unknown language** (line 7708): `throw Error('Unknown language: "' + e + '"')`.
- **Zero-width match** (line 7695): Throws when a regex produces a zero-width match, which would cause an infinite loop.

## 3. Console Warnings and Errors

### 3.1 Illegal Option Warning (line 1486)

```js
console.warn('Illegal option: "' + key + '"');
return undefined;
```

When `option()` is called with a key not in `DEFAULT_OPTIONS` and not in `window.markdeepOptions`, it warns to the console and returns `undefined`. Processing continues.

### 3.2 wrapHeaderSections Safety Errors (lines 2965, 2969)

```js
if (Date.now() - startTime > TIMEOUT_MS) {
    console.error('[wrapHeaderSections] Timeout after', Date.now() - startTime, 'ms, aborting');
    return str;
}
if (matchCount > 10000) {
    console.error('[wrapHeaderSections] Too many matches, aborting');
    return str;
}
```

The header section-wrapping function has two safety valves: a 5-second timeout (line 2868: `var TIMEOUT_MS = 5000`) and a 10,000-match limit. Both log to `console.error` and return the original string unmodified. This prevents the function from hanging on pathological input.

### 3.3 Unclosed Block Warning (line 3405)

```js
if (mode !== 'normal') {
    console.warn('[MDVIEW] WARNING: Document ended in mode "' + mode + '" (started at line ' + blockStartLine + ')');
}
```

After processing source-line markers, if the parser state machine ends in a non-normal mode (e.g., inside an unclosed code fence or block), a warning is emitted. The document is still processed — the warning is informational only. The message includes the mode name and the starting line number for debugging.

### 3.4 Vec2 Constructor Error (line 4719)

```js
else { console.error("Vec2 requires one Vec2 or (x, y) as an argument"); }
```

When `Vec2` receives arguments that are neither a Vec2 instance nor `(x, y)` coordinates, it logs an error. However, execution continues and `this.x`/`this.y` will be set to the invalid input value and `undefined` respectively. The object is still created (and sealed via `Object.seal(this)` on line 4723).

### 3.5 Grid Function Errors (lines 4737, 4760, 4771)

```js
else { console.error('grid requires either a Vec2 or (x, y)'); }
```

Three separate locations in the `makeGrid` function (`grid()`, `grid.setUsed()`, `grid.isUsed()`) log this same error when called with invalid arguments. Like Vec2, these continue execution with potentially undefined coordinate values.

### 3.6 Path Constructor Error (line 4913)

```js
if (! ((A instanceof Vec2) && (B instanceof Vec2))) {
    console.error('Path constructor requires at least two Vec2s');
}
```

Validates that the first two arguments to `Path` are Vec2 instances. Logs but does not throw — the Path object is still constructed with the invalid values and frozen.

### 3.7 Illegal Decoration Character (line 5128)

```js
if (! isDecoration(type)) {
    console.error('Illegal decoration character: ' + type);
}
```

In `DecorationSet.insert()`, validates that the character is a known decoration type before inserting. The decoration is still inserted regardless of this check.

### 3.8 Highlight.js Internal Logging (lines 7577-7578, 7735-7739)

```js
console.error(e)                    // line 7577 — generic error logger
console.log("WARN: "+e,...n)        // line 7577 — warning logger
console.log(`Deprecated as of ${e}. ${n}`)  // line 7578 — deprecation logger
```

And the security warning:
```js
console.warn("One of your code blocks includes unescaped HTML. This is a potentially serious security risk.");
console.warn("https://github.com/highlightjs/highlight.js/wiki/security");
console.warn("The element with unescaped HTML:");
console.warn(e);
```

Highlight.js logs unescaped HTML in code blocks as a security warning (lines 7736-7739). If `throwUnescapedHTML` is configured, this becomes a thrown `W` error (line 7739).

## 4. Fallback / Default Value Patterns

### 4.1 Fallback Stylesheet for Unprocessed Documents (line 618)

```js
var MARKDEEP_LINE = '<!-- Markdeep: --><style class="fallback">body{visibility:hidden;...}</style>
<script src="markdeep.min.js"></script>
<script src="https://casual-effects.com/markdeep/latest/markdeep.min.js?"></script>
<script>window.alreadyProcessedMarkdeep||(document.body.style.visibility="visible")</script>';
```

This is the canonical Markdeep fallback pattern. The `<style class="fallback">` hides the body while Markdeep loads. If Markdeep fails to load entirely, the final `<script>` tag checks `window.alreadyProcessedMarkdeep` and restores visibility so the user sees raw text rather than a blank page. The fallback style nodes are actively removed after processing at lines 6476-6478 and 6530-6532.

### 4.2 Recursive Invocation Guard (lines 6109-6110)

```js
if (! window.alreadyProcessedMarkdeep) {
    window.alreadyProcessedMarkdeep = true;
```

Prevents Markdeep from processing a document twice if the script is included multiple times (or loaded both locally and from CDN). Also set at line 6483 after html/doxygen mode processing.

### 4.3 Option System with Defaults (lines 1466-1488)

```js
function option(key, key2) {
    if (window.markdeepOptions && (window.markdeepOptions[key] !== undefined)) {
        var val = window.markdeepOptions[key];
        if (key2) {
            val = val[key2]
            if (val !== undefined) {
                return val;
            } else {
                return DEFAULT_OPTIONS[key][key2];
            }
        } else {
            return window.markdeepOptions[key];
        }
    } else if (DEFAULT_OPTIONS[key] !== undefined) {
        if (key2) {
            return DEFAULT_OPTIONS[key][key2];
        } else {
            return DEFAULT_OPTIONS[key];
        }
    } else {
        console.warn('Illegal option: "' + key + '"');
        return undefined;
    }
}
```

Three-tier fallback: user-specified value -> default value -> warn + undefined. For nested options (`key2`), it checks the user's nested value first, then falls back to the default nested value. This handles partial option overrides gracefully.

### 4.4 Language/Keyword Fallback (line 1546)

```js
return option('lang').keyword[word] || option('lang').keyword[word.toLowerCase()] || word;
```

The `keyword()` function tries exact match, then lowercase match, then returns the original English word unchanged. This allows partial translations.

### 4.5 Math.sign Polyfill (line 1460)

```js
var sign = Math.sign || function (x) {
    return ( +x === x ) ? ((x === 0) ? x : (x > 0) ? 1 : -1) : NaN;
};
```

Provides a fallback implementation for `Math.sign` if not available, correctly handling `NaN`, `+0`, and `-0`.

### 4.6 String.endsWith Polyfill (lines 49-57)

```js
if (!_.endsWith) {
    _.endsWith = function(S, L) {
        if (L === undefined || L > this.length) {
            L = this.length;
        }
        return this.ss(L - S.length, L) === S;
    };
}
```

IE11 polyfill with bounds checking on the length parameter.

### 4.7 Array.from / strToArray IE11 Workaround (lines 4557-4568)

```js
function strToArray(s) {
    if (Array.from) {
        return Array.from(s);
    } else {
        var a = [];
        for (var i = 0; i < s.length; ++i) {
            a[i] = s[i];
        }
        return a;
    }
}
```

Falls back to manual array construction for environments without `Array.from`.

### 4.8 Array.prototype.includes Polyfill (lines 145-149)

```js
if (!Array.prototype.includes) {
    Array.prototype.includes = function(search) {
        return !!~this.indexOf(search);
    }
}
```

Simple IE11 polyfill using bitwise NOT on indexOf.

### 4.9 Object.assign Polyfill (lines 106-133)

Full polyfill for IE11 with null source filtering (`if (nextSource !== null && nextSource !== undefined)`).

## 5. Defensive Null/Undefined Checks

### 5.1 nodeToMarkdeepSource Null Safety (lines 1687-1713)

```js
if (nodeOrArray) {
    if (Array.isArray(nodeOrArray)) {
        for (var i = 0; i < nodeOrArray.length; ++i) {
            if (nodeOrArray[i]) {     // null check on each node
                const node = nodeOrArray[i];
                if (node.tagName === 'HEAD') { ... }
```

The comment on line 1690-1692 explains: "The document.body can be null if a document contains exclusively 'preformatted' scripts, so check for null."

### 5.2 markdeepToHTML Input Coercion (lines 3155-3161)

```js
if (elementMode === undefined) {
    elementMode = true;
}

if (str.innerHTML !== undefined) {
    str = str.innerHTML;
}
```

Handles two calling conventions: if `elementMode` is not provided, it defaults to `true`. If `str` is a DOM element instead of a string, it extracts `innerHTML`.

### 5.3 isBlockElement Null Guard (line 6147)

```js
function isBlockElement(tagName) {
    if (!tagName) { return false; }
```

### 5.4 attributeSourceLines Null Guard (line 6160)

```js
function attributeSourceLines(rootElement) {
    if (!rootElement) { return; }
```

### 5.5 Text Node Null Check (line 6178)

```js
var text = node.nodeValue;
if (!text) { continue; }
```

### 5.6 definitionAnchor Input Validation (lines 7157-7166)

```js
if (typeof term !== 'string' || term.length === 0) {
    return '';
}
// ...
if (!Array.isArray(headerArray) || headerArray.length === 0) {
    return 'def-' + mangledTerm;
}
```

Returns safe empty/simplified values for invalid inputs rather than throwing.

### 5.7 Context Menu Null Checks (lines 6567-6574, 6583)

```js
if (! node) {
    // never found .md
    return;
}
// ...
if (! menu) { return; }
// ...
if (!anchorNode || anchorNode.tagName !== 'A') { return; }
```

Multiple early returns in the context menu handler guard against missing DOM elements.

### 5.8 document.body Null Check (lines 6513-6515)

```js
if (document.body) {
    document.body.style.visibility = 'hidden';
}
```

Guards against the case where the script runs before the body element exists.

## 6. Regex Safety / Catastrophic Backtracking Prevention

### 6.1 Image Attribute Length Limits

Multiple regexps use `{0,200}` quantifiers to limit match length and prevent catastrophic backtracking:

- **Line 3985**: `(\s+[^\)]{0,200})?` in reference link attributes
- **Line 4029**: `([ \t][^\n\[\]]{0,200})?` in reference image attributes
- **Line 4053**: `(?:[^\n\)]{0,200})?` in image line regex
- **Line 4110**: `([^\)]{0,200})?` in image grid parsing
- **Line 4126**: `(\s[^\)]{0,200})?` in simple image attributes
- **Line 4148**: `(\s[^\)]{0,200})?` in captioned image attributes

Comments at lines 4028, 4046-4048, 4108-4109, 4125, and 4147 document this as intentional: "Limit attribute matching to prevent catastrophic backtracking on malformed input."

### 6.2 Image Caption Length Limit

- **Line 4053**: `[^\]]{0,100}` limits caption length in image line regex
- **Line 4110**: `[^\]]{0,100}` in image grid parsing

Comment at line 4109: "Limit caption length with {0,100} to prevent catastrophic backtracking."

### 6.3 wrapHeaderSections — Two-Phase Safety (lines 2864-2971)

The function uses a simple `/<h([1-6])[^>]*>/g` pattern (line 2872) instead of trying to match headers with their preceding anchor tags in a single regex. The comment at line 2871 states: "This avoids catastrophic backtracking from nested quantifiers." It then looks backwards in code for anchor positions rather than using a complex regex.

### 6.4 Image Grid — Algorithmic Instead of Regex (lines 4046-4090)

The original image grid regex had "catastrophic backtracking due to nested quantifiers" (comment, line 4046). The solution replaces the regex with a two-pass algorithm: first find individual image lines with a simple regex, then group consecutive lines in code. This eliminates the nested quantifier problem entirely.

## 7. Graceful Degradation for Missing/Broken References

### 7.1 Missing Reference Links Return '?' (lines 4009-4010, 4032-4033)

```js
if (! t) {
    return '?';
}
```

When a reference-style link `[text][ref]` or image `![...][ref]` references a symbolic name not defined in `referenceLinkTable`, Markdeep renders a literal `?` character. This makes the broken reference visible to the author without breaking the page.

### 7.2 Missing Figure/Table/Listing References (line 4375)

```js
if (t) {
    t.used = true;
    return '<a ...>' + _type + '&nbsp;' + t.number + '</a>';
} else {
    return _type + ' ?';
}
```

Unresolved figure/table/listing references like `Figure [nonexistent]` render as "Figure ?" rather than producing an error.

### 7.3 Missing Section Links (line 4478)

```js
if (link) {
    return prefix + ' <a ...>' + link + '</a>';
} else {
    return prefix + ' ?';
}
```

Unresolved section references like `Section [nonexistent]` render as "Section ?" rather than failing.

### 7.4 Missing Endnote Definitions (line 4332)

```js
if (symbolicName in endNoteTable) {
    return '\n<div ...>...</div>';
} else {
    return "\n";
}
```

Endnote definitions `[^name]: text` that don't correspond to any footnote reference in the text are silently removed (replaced with a newline).

### 7.5 Unused Reference Tracking (lines 4500-4509)

```js
Object.keys(referenceLinkTable).forEach(function (key) {
    if (! referenceLinkTable[key].used) {
        // Empty — intentionally silent
    }
});
Object.keys(refTable).forEach(function (key) {
    if (! refTable[key].used) {
        // Empty — intentionally silent
    }
});
```

The code iterates over unused references but currently does nothing with them. The empty `if` blocks suggest this was designed for future warning functionality but left as no-ops.

## 8. Diagram Parsing Edge Cases

### 8.1 noDiagramResult Pattern (lines 1788, 1832, 1887)

```js
var noDiagramResult = {beforeString: sourceString, diagramString: '', alignmentHint: '', afterString: ''};
```

`extractDiagram()` returns this sentinel object at three points:
- When no `DIAGRAM_START` pattern is found (line 1887, end of search loop)
- When the string ends before the diagram closes (line 1832: "Hit the end of the string before the end of the pattern")
- The `diagramString: ''` empty value signals to callers that no diagram was extracted

### 8.2 Diagram Border Detection (lines 1821-1882)

The diagram extraction code handles multiple edge cases:
- **Wide Unicode characters**: `unicodeSyms()` (line 1769) counts characters outside the BMP that take two JavaScript char positions, adjusting column alignment
- **Missing right border**: tracked via `noRightBorder` flag (line 1782) — diagrams can have left+top+bottom borders without a right border
- **Text on left/right**: determines float alignment (lines 1835-1839) — `floatright` if text on left, `floatleft` if text on right, `center` if neither
- **Incorrectly delimited line**: sets `good = false` (line 1882) to abort the current diagram candidate without failing the whole parse

### 8.3 Diagram Content Heuristic (lines 3458-3508)

The `looksLikeDiagram()` function uses a multi-factor heuristic to detect diagrams that lack explicit star borders:
- Returns `false` for content with fewer than 3 lines (line 3461)
- Uses ratio-based thresholds: 20% diagram chars + 30% pattern matches, OR 25%+ diagram chars, OR 3+ lines with vertical bars + 2+ pattern matches
- Protects against division by zero with `totalChars > 0 ? ... : 0` (line 3502)

## 9. Loop Safety / Iteration Limits

### 9.1 Protect/Expose Iteration Limit (lines 4490-4497)

```js
var maxIterations = 50;
exposeRan = true;
while ((str.indexOf(PROTECT_CHARACTER) + 1) && exposeRan && (maxIterations > 0)) {
    exposeRan = false;
    str = str.rp(PROTECT_REGEXP, expose);
    --maxIterations;
}
```

The protected-string exposure loop has three termination conditions: no more protect characters, no replacements made in last iteration, or 50 iterations reached. This prevents infinite loops from circular protection references.

### 9.2 wrapHeaderSections Match Limit (lines 2868, 2964-2970)

Two independent safety limits:
- **Time-based**: 5-second timeout checked after each header match
- **Count-based**: 10,000-match hard limit

Both return the original unmodified string and log to `console.error`.

### 9.3 Highlight.js Infinite Loop Detection (line 7706)

```js
if(D>1e5&&D>3*i.index)throw Error("potential infinite loop, way more iterations than matches")
```

Throws when the iteration counter exceeds 100,000 AND is more than 3x the current match index, indicating the matcher is stuck.

## 10. Browser-Specific Workarounds

### 10.1 Firefox Object Tag Workaround (lines 6011-6035)

```js
if (isFirefox && ! isHTML) {
    tag = 'object'; url = 'data';
    if (location.protocol.startsWith('http')) {
        var req = new XMLHttpRequest();
        // ... fetch document directly ...
    }
}
```

Firefox doesn't handle embedding non-HTML documents in iframes (tries to download them). Markdeep switches to `<object>` tags and, when on an HTTP server, uses XMLHttpRequest to fetch the content directly, working around Firefox MIME type confusion.

### 10.2 Firefox Admonition Icon Sizing (lines 516, 538, 564)

```js
'font-size:' + (isFirefox ? '200%;' : '150%;')
```

Different icon sizes for Firefox vs. other browsers in admonition blocks, accounting for Firefox's different Unicode glyph rendering.

### 10.3 IE11 Polyfills (lines 49-149, 4557-4568)

Five separate polyfills for IE11:
- `String.prototype.endsWith`
- `Object.assign`
- `String.prototype.includes`
- `Array.prototype.includes`
- `Array.from` (via `strToArray`)

## 11. URL / HTML Recovery

### 11.1 Malformed HTML Recovery in nodeToMarkdeepSource (lines 1720-1743)

```js
source = source.rp(/<\/https?:.*>|<\/ftp:.*>|<\/[^ "\t\n>]+@[^ "\t\n>]+>/gi, '');
source = source.rp(/<(https?|ftp): (.*?)>/gi, function (match, protocol, list) {
    var s = '<' + protocol + '://' + list.rp(/=""\s/g, '/');
    if (s.ss(s.length - 3) === '=""') {
        s = s.ss(0, s.length - 3);
    }
    s = s.rp(/"/g, '');
    return s + '>';
});
source = source.rp(/<style class=["']fallback["']>.*?<\/style>/gmi, '');
```

When the browser parses Markdeep source as HTML, URLs like `<http://example.com>` get mangled into `<http: example.com="">` with artificial close tags. This code reconstructs the original URLs from the mangled HTML. It also strips fallback style tags and removes artificial close tags from email-like syntax.

### 11.2 Email vs. URL Disambiguation (lines 3870-3876)

```js
str = str.rp(/(?:<|(?!<)\b)(\S+@(\S+\.)+?\S{2,}?).../, function (match, addr) {
    if (/http:|ftp:|https:|svn:|:\/\/|\.html|\(|\)|\]/.test(match)) {
        return match;  // It's a URL, not an email
    } else {
        return '<a href="mailto:' + addr + '">' + addr + '</a>';
    }
});
```

Matches that look like email addresses but are actually URLs (containing protocol prefixes or HTML-like characters) are passed through unchanged.

### 11.3 URL Period Trimming (lines 4383-4386)

```js
if (url[url.length - 1] == '.') {
    url = url.ss(0, url.length - 1);
    extra = '.';
}
```

When a URL at the end of a sentence accidentally captures the trailing period, it is stripped and re-appended after the link tag.

## 12. Table Column Style Fallback (line 2008)

```js
return ' </' + tag + '><' + tag + ' ' + (columnStyle[i] || '') + '> ';
```

When a table row has more columns than the separator row defined styles for, `columnStyle[i]` would be `undefined`. The `|| ''` ensures no style is applied rather than inserting "undefined" into the HTML.

## 13. Language Detection Fallback in Highlight.js (lines 7731-7732)

```js
const n = v(t[1]);
return n||(q(o.replace("{}",t[1])),
q("Falling back to no-highlight mode for this block.",e)),n?t[1]:"no-highlight"
```

When a CSS class specifies a language that highlight.js doesn't recognize, it warns and falls back to "no-highlight" mode rather than failing.

## Summary of Error Handling Philosophy

Markdeep's error handling follows a consistent philosophy across its ~8,800 lines:

1. **Never crash the page**: All try/catch blocks use silent recovery or fallback values. The user always gets rendered output.
2. **Prefer visible degradation over silent failure**: Missing references become `?` marks, broken diagrams pass through as text, unrecognized options produce console warnings.
3. **Protect against pathological input**: Regex length limits (`{0,200}`), iteration caps (50 for expose, 10,000 for headers), and timeouts (5 seconds) prevent denial-of-service from malformed documents.
4. **Browser compatibility over correctness**: Six IE11 polyfills and Firefox-specific workarounds prioritize broad compatibility.
5. **Log errors for developers, hide them from users**: `console.error`/`console.warn` messages include context (function name, values) but never surface in the rendered document.
6. **Highlight.js uses structured error classification**: Distinguishes illegal lexemes (expected), safe-mode errors (recoverable), and truly unexpected errors (re-thrown).
