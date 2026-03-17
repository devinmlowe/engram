/**
 * Depth page — Three.js 3D knowledge graph visualization.
 */

import { sharedPanelCss } from "./shared-css.js";
import { TYPE_COLORS, DEFAULT_COLOR, BG_DEEP } from './theme.js';

export function depthPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram depth</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #191d20;
    color: #d3c6aa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  #graph-3d { width: 100vw; height: 100vh; }

  #tooltip {
    position: fixed;
    display: none;
    background: rgba(39,46,51,0.95);
    border: 1px solid #374145;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 360px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  }
  #tooltip .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  #tooltip .type { color: #9da9a0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .desc { margin-top: 6px; color: #d3c6aa; line-height: 1.4; }
  #tooltip .community { margin-top: 6px; color: #83c092; font-size: 11px; }
  #tooltip .time { margin-top: 6px; color: #9da9a0; font-size: 11px; }

  #stats-bar {
    position: fixed; bottom: 12px; left: 16px; z-index: 50;
    font-size: 11px; color: #495156; pointer-events: none;
  }

  ${sharedPanelCss()}
</style>
</head>
<body>
<div id="graph-3d"></div>
<div id="tooltip"></div>
<div id="view-tabs">
  <a href="/graph">Graph</a>
  <a class="active" href="/graph/depth">Depth</a>
  <a href="/graph/galaxy">Galaxy</a>
  <a href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-nodes">-</span> nodes &middot; <span id="stat-edges">-</span> edges &middot; Z = relevance</div>

<button id="animate-btn" title="Animate growth">&#x25B6;</button>
<div id="anim-progress"><span id="anim-date"></span><div id="anim-bar-wrap"><div id="anim-bar"></div></div><span id="anim-speed" title="Click to cycle speed">1x</span></div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Depth view</h2>
    <div class="panel-header-actions">
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Filters</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Min mentions <span class="val" id="threshold-val">5</span></div>
        <input type="range" id="threshold" min="1" max="50" value="5" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Node size <span class="val" id="node-size-val">1.0</span></div>
        <input type="range" id="node-size" min="2" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link opacity <span class="val" id="link-opacity-val">0.3</span></div>
        <input type="range" id="link-opacity" min="1" max="100" value="30" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link gradient <span class="val" id="link-gradient-val">50</span></div>
        <input type="range" id="link-gradient" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Z spread <span class="val" id="z-range-val">800</span></div>
        <input type="range" id="z-range" min="100" max="2000" value="800" />
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Forces</span></div>
    <div class="section-body">
      <div class="ctrl-row" style="gap:6px;margin-bottom:4px;display:flex">
        <button class="preset-btn active" id="preset-cluster">Cluster</button>
        <button class="preset-btn" id="preset-spread">Spread</button>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Repel force <span class="val" id="repel-force-val">-40</span></div>
        <input type="range" id="repel-force" min="0" max="100" value="40" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link force <span class="val" id="link-force-val">0.30</span></div>
        <input type="range" id="link-force" min="0" max="100" value="30" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link distance <span class="val" id="link-distance-val">15</span></div>
        <input type="range" id="link-distance" min="5" max="100" value="15" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Behavior</span></div>
    <div class="section-body">
      <div class="ctrl-toggle">
        <span class="label">Auto-rotate</span>
        <div class="switch on" id="toggle-autorotate"></div>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Rotate speed <span class="val" id="rotate-speed-val">5</span></div>
        <input type="range" id="rotate-speed" min="1" max="20" value="5" />
      </div>
      <div class="ctrl-toggle">
        <span class="label">Auto-zoom to changes</span>
        <div class="switch on" id="toggle-autozoom-3d"></div>
      </div>
    </div>
  </div>

</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script src="https://unpkg.com/3d-force-graph"></script>
<script>
// Panel logic
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => hdr.parentElement.classList.toggle('open'));
});

const TYPE_COLORS = ${JSON.stringify(TYPE_COLORS)};

let Z_RANGE = 800;
let mentionThreshold = 5;
let nodeSizeMult = 1.0;
let linkOpacity = 0.3;
let linkGradient = 0.5;
let forceRepel = -40;
let forceLinkDist = 15;
let forceLinkStr = 0.3;

