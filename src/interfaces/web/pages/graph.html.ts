/**
 * Graph page — D3 force-directed knowledge graph with Canvas rendering.
 */

import { TYPE_COLORS, DEFAULT_COLOR, BG_DEEP, FG, FG_FAINT } from './theme.js';

export function graphPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e2326;
    color: #d3c6aa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  canvas { display: block; }

  #tooltip {
    position: fixed;
    display: none;
    background: #2e383c;
    border: 1px solid #414b50;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 360px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  #tooltip .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  #tooltip .type { color: #9da9a0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .desc { margin-top: 6px; color: #d3c6aa; line-height: 1.4; }
  #tooltip .community { margin-top: 6px; color: #83c092; font-size: 11px; }

  /* ─── Settings toggle button ─── */
  #settings-toggle {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 60;
    width: 36px; height: 36px;
    border-radius: 50%;
    background: #2e383c;
    border: 1px solid #414b50;
    color: #d3c6aa;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    line-height: 1;
  }
  #settings-toggle:hover { background: #414b50; border-color: #7fbbb3; }

  /* ─── Settings panel ─── */
  #settings-panel {
    position: fixed;
    top: 0; right: 0;
    width: 300px;
    height: 100vh;
    background: rgba(30, 30, 46, 0.95);
    border-left: 1px solid #414b50;
    z-index: 55;
    overflow-y: auto;
    transform: translateX(100%);
    transition: transform 0.25s ease;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  #settings-panel.open { transform: translateX(0); }
  #settings-panel::-webkit-scrollbar { width: 4px; }
  #settings-panel::-webkit-scrollbar-track { background: transparent; }
  #settings-panel::-webkit-scrollbar-thumb { background: #414b50; border-radius: 2px; }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid #2e383c;
  }
  .panel-header h2 {
    font-size: 15px;
    font-weight: 600;
    color: #d3c6aa;
  }
  .panel-header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .panel-header-actions button {
    background: none;
    border: none;
    color: #7a8478;
    cursor: pointer;
    font-size: 16px;
    padding: 2px;
    line-height: 1;
    transition: color 0.15s;
  }
  .panel-header-actions button:hover { color: #d3c6aa; }

  /* Collapsible sections */
  .section {
    border-bottom: 1px solid #2e383c;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    cursor: pointer;
    user-select: none;
    transition: background 0.1s;
  }
  .section-header:hover { background: rgba(69, 71, 90, 0.3); }
  .section-header .arrow {
    font-size: 10px;
    color: #7a8478;
    transition: transform 0.2s;
    width: 12px;
    text-align: center;
  }
  .section.open .section-header .arrow { transform: rotate(90deg); }
  .section-header .section-title {
    font-size: 14px;
    font-weight: 500;
    color: #d3c6aa;
  }
  .section-body {
    display: none;
    padding: 4px 20px 16px;
  }
  .section.open .section-body { display: block; }

  /* Control rows */
  .ctrl-row {
    margin-bottom: 12px;
  }
  .ctrl-row:last-child { margin-bottom: 0; }
  .ctrl-label {
    font-size: 12px;
    color: #9da9a0;
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .ctrl-label .val {
    font-size: 11px;
    color: #7a8478;
    min-width: 32px;
    text-align: right;
  }
  .ctrl-row input[type=range] {
    width: 100%;
    accent-color: #7fbbb3;
    height: 4px;
  }
  .ctrl-row input[type=text] {
    width: 100%;
    background: #2e383c;
    border: 1px solid #414b50;
    border-radius: 6px;
    padding: 7px 12px;
    color: #d3c6aa;
    font-size: 13px;
    outline: none;
  }
  .ctrl-row input[type=text]:focus { border-color: #7fbbb3; }
  .ctrl-row input[type=text]::placeholder { color: #7a8478; }

  /* Toggle switch */
  .ctrl-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .ctrl-toggle .label { font-size: 12px; color: #9da9a0; }
  .switch {
    width: 36px; height: 20px;
    background: #414b50;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
  }
  .switch.on { background: #7fbbb3; }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    background: #d3c6aa;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .switch.on::after { transform: translateX(16px); }

  /* Type filter pills in panel */
  #filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    background: #2e383c;
    border: 1px solid #414b50;
    border-radius: 14px;
    padding: 4px 10px;
    font-size: 11px;
    color: #9da9a0;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .pill:hover { border-color: #7fbbb3; color: #d3c6aa; }
  .pill.active { background: #414b50; color: #d3c6aa; border-color: #7fbbb3; }
  .pill .dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 5px;
    vertical-align: middle;
  }

  /* Stats bar (minimal, always visible) */
  #stats-bar {
    position: fixed;
    bottom: 12px;
    left: 16px;
    z-index: 50;
    font-size: 11px;
    color: #4f5b58;
    pointer-events: none;
  }

  /* Dream button (always visible, bottom-right) */
  #dream-btn {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 50;
    background: #2e383c;
    border: 1px solid #414b50;
    border-radius: 8px;
    padding: 8px 16px;
    color: #d699b6;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #dream-btn:hover { border-color: #d699b6; background: #414b50; }
  #dream-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #dream-btn .icon { font-size: 16px; }

  /* Dream status (in panel) */
  #dream-status {
    display: none;
    margin-top: 8px;
  }
  #dream-status.active { display: block; }
  .ds-phase-label {
    font-size: 13px;
    font-weight: 600;
    color: #d699b6;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ds-phase-label .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid #414b50;
    border-top-color: #d699b6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ds-detail {
    font-size: 11px;
    color: #9da9a0;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .ds-progress-bar {
    height: 4px;
    background: #414b50;
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 4px;
  }
  .ds-progress-fill {
    height: 100%;
    background: #d699b6;
    border-radius: 2px;
    transition: width 0.5s ease;
  }
  .ds-progress-text {
    font-size: 10px;
    color: #7a8478;
  }
  .ds-pipeline {
    display: flex;
    gap: 3px;
    margin-top: 8px;
  }
  .ds-pipeline .step {
    flex: 1;
    height: 3px;
    border-radius: 1.5px;
    background: #414b50;
    transition: background 0.3s;
  }
  .ds-pipeline .step.done { background: #a7c080; }
  .ds-pipeline .step.active { background: #d699b6; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
  .ds-phase-names {
    display: flex;
    gap: 3px;
    margin-top: 2px;
  }
  .ds-phase-names span {
    flex: 1;
    font-size: 8px;
    text-align: center;
    color: #4f5b58;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .ds-phase-names span.done { color: #a7c080; }
  .ds-phase-names span.active { color: #d699b6; }

  /* ─── View tab bar ─── */
  #view-tabs {
    position: fixed; top: 12px; left: 16px; z-index: 60;
    display: flex; gap: 4px;
  }
  #view-tabs a {
    background: rgba(46,56,60,0.85); border: 1px solid #414b50; border-radius: 14px;
    padding: 5px 14px; font-size: 12px; font-weight: 500;
    color: #9da9a0; text-decoration: none; cursor: pointer;
    transition: all 0.15s; user-select: none;
  }
  #view-tabs a:hover { border-color: #7fbbb3; color: #d3c6aa; }
  #view-tabs a.active { background: #414b50; color: #7fbbb3; border-color: #7fbbb3; }

  /* ─── Settings persistence buttons ─── */
  .panel-footer {
    padding: 12px 20px 16px;
    display: flex;
    gap: 8px;
  }
  .panel-footer button {
    flex: 1;
    padding: 7px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid #414b50;
    background: #2e383c;
    color: #d3c6aa;
  }
  .panel-footer button:hover { border-color: #7fbbb3; background: #414b50; }
  .panel-footer button.saved { border-color: #a7c080; color: #a7c080; }

  /* ─── Setting hint tooltips ─── */
  .hint-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: #414b50;
    color: #7a8478;
    font-size: 9px;
    font-weight: 700;
    cursor: help;
    margin-left: 6px;
    flex-shrink: 0;
    user-select: none;
  }
  .hint-bubble {
    position: absolute;
    background: #2e383c;
    border: 1px solid #414b50;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 11px;
    color: #d3c6aa;
    line-height: 1.4;
    max-width: 220px;
    z-index: 200;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .hint-bubble.visible { opacity: 1; }
  @media (hover: none) {
    .hint-icon { display: none; }
  }

  /* ─── Info dialog (mobile-friendly) ─── */
  #info-btn {
    background: none;
    border: none;
    color: #7a8478;
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 1.5px solid #7a8478;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    padding: 0;
    line-height: 1;
  }
  #info-btn:hover { color: #d3c6aa; border-color: #d3c6aa; }
  #info-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 300;
    display: none;
    align-items: center;
    justify-content: center;
  }
  #info-overlay.open { display: flex; }
  #info-dialog {
    background: #272e33;
    border: 1px solid #414b50;
    border-radius: 12px;
    padding: 0;
    max-width: 420px;
    width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  #info-dialog::-webkit-scrollbar { width: 4px; }
  #info-dialog::-webkit-scrollbar-thumb { background: #414b50; border-radius: 2px; }
  .info-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid #2e383c;
    position: sticky;
    top: 0;
    background: #272e33;
    z-index: 1;
  }
  .info-header h3 { font-size: 15px; font-weight: 600; color: #d3c6aa; }
  .info-close {
    background: none; border: none; color: #7a8478; cursor: pointer;
    font-size: 18px; padding: 2px; line-height: 1;
  }
  .info-close:hover { color: #d3c6aa; }
  .info-section {
    padding: 12px 20px 4px;
  }
  .info-section-title {
    font-size: 12px;
    font-weight: 600;
    color: #7fbbb3;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .info-item {
    margin-bottom: 10px;
  }
  .info-item-name {
    font-size: 12px;
    font-weight: 600;
    color: #d3c6aa;
    margin-bottom: 2px;
  }
  .info-item-desc {
    font-size: 11px;
    color: #9da9a0;
    line-height: 1.4;
  }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="tooltip"></div>
<div id="view-tabs">
  <a class="active" href="/graph">Graph</a>
  <a href="/graph/depth">Depth</a>
  <a href="/graph/galaxy">Galaxy</a>
  <a href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-nodes">-</span> nodes &middot; <span id="stat-edges">-</span> edges &middot; <span id="stat-total">-</span> total</div>

<button id="animate-btn" title="Animate growth">&#x25B6;</button>
<div id="anim-progress"><span id="anim-date"></span><div id="anim-bar-wrap"><div id="anim-bar"></div></div><span id="anim-speed" title="Click to cycle speed">1x</span></div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Graph view</h2>
    <div class="panel-header-actions">
      <button id="info-btn" title="Setting descriptions">i</button>
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <!-- Filters -->
  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Filters</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <input type="text" id="search" placeholder="Search nodes..." autocomplete="off" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Min mentions <span class="val" id="threshold-val">5</span></div>
        <input type="range" id="threshold" min="1" max="50" value="5" />
      </div>
    </div>
  </div>

  <!-- Groups (type filters) -->
  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Groups</span></div>
    <div class="section-body">
      <div id="filters"></div>
    </div>
  </div>

  <!-- Display -->
  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-toggle">
        <span class="label">Show labels</span>
        <div class="switch on" id="toggle-labels"></div>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Label threshold <span class="val" id="label-threshold-val">auto</span></div>
        <input type="range" id="label-threshold" min="1" max="100" value="20" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Node size <span class="val" id="node-size-val">1.0</span></div>
        <input type="range" id="node-size" min="2" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link thickness <span class="val" id="link-thickness-val">1.0</span></div>
        <input type="range" id="link-thickness" min="1" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link gradient <span class="val" id="link-gradient-val">50</span></div>
        <input type="range" id="link-gradient" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-toggle">
        <span class="label">Auto-zoom to changes</span>
        <div class="switch on" id="toggle-autozoom"></div>
      </div>
    </div>
  </div>

  <!-- Forces -->
  <div class="section">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Forces</span></div>
    <div class="section-body">
      <div class="ctrl-row" style="gap:6px;margin-bottom:4px;display:flex">
        <button class="preset-btn active" id="preset-cluster">Cluster</button>
        <button class="preset-btn" id="preset-spread">Spread</button>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Center force <span class="val" id="center-force-val">0.01</span></div>
        <input type="range" id="center-force" min="0" max="100" value="1" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Repel force <span class="val" id="repel-force-val">-200</span></div>
        <input type="range" id="repel-force" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link force <span class="val" id="link-force-val">0.50</span></div>
        <input type="range" id="link-force" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link distance <span class="val" id="link-distance-val">30</span></div>
        <input type="range" id="link-distance" min="10" max="200" value="30" />
      </div>
    </div>
  </div>

  <!-- Dream -->
  <div class="section">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Dream</span></div>
    <div class="section-body">
      <button id="dream-btn-panel" style="width:100%;background:#2e383c;border:1px solid #414b50;border-radius:8px;padding:8px 16px;color:#d699b6;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s"><span class="icon">&#x2728;</span> Dream</button>
      <div id="dream-status">
        <div class="ds-phase-label"><span class="spinner"></span> <span id="ds-phase">-</span></div>
        <div class="ds-detail" id="ds-detail">-</div>
        <div class="ds-progress-bar"><div class="ds-progress-fill" id="ds-fill"></div></div>
        <div class="ds-progress-text" id="ds-progress">-</div>
        <div class="ds-pipeline" id="ds-pipeline"></div>
        <div class="ds-phase-names" id="ds-phase-names"></div>
      </div>
    </div>
  </div>

  <div class="panel-footer">
    <button id="save-defaults-btn">Save as Default</button>
    <button id="reset-defaults-btn">Reset to Defaults</button>
  </div>
</div>

<div id="info-overlay">
  <div id="info-dialog">
    <div class="info-header">
      <h3>Settings Guide</h3>
      <button class="info-close" id="info-close">&times;</button>
    </div>
    <div class="info-section">
      <div class="info-section-title">Filters</div>
      <div class="info-item"><div class="info-item-name">Search nodes</div><div class="info-item-desc">Filter visible nodes by name, description, or community</div></div>
      <div class="info-item"><div class="info-item-name">Min mentions</div><div class="info-item-desc">Only show entities mentioned at least this many times across conversations</div></div>
    </div>
    <div class="info-section">
      <div class="info-section-title">Groups</div>
      <div class="info-item"><div class="info-item-name">Type filters</div><div class="info-item-desc">Toggle visibility of entity types (e.g., projects, tools, people)</div></div>
    </div>
    <div class="info-section">
      <div class="info-section-title">Display</div>
      <div class="info-item"><div class="info-item-name">Show labels</div><div class="info-item-desc">Toggle text labels on graph nodes</div></div>
      <div class="info-item"><div class="info-item-name">Label threshold</div><div class="info-item-desc">At higher densities, hide labels to reduce clutter. Lower = more labels visible</div></div>
      <div class="info-item"><div class="info-item-name">Node size</div><div class="info-item-desc">Scale the radius of all nodes. Based on mention count</div></div>
      <div class="info-item"><div class="info-item-name">Link thickness</div><div class="info-item-desc">Scale the width of relationship lines. Based on relationship strength</div></div>
      <div class="info-item"><div class="info-item-name">Link gradient</div><div class="info-item-desc">Opacity falloff for links \u2014 higher values fade weak links more</div></div>
      <div class="info-item"><div class="info-item-name">Auto-zoom</div><div class="info-item-desc">Automatically pan/zoom to center newly loaded or changed nodes</div></div>
    </div>
    <div class="info-section">
      <div class="info-section-title">Forces</div>
      <div class="info-item"><div class="info-item-name">Center force</div><div class="info-item-desc">How strongly nodes are pulled toward the center of the canvas</div></div>
      <div class="info-item"><div class="info-item-name">Repel force</div><div class="info-item-desc">How strongly nodes push each other apart (higher = more spacing)</div></div>
      <div class="info-item"><div class="info-item-name">Link force</div><div class="info-item-desc">How strongly connected nodes are pulled together</div></div>
      <div class="info-item"><div class="info-item-name">Link distance</div><div class="info-item-desc">Target resting distance between connected nodes</div></div>
    </div>
  </div>
</div>

<button id="dream-btn" style="display:none"><span class="icon">&#x2728;</span> Dream</button>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
// ─── Color System ─────────────────────────────────────────────────
const TYPE_COLORS = ${JSON.stringify(TYPE_COLORS)};

// Pre-compute RGB for type colors and their muted versions
const BG = [30, 35, 38]; // #1e2326
const FADE_DURATION = 60000; // 60 seconds to fully mute
const GLOW_DURATION = 3000;  // 3 seconds of glow effect

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

const TYPE_RGB = {};
const TYPE_MUTED = {};
for (const [k, hex] of Object.entries(TYPE_COLORS)) {
  const [r, g, b] = hexToRgb(hex);
  TYPE_RGB[k] = [r, g, b];
  TYPE_MUTED[k] = [
    Math.round(r * 0.35 + BG[0] * 0.65),
    Math.round(g * 0.35 + BG[1] * 0.65),
    Math.round(b * 0.35 + BG[2] * 0.65),
  ];
}

function sparkNodeColor(type, lastSpark) {
  const muted = TYPE_MUTED[type] || [60, 60, 70];
  if (!lastSpark) return 'rgb(' + muted.join(',') + ')';
  const age = Date.now() - lastSpark;
  if (age >= FADE_DURATION) return 'rgb(' + muted.join(',') + ')';
  const t = age / FADE_DURATION; // 0=fresh, 1=muted
  const bright = TYPE_RGB[type] || [136, 136, 136];
  const r = Math.round(bright[0] + (muted[0] - bright[0]) * t);
  const g = Math.round(bright[1] + (muted[1] - bright[1]) * t);
  const b = Math.round(bright[2] + (muted[2] - bright[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function sparkLinkAlpha(lastSpark) {
  if (!lastSpark) return 0.06;
  const age = Date.now() - lastSpark;
  if (age >= FADE_DURATION) return 0.06;
  const t = age / FADE_DURATION;
  return 0.45 + (0.06 - 0.45) * t; // 0.45 → 0.06
}

function glowAlpha(lastSpark) {
  if (!lastSpark) return 0;
  const age = Date.now() - lastSpark;
  if (age >= GLOW_DURATION) return 0;
  return 0.5 * (1 - age / GLOW_DURATION);
}

const REL_RGB = {
  uses:          [127,187,179],
  depends_on:    [230,126,128],
  related_to:    [214,153,182],
  part_of:       [167,192,128],
  configured_by: [230,152,117],
  solved_by:     [219,188,127],
};

let allNodes = [], allLinks = [];
let nodeMap = new Map();
let linkKey = new Set();
let filteredNodes = [], filteredLinks = [];
let activeTypes = new Set(Object.keys(TYPE_COLORS));
let searchTerm = '';
let mentionThreshold = 5;
let simulation;
let transform = d3.zoomIdentity;
let hoveredNode = null;
let focusedNode = null;
let focusNeighbors = null;
let draggedNode = null;
let totalInDb = 0;
let lastDiffTimestamp = 0;
let diffPollTimer = null;
let hasFreshNodes = false;
let autoZoom2D = true;
let lastAutoZoomTime2D = 0;

// Display settings
let showLabels = true;
let labelThresholdManual = 20;
let nodeSizeMult = 1.0;
let linkThicknessMult = 1.0;
let linkGradient = 0.5;

// Force settings — Cluster preset (default)
let forceCenter = 0.01;
let forceRepel = -200;
let forceLinkStrength = 0.5;
let forceLinkDistance = 30;

const PRESETS = {
  cluster:  { center: 0.01, repel: -200, linkStr: 0.5, linkDist: 30 },
  spread:   { center: 0.03, repel: -80,  linkStr: 0.2, linkDist: 60 },
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;

function resize() {
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', () => {
  resize();
  if (simulation) {
    simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
    simulation.alpha(0.05).restart();
  }
});

function nodeRadius(d) {
  return Math.max(2.5, Math.min(Math.sqrt(d.mentionCount || 1) * 2 * nodeSizeMult, 18 * nodeSizeMult));
}

function filterGraph() {
  const nodeSet = new Set();
  filteredNodes = allNodes.filter(n => {
    if (!activeTypes.has(n.type)) return false;
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  filteredLinks = allLinks.filter(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    return nodeSet.has(sid) && nodeSet.has(tid);
  });
}

function buildFilters() {
  const types = [...new Set(allNodes.map(n => n.type))].sort();
  const container = document.getElementById('filters');
  container.innerHTML = '';
  for (const t of types) {
    const pill = document.createElement('div');
    pill.className = 'pill active';
    pill.dataset.type = t;
    pill.innerHTML = '<span class="dot" style="background:' + (TYPE_COLORS[t] || '#4f5b58') + '"></span>' + t;
    pill.addEventListener('click', () => {
      if (activeTypes.has(t)) { activeTypes.delete(t); pill.classList.remove('active'); }
      else { activeTypes.add(t); pill.classList.add('active'); }
      rebuildSim();
    });
    container.appendChild(pill);
  }
}

function rebuildSim() {
  filterGraph();
  updateStats();

  if (simulation) simulation.stop();

  simulation = d3.forceSimulation(filteredNodes)
    .force('link', d3.forceLink(filteredLinks).id(d => d.id).distance(forceLinkDistance).strength(d => Math.min((d.weight || 0.5) * forceLinkStrength, forceLinkStrength * 2)))
    .force('charge', d3.forceManyBody().strength(forceRepel).distanceMax(600).theta(0.9))
    .force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2).strength(forceCenter))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 1).strength(0.3))
    .alphaDecay(0.03)
    .velocityDecay(0.4)
    .on('tick', draw);
}

function draw() {
  ctx.save();
  ctx.fillStyle = '#1e2326';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const labelsVisible = showLabels && transform.k > 0.15;
  const labelThreshold = Math.max(3, Math.round(labelThresholdManual / transform.k));

  // Determine highlight state
  let highlightSet = null;
  let highlightEdges = null;
  if (searchTerm) {
    highlightSet = new Set();
    allNodes.forEach(n => {
      if (n.name.toLowerCase().includes(searchTerm) ||
          (n.description && n.description.toLowerCase().includes(searchTerm)) ||
          (n.community && n.community.toLowerCase().includes(searchTerm))) {
        highlightSet.add(n.id);
      }
    });
  } else if (focusedNode) {
    highlightSet = focusNeighbors;
    highlightEdges = new Set();
    filteredLinks.forEach(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      if (sid === focusedNode.id || tid === focusedNode.id) highlightEdges.add(l);
    });
  }

  // Track whether any sparks are still fading
  let hasActiveSparks = false;
  const now = Date.now();

  // Draw links
  for (const l of filteredLinks) {
    if (!l.source.x || !l.target.x) continue;
    let alpha = sparkLinkAlpha(l.lastSpark);
    if (l.lastSpark && now - l.lastSpark < FADE_DURATION) hasActiveSparks = true;
    if (highlightSet) {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      if (highlightEdges) {
        alpha = highlightEdges.has(l) ? 0.5 : 0.02;
      } else {
        alpha = (highlightSet.has(sid) || highlightSet.has(tid)) ? 0.4 : 0.02;
      }
    }
    const rgb = REL_RGB[l.type] || [69, 71, 90];
    ctx.beginPath();
    ctx.moveTo(l.source.x, l.source.y);
    ctx.lineTo(l.target.x, l.target.y);
    // Gradient: parameterized by linkGradient (0=invisible, 0.5=default fade, 1=solid)
    const rc = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    const g = linkGradient;
    const fz = (1.0 - g) * 0.5;
    const dimLevel = g * g;
    const scale = Math.min(g * 3.0, 1.0);
    if (fz < 0.001) {
      // Solid line
      ctx.strokeStyle = 'rgba(' + rc + ',' + (alpha * scale) + ')';
    } else {
      const grad = ctx.createLinearGradient(l.source.x, l.source.y, l.target.x, l.target.y);
      const hiA = alpha * scale;
      const loA = alpha * dimLevel * scale;
      grad.addColorStop(0,      'rgba(' + rc + ',' + hiA + ')');
      grad.addColorStop(fz,     'rgba(' + rc + ',' + loA + ')');
      grad.addColorStop(1 - fz, 'rgba(' + rc + ',' + loA + ')');
      grad.addColorStop(1,      'rgba(' + rc + ',' + hiA + ')');
      ctx.strokeStyle = grad;
    }
    ctx.lineWidth = Math.max(0.3, (l.weight || 0.5) * 1.2 * linkThicknessMult);
    ctx.stroke();
  }

  // Draw glow halos for fresh nodes (behind the nodes)
  for (const n of filteredNodes) {
    if (n.x == null) continue;
    const ga = glowAlpha(n.lastSpark);
    if (ga > 0) {
      hasActiveSparks = true;
      const r = nodeRadius(n);
      const bright = TYPE_RGB[n.type] || [136, 136, 136];
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + bright[0] + ',' + bright[1] + ',' + bright[2] + ',' + ga + ')';
      ctx.fill();
    }
  }

  // Draw nodes
  for (const n of filteredNodes) {
    if (n.x == null) continue;
    const r = nodeRadius(n);
    if (n.lastSpark && now - n.lastSpark < FADE_DURATION) hasActiveSparks = true;
    let alpha = 1;
    if (highlightSet) {
      alpha = highlightSet.has(n.id) ? 1 : 0.06;
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = sparkNodeColor(n.type, n.lastSpark);
    ctx.globalAlpha = alpha;
    ctx.fill();

    // Glow for hovered node
    if (hoveredNode === n) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  // Draw labels
  if (labelsVisible) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const n of filteredNodes) {
      if (n.x == null) continue;
      if (n.mentionCount < labelThreshold && !(highlightSet && highlightSet.has(n.id))) continue;
      const r = nodeRadius(n);
      const fontSize = Math.max(7, Math.min(10, n.mentionCount * 0.3 + 5));
      ctx.font = fontSize + 'px -apple-system, system-ui, sans-serif';
      let alpha = 0.75;
      if (highlightSet) {
        alpha = highlightSet.has(n.id) ? 0.95 : 0.04;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#d3c6aa';
      ctx.fillText(n.name, n.x, n.y - r - 3);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // Continue rAF loop while sparks are fading
  hasFreshNodes = hasActiveSparks;
  if (hasActiveSparks) {
    requestAnimationFrame(draw);
  }
}

// ─── Zoom ────────────────────────────────────────────────────────

const zoomBehavior = d3.zoom()
  .scaleExtent([0.02, 10])
  .on('zoom', (e) => { transform = e.transform; draw(); });
d3.select(canvas).call(zoomBehavior);

// ─── Mouse interaction ──────────────────────────────────────────

function screenToWorld(sx, sy) {
  return [(sx - transform.x) / transform.k, (sy - transform.y) / transform.k];
}

function findNodeAt(sx, sy) {
  const [wx, wy] = screenToWorld(sx, sy);
  let closest = null, minDist = Infinity;
  for (const n of filteredNodes) {
    if (n.x == null) continue;
    const dx = n.x - wx, dy = n.y - wy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const r = nodeRadius(n) + 4;
    if (dist < r && dist < minDist) { closest = n; minDist = dist; }
  }
  return closest;
}

canvas.addEventListener('mousemove', (e) => {
  if (draggedNode) {
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    draggedNode.fx = wx;
    draggedNode.fy = wy;
    return;
  }
  const node = findNodeAt(e.clientX, e.clientY);
  if (node !== hoveredNode) {
    hoveredNode = node;
    canvas.style.cursor = node ? 'pointer' : 'default';
    if (node) {
      showTooltip(e, node);
    } else {
      hideTooltip();
    }
    draw();
  } else if (node) {
    moveTooltip(e);
  }
});

canvas.addEventListener('mousedown', (e) => {
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) {
    draggedNode = node;
    node.fx = node.x;
    node.fy = node.y;
    simulation.alphaTarget(0.1).restart();
    e.stopPropagation();
  }
});

canvas.addEventListener('mouseup', () => {
  if (draggedNode) {
    draggedNode.fx = null;
    draggedNode.fy = null;
    draggedNode = null;
    simulation.alphaTarget(0);
  }
});

canvas.addEventListener('click', (e) => {
  if (draggedNode) return;
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) {
    if (focusedNode === node) {
      focusedNode = null;
      focusNeighbors = null;
    } else {
      focusedNode = node;
      focusNeighbors = new Set([node.id]);
      filteredLinks.forEach(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        if (sid === node.id) focusNeighbors.add(tid);
        if (tid === node.id) focusNeighbors.add(sid);
      });
    }
    draw();
  } else {
    if (focusedNode) {
      focusedNode = null;
      focusNeighbors = null;
      draw();
    }
  }
});

// ─── Tooltip ─────────────────────────────────────────────────────

function showTooltip(event, d) {
  const tip = document.getElementById('tooltip');
  let html = '<div class="name">' + esc(d.name) + '</div>';
  html += '<div class="type">' + d.type + ' &middot; ' + d.mentionCount + ' mentions</div>';
  if (d.description) html += '<div class="desc">' + esc(d.description) + '</div>';
  if (d.community) html += '<div class="community">' + esc(d.community) + '</div>';
  tip.innerHTML = html;
  tip.style.display = 'block';
  moveTooltip(event);
}
function moveTooltip(event) {
  const tip = document.getElementById('tooltip');
  tip.style.left = (event.clientX + 16) + 'px';
  tip.style.top = (event.clientY - 10) + 'px';
}
function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}
function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ─── Settings Panel ──────────────────────────────────────────────

// Panel toggle
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});

// Section collapse
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => {
    hdr.parentElement.classList.toggle('open');
  });
});

// Filters
document.getElementById('search').addEventListener('input', (e) => {
  searchTerm = e.target.value.toLowerCase();
  focusedNode = null;
  focusNeighbors = null;
  draw();
});

document.getElementById('threshold').addEventListener('input', (e) => {
  mentionThreshold = parseInt(e.target.value, 10);
  document.getElementById('threshold-val').textContent = mentionThreshold;
  rebuildSim();
});

// Display controls
document.getElementById('toggle-labels').addEventListener('click', function() {
  this.classList.toggle('on');
  showLabels = this.classList.contains('on');
  draw();
});

document.getElementById('label-threshold').addEventListener('input', (e) => {
  labelThresholdManual = parseInt(e.target.value, 10);
  document.getElementById('label-threshold-val').textContent = labelThresholdManual;
  draw();
});

document.getElementById('node-size').addEventListener('input', (e) => {
  nodeSizeMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);
  draw();
});

