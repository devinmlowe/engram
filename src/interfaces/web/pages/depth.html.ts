/**
 * Depth page — Three.js 3D knowledge graph visualization.
 */

import { sharedPanelCss } from "./shared-css.js";
import { sharedJs, panelToggleJs } from "./shared-js.js";
import { sparkColorsJs } from "./spark-colors.js";
import { relevanceScoresJs } from "./relevance.js";
import { diffPollingJs } from "./diff-polling.js";
import { growthAnimationJs } from "./growth-animation.js";
import { threeHelpersJs } from "./three-helpers.js";

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
<script src="https://unpkg.com/3d-force-graph@1.79.1"></script>
<script>
${panelToggleJs()}
${sharedJs()}
${sparkColorsJs({ bg: [39, 46, 51], minBlend: 0.15, maxBlend: 0.95 })}
${relevanceScoresJs()}

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

// ─── Z placement: relevance → gravity → re-rank ─────────────────
const PULL_STRENGTH = 0.15;
const GRAVITY_PASSES = 3;

function applyGravity(filtered, links, scores, degree, passes) {
  // Build adjacency list with link weights
  const adj = new Map();
  for (const n of filtered) adj.set(n.id, []);
  for (const l of links) {
    const s = linkId(l.source), t = linkId(l.target);
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

// Place the given nodes on the Z axis, colour them by degree, update the stats bar.
function layoutDepth(filtered, links) {
  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;

  const { scores, degree } = computeRelevanceScores(filtered, links);
  const zMap = applyGravity(filtered, links, scores, degree, GRAVITY_PASSES);
  reRank(filtered, zMap);

  for (const n of filtered) n.degree = degree.get(n.id) || 0;
  assignEnergy(filtered);

  return { nodes: filtered, links };
}

function filterAndBuild() {
  const nodeSet = new Set();
  const filtered = allNodes.filter(n => {
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  const links = allLinks.filter(l => nodeSet.has(linkId(l.source)) && nodeSet.has(linkId(l.target)));
  return layoutDepth(filtered, links);
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

    gradLinkMat = makeGradientLinkMaterial(linkOpacity, linkGradient);

    graph = ForceGraph3D({ controlType: 'orbit' })
      (document.getElementById('graph-3d'))
      .graphData(graphData)
      .backgroundColor('#191d20')
      .nodeColor(n => sparkNodeColor(n))
      .nodeVal(n => Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult))
      .nodeOpacity(0.85)
      .nodeLabel(null)
      .linkThreeObject(l => gradientLinkObject(gradLinkMat, REL_RGB[l.type] || [65,75,80], 1.0))
      .linkPositionUpdate(gradientLinkPositionUpdate)
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
    setTimeout(fitCameraToGraph, 3000);

    startDiffPolling('/graph/depth', onDiffChanged);
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

// ─── Live updates ────────────────────────────────────────────────
${diffPollingJs()}

let autoZoom3D = localStorage.getItem('engram-autozoom-3d') !== 'false';
let lastAutoZoomTime3D = 0;
const AUTOZOOM_COOLDOWN = 5000;

function onDiffChanged(newNodeIds) {
  graph.graphData(filterAndBuild());
  refreshSparkColors(1500);

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
}

document.getElementById('toggle-autozoom-3d').addEventListener('click', function() {
  this.classList.toggle('on');
  autoZoom3D = this.classList.contains('on');
  localStorage.setItem('engram-autozoom-3d', autoZoom3D);
});

if (!autoZoom3D) document.getElementById('toggle-autozoom-3d').classList.remove('on');

${threeHelpersJs()}
${growthAnimationJs()}

setupGrowthAnimation(
  (nodes, links) => {
    graph.graphData(layoutDepth(nodes, links));
    refreshSparkColors(1200);
  },
  () => graph.graphData(filterAndBuild()),
);
</script>
</body>
</html>`;
}
