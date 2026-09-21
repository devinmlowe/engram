/**
 * Terminal-optimized Depth page — 2D flattened representation of the 3D depth view.
 * Uses Y-axis for relevance (Z in the original) and X for force layout.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Key differences from the standard depth.html.ts:
 * - SVG instead of WebGL/Three.js
 * - Z (relevance) mapped to vertical position — high relevance at top
 * - Color saturation encodes energy (degree-based)
 * - Pre-stabilized layout
 * - Click-based info panel
 */

import { terminalSharedCss } from "./shared-css.js";
import { sharedJs } from "../shared-js.js";
import { sparkColorsJs } from "../spark-colors.js";
import { relevanceScoresJs } from "../relevance.js";
import { DEFAULT_COLOR } from '../theme.js';

export function terminalDepthPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram depth [terminal]</title>
<style>
  ${terminalSharedCss()}

  .node { cursor: pointer; }
  .node circle { stroke-width: 2; }
  .node text {
    fill: #d3c6aa;
    font-size: 11px;
    font-weight: 700;
    text-anchor: middle;
  }
  .link { stroke-opacity: 0.25; }
  .node.selected circle { stroke: #dbbc7f !important; stroke-width: 3; }
  .node.dimmed circle { opacity: 0.15; }
  .node.dimmed text { opacity: 0.1; }
  .link.dimmed { stroke-opacity: 0.03 !important; }
  .link.highlighted { stroke-opacity: 0.7 !important; stroke-width: 2 !important; }

  /* Relevance axis labels */
  .axis-label {
    fill: #495156;
    font-size: 11px;
    font-family: monospace;
  }
  .axis-line {
    stroke: #272e33;
    stroke-dasharray: 4 4;
  }
</style>
</head>
<body>
<div id="view-tabs">
  <a href="/terminal/graph">Graph</a>
  <a class="active" href="/terminal/depth">Depth</a>
  <a href="/terminal/words">Words</a>
  <a href="/terminal/communities">Communities</a>
</div>

<div id="graph-container">
  <svg id="graph-svg"></svg>
</div>

<div id="info-panel">
  <button class="close-btn" onclick="closeInfo()">[x]</button>
  <div id="info-content">Click a node to inspect</div>
</div>

<div id="stats-bar">Loading...</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DEFAULT_COLOR = '${DEFAULT_COLOR}';
${sharedJs()}
${sparkColorsJs({ bg: [39, 46, 51], minBlend: 0.2, maxBlend: 1.0 })}
${relevanceScoresJs()}

// Node fill: type colour blended with the background by energy (0=dim, 1=bright)
function energyColor(type, energy) {
  return 'rgb(' + restingColor(type, energy).join(',') + ')';
}

function closeInfo() {
  document.getElementById('info-panel').classList.remove('open');
  d3.selectAll('.node').classed('selected', false).classed('dimmed', false);
  d3.selectAll('.link').classed('dimmed', false).classed('highlighted', false);
}

function showNodeInfo(d) {
  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  let html = '<div class="name" style="color:' + (TYPE_COLORS[d.type] || DEFAULT_COLOR) + '">' + esc(d.name) + '</div>';
  html += '<div class="type">' + d.type + '</div>';
  html += '<div class="meta">' + d.mentionCount + ' mentions | relevance: ' + (d._relevance || 0).toFixed(2) + '</div>';
  if (d.description) html += '<div class="desc">' + esc(d.description) + '</div>';
  if (d.community) html += '<div class="meta">Community: ' + esc(d.community) + '</div>';
  html += '<div class="meta">Last active: ' + formatAge(d.lastActive) + '</div>';
  if (d.firstSeen) html += '<div class="meta">First seen: ' + formatAge(d.firstSeen) + '</div>';
  if (d.bridgeScore > 0) html += '<div class="meta">Bridge: ' + d.bridgeScore.toFixed(3) + '</div>';
  content.innerHTML = html;
  panel.classList.add('open');

  const neighborIds = new Set([d.id]);
  d3.selectAll('.link').each(function(l) {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    if (sid === d.id) neighborIds.add(tid);
    if (tid === d.id) neighborIds.add(sid);
  });
  d3.selectAll('.node')
    .classed('selected', n => n.id === d.id)
    .classed('dimmed', n => !neighborIds.has(n.id));
  d3.selectAll('.link')
    .classed('dimmed', l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return s !== d.id && t !== d.id;
    })
    .classed('highlighted', l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return s === d.id || t === d.id;
    });
}

// ─── Load & Render ──────────────────────────────────────────────

