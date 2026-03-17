/**
 * Terminal-optimized Communities page — D3 treemap of topic clusters.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Each rectangle represents a community (topic cluster) with area
 * proportional to entity count. Color saturation encodes coherence score.
 * Click a cell to see community details in the info panel.
 */

import { terminalSharedCss } from "./shared-css.js";

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
    stroke: #1e1e2e;
    stroke-width: 1.5;
    cursor: pointer;
  }
  .cell text {
    fill: #1e1e2e;
    font-weight: 700;
    pointer-events: none;
    text-anchor: middle;
  }
  .cell.selected rect {
    stroke: #f9e2af;
    stroke-width: 3;
  }
  .cell:hover rect {
    stroke: #cdd6f4;
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
// Catppuccin Mocha hues — one per community, cycled
const HUES = [
  [243, 139, 168],  // red
  [137, 180, 250],  // blue
  [166, 227, 161],  // green
  [250, 179, 135],  // peach
  [203, 166, 247],  // mauve
  [116, 199, 236],  // sapphire
  [249, 226, 175],  // yellow
  [148, 226, 213],  // teal
  [242, 205, 205],  // flamingo
  [180, 190, 254],  // lavender
  [235, 160, 172],  // maroon
  [137, 220, 235],  // sky
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
  if (score >= 0.7) return { text: 'high', color: '#a6e3a1' };
  if (score >= 0.5) return { text: 'moderate', color: '#f9e2af' };
  return { text: 'low', color: '#f38ba8' };
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
  html += '<div class="coherence-badge" style="background:' + c.color + ';color:#1e1e2e">coherence: ' + d.coherenceScore.toFixed(3) + ' (' + c.text + ')</div>';
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

  // Fit labels into cells
  cells.each(function(d) {
    const cellW = d.x1 - d.x0;
    const cellH = d.y1 - d.y0;
    const name = d.data.name;

    if (cellW < 32 || cellH < 18) return;

    const g = d3.select(this);

    // Scale font to fit — community names are longer than single words
    const maxFontByW = (cellW - 10) / (name.length * 0.55);
    const maxFontByH = (cellH - 6) * 0.5;
    const fontSize = Math.min(Math.max(maxFontByW, 7), maxFontByH, 28);

    if (fontSize < 7) return;

    const charWidth = fontSize * 0.55;
    const maxChars = Math.floor((cellW - 10) / charWidth);

    // Try to word-wrap into multiple lines if cell is tall enough
    const words = name.split(/\\s+/);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const test = currentLine ? currentLine + ' ' + word : word;
      if (test.length > maxChars && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    // Limit lines to what fits vertically
    const lineHeight = fontSize * 1.2;
    const maxLines = Math.floor((cellH - 6) / lineHeight);
    const shownLines = lines.slice(0, Math.max(maxLines, 1));

    // Truncate last line if needed
    if (shownLines.length > 0) {
      const last = shownLines[shownLines.length - 1];
      if (last.length > maxChars) {
        shownLines[shownLines.length - 1] = last.slice(0, maxChars - 1) + '\\u2026';
      }
    }

    const totalTextH = shownLines.length * lineHeight;
    const startY = (cellH - totalTextH) / 2 + fontSize * 0.35 + lineHeight / 2;

    shownLines.forEach((line, i) => {
      g.append('text')
        .attr('x', cellW / 2)
        .attr('y', startY + i * lineHeight)
        .attr('font-size', fontSize + 'px')
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