document.getElementById('link-thickness').addEventListener('input', (e) => {
  linkThicknessMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('link-thickness-val').textContent = linkThicknessMult.toFixed(1);
  draw();
});

document.getElementById('link-gradient').addEventListener('input', (e) => {
  linkGradient = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-gradient-val').textContent = e.target.value;
  draw();
});

// Force controls
function updateForces() {
  if (!simulation) return;
  simulation.force('center').strength(forceCenter);
  simulation.force('charge').strength(forceRepel);
  simulation.force('link').distance(forceLinkDistance);
  simulation.force('link').strength(d => Math.min((d.weight || 0.5) * forceLinkStrength, forceLinkStrength * 2));
  simulation.alpha(0.3).restart();
}

document.getElementById('center-force').addEventListener('input', (e) => {
  forceCenter = parseInt(e.target.value, 10) / 100;
  document.getElementById('center-force-val').textContent = forceCenter.toFixed(2);
  updateForces();
});

document.getElementById('repel-force').addEventListener('input', (e) => {
  forceRepel = -(parseInt(e.target.value, 10) * 4);
  document.getElementById('repel-force-val').textContent = forceRepel;
  updateForces();
});

document.getElementById('link-force').addEventListener('input', (e) => {
  forceLinkStrength = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-force-val').textContent = forceLinkStrength.toFixed(2);
  updateForces();
});

