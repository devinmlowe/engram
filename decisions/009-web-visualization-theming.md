# ADR-009: Web Visualization Theming Architecture

**Status:** Accepted
**Date:** 2026-03-17
**Context:** Migrating web visualizations from Catppuccin Mocha to Everforest Hard Dark

## Context

The engram web visualizations (graph, depth, galaxy, words, communities) had colors hardcoded as hex literals across 10+ TypeScript template files. Changing the theme required a manual find-replace across every file, with high risk of inconsistency.

The user's terminal environment (iTerm2, tmux, neovim) uses Everforest Hard Dark consistently, creating a visual mismatch when viewing engram graphs in carbonyl (terminal Chromium browser).

## Decision

### Centralized theme module

Create `src/interfaces/web/pages/theme.ts` as the single source of truth for all color constants. Page files import from theme.ts and interpolate values into their HTML template literals.

### Dual delivery: TypeScript constants + CSS custom properties

- **TypeScript constants** (`theme.ts`) — for values used in JavaScript (Canvas API, D3 `.attr()` calls, inline style interpolation). Canvas/SVG rendering APIs require raw hex strings; CSS variables are not accessible from Canvas drawing calls.
- **CSS custom properties** (`theme-everforest` external repo) — for pure-CSS consumers. Published via GitHub Pages for cross-project sharing.

### Background scale anchored to terminal emulator

The `--theme-bg` / `BG` value must match the terminal emulator's background exactly (`#1e2326` / bg_dim for iTerm2 Everforest Hard Dark). The rest of the scale shifts accordingly:

| Role | Hex | Everforest Name |
|------|-----|-----------------|
| bg-deep (headers/canvas) | `#191d20` | derived (darker than bg_dim) |
| **bg (main)** | **`#1e2326`** | **bg_dim (matches iTerm2)** |
| bg-surface (panels) | `#272e33` | bg0 |
| bg-overlay (hover) | `#2e383c` | bg1 |
| bg-border (dividers) | `#374145` | bg2 |

## Lessons Learned

### Terminal browser rendering (carbonyl)

1. **CSS `text-anchor` is unreliable via stylesheets** — carbonyl doesn't consistently apply CSS properties to dynamically created SVG `<text>` elements. Always set `text-anchor` as an SVG attribute directly on the element, not via CSS class.

2. **Monospace char-width ratio is ~0.65 in carbonyl** — the ratio of rendered character width to font size in carbonyl's monospace rendering is approximately 0.65, not the typical 0.6 used in browser layout calculations. Using 0.6 causes text to overflow cells and triggers unwanted mid-word breaks.

3. **SVG over Canvas for terminal views** — Canvas API renders to a bitmap that carbonyl can't meaningfully translate to terminal cells. SVG elements are rendered as character-based output. All terminal-optimized views must use SVG, not Canvas.

### Treemap label sizing

4. **Size font from cell, not from text length** — The naive approach `fontSize = cellWidth / (nameLength * charWidth)` produces tiny text for long labels because it sizes the font to fit the entire name on one line. The correct approach: start with a font size proportional to cell height (`cellH * 0.35`), word-wrap at that size, then iteratively shrink only if the wrapped lines don't fit vertically.

5. **Truncate oversized words, don't character-break** — When a single word is wider than the cell, truncating with ellipsis ("Developm…") is far more readable than splitting across lines ("Develo" / "pment"). Character-breaking destroys word recognition.

### Theme migration at scale

6. **Updating a constants file doesn't cascade to hardcoded values** — TypeScript template literals (`return \`<style>background: #272e33</style>\``) embed hex values as raw strings at compile time. Updating `theme.ts` only affects places that use `${BG}` interpolation, not the dozens of inline hex values in CSS-within-templates. A bulk replacement pass is required after any scale shift.

7. **Order of replacement matters for overlapping values** — When shifting a color scale (e.g., `#272e33` → `#1e2326` and `#1e2326` → `#191d20`), naive sequential replacement causes double-substitution. Use a two-pass placeholder approach: first replace all old values with unique tokens, then replace tokens with new values.

## Consequences

- Adding a new visualization page requires importing from `theme.ts` — no hardcoded colors
- Theme changes are a single-file edit (`theme.ts`) plus rebuild
- External CSS consumers (terminal-clock, future tools) reference `theme-everforest` repo
- The background scale is anchored to iTerm2's bg_dim; changing terminal emulator theme requires updating both `theme.ts` and `everforest-dark.css`