const PRESETS_3D = {
  cluster:  { repel: -40, linkStr: 0.3, linkDist: 15 },
  spread:   { repel: -15, linkStr: 0.1, linkDist: 25 },
};
let allNodes = [], allLinks = [];
let graph;
let gradLinkMat;

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function formatAge(ts) {
  if (!ts) return 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.round(diff / 86400) + 'd ago';
  return Math.round(diff / 2592000) + 'mo ago';
}

// ─── Relevance Scoring ──────────────────────────────────────────
const DAY = 86400;
const RECENCY_HALF = 30 * DAY;   // 30-day half-life for access recency
const AGE_HALF = 90 * DAY;       // 90-day half-life for creation recency
const PULL_STRENGTH = 0.15;
const GRAVITY_PASSES = 3;

function computeRelevanceScores(filtered, links) {
  const now = Math.floor(Date.now() / 1000);

  // Build degree map from filtered links
  const degree = new Map();
  for (const n of filtered) degree.set(n.id, 0);
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (degree.has(s)) degree.set(s, degree.get(s) + 1);
    if (degree.has(t)) degree.set(t, degree.get(t) + 1);
  }

  // Find maxima for normalization
  let maxMentions = 1, maxDegree = 1, maxBridge = 0.001;
  for (const n of filtered) {
    if (n.mentionCount > maxMentions) maxMentions = n.mentionCount;
    if ((degree.get(n.id) || 0) > maxDegree) maxDegree = degree.get(n.id);
    if ((n.bridgeScore || 0) > maxBridge) maxBridge = n.bridgeScore;
  }

  const scores = new Map();
  for (const n of filtered) {
    const sinceActive = now - (n.lastActive || 0);
    const age = now - (n.firstSeen || n.lastActive || 0);
    const deg = degree.get(n.id) || 0;

    const recency    = Math.exp(-sinceActive / RECENCY_HALF);
    const creation   = Math.exp(-age / AGE_HALF);
    const mentions   = Math.log2((n.mentionCount || 0) + 1) / Math.log2(maxMentions + 1);
    const degScore   = Math.log2(deg + 1) / Math.log2(maxDegree + 1);
    const bridge     = (n.bridgeScore || 0) / maxBridge;

    const score = 0.30 * recency + 0.10 * creation + 0.25 * mentions + 0.15 * degScore + 0.20 * bridge;
    scores.set(n.id, score);
  }

  return { scores, degree };
}

function applyGravity(filtered, links, scores, degree, passes) {
  // Build adjacency list with link weights
  const adj = new Map();
  for (const n of filtered) adj.set(n.id, []);
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (adj.has(s) && adj.has(t)) {
      adj.get(s).push({ id: t, weight: l.weight || 1 });
      adj.get(t).push({ id: s, weight: l.weight || 1 });
    }
  }

  // Initialize Z from scores
  const zMap = new Map();
  for (const n of filtered) {
    zMap.set(n.id, (scores.get(n.id) || 0) * Z_RANGE);
  }

  for (let pass = 0; pass < passes; pass++) {
    for (const n of filtered) {
      const neighbors = adj.get(n.id);
      if (!neighbors || neighbors.length === 0) continue;

      const deg = degree.get(n.id) || 1;
      const inertia = 1 - 1 / (1 + Math.log2(deg));

      let weightSum = 0;
      let zWeighted = 0;
      for (const nb of neighbors) {
        const nbDeg = degree.get(nb.id) || 1;
        const w = Math.log2(nbDeg + 1) * nb.weight;
        zWeighted += zMap.get(nb.id) * w;
        weightSum += w;
      }

      if (weightSum > 0) {
        const neighborAvg = zWeighted / weightSum;
        const currentZ = zMap.get(n.id);
        const blend = PULL_STRENGTH * (1 - inertia);
        zMap.set(n.id, currentZ + (neighborAvg - currentZ) * blend);
      }
    }
  }

  return zMap;
}