document.getElementById('link-distance').addEventListener('input', (e) => {
  forceLinkDistance = parseInt(e.target.value, 10);
  document.getElementById('link-distance-val').textContent = forceLinkDistance;
  updateForces();
});

// Preset buttons
function applyPreset(name) {
  const p = PRESETS[name];
  forceCenter = p.center; forceRepel = p.repel; forceLinkStrength = p.linkStr; forceLinkDistance = p.linkDist;
  document.getElementById('center-force').value = Math.round(p.center * 100);
  document.getElementById('center-force-val').textContent = p.center.toFixed(2);
  document.getElementById('repel-force').value = Math.round(-p.repel / 4);
  document.getElementById('repel-force-val').textContent = p.repel;
  document.getElementById('link-force').value = Math.round(p.linkStr * 100);
  document.getElementById('link-force-val').textContent = p.linkStr.toFixed(2);
  document.getElementById('link-distance').value = p.linkDist;
  document.getElementById('link-distance-val').textContent = p.linkDist;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('preset-' + name).classList.add('active');
  updateForces();
}
document.getElementById('preset-cluster').addEventListener('click', () => applyPreset('cluster'));
document.getElementById('preset-spread').addEventListener('click', () => applyPreset('spread'));

// Auto-zoom toggle
document.getElementById('toggle-autozoom').addEventListener('click', function() {
  this.classList.toggle('on');
  autoZoom2D = this.classList.contains('on');
});

