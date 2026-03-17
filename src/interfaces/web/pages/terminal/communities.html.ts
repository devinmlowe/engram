/**
 * Terminal-optimized Communities page — D3 treemap of topic clusters.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Each rectangle represents a community (topic cluster) with area
 * proportional to entity count. Color saturation encodes coherence score.
 * Click a cell to see community details in the info panel.
 */

import { terminalSharedCss } from "./shared-css.js";
import { RED, BLUE, GREEN, ORANGE, PURPLE, AQUA, YELLOW } from '../theme.js';

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
// Everforest Hard Dark hues — one per community, cycled
const HUES = [
  [230, 126, 128],  // red
  [127, 187, 179],  // blue
  [167, 192, 128],  // green
  [230, 152, 117],  // peach
  [214, 153, 182],  // mauve
  [131, 192, 146],  // sapphire
  [219, 188, 127],  // yellow
  [131, 192, 146],  // teal
  [230, 152, 117],  // flamingo
  [214, 153, 182],  // lavender
  [230, 126, 128],  // maroon
  [131, 192, 146],  // sky
];

let communityData = [];

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

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

function renderTreemap(communities) {
  const container = document.getElementById('treemap');
  container.innerHTML = '';

  if (communities.length === 0) return;

  const width = Math.max(window.innerWidth - 32, 768);
  const height = Math.max(window.innerHeight - 78, 500);

  // Budget: show top 80 communities to keep the treemap readable
  const BUDGET = 80;
  const shown = communities.slice(0, BUDGET);

  const root = d3.hierarchy({ children: shown.map((c, i) => ({ ...c, rank: i })) })
    .sum(d => d.entityCount)
    .sort((a, b) => b.value - a.value);

  d3.treemap()
    .size([width, height])
    .padding(2)
    .round(true)(root);

  const svg = d3.select(container).append('svg')
    .attr('width', width)
    .attr('height', height);

  const cells = svg.selectAll('g')
    .data(root.leaves())
    .join('g')
    .attr('class', 'cell')
    .attr('transform', d => 'translate(' + d.x0 + ',' + d.y0 + ')')
    .on('click', function(event, d) {
      event.stopPropagation();
      showCommunityInfo(d.data, this);
    });

  cells.append('rect')
    .attr('width', d => d.x1 - d.x0)
    .attr('height', d => d.y1 - d.y0)
    .attr('fill', d => cellColor(d.data.rank, d.data.coherenceScore))
    .attr('rx', 2);

  // Fit labels into cells with word-wrapping and proper centering
  cells.each(function(d) {
    const cellW = d.x1 - d.x0;
    const cellH = d.y1 - d.y0;
    const name = d.data.name;
    const pad = 6;

    if (cellW < 30 || cellH < 16) return;

    const g = d3.select(this);
    const usableW = cellW - pad * 2;
    const usableH = cellH - pad * 2;

    // Start with a font size based on cell height, then shrink if needed
    const charRatio = 0.65; // monospace char width / font size (tuned for carbonyl)
    let fontSize = Math.min(usableH * 0.35, 28);

    function wrapText(fs) {
      const cw = fs * charRatio;
      const maxChars = Math.max(Math.floor(usableW / cw), 1);
      const words = name.split(/\\s+/);
      const lines = [];
      let cur = '';
      for (const w of words) {
        if (w.length > maxChars) {
          // Word too wide — put it on its own line, truncated with ellipsis
          if (cur) { lines.push(cur); cur = ''; }
          lines.push(w.slice(0, maxChars - 1) + '\\u2026');
          continue;
        }
        const test = cur ? cur + ' ' + w : w;
        if (test.length > maxChars && cur) {
          lines.push(cur);
          cur = w;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
      return { lines, maxChars };
    }

    // Try wrapping at current font size, shrink if lines don't fit
    let result, lineHeight, maxLines;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (fontSize < 6) return;
      result = wrapText(fontSize);
      lineHeight = fontSize * 1.25;
      maxLines = Math.floor(usableH / lineHeight);
      if (maxLines >= 1 && (result.lines.length <= maxLines || maxLines >= 2)) break;
      fontSize *= 0.8;
    }

    if (fontSize < 6) return;

    const shownLines = result.lines.slice(0, Math.max(maxLines, 1));

    // Truncate last visible line if there are hidden lines
    if (shownLines.length < result.lines.length && shownLines.length > 0) {
      const last = shownLines[shownLines.length - 1];
      const mc = result.maxChars;
      shownLines[shownLines.length - 1] = last.length > mc - 1
        ? last.slice(0, mc - 1) + '\\u2026'
        : last + '\\u2026';
    }

    // Center the text block vertically and horizontally
    const totalH = shownLines.length * lineHeight;
    const baseY = pad + (usableH - totalH) / 2 + fontSize * 0.8;

    shownLines.forEach((line, i) => {
      g.append('text')
        .attr('x', cellW / 2)
        .attr('y', baseY + i * lineHeight)
        .attr('font-size', fontSize + 'px')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'auto')
        .text(line);
    });
  });

  svg.on('click', closeInfo);
}

// Load data
fetch('/api/communities')
  .then(r => r.json())
  .then(data => {
    communityData = data;
    const totalEntities = data.reduce((s, c) => s + c.entityCount, 0);
    document.getElementById('stats-bar').textContent =
      data.length + ' communities | ' + totalEntities + ' total entities | generation ' + (data[0]?.generation ?? '?');
    renderTreemap(data);
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