function reRank(filtered, zMap) {
  // Sort by gravity-adjusted Z, then re-spread evenly across Z_RANGE
  const sorted = [...filtered].sort((a, b) => (zMap.get(a.id) || 0) - (zMap.get(b.id) || 0));
  const count = sorted.length || 1;
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].fz = (i / (count - 1 || 1)) * Z_RANGE;
  }
}

function filterAndBuild() {
  const nodeSet = new Set();
  const filtered = allNodes.filter(n => {
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  const links = allLinks.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target));

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;

  // 3-phase Z pipeline: relevance → gravity → re-rank
  const { scores, degree } = computeRelevanceScores(filtered, links);
  const zMap = applyGravity(filtered, links, scores, degree, GRAVITY_PASSES);
  reRank(filtered, zMap);

  // Stash degree on each node for the color system
  let maxDeg = 1;
  for (const n of filtered) {
    n.degree = degree.get(n.id) || 0;
    if (n.degree > maxDeg) maxDeg = n.degree;
  }
  // Log-scaled energy: 0 connections → 0, max connections → 1
  for (const n of filtered) {
    n.energy = Math.log2(n.degree + 1) / Math.log2(maxDeg + 1);
  }

  return { nodes: filtered, links };
}

Promise.all([
  fetch('/graph/depth/api/graph').then(r => r.json()),
  fetch('/graph/depth/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
    mentionThreshold = thresholdData.value;
    document.getElementById('threshold').value = mentionThreshold;
    document.getElementById('threshold-val').textContent = mentionThreshold;

    allNodes = data.nodes;
    allLinks = data.links;

    const graphData = filterAndBuild();

    // Shared gradient shader for link lines — bright at endpoints, dim in middle
    gradLinkMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uOpacity: { value: linkOpacity }, uGradient: { value: linkGradient } },
      vertexShader: [
        'attribute float t;',
        'attribute vec3 vColor;',
        'varying float vT;',
        'varying vec3 fColor;',
        'void main() {',
        '  vT = t; fColor = vColor;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\\n'),
      fragmentShader: [
        'uniform float uOpacity;',
        'uniform float uGradient;',
        'varying float vT;',
        'varying vec3 fColor;',
        'void main() {',
        '  float fz = (1.0 - uGradient) * 0.5;',
        '  float dim = uGradient * uGradient;',
        '  float a;',
        '  if (fz < 0.001) { a = 1.0; }',
        '  else if (vT < fz) { a = mix(1.0, dim, vT / fz); }',
        '  else if (vT > 1.0 - fz) { a = mix(dim, 1.0, (vT - (1.0 - fz)) / fz); }',
        '  else { a = dim; }',
        '  a *= min(uGradient * 3.0, 1.0);',
        '  gl_FragColor = vec4(fColor, a * uOpacity);',
        '}',
      ].join('\\n'),
    });

    graph = ForceGraph3D({ controlType: 'orbit' })
      (document.getElementById('graph-3d'))
      .graphData(graphData)
      .backgroundColor('#191d20')
      .nodeColor(n => sparkNodeColor3D(n))
      .nodeVal(n => Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult))
      .nodeOpacity(0.85)
      .nodeLabel(null)
      .linkThreeObject(l => {
        const SEGS = 10;
        const colors = {
          uses:          [127,187,179],
          depends_on:    [230,126,128],
          related_to:    [214,153,182],
          part_of:       [167,192,128],
          configured_by: [230,152,117],
          solved_by:     [219,188,127],
        };
        const c = colors[l.type] || [65,75,80];
        const pts = SEGS + 1;
        const positions = new Float32Array(pts * 3);
        const tAttr = new Float32Array(pts);
        const colorAttr = new Float32Array(pts * 3);
        for (let i = 0; i < pts; i++) {
          tAttr[i] = i / SEGS;
          colorAttr[i*3]   = c[0] / 255;
          colorAttr[i*3+1] = c[1] / 255;
          colorAttr[i*3+2] = c[2] / 255;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('t', new THREE.BufferAttribute(tAttr, 1));
        geo.setAttribute('vColor', new THREE.BufferAttribute(colorAttr, 3));
        const line = new THREE.Line(geo, gradLinkMat);
        line.renderOrder = -1;
        return line;
      })
      .linkPositionUpdate((obj, { start, end }) => {
        const pos = obj.geometry.attributes.position;
        const arr = pos.array;
        const segs = (arr.length / 3) - 1;
        for (let i = 0; i <= segs; i++) {
          const f = i / segs;
          arr[i*3]   = start.x + (end.x - start.x) * f;
          arr[i*3+1] = start.y + (end.y - start.y) * f;
          arr[i*3+2] = start.z + (end.z - start.z) * f;
        }
        pos.needsUpdate = true;
        return true;
      })
      .linkWidth(0)
      .linkOpacity(1.0)
      .d3Force('charge', d3.forceManyBody().strength(forceRepel).distanceMax(300))
      .d3Force('link', d3.forceLink().id(d => d.id).distance(forceLinkDist).strength(l => Math.min((l.weight || 0.5) * forceLinkStr, forceLinkStr * 2)))
      .d3Force('z-pin', () => {
        const nodes = graph.graphData().nodes;
        for (const n of nodes) {
          if (n.fz != null) {
            n.vz = (n.vz || 0) * 0.1;
            n.z = n.z + (n.fz - n.z) * 0.1;
          }
        }
      })
      .onNodeHover(node => {
        document.getElementById('graph-3d').style.cursor = node ? 'pointer' : 'default';
        const tip = document.getElementById('tooltip');
        if (!node) { tip.style.display = 'none'; return; }
        let html = '<div class="name">' + esc(node.name) + '</div>';
        html += '<div class="type">' + node.type + ' &middot; ' + node.mentionCount + ' mentions</div>';
        if (node.description) html += '<div class="desc">' + esc(node.description) + '</div>';
        if (node.community) html += '<div class="community">' + esc(node.community) + '</div>';
        html += '<div class="time">Last active: ' + formatAge(node.lastActive) + '</div>';
        if (node.firstSeen) html += '<div class="time">First seen: ' + formatAge(node.firstSeen) + '</div>';
        if (node.bridgeScore > 0) html += '<div class="time">Bridge score: ' + node.bridgeScore.toFixed(3) + '</div>';
        tip.innerHTML = html;
        tip.style.display = 'block';
      })
      .onBackgroundClick(() => {
        document.getElementById('tooltip').style.display = 'none';
      })
      .warmupTicks(80)
      .cooldownTicks(200);

    document.addEventListener('mousemove', (e) => {
      const tip = document.getElementById('tooltip');
      if (tip.style.display === 'block') {
        tip.style.left = (e.clientX + 16) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      }
    });

    // Fit camera to extents of visible nodes after simulation settles
    setTimeout(() => {
      const gd = graph.graphData();
      if (!gd.nodes.length) return;

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const n of gd.nodes) {
        if (n.x == null) continue;
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
        const z = n.z || 0;
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const spanX = maxX - minX;
      const spanY = maxY - minY;
      const spanZ = maxZ - minZ;
      const maxSpan = Math.max(spanX, spanY, spanZ, 1);

      // Distance needed to see the full extent (rough FOV estimate ~60deg)
      const dist = maxSpan * 1.2;

      graph.cameraPosition(
        { x: cx, y: cy - dist * 0.3, z: cz + dist },
        { x: cx, y: cy, z: cz },
        1500
      );
    }, 3000);
  });