// ─── Settings Persistence ─────────────────────────────────────────
const SETTINGS_KEY = 'engram-graph-settings';
let factoryThreshold = 5; // updated from server on load

const FACTORY_DEFAULTS = {
  mentionThreshold: 5,
  showLabels: true,
  labelThreshold: 20,
  nodeSizeMultiplier: 1.0,
  linkThicknessMultiplier: 1.0,
  linkGradient: 50,
  autoZoom: true,
  activePreset: 'cluster',
  centerForce: 1,
  repelForce: 50,
  linkForce: 50,
  linkDistance: 30,
  activeTypes: Object.keys(TYPE_COLORS),
};

function collectCurrentSettings() {
  return {
    mentionThreshold: mentionThreshold,
    showLabels: showLabels,
    labelThreshold: labelThresholdManual,
    nodeSizeMultiplier: parseFloat(document.getElementById('node-size').value),
    linkThicknessMultiplier: parseFloat(document.getElementById('link-thickness').value),
    linkGradient: parseInt(document.getElementById('link-gradient').value, 10),
    autoZoom: autoZoom2D,
    activePreset: document.querySelector('.preset-btn.active') ? document.querySelector('.preset-btn.active').id.replace('preset-', '') : null,
    centerForce: parseInt(document.getElementById('center-force').value, 10),
    repelForce: parseInt(document.getElementById('repel-force').value, 10),
    linkForce: parseInt(document.getElementById('link-force').value, 10),
    linkDistance: parseInt(document.getElementById('link-distance').value, 10),
    activeTypes: [...activeTypes],
  };
}

