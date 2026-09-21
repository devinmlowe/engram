/**
 * Terminal-optimized Communities page — D3 treemap of topic clusters.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Each rectangle represents a community (topic cluster) with area
 * proportional to entity count. Color saturation encodes coherence score.
 * Click a cell to see community details in the info panel.
 */

import { terminalSharedCss } from "./shared-css.js";
import { terminalTreemapJs } from "./treemap.js";
import { sharedJs } from "../shared-js.js";
import { PALETTE, hexToRgb } from '../theme.js';

export function terminalCommunitiesPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram communities [terminal]</title>
<style>
  ${terminalSharedCss()}

  #treemap {
    margin-top: 42px;
    margin-bottom: 36px;
    margin-left: 16px;
    margin-right: 16px;
    overflow: hidden;
  }

  .cell rect {
    stroke: #1e2326;
    stroke-width: 1.5;
    cursor: pointer;
  }
  .cell text {
    fill: #1e2326;
    font-weight: 700;
    pointer-events: none;
    text-anchor: middle;
  }
  .cell.selected rect {
    stroke: #dbbc7f;
    stroke-width: 3;
  }
  .cell:hover rect {
    stroke: #d3c6aa;
    stroke-width: 2;
  }

  .coherence-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 700;
    margin-top: 4px;
  }
</style>
</head>
<body>
<div id="view-tabs">
  <a href="/terminal/graph">Graph</a>
  <a href="/terminal/depth">Depth</a>
  <a href="/terminal/words">Words</a>
  <a class="active" href="/terminal/communities">Communities</a>
</div>

<div id="treemap"></div>

<div id="info-panel">
  <button class="close-btn" onclick="closeInfo()">[x]</button>
  <div id="info-content">Click a community to inspect</div>
</div>

<div id="stats-bar">Loading...</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
// Everforest palette as RGB — one hue per community, cycled
const HUES = ${JSON.stringify(PALETTE.map(hexToRgb))};
${sharedJs()}
${terminalTreemapJs()}

let communityData = [];

function closeInfo() {
  document.getElementById('info-panel').classList.remove('open');
  d3.selectAll('.cell').classed('selected', false);
}

function coherenceLabel(score) {
  if (score >= 0.7) return { text: 'high', color: '#a7c080' };
  if (score >= 0.5) return { text: 'moderate', color: '#dbbc7f' };
  return { text: 'low', color: '#e67e80' };
}

function showCommunityInfo(d, cellEl) {
  d3.selectAll('.cell').classed('selected', false);
  if (cellEl) d3.select(cellEl).classed('selected', true);

  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  const c = coherenceLabel(d.coherenceScore);
  const totalEntities = communityData.reduce((s, c) => s + c.entityCount, 0);
  const pct = (d.entityCount / totalEntities * 100).toFixed(1);

  let html = '<div class="name">' + esc(d.name) + '</div>';
  html += '<div class="meta">' + d.entityCount + ' entities (' + pct + '% of graph)</div>';
  html += '<div class="coherence-badge" style="background:' + c.color + ';color:#1e2326">coherence: ' + d.coherenceScore.toFixed(3) + ' (' + c.text + ')</div>';
  if (d.description) html += '<div class="desc" style="margin-top:8px">' + esc(d.description) + '</div>';

  content.innerHTML = html;
  panel.classList.add('open');
}

function cellColor(index, coherence) {
  const hue = HUES[index % HUES.length];
  // Modulate saturation/brightness by coherence: high coherence = vivid, low = muted
  const factor = 0.4 + coherence * 0.6;
  const r = Math.round(hue[0] * factor);
  const g = Math.round(hue[1] * factor);
  const b = Math.round(hue[2] * factor);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function renderCommunityTreemap(communities) {
  // Budget: show top 80 communities to keep the treemap readable
  const items = communities.slice(0, 80).map((c, i) => ({
    ...c, label: c.name, value: c.entityCount, fill: cellColor(i, c.coherenceScore),
  }));
  renderTreemap(document.getElementById('treemap'), items, {
    maxFont: 28,
    onClick: (d, cellEl) => showCommunityInfo(d, cellEl),
  });
}

// Load data
fetch('/api/communities')
  .then(r => r.json())
  .then(data => {
    communityData = data;
    const totalEntities = data.reduce((s, c) => s + c.entityCount, 0);
    document.getElementById('stats-bar').textContent =
      data.length + ' communities | ' + totalEntities + ' total entities | generation ' + (data[0]?.generation ?? '?');
    renderCommunityTreemap(data);
  });

document.addEventListener('click', (e) => {
  if (!e.target.closest('#info-panel') && !e.target.closest('.cell')) {
    closeInfo();
  }
});
</script>
</body>
</html>`;
}
