/**
 * Terminal-optimized Graph page — D3 force-directed knowledge graph with SVG rendering.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Key differences from the standard graph.html.ts:
 * - SVG instead of Canvas (text renders as terminal text)
 * - Pre-stabilized simulation (runs to completion before rendering)
 * - Click-based info panel instead of hover tooltips
 * - High-contrast solid colors, no transparency/blur
 * - Larger nodes and text for character-cell resolution
 * - No settings panel — simplified static view
 * - No animations or live updates (terminal refresh is slow)
 */

import { terminalSharedCss } from "./shared-css.js";

export function terminalGraphPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram graph [terminal]</title>
<style>
  ${terminalSharedCss()}

  .node { cursor: pointer; }
  .node circle { stroke-width: 2; }
  .node text {
    fill: #cdd6f4;
    font-size: 11px;
    font-weight: 700;
    text-anchor: middle;
    dominant-baseline: central;
    display: none;
  }
  .node.selected text, .node.neighbor text { display: block; }
  .link { stroke-opacity: 0.4; }
  .node.selected circle { stroke: #f9e2af !important; stroke-width: 3; }
  .node.dimmed circle { opacity: 0.2; }
  .node.dimmed text { opacity: 0.15; }
  .link.dimmed { stroke-opacity: 0.05 !important; }
  .link.highlighted { stroke-opacity: 0.8 !important; stroke-width: 3 !important; }
</style>
</head>
<body>
<div id="view-tabs">
  <a class="active" href="/terminal/graph">Graph</a>
  <a href="/terminal/depth">Depth</a>
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
const TYPE_COLORS = {
  project:    '#f38ba8',
  tool:       '#89b4fa',
  technology: '#a6e3a1',
  person:     '#fab387',
  concept:    '#cba6f7',
  file:       '#6c7086',
  repo:       '#74c7ec',
};

const DEFAULT_COLOR = '#585b70';

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

let selectedNode = null;

function closeInfo() {
  document.getElementById('info-panel').classList.remove('open');
  d3.selectAll('.node').classed('selected', false).classed('neighbor', false).classed('dimmed', false);
  d3.selectAll('.link').classed('dimmed', false).classed('highlighted', false);
  selectedNode = null;
}

function showNodeInfo(d) {
  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');

  let html = '<div class="name" style="color:' + (TYPE_COLORS[d.type] || DEFAULT_COLOR) + '">' + esc(d.name) + '</div>';
  html += '<div class="type">' + d.type + '</div>';
  html += '<div class="meta">' + d.mentionCount + ' mentions</div>';
  if (d.informativeness > 0) html += '<div class="meta">Informativeness: ' + d.informativeness.toFixed(2) + '</div>';
  if (d.description) html += '<div class="desc">' + esc(d.description) + '</div>';
  if (d.community) html += '<div class="meta">Community: ' + esc(d.community) + '</div>';
  html += '<div class="meta">Last active: ' + formatAge(d.lastActive) + '</div>';
  if (d.firstSeen) html += '<div class="meta">First seen: ' + formatAge(d.firstSeen) + '</div>';
  if (d.bridgeScore > 0) html += '<div class="meta">Bridge: ' + d.bridgeScore.toFixed(3) + '</div>';

  content.innerHTML = html;
  panel.classList.add('open');

  // Highlight neighbors
  const neighborIds = new Set();
  neighborIds.add(d.id);
  d3.selectAll('.link').each(function(l) {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    if (sid === d.id) neighborIds.add(tid);
    if (tid === d.id) neighborIds.add(sid);
  });

  d3.selectAll('.node')
    .classed('selected', n => n.id === d.id)
    .classed('neighbor', n => n.id !== d.id && neighborIds.has(n.id))
    .classed('dimmed', n => !neighborIds.has(n.id));

  d3.selectAll('.link')
    .classed('dimmed', l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return sid !== d.id && tid !== d.id;
    })
    .classed('highlighted', l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return sid === d.id || tid === d.id;
    });

  selectedNode = d;
}

// ─── Load & Render ──────────────────────────────────────────────