function saveDefaultSettings() {
  const settings = collectCurrentSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  // Remove legacy key
  localStorage.removeItem('engram-autozoom-2d');

  const btn = document.getElementById('save-defaults-btn');
  btn.textContent = 'Saved!';
  btn.classList.add('saved');
  setTimeout(() => {
    btn.textContent = 'Save as Default';
    btn.classList.remove('saved');
  }, 1500);
}

function applySettings(s) {
  mentionThreshold = s.mentionThreshold;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;

  showLabels = s.showLabels;
  document.getElementById('toggle-labels').classList.toggle('on', showLabels);

  labelThresholdManual = s.labelThreshold;
  document.getElementById('label-threshold').value = s.labelThreshold;
  document.getElementById('label-threshold-val').textContent = s.labelThreshold;

  const nodeSlider = s.nodeSizeMultiplier;
  document.getElementById('node-size').value = nodeSlider;
  nodeSizeMult = nodeSlider / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);

  const linkSlider = s.linkThicknessMultiplier;
  document.getElementById('link-thickness').value = linkSlider;
  linkThicknessMult = linkSlider / 10;
  document.getElementById('link-thickness-val').textContent = linkThicknessMult.toFixed(1);

  linkGradient = s.linkGradient / 100;
  document.getElementById('link-gradient').value = s.linkGradient;
  document.getElementById('link-gradient-val').textContent = s.linkGradient;

  autoZoom2D = s.autoZoom;
  document.getElementById('toggle-autozoom').classList.toggle('on', autoZoom2D);

  // Forces
  document.getElementById('center-force').value = s.centerForce;
  forceCenter = s.centerForce / 100;
  document.getElementById('center-force-val').textContent = forceCenter.toFixed(2);

  document.getElementById('repel-force').value = s.repelForce;
  forceRepel = -(s.repelForce * 4);
  document.getElementById('repel-force-val').textContent = forceRepel;

  document.getElementById('link-force').value = s.linkForce;
  forceLinkStrength = s.linkForce / 100;
  document.getElementById('link-force-val').textContent = forceLinkStrength.toFixed(2);

  document.getElementById('link-distance').value = s.linkDistance;
  forceLinkDistance = s.linkDistance;
  document.getElementById('link-distance-val').textContent = s.linkDistance;

  // Preset highlight
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  if (s.activePreset) {
    const presetBtn = document.getElementById('preset-' + s.activePreset);
    if (presetBtn) presetBtn.classList.add('active');
  }

  // Type filters
  if (s.activeTypes) {
    activeTypes = new Set(s.activeTypes);
    document.querySelectorAll('#filters .pill').forEach(pill => {
      const t = pill.dataset.type;
      if (activeTypes.has(t)) pill.classList.add('active');
      else pill.classList.remove('active');
    });
  }
}

