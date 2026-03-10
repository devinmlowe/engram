/**
 * Shared CSS for terminal-optimized (carbonyl) pages.
 * High contrast, no blur/transparency, solid colors, larger text.
 */

export function terminalSharedCss(): string {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: monospace, 'Courier New', Courier;
    overflow: auto;
  }

  /* ─── View tab bar ─── */
  #view-tabs {
    position: fixed; top: 0; left: 0; right: 0; z-index: 60;
    display: flex; gap: 0;
    background: #181825;
    border-bottom: 2px solid #45475a;
    padding: 0;
  }
  #view-tabs a {
    padding: 6px 16px;
    font-size: 14px; font-weight: 700;
    color: #6c7086; text-decoration: none;
    border-right: 1px solid #313244;
    font-family: monospace;
  }
  #view-tabs a:hover { color: #cdd6f4; background: #313244; }
  #view-tabs a.active { color: #89b4fa; background: #313244; border-bottom: 2px solid #89b4fa; }

  /* ─── Stats bar ─── */
  #stats-bar {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
    font-size: 13px; color: #a6adc8;
    background: #181825; border-top: 1px solid #45475a;
    padding: 4px 12px;
    font-family: monospace;
  }

  /* ─── Info panel (click-based, replaces hover tooltips) ─── */
  #info-panel {
    position: fixed; right: 0; top: 30px; bottom: 24px;
    width: 40ch;
    background: #181825;
    border-left: 2px solid #45475a;
    padding: 8px 12px;
    overflow-y: auto;
    z-index: 40;
    font-size: 13px;
    font-family: monospace;
    display: none;
  }
  #info-panel.open { display: block; }
  #info-panel .name { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
  #info-panel .type { color: #89b4fa; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  #info-panel .desc { margin-top: 6px; color: #bac2de; line-height: 1.5; }
  #info-panel .meta { margin-top: 6px; color: #6c7086; font-size: 12px; }
  #info-panel .close-btn {
    float: right; background: none; border: 1px solid #45475a;
    color: #cdd6f4; padding: 2px 8px; cursor: pointer; font-family: monospace;
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