Promise.all([
  fetch('/graph/depth/api/graph').then(r => r.json()),
  fetch('/graph/depth/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
  const threshold = thresholdData.value;

  const nodeSet = new Set();
  const nodes = data.nodes.filter(n => {
    if (n.mentionCount < threshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  const linkSources = data.links.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target));

  // Compute relevance
  const { scores, degree } = computeRelevanceScores(nodes, linkSources);

  let maxDeg = 1;
  for (const n of nodes) {
    n._relevance = scores.get(n.id) || 0;
    n._degree = degree.get(n.id) || 0;
    if (n._degree > maxDeg) maxDeg = n._degree;
  }
  for (const n of nodes) {
    n._energy = Math.log2(n._degree + 1) / Math.log2(maxDeg + 1);
  }

  document.getElementById('stats-bar').textContent =
    nodes.length + ' nodes | ' + linkSources.length + ' edges | threshold: ' + threshold + ' | Y = relevance';

  const width = Math.max(window.innerWidth, 800);
  const height = Math.max(window.innerHeight - 54, 600);
  const margin = { top: 50, bottom: 40, left: 60, right: 50 };

  const svg = d3.select('#graph-svg')
    .attr('width', width)
    .attr('height', height);

  const g = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  // Y-axis: relevance (0 at bottom, 1 at top)
  const yScale = d3.scaleLinear()
    .domain([0, 1])
    .range([height - margin.bottom, margin.top]);

  // X: force simulation spreads nodes horizontally
  const rScale = d3.scaleSqrt()
    .domain([1, d3.max(nodes, d => d.mentionCount) || 1])
    .range([5, 24]);

  // Set initial Y from relevance, X will be force-determined
  for (const n of nodes) {
    n.y = yScale(n._relevance);
    n.x = width / 2 + (Math.random() - 0.5) * (width - margin.left - margin.right);
  }

  // Run horizontal-only force
  const sim = d3.forceSimulation(nodes)
    .force('x', d3.forceX(width / 2).strength(0.02))
    .force('link', d3.forceLink(linkSources).id(d => d.id).distance(30).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-60).distanceMax(300))
    .force('collide', d3.forceCollide().radius(d => rScale(d.mentionCount || 1) + 3))
    .stop();

  // Fix Y positions (relevance axis)
  for (const n of nodes) n.fy = n.y;

  for (let i = 0; i < 200; i++) sim.tick();

  // Release fy and finalize
  for (const n of nodes) { n.y = n.fy; delete n.fy; }

  // Draw relevance axis guide lines
  const axisG = g.append('g');
  [0, 0.25, 0.5, 0.75, 1.0].forEach(v => {
    const y = yScale(v);
    axisG.append('line')
      .attr('class', 'axis-line')
      .attr('x1', margin.left - 10).attr('x2', width - margin.right)
      .attr('y1', y).attr('y2', y);
    axisG.append('text')
      .attr('class', 'axis-label')
      .attr('x', margin.left - 14).attr('y', y + 4)
      .attr('text-anchor', 'end')
      .text(v.toFixed(2));
  });
  axisG.append('text')
    .attr('class', 'axis-label')
    .attr('transform', 'translate(14,' + (height / 2) + ')rotate(-90)')
    .attr('text-anchor', 'middle')
    .attr('font-size', '13px')
    .text('relevance');

  // Draw links
  g.append('g').selectAll('line')
    .data(linkSources)
    .join('line')
    .attr('class', 'link')
    .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y)
    .attr('stroke', d => TYPE_COLORS[d.type] || '#374145')
    .attr('stroke-width', d => Math.max(1, Math.min(2.5, (d.weight || 1))));

  // Draw nodes
  const node = g.append('g').selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')')
    .on('click', (event, d) => { event.stopPropagation(); showNodeInfo(d); });

  node.append('circle')
    .attr('r', d => rScale(d.mentionCount || 1))
    .attr('fill', d => energyColor(d.type, d._energy))
    .attr('stroke', d => TYPE_COLORS[d.type] || DEFAULT_COLOR);

  // Labels for high-relevance nodes
  const labelCutoff = Math.max(threshold, Math.floor(nodes.length / 25));
  node.filter(d => d.mentionCount >= labelCutoff || d._relevance > 0.7)
    .append('text')
    .attr('dy', d => rScale(d.mentionCount || 1) + 13)
    .text(d => d.name.length > 18 ? d.name.slice(0, 17) + '~' : d.name);

  svg.on('click', closeInfo);

  // Legend
  const legend = svg.append('g').attr('transform', 'translate(' + (width - 140) + ', 40)');
  const types = [...new Set(nodes.map(n => n.type))].sort();
  types.forEach((type, i) => {
    const row = legend.append('g').attr('transform', 'translate(0,' + (i * 18) + ')');
    row.append('rect').attr('width', 12).attr('height', 12).attr('fill', TYPE_COLORS[type] || DEFAULT_COLOR);
    row.append('text').attr('x', 18).attr('y', 10).attr('fill', '#9da9a0')
      .attr('font-size', '12px').attr('font-family', 'monospace').text(type);
  });
});
</script>
</body>
</html>`;
}