function loadDefaultSettings() {
  // Migrate legacy autozoom key
  const legacyAz = localStorage.getItem('engram-autozoom-2d');
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch(e) { return null; }
  }
  if (legacyAz !== null) {
    // No full saved settings but legacy autozoom exists — carry it forward
    autoZoom2D = legacyAz !== 'false';
    document.getElementById('toggle-autozoom').classList.toggle('on', autoZoom2D);
    localStorage.removeItem('engram-autozoom-2d');
  }
  return null;
}

function resetToFactoryDefaults() {
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem('engram-autozoom-2d');
  const defaults = { ...FACTORY_DEFAULTS, mentionThreshold: factoryThreshold };
  applySettings(defaults);
  rebuildSim();
  draw();
}

document.getElementById('save-defaults-btn').addEventListener('click', saveDefaultSettings);
document.getElementById('reset-defaults-btn').addEventListener('click', resetToFactoryDefaults);

// ─── Setting Hint Tooltips ────────────────────────────────────────
const SETTING_HINTS = {
  'search': 'Filter visible nodes by name, description, or community',
  'threshold': 'Only show entities mentioned at least this many times across conversations',
  'toggle-labels': 'Toggle text labels on graph nodes',
  'label-threshold': 'At higher densities, hide labels to reduce clutter. Lower = more labels visible',
  'node-size': 'Scale the radius of all nodes. Based on mention count',
  'link-thickness': 'Scale the width of relationship lines. Based on relationship strength',
  'link-gradient': 'Opacity falloff for links \\u2014 higher values fade weak links more',
  'toggle-autozoom': 'Automatically pan/zoom to center newly loaded or changed nodes',
  'center-force': 'How strongly nodes are pulled toward the center of the canvas',
  'repel-force': 'How strongly nodes push each other apart (higher = more spacing)',
  'link-force': 'How strongly connected nodes are pulled together',
  'link-distance': 'Target resting distance between connected nodes',
};

const SECTION_HINTS = {
  'Filters': 'Control which entities are visible based on search and mention count',
  'Groups': 'Toggle visibility of entity types (e.g., projects, tools, people)',
  'Display': 'Adjust visual appearance of nodes, labels, and links',
  'Forces': 'Tune the physics simulation that positions nodes',
  'Dream': 'Trigger the dream consolidation pipeline',
};

let activeBubble = null;

function createHintIcons() {
  // Add hints to settings controls
  for (const [id, hint] of Object.entries(SETTING_HINTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Find the label element (parent ctrl-label or ctrl-toggle > .label)
    let labelEl = null;
    const row = el.closest('.ctrl-row') || el.closest('.ctrl-toggle');
    if (row) {
      labelEl = row.querySelector('.ctrl-label') || row.querySelector('.label');
    }
    if (!labelEl) continue;

    const icon = document.createElement('span');
    icon.className = 'hint-icon';
    icon.textContent = '?';
    icon.dataset.hint = hint;
    labelEl.style.position = 'relative';
    labelEl.appendChild(icon);

    icon.addEventListener('mouseenter', showHintBubble);
    icon.addEventListener('mouseleave', hideHintBubble);
  }

  // Add hints to section headers
  document.querySelectorAll('.section-header').forEach(hdr => {
    const titleEl = hdr.querySelector('.section-title');
    if (!titleEl) return;
    const hint = SECTION_HINTS[titleEl.textContent];
    if (!hint) return;

    const icon = document.createElement('span');
    icon.className = 'hint-icon';
    icon.textContent = '?';
    icon.dataset.hint = hint;
    hdr.style.position = 'relative';
    hdr.appendChild(icon);

    icon.addEventListener('mouseenter', showHintBubble);
    icon.addEventListener('mouseleave', hideHintBubble);
    // Prevent section toggle when clicking the hint icon
    icon.addEventListener('click', (e) => e.stopPropagation());
  });
}

function showHintBubble(e) {
  hideHintBubble();
  const icon = e.currentTarget;
  const hint = icon.dataset.hint;
  if (!hint) return;

  const bubble = document.createElement('div');
  bubble.className = 'hint-bubble';
  bubble.textContent = hint;

  // Position near the icon, inside the settings panel
  const panel = document.getElementById('settings-panel');
  panel.appendChild(bubble);

  const iconRect = icon.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  bubble.style.right = '20px';
  bubble.style.top = (iconRect.top - panelRect.top + panel.scrollTop + 20) + 'px';

  requestAnimationFrame(() => bubble.classList.add('visible'));
  activeBubble = bubble;
}

function hideHintBubble() {
  if (activeBubble) {
    activeBubble.remove();
    activeBubble = null;
  }
}

// ─── Info Dialog ─────────────────────────────────────────────────
document.getElementById('info-btn').addEventListener('click', () => {
  document.getElementById('info-overlay').classList.add('open');
});
document.getElementById('info-close').addEventListener('click', () => {
  document.getElementById('info-overlay').classList.remove('open');
});
document.getElementById('info-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('info-overlay')) {
    document.getElementById('info-overlay').classList.remove('open');
  }
});

function updateStats() {
  document.getElementById('stat-nodes').textContent = filteredNodes.length;
  document.getElementById('stat-edges').textContent = filteredLinks.length;
  document.getElementById('stat-total').textContent = totalInDb;
}

// ─── Init ────────────────────────────────────────────────────────

