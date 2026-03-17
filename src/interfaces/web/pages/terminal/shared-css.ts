/**
 * Shared CSS for terminal-optimized (carbonyl) pages.
 * High contrast, no blur/transparency, solid colors, larger text.
 */

export function terminalSharedCss(): string {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #272e33;
    color: #d3c6aa;
    font-family: monospace, 'Courier New', Courier;
    overflow: auto;
  }

  /* ─── View tab bar ─── */
  #view-tabs {
    position: fixed; top: 0; left: 0; right: 0; z-index: 60;
    display: flex; gap: 0;
    background: #1e2326;
    border-bottom: 2px solid #414b50;
    padding: 0;
  }
  #view-tabs a {
    padding: 6px 16px;
    font-size: 14px; font-weight: 700;
    color: #7a8478; text-decoration: none;
    border-right: 1px solid #2e383c;
    font-family: monospace;
  }
  #view-tabs a:hover { color: #d3c6aa; background: #2e383c; }
  #view-tabs a.active { color: #7fbbb3; background: #2e383c; border-bottom: 2px solid #7fbbb3; }

  /* ─── Stats bar ─── */
  #stats-bar {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
    font-size: 13px; color: #9da9a0;
    background: #1e2326; border-top: 1px solid #414b50;
    padding: 4px 12px;
    font-family: monospace;
  }

  /* ─── Info panel (click-based, replaces hover tooltips) ─── */
  #info-panel {
    position: fixed; right: 0; top: 30px; bottom: 24px;
    width: 40ch;
    background: #1e2326;
    border-left: 2px solid #414b50;
    padding: 8px 12px;
    overflow-y: auto;
    z-index: 40;
    font-size: 13px;
    font-family: monospace;
    display: none;
  }
  #info-panel.open { display: block; }
  #info-panel .name { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
  #info-panel .type { color: #7fbbb3; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  #info-panel .desc { margin-top: 6px; color: #d3c6aa; line-height: 1.5; }
  #info-panel .meta { margin-top: 6px; color: #7a8478; font-size: 12px; }
  #info-panel .close-btn {
    float: right; background: none; border: 1px solid #414b50;
    color: #d3c6aa; padding: 2px 8px; cursor: pointer; font-family: monospace;
  }

  /* ─── Graph container ─── */
  #graph-container {
    margin-top: 30px;
    margin-bottom: 24px;
    overflow: auto;
    width: 100%;
  }

  /* SVG styling */
  svg {
    display: block;
  }
  svg text {
    font-family: monospace;
    pointer-events: none;
  }
`;
}