Promise.all([
  fetch('/api/graph').then(r => r.json()),
  fetch('/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
  // Terminal budget: show only the most significant nodes.
  // Sort by mention count descending, take top NODE_BUDGET.
  const TERMINAL_NODE_BUDGET = 120;

  // Sort by informativeness (composite IDF + bridge + log-mentions) with fallback to mentionCount
  const sorted = [...data.nodes].sort((a, b) =>
    (b.informativeness || b.mentionCount) - (a.informativeness || a.mentionCount)
  );
  const budgetThreshold = sorted.length > TERMINAL_NODE_BUDGET
    ? sorted[TERMINAL_NODE_BUDGET - 1].mentionCount
    : 1;
  const threshold = Math.max(thresholdData.value, budgetThreshold);

  // Filter nodes
  const nodeSet = new Set();
  const nodes = sorted.filter(n => {
    if (n.mentionCount < threshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  // Cap at budget in case of ties at the boundary
  while (nodes.length > TERMINAL_NODE_BUDGET) {
    const removed = nodes.pop();
    nodeSet.delete(removed.id);
  }
  const links = data.links.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target));

  const hasInformativeness = data.nodes.some(n => n.informativeness > 0);
  document.getElementById('stats-bar').textContent =
    nodes.length + ' nodes | ' + links.length + ' edges | threshold: \u2265' + threshold +
    (hasInformativeness ? ' | sorted by informativeness' : ' | sorted by mentions');

  const width = Math.max(window.innerWidth, 800);
  const height = Math.max(window.innerHeight - 54, 600);

  const svg = d3.select('#graph-svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height]);

  // Container for zoom
  const g = svg.append('g');

  // Zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  // Radius scale
  const maxMentions = d3.max(nodes, d => d.mentionCount) || 1;
  const rScale = d3.scaleSqrt()
    .domain([1, maxMentions])
    .range([6, 28]);

  // Run force simulation to completion (pre-stabilize)
  const sim = d3.forceSimulation(nodes)
    .force('charge', d3.forceManyBody().strength(-120).distanceMax(400))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('link', d3.forceLink(links).id(d => d.id).distance(40).strength(l => Math.min((l.weight || 0.5) * 0.5, 1)))
    .force('collide', d3.forceCollide().radius(d => rScale(d.mentionCount || 1) + 4))
    .stop();

  // Run 300 ticks to stabilize
  for (let i = 0; i < 300; i++) sim.tick();

  // Render links
  const link = g.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('class', 'link')
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y)
    .attr('stroke', d => TYPE_COLORS[d.type] || '#45475a')
    .attr('stroke-width', d => Math.max(1, Math.min(3, (d.weight || 1))))
    .attr('stroke-opacity', 0.3);

  // Render nodes
  const node = g.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')')
    .on('click', (event, d) => {
      event.stopPropagation();
      showNodeInfo(d);
    });

  node.append('circle')
    .attr('r', d => rScale(d.mentionCount || 1))
    .attr('fill', d => TYPE_COLORS[d.type] || DEFAULT_COLOR)
    .attr('stroke', d => {
      const c = TYPE_COLORS[d.type] || DEFAULT_COLOR;
      // Brighter stroke
      return d3.color(c).brighter(0.5).toString();
    });

  // Labels — hidden by default, shown on click via CSS
  node.append('text')
    .attr('dy', d => rScale(d.mentionCount || 1) + 14)
    .text(d => d.name.length > 16 ? d.name.slice(0, 15) + '~' : d.name);

  // Click background to deselect
  svg.on('click', closeInfo);

  // Fit view
  const bounds = g.node().getBBox();
  const padding = 40;
  const dx = bounds.width + padding * 2;
  const dy = bounds.height + padding * 2;
  const scale = Math.min(width / dx, height / dy, 1.5);
  const tx = width / 2 - (bounds.x + bounds.width / 2) * scale;
  const ty = height / 2 - (bounds.y + bounds.height / 2) * scale;
  svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

  // Build legend
  const legend = svg.append('g')
    .attr('transform', 'translate(12, ' + (height - 120) + ')');

  const types = [...new Set(nodes.map(n => n.type))].sort();
  types.forEach((type, i) => {
    const row = legend.append('g').attr('transform', 'translate(0,' + (i * 18) + ')');
    row.append('rect').attr('width', 12).attr('height', 12).attr('fill', TYPE_COLORS[type] || DEFAULT_COLOR);
    row.append('text').attr('x', 18).attr('y', 10).attr('fill', '#a6adc8')
      .attr('font-size', '12px').attr('font-family', 'monospace').text(type);
  });
});
</script>
</body>
</html>`;
}