Promise.all([
  fetch('/graph/api/graph').then(r => r.json()),
  fetch('/graph/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
    // Store server threshold as factory default
    factoryThreshold = thresholdData.value;
    FACTORY_DEFAULTS.mentionThreshold = factoryThreshold;

    // Apply computed optimal threshold as initial default
    mentionThreshold = thresholdData.value;
    document.getElementById('threshold').value = mentionThreshold;
    document.getElementById('threshold-val').textContent = mentionThreshold;

    // Initialize all nodes as fully muted (lastSpark = 0)
    allNodes = data.nodes.map(n => { n.lastSpark = 0; return n; });
    allLinks = data.links.map(l => { l.lastSpark = 0; return l; });
    totalInDb = allNodes.length;

    // Build lookup structures
    nodeMap.clear();
    linkKey.clear();
    for (const n of allNodes) nodeMap.set(n.id, n);
    for (const l of allLinks) linkKey.add(l.source + '|' + l.target + '|' + l.type);

    // Set initial diff timestamp to now (only fetch changes after load)
    lastDiffTimestamp = Math.floor(Date.now() / 1000);

    buildFilters();

    // Load saved settings (after buildFilters so type filter pills exist)
    const savedSettings = loadDefaultSettings();
    if (savedSettings) {
      applySettings(savedSettings);
    }

    // Create hint icons (after DOM is ready)
    createHintIcons();

    rebuildSim();

    // Start diff polling
    startDiffPolling();

    // Auto-fit after settling
    setTimeout(() => {
      if (filteredNodes.length === 0) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of filteredNodes) {
        if (n.x == null) continue;
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const pad = 60;
      const bw = maxX - minX + pad * 2;
      const bh = maxY - minY + pad * 2;
      const scale = Math.min(window.innerWidth / bw, window.innerHeight / bh, 2);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const t = d3.zoomIdentity
        .translate(window.innerWidth / 2, window.innerHeight / 2)
        .scale(scale)
        .translate(-cx, -cy);
      d3.select(canvas).transition().duration(750).call(zoomBehavior.transform, t);
    }, 3000);
  });

// ─── Diff Polling ─────────────────────────────────────────────────

function startDiffPolling() {
  if (diffPollTimer) return;
  diffPollTimer = setInterval(pollDiff, 1500);
}

function pollDiff() {
  fetch('/graph/api/diff?since=' + lastDiffTimestamp)
    .then(r => r.json())
    .then(mergeDiff)
    .catch(() => {});
}

function mergeDiff(diff) {
  if (!diff) return;
  lastDiffTimestamp = diff.timestamp;
  const sparkTime = Date.now();
  let changed = false;
  const newNodeIds = [];

  // New nodes
  for (const n of diff.newNodes) {
    if (!nodeMap.has(n.id)) {
      n.lastSpark = sparkTime;
      allNodes.push(n);
      nodeMap.set(n.id, n);
      newNodeIds.push(n.id);
      changed = true;
    }
  }

  // Updated nodes — refresh properties, spark them
  for (const n of diff.updatedNodes) {
    const existing = nodeMap.get(n.id);
    if (existing) {
      existing.name = n.name;
      existing.description = n.description;
      existing.mentionCount = n.mentionCount;
      existing.community = n.community;
      existing.lastSpark = sparkTime;
      changed = true;
    }
  }

  // New links
  for (const l of diff.newLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    if (!linkKey.has(key)) {
      l.lastSpark = sparkTime;
      allLinks.push(l);
      linkKey.add(key);
      changed = true;
      // Also spark the connected nodes
      const sn = nodeMap.get(l.source);
      const tn = nodeMap.get(l.target);
      if (sn) sn.lastSpark = sparkTime;
      if (tn) tn.lastSpark = sparkTime;
    }
  }

  // Updated links
  for (const l of diff.updatedLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    // Find and update existing link
    for (const el of allLinks) {
      const sid = typeof el.source === 'object' ? el.source.id : el.source;
      const tid = typeof el.target === 'object' ? el.target.id : el.target;
      if (sid === l.source && tid === l.target && el.type === l.type) {
        el.weight = l.weight;
        el.context = l.context;
        el.lastSpark = sparkTime;
        changed = true;
        break;
      }
    }
  }

  if (changed) {
    totalInDb = allNodes.length;

    // Incremental sim update: re-filter and add new nodes/links without full restart
    const prevNodeCount = filteredNodes.length;
    filterGraph();
    updateStats();

    if (filteredNodes.length !== prevNodeCount) {
      // New visible nodes appeared — warm-restart the sim
      simulation.nodes(filteredNodes);
      simulation.force('link').links(filteredLinks);
      simulation.alpha(0.15).restart();
    }

    // Show update indicator
    const live = document.getElementById('live');
    live.textContent = '+' + (diff.newNodes.length + diff.updatedNodes.length) + ' changes';
    live.classList.add('show');
    setTimeout(() => live.classList.remove('show'), 2000);

    // Auto-zoom to new nodes
    if (autoZoom2D && newNodeIds.length >= 2 && Date.now() - lastAutoZoomTime2D > 5000) {
      setTimeout(() => {
        const newNodes = newNodeIds.map(id => nodeMap.get(id)).filter(n => n && n.x != null);
        if (newNodes.length >= 2) {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const n of newNodes) {
            minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
            minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
          }
          const pad = 150;
          const bw = maxX - minX + pad * 2;
          const bh = maxY - minY + pad * 2;
          const scale = Math.min(window.innerWidth / bw, window.innerHeight / bh, 2);
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const t = d3.zoomIdentity
            .translate(window.innerWidth / 2, window.innerHeight / 2)
            .scale(scale)
            .translate(-cx, -cy);
          d3.select(canvas).transition().duration(750).call(zoomBehavior.transform, t);
          lastAutoZoomTime2D = Date.now();
        }
      }, 500);
    }

    // Trigger rAF fade loop
    if (!hasFreshNodes) {
      hasFreshNodes = true;
      requestAnimationFrame(draw);
    }
  }
}

// ─── Dream UI ─────────────────────────────────────────────────────

const PHASES = ['ingest', 'extract', 'consolidate', 'reflect', 'prune'];
let dreamPolling = null;

function initDreamUI() {
  // Build pipeline indicators
  const pipeline = document.getElementById('ds-pipeline');
  const names = document.getElementById('ds-phase-names');
  pipeline.innerHTML = '';
  names.innerHTML = '';
  PHASES.forEach(p => {
    const step = document.createElement('div');
    step.className = 'step';
    step.dataset.phase = p;
    pipeline.appendChild(step);
    const label = document.createElement('span');
    label.dataset.phase = p;
    label.textContent = p.slice(0, 3);
    names.appendChild(label);
  });

  document.getElementById('dream-btn-panel').addEventListener('click', startDreamFromPanel);

  // Initial status check
  pollDreamStatus();
}

function startDreamFromPanel() {
  const btn = document.getElementById('dream-btn-panel');
  btn.disabled = true;
  btn.style.opacity = '0.5';
  fetch('/graph/api/dream/start', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        startDreamPolling();
      } else {
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    })
    .catch(() => { btn.disabled = false; btn.style.opacity = '1'; });
}

function startDreamPolling() {
  if (dreamPolling) return;
  dreamPolling = setInterval(pollDreamStatus, 2000);
}