// Controls
document.getElementById('threshold').addEventListener('input', (e) => {
  mentionThreshold = parseInt(e.target.value, 10);
  document.getElementById('threshold-val').textContent = mentionThreshold;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('node-size').addEventListener('input', (e) => {
  nodeSizeMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);
  if (graph) graph.nodeVal(n => Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult));
});

document.getElementById('link-opacity').addEventListener('input', (e) => {
  linkOpacity = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-opacity-val').textContent = linkOpacity.toFixed(2);
  gradLinkMat.uniforms.uOpacity.value = linkOpacity;
});

document.getElementById('link-gradient').addEventListener('input', (e) => {
  linkGradient = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-gradient-val').textContent = e.target.value;
  gradLinkMat.uniforms.uGradient.value = linkGradient;
});

document.getElementById('z-range').addEventListener('input', (e) => {
  Z_RANGE = parseInt(e.target.value, 10);
  document.getElementById('z-range-val').textContent = Z_RANGE;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('repel-force').addEventListener('input', (e) => {
  forceRepel = -(parseInt(e.target.value, 10));
  document.getElementById('repel-force-val').textContent = forceRepel;
  if (graph) { graph.d3Force('charge').strength(forceRepel); graph.d3ReheatSimulation(); }
});

document.getElementById('link-force').addEventListener('input', (e) => {
  forceLinkStr = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-force-val').textContent = forceLinkStr.toFixed(2);
  if (graph) { graph.d3Force('link').strength(l => Math.min((l.weight || 0.5) * forceLinkStr, forceLinkStr * 2)); graph.d3ReheatSimulation(); }
});

document.getElementById('link-distance').addEventListener('input', (e) => {
  forceLinkDist = parseInt(e.target.value, 10);
  document.getElementById('link-distance-val').textContent = forceLinkDist;
  if (graph) { graph.d3Force('link').distance(forceLinkDist); graph.d3ReheatSimulation(); }
});

// Preset buttons
function applyPreset3D(name) {
  const p = PRESETS_3D[name];
  forceRepel = p.repel; forceLinkStr = p.linkStr; forceLinkDist = p.linkDist;
  document.getElementById('repel-force').value = Math.abs(p.repel);
  document.getElementById('repel-force-val').textContent = p.repel;
  document.getElementById('link-force').value = Math.round(p.linkStr * 100);
  document.getElementById('link-force-val').textContent = p.linkStr.toFixed(2);
  document.getElementById('link-distance').value = p.linkDist;
  document.getElementById('link-distance-val').textContent = p.linkDist;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('preset-' + name).classList.add('active');
  if (graph) {
    graph.d3Force('charge').strength(forceRepel);
    graph.d3Force('link').distance(forceLinkDist).strength(l => Math.min((l.weight || 0.5) * forceLinkStr, forceLinkStr * 2));
    graph.d3ReheatSimulation();
  }
}
document.getElementById('preset-cluster').addEventListener('click', () => applyPreset3D('cluster'));
document.getElementById('preset-spread').addEventListener('click', () => applyPreset3D('spread'));

// ─── Spark color system (mirroring 2D) ─────────────────────────

const BG3D = [39, 46, 51];
const FADE_DURATION_3D = 60000;
const MIN_ENERGY_BLEND = 0.15;  // dimmest resting state (isolated nodes)
const MAX_ENERGY_BLEND = 0.95;  // brightest resting state (hub nodes)

function hexToRgb3D(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

const TYPE_RGB_3D = {};
for (const [k, hex] of Object.entries(TYPE_COLORS)) {
  TYPE_RGB_3D[k] = hexToRgb3D(hex);
}

// Compute resting color for a node based on its energy (degree-scaled 0-1)
function restingColor3D(type, energy) {
  const bright = TYPE_RGB_3D[type] || [136, 136, 136];
  const blend = MIN_ENERGY_BLEND + (MAX_ENERGY_BLEND - MIN_ENERGY_BLEND) * (energy || 0);
  return [
    Math.round(bright[0] * blend + BG3D[0] * (1 - blend)),
    Math.round(bright[1] * blend + BG3D[1] * (1 - blend)),
    Math.round(bright[2] * blend + BG3D[2] * (1 - blend)),
  ];
}

function sparkNodeColor3D(node) {
  const resting = restingColor3D(node.type, node.energy);
  if (!node.lastSpark) return 'rgb(' + resting.join(',') + ')';
  const age = Date.now() - node.lastSpark;
  if (age >= FADE_DURATION_3D) return 'rgb(' + resting.join(',') + ')';
  const t = age / FADE_DURATION_3D;
  const bright = TYPE_RGB_3D[node.type] || [136, 136, 136];
  // Spark always flashes to full bright, then fades to energy-based resting
  const r = Math.round(bright[0] + (resting[0] - bright[0]) * t);
  const g = Math.round(bright[1] + (resting[1] - bright[1]) * t);
  const b = Math.round(bright[2] + (resting[2] - bright[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ─── Diff Polling (3D) ──────────────────────────────────────────

let lastDiffTimestamp3D = Math.floor(Date.now() / 1000);
let nodeMap3D = new Map();
let linkKey3D = new Set();
let autoZoom3D = localStorage.getItem('engram-autozoom-3d') !== 'false';
let lastAutoZoomTime3D = 0;
const AUTOZOOM_COOLDOWN = 5000;

function initLookups3D() {
  for (const n of allNodes) nodeMap3D.set(n.id, n);
  for (const l of allLinks) linkKey3D.add(l.source + '|' + l.target + '|' + l.type);
}

function pollDiff3D() {
  fetch('/graph/depth/api/diff?since=' + lastDiffTimestamp3D)
    .then(r => r.json())
    .then(mergeDiff3D)
    .catch(() => {});
}

function mergeDiff3D(diff) {
  if (!diff) return;
  lastDiffTimestamp3D = diff.timestamp;
  const sparkTime = Date.now();
  let changed = false;
  const newNodeIds = [];

  for (const n of diff.newNodes) {
    if (!nodeMap3D.has(n.id)) {
      n.lastSpark = sparkTime;
      n.lastActive = n.lastActive || 0;
      n.firstSeen = n.firstSeen || 0;
      n.bridgeScore = n.bridgeScore || 0;
      allNodes.push(n);
      nodeMap3D.set(n.id, n);
      newNodeIds.push(n.id);
      changed = true;
    }
  }

  for (const n of diff.updatedNodes) {
    const existing = nodeMap3D.get(n.id);
    if (existing) {
      existing.name = n.name;
      existing.description = n.description;
      existing.mentionCount = n.mentionCount;
      existing.community = n.community;
      existing.lastActive = n.lastActive || existing.lastActive;
      existing.firstSeen = n.firstSeen || existing.firstSeen;
      existing.bridgeScore = n.bridgeScore ?? existing.bridgeScore;
      existing.lastSpark = sparkTime;
      changed = true;
    }
  }

  for (const l of diff.newLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    if (!linkKey3D.has(key)) {
      allLinks.push(l);
      linkKey3D.add(key);
      changed = true;
      const sn = nodeMap3D.get(l.source);
      const tn = nodeMap3D.get(l.target);
      if (sn) sn.lastSpark = sparkTime;
      if (tn) tn.lastSpark = sparkTime;
    }
  }

  for (const l of diff.updatedLinks) {
    for (const el of allLinks) {
      if (el.source === l.source && el.target === l.target && el.type === l.type) {
        el.weight = l.weight;
        el.context = l.context;
        changed = true;
        break;
      }
    }
  }

  if (changed && graph) {
    const gd = filterAndBuild();
    graph.graphData(gd);
    graph.nodeColor(n => sparkNodeColor3D(n));

    const live = document.getElementById('live');
    live.textContent = '+' + (diff.newNodes.length + diff.updatedNodes.length) + ' changes';
    live.classList.add('show');
    setTimeout(() => live.classList.remove('show'), 2000);

    // Auto-zoom to new nodes
    if (autoZoom3D && newNodeIds.length >= 2 && Date.now() - lastAutoZoomTime3D > AUTOZOOM_COOLDOWN) {
      setTimeout(() => {
        const gNodes = graph.graphData().nodes;
        const newNodes = newNodeIds.map(id => gNodes.find(n => n.id === id)).filter(n => n && n.x != null);

        if (newNodes.length >= 2) {
          let cx = 0, cy = 0, cz = 0;
          for (const n of newNodes) { cx += n.x; cy += n.y; cz += n.z || 0; }
          cx /= newNodes.length; cy /= newNodes.length; cz /= newNodes.length;

          let maxSpread = 0;
          for (const n of newNodes) {
            const dx = n.x - cx, dy = n.y - cy, dz = (n.z || 0) - cz;
            maxSpread = Math.max(maxSpread, Math.sqrt(dx*dx + dy*dy + dz*dz));
          }

          const dist = Math.max(maxSpread * 3, 200);
          graph.cameraPosition(
            { x: cx, y: cy - dist * 0.3, z: cz + dist },
            { x: cx, y: cy, z: cz },
            1200
          );
          lastAutoZoomTime3D = Date.now();
        }
      }, 500);
    }

    // Continue fade
    setTimeout(() => {
      if (graph) graph.nodeColor(n => sparkNodeColor3D(n));
    }, 1500);
  }
}

// Start polling after initial load
setTimeout(() => {
  initLookups3D();
  setInterval(pollDiff3D, 1500);
  if (graph) graph.nodeColor(n => sparkNodeColor3D(n));
}, 200);

// ─── Turntable Rotation ──────────────────────────────────────────

let autoRotateEnabled = true;
let autoRotateSpeed = 5; // degrees per second
let turntablePaused = false;
let idleTimer = null;
let turntableAngle = 0;
let lastTurntableTime = 0;

function getCentroid() {
  const gd = graph ? graph.graphData() : null;
  if (!gd || !gd.nodes.length) return { x: 0, y: 0, z: 0 };
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const n of gd.nodes) {
    if (n.x != null) { cx += n.x; cy += n.y; cz += n.z || 0; count++; }
  }
  if (count === 0) return { x: 0, y: 0, z: 0 };
  return { x: cx / count, y: cy / count, z: cz / count };
}

function turntableTick(now) {
  if (!graph || !autoRotateEnabled || turntablePaused) {
    lastTurntableTime = now;
    requestAnimationFrame(turntableTick);
    return;
  }

  if (!lastTurntableTime) lastTurntableTime = now;
  const dt = (now - lastTurntableTime) / 1000; // seconds
  lastTurntableTime = now;

  turntableAngle += autoRotateSpeed * dt * (Math.PI / 180); // convert deg/s to rad

  const cam = graph.cameraPosition();
  const center = getCentroid();

  // Vector from centroid to camera
  const dx = cam.x - center.x;
  const dz = (cam.z || 0) - center.z;
  const radius = Math.sqrt(dx * dx + dz * dz);

  if (radius > 0.1) {
    // Current angle in XZ plane around centroid
    const currentAngle = Math.atan2(dz, dx);
    const newAngle = currentAngle + autoRotateSpeed * dt * (Math.PI / 180);

    graph.cameraPosition({
      x: center.x + radius * Math.cos(newAngle),
      y: cam.y, // keep Y (height) unchanged
      z: center.z + radius * Math.sin(newAngle),
    });
  }

  requestAnimationFrame(turntableTick);
}

setTimeout(() => {
  if (!graph) return;

  // Pause on user interaction, resume after 5s idle
  const controls = graph.controls();
  if (controls) {
    controls.addEventListener('start', () => {
      turntablePaused = true;
      if (idleTimer) clearTimeout(idleTimer);
    });
    controls.addEventListener('end', () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { turntablePaused = false; }, 5000);
    });
  }

  requestAnimationFrame(turntableTick);
}, 500);

document.getElementById('toggle-autorotate').addEventListener('click', function() {
  this.classList.toggle('on');
  autoRotateEnabled = this.classList.contains('on');
});

document.getElementById('rotate-speed').addEventListener('input', (e) => {
  autoRotateSpeed = parseInt(e.target.value, 10);
  document.getElementById('rotate-speed-val').textContent = autoRotateSpeed;
});

document.getElementById('toggle-autozoom-3d').addEventListener('click', function() {
  this.classList.toggle('on');
  autoZoom3D = this.classList.contains('on');
  localStorage.setItem('engram-autozoom-3d', autoZoom3D);
});

if (!autoZoom3D) document.getElementById('toggle-autozoom-3d').classList.remove('on');

// ─── Growth Animation ────────────────────────────────────────────

let animating = false;
let animTime = 0;
let animMinTime = 0;
let animMaxTime = 0;
let animSpeed = 1;
const ANIM_SPEEDS = [1, 2, 5, 10, 20];
let animSpeedIdx = 0;
let animLastFrame = 0;
let animNodeOrder = [];
let animVisibleCount = 0;
let animSavedThreshold = 0;

const animBtn = document.getElementById('animate-btn');
const animProgress = document.getElementById('anim-progress');
const animBar = document.getElementById('anim-bar');
const animDate = document.getElementById('anim-date');
const animSpeedEl = document.getElementById('anim-speed');

function formatAnimDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startAnimation() {
  // Animate within the current threshold — keeps node count manageable
  const thresholdFiltered = allNodes.filter(n => (n.mentionCount || 0) >= mentionThreshold);
  animNodeOrder = thresholdFiltered
    .filter(n => (n.firstSeen || 0) > 0)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  if (animNodeOrder.length < 2) return;

  animMinTime = animNodeOrder[0].firstSeen;
  animMaxTime = animNodeOrder[animNodeOrder.length - 1].firstSeen;
  animTime = animMinTime;
  animVisibleCount = 0;
  animSavedThreshold = mentionThreshold;

  animating = true;
  animLastFrame = performance.now();
  animBtn.classList.add('playing');
  animBtn.innerHTML = '&#x25A0;';
  animProgress.classList.add('show');

  graph.graphData({ nodes: [], links: [] });
  requestAnimationFrame(animTickDepth);
}

function stopAnimation() {
  animating = false;
  animBtn.classList.remove('playing');
  animBtn.innerHTML = '&#x25B6;';
  animProgress.classList.remove('show');

  mentionThreshold = animSavedThreshold;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;
  graph.graphData(filterAndBuild());
}

function animTickDepth(now) {
  if (!animating) return;
  const dt = (now - animLastFrame) / 1000;
  animLastFrame = now;

  const BASE_DURATION = 45;
  const timeSpan = animMaxTime - animMinTime || 1;
  const timeScale = timeSpan / BASE_DURATION;
  animTime += dt * timeScale * animSpeed;

  if (animTime >= animMaxTime) {
    animTime = animMaxTime;
    animVisibleCount = animNodeOrder.length;
    animRebuildDepth();
    updateAnimUI();
    setTimeout(stopAnimation, 1500);
    return;
  }

  let newCount = animVisibleCount;
  while (newCount < animNodeOrder.length && (animNodeOrder[newCount].firstSeen || 0) <= animTime) {
    newCount++;
  }

  if (newCount > animVisibleCount) {
    const sparkTime = Date.now();
    for (let i = animVisibleCount; i < newCount; i++) {
      animNodeOrder[i].lastSpark = sparkTime;
    }
    animVisibleCount = newCount;
    animRebuildDepth();
  }

  updateAnimUI();
  requestAnimationFrame(animTickDepth);
}

function animRebuildDepth() {
  const visibleIds = new Set();
  for (let i = 0; i < animVisibleCount; i++) {
    visibleIds.add(animNodeOrder[i].id);
  }

  const filtered = animNodeOrder.slice(0, animVisibleCount);
  const links = allLinks.filter(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return visibleIds.has(s) && visibleIds.has(t);
  });

  // Depth relevance pipeline
  if (filtered.length > 0) {
    const { scores, degree } = computeRelevanceScores(filtered, links);
    const zMap = applyGravity(filtered, links, scores, degree, GRAVITY_PASSES);
    reRank(filtered, zMap);
    let maxDeg = 1;
    for (const n of filtered) {
      n.degree = degree.get(n.id) || 0;
      if (n.degree > maxDeg) maxDeg = n.degree;
    }
    for (const n of filtered) {
      n.energy = Math.log2(n.degree + 1) / Math.log2(maxDeg + 1);
    }
  }

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;

  graph.graphData({ nodes: filtered, links });
  graph.nodeColor(n => sparkNodeColor3D(n));
  setTimeout(() => { if (graph) graph.nodeColor(n => sparkNodeColor3D(n)); }, 1200);
}

function updateAnimUI() {
  const pct = ((animTime - animMinTime) / (animMaxTime - animMinTime || 1)) * 100;
  animBar.style.width = pct + '%';
  animDate.textContent = formatAnimDate(animTime);
}

animBtn.addEventListener('click', () => {
  if (animating) stopAnimation();
  else startAnimation();
});

animSpeedEl.addEventListener('click', () => {
  animSpeedIdx = (animSpeedIdx + 1) % ANIM_SPEEDS.length;
  animSpeed = ANIM_SPEEDS[animSpeedIdx];
  animSpeedEl.textContent = animSpeed + 'x';
});
</script>
</body>
</html>`;
}
