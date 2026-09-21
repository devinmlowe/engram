/**
 * Graph page — D3 force-directed knowledge graph with Canvas rendering.
 */

import { sharedPanelCss } from "./shared-css.js";
import { sharedJs, panelToggleJs } from "./shared-js.js";
import { sparkColorsJs } from "./spark-colors.js";
import { diffPollingJs } from "./diff-polling.js";
import { growthAnimationJs } from "./growth-animation.js";

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
    background: #191d20;
    color: #d3c6aa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  canvas { display: block; }

  #tooltip {
    position: fixed;
    display: none;
    background: #272e33;
    border: 1px solid #374145;
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

  ${sharedPanelCss()}

  /* Type filter pills in panel */
  #filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* Stats bar (minimal, always visible) */
  #stats-bar {
    position: fixed;
    bottom: 12px;
    left: 16px;
    z-index: 50;
    font-size: 11px;
    color: #495156;
    pointer-events: none;
  }

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
    border: 2px solid #374145;
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
    background: #374145;
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
    background: #374145;
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
    color: #495156;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .ds-phase-names span.done { color: #a7c080; }
  .ds-phase-names span.active { color: #d699b6; }

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
    border: 1px solid #374145;
    background: #272e33;
    color: #d3c6aa;
  }
  .panel-footer button:hover { border-color: #7fbbb3; background: #374145; }
  .panel-footer button.saved { border-color: #a7c080; color: #a7c080; }

  /* ─── Setting hint tooltips ─── */
  .hint-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: #374145;
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
    background: #272e33;
    border: 1px solid #374145;
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
    background: #1e2326;
    border: 1px solid #374145;
    border-radius: 12px;
    padding: 0;
    max-width: 420px;
    width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  #info-dialog::-webkit-scrollbar { width: 4px; }
  #info-dialog::-webkit-scrollbar-thumb { background: #374145; border-radius: 2px; }
  .info-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid #272e33;
    position: sticky;
    top: 0;
    background: #1e2326;
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
      <button id="dream-btn-panel" style="width:100%;background:#272e33;border:1px solid #374145;border-radius:8px;padding:8px 16px;color:#d699b6;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s"><span class="icon">&#x2728;</span> Dream</button>
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
    <!-- Sections are generated from SETTING_HINTS / SECTION_HINTS by buildInfoDialog() -->
  </div>
</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
${panelToggleJs()}
${sharedJs()}
${sparkColorsJs({ bg: [25, 29, 32], minBlend: 0.35, maxBlend: 0.35 })}

const GLOW_DURATION = 3000;  // 3 seconds of glow effect

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

let allNodes = [], allLinks = [];
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
    pill.innerHTML = '<span class="dot" style="background:' + (TYPE_COLORS[t] || '#495156') + '"></span>' + t;
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
  buildSim();
}

// (Re)start the force simulation over filteredNodes / filteredLinks
function buildSim() {
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
  ctx.fillStyle = '#191d20';
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
      const bright = typeRgb(n.type);
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
    ctx.fillStyle = sparkNodeColor(n);
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

// ─── Settings Panel ──────────────────────────────────────────────

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

// Display name for a hinted control: its label text, or the search placeholder
function settingName(el) {
  if (el.placeholder) return el.placeholder.replace(/\\.\\.\\.$/, '');
  const row = el.closest('.ctrl-row') || el.closest('.ctrl-toggle');
  const label = row && (row.querySelector('.ctrl-label') || row.querySelector('.label'));
  return label ? label.firstChild.textContent.trim() : el.id;
}

// One dialog section per settings section; rows come from SETTING_HINTS, and a
// section without hinted controls (Groups, Dream) shows its SECTION_HINTS line.
function buildInfoDialog() {
  const dialog = document.getElementById('info-dialog');
  document.querySelectorAll('#settings-panel .section').forEach(section => {
    const title = section.querySelector('.section-title').textContent;
    const rows = [...section.querySelectorAll('[id]')]
      .filter(el => SETTING_HINTS[el.id])
      .map(el => [settingName(el), SETTING_HINTS[el.id]]);
    if (rows.length === 0 && SECTION_HINTS[title]) rows.push([title, SECTION_HINTS[title]]);
    const sec = document.createElement('div');
    sec.className = 'info-section';
    sec.innerHTML = '<div class="info-section-title">' + esc(title) + '</div>' +
      rows.map(([name, desc]) =>
        '<div class="info-item"><div class="info-item-name">' + esc(name) + '</div><div class="info-item-desc">' + esc(desc) + '</div></div>'
      ).join('');
    dialog.appendChild(sec);
  });
}

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

    buildFilters();

    // Load saved settings (after buildFilters so type filter pills exist)
    const savedSettings = loadDefaultSettings();
    if (savedSettings) {
      applySettings(savedSettings);
    }

    // Create hint icons and the settings guide (after DOM is ready)
    buildInfoDialog();
    createHintIcons();

    rebuildSim();

    startDiffPolling('/graph', onDiffChanged);

    // Auto-fit after settling
    setTimeout(() => {
      const placed = filteredNodes.filter(n => n.x != null);
      if (placed.length > 0) zoomToNodes(placed, 60);
    }, 3000);
  });

${diffPollingJs()}

// Zoom the canvas to fit a set of positioned nodes
function zoomToNodes(nodes, pad) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  const scale = Math.min(window.innerWidth / bw, window.innerHeight / bh, 2);
  const t = d3.zoomIdentity
    .translate(window.innerWidth / 2, window.innerHeight / 2)
    .scale(scale)
    .translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
  d3.select(canvas).transition().duration(750).call(zoomBehavior.transform, t);
}

function onDiffChanged(newNodeIds) {
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

  // Auto-zoom to new nodes
  if (autoZoom2D && newNodeIds.length >= 2 && Date.now() - lastAutoZoomTime2D > 5000) {
    setTimeout(() => {
      const newNodes = newNodeIds.map(id => nodeMap.get(id)).filter(n => n && n.x != null);
      if (newNodes.length >= 2) {
        zoomToNodes(newNodes, 150);
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

${growthAnimationJs()}

setupGrowthAnimation(
  (nodes, links) => {
    filteredNodes = nodes;
    filteredLinks = links;
    updateStats();
    buildSim();
  },
  rebuildSim,
);
</script>
</body>
</html>`;
}