function stopDreamPolling() {
  if (dreamPolling) {
    clearInterval(dreamPolling);
    dreamPolling = null;
  }
}

function pollDreamStatus() {
  fetch('/graph/api/dream/status')
    .then(r => r.json())
    .then(updateDreamUI)
    .catch(() => {});
}

function updateDreamUI(status) {
  const panel = document.getElementById('dream-status');
  const btn = document.getElementById('dream-btn-panel');

  if (!status.running) {
    panel.classList.remove('active');
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.innerHTML = '<span class="icon">&#x2728;</span> Dream';
    stopDreamPolling();
    return;
  }

  panel.classList.add('active');
  btn.disabled = true;
  btn.style.opacity = '0.5';
  btn.innerHTML = '<span class="icon">&#x2728;</span> Dreaming...';
  startDreamPolling();

  // Phase label
  const phaseLabel = status.phase ? status.phase.charAt(0).toUpperCase() + status.phase.slice(1) : 'Starting';
  document.getElementById('ds-phase').textContent = phaseLabel;

  // Detail
  document.getElementById('ds-detail').textContent = status.detail || 'Processing...';

  // Progress bar
  const fill = document.getElementById('ds-fill');
  const progressText = document.getElementById('ds-progress');
  if (status.progress && status.progress.total > 0) {
    const pct = Math.round((status.progress.processed / status.progress.total) * 100);
    fill.style.width = pct + '%';
    progressText.textContent = status.progress.processed + '/' + status.progress.total +
      (status.progress.errors > 0 ? ' (' + status.progress.errors + ' errors)' : '');
  } else {
    fill.style.width = '0%';
    progressText.textContent = '';
  }

  // Pipeline steps
  const currentIdx = PHASES.indexOf(status.phase);
  document.querySelectorAll('.ds-pipeline .step, #ds-pipeline .step').forEach((el, i) => {
    el.className = 'step';
    if (i < currentIdx) el.classList.add('done');
    else if (i === currentIdx) el.classList.add('active');
  });
  document.querySelectorAll('.ds-phase-names span, #ds-phase-names span').forEach((el, i) => {
    el.className = '';
    if (i < currentIdx) el.classList.add('done');
    else if (i === currentIdx) el.classList.add('active');
  });
}

initDreamUI();

// ─── Growth Animation ────────────────────────────────────────────

let animating2D = false;
let animTime2D = 0;
let animMinTime2D = 0;
let animMaxTime2D = 0;
let animSpeed2D = 1;
const ANIM_SPEEDS_2D = [1, 2, 5, 10, 20];
let animSpeedIdx2D = 0;
let animLastFrame2D = 0;
let animNodeOrder2D = [];
let animVisibleCount2D = 0;
let animSavedThreshold2D = 0;

const animBtn2D = document.getElementById('animate-btn');
const animProgress2D = document.getElementById('anim-progress');
const animBar2D = document.getElementById('anim-bar');
const animDate2D = document.getElementById('anim-date');
const animSpeedEl2D = document.getElementById('anim-speed');

function formatAnimDate2D(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startAnimation2D() {
  // Animate within the current threshold — keeps node count manageable
  const thresholdFiltered = allNodes.filter(n => (n.mentionCount || 0) >= mentionThreshold);
  animNodeOrder2D = thresholdFiltered
    .filter(n => (n.firstSeen || 0) > 0)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  if (animNodeOrder2D.length < 2) return;

  animMinTime2D = animNodeOrder2D[0].firstSeen;
  animMaxTime2D = animNodeOrder2D[animNodeOrder2D.length - 1].firstSeen;
  animTime2D = animMinTime2D;
  animVisibleCount2D = 0;
  animSavedThreshold2D = mentionThreshold;

  animating2D = true;
  animLastFrame2D = performance.now();
  animBtn2D.classList.add('playing');
  animBtn2D.innerHTML = '&#x25A0;';
  animProgress2D.classList.add('show');

  // Start with empty graph
  filteredNodes = [];
  filteredLinks = [];
  rebuildSim();
  requestAnimationFrame(animTick2D);
}

function stopAnimation2D() {
  animating2D = false;
  animBtn2D.classList.remove('playing');
  animBtn2D.innerHTML = '&#x25B6;';
  animProgress2D.classList.remove('show');

  mentionThreshold = animSavedThreshold2D;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;
  rebuildSim();
}

function animTick2D(now) {
  if (!animating2D) return;
  const dt = (now - animLastFrame2D) / 1000;
  animLastFrame2D = now;

  const BASE_DURATION = 45;
  const timeSpan = animMaxTime2D - animMinTime2D || 1;
  const timeScale = timeSpan / BASE_DURATION;
  animTime2D += dt * timeScale * animSpeed2D;

  if (animTime2D >= animMaxTime2D) {
    animTime2D = animMaxTime2D;
    animVisibleCount2D = animNodeOrder2D.length;
    animRebuild2D();
    updateAnimUI2D();
    setTimeout(stopAnimation2D, 1500);
    return;
  }

  let newCount = animVisibleCount2D;
  while (newCount < animNodeOrder2D.length && (animNodeOrder2D[newCount].firstSeen || 0) <= animTime2D) {
    newCount++;
  }

  if (newCount > animVisibleCount2D) {
    const sparkTime = Date.now();
    for (let i = animVisibleCount2D; i < newCount; i++) {
      animNodeOrder2D[i].lastSpark = sparkTime;
    }
    animVisibleCount2D = newCount;
    animRebuild2D();
  }

  updateAnimUI2D();
  requestAnimationFrame(animTick2D);
}

function animRebuild2D() {
  const visibleIds = new Set();
  for (let i = 0; i < animVisibleCount2D; i++) {
    visibleIds.add(animNodeOrder2D[i].id);
  }

  filteredNodes = allNodes.filter(n => visibleIds.has(n.id));
  filteredLinks = allLinks.filter(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return visibleIds.has(s) && visibleIds.has(t);
  });

  updateStats();

  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(filteredNodes)
    .force('link', d3.forceLink(filteredLinks).id(d => d.id).distance(forceLinkDistance).strength(d => Math.min((d.weight || 0.5) * forceLinkStrength, forceLinkStrength * 2)))
    .force('charge', d3.forceManyBody().strength(forceRepel).distanceMax(600).theta(0.9))
    .force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2).strength(forceCenter))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 1).strength(0.3))
    .alphaDecay(0.03)
    .velocityDecay(0.4)
    .on('tick', draw);
}

function updateAnimUI2D() {
  const pct = ((animTime2D - animMinTime2D) / (animMaxTime2D - animMinTime2D || 1)) * 100;
  animBar2D.style.width = pct + '%';
  animDate2D.textContent = formatAnimDate2D(animTime2D);
}

animBtn2D.addEventListener('click', () => {
  if (animating2D) stopAnimation2D();
  else startAnimation2D();
});

animSpeedEl2D.addEventListener('click', () => {
  animSpeedIdx2D = (animSpeedIdx2D + 1) % ANIM_SPEEDS_2D.length;
  animSpeed2D = ANIM_SPEEDS_2D[animSpeedIdx2D];
  animSpeedEl2D.textContent = animSpeed2D + 'x';
});
</script>
</body>
</html>`;
}
