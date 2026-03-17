/**
 * Terminal-optimized Words page — D3 treemap word frequency visualization.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Key design choices:
 * - Treemap layout: rectangle area is proportional to word frequency
 * - SVG rendering for crisp text in terminal character cells
 * - High-contrast Everforest palette, type-coded by frequency tier
 * - Click a cell to see frequency details in the info panel
 * - Toggle to a ranked table view for precise numbers
 * - No animation — static pre-rendered layout
 */

import { terminalSharedCss } from "./shared-css.js";
import { PALETTE } from '../theme.js';

export function terminalWordsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram words [terminal]</title>
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
    stroke: #7fbbb3;
    stroke-width: 2;
  }

  /* Frequency table (alternative view) */
  #freq-table {
    display: none;
    margin-top: 34px;
    margin-bottom: 28px;
    padding: 8px 16px;
    max-width: 80ch;
    margin-left: auto;
    margin-right: auto;
  }
  #freq-table.active { display: block; }
  .freq-row {
    display: flex;
    justify-content: space-between;
    padding: 3px 8px;
    border-bottom: 1px solid #272e33;
    font-family: monospace;
    font-size: 13px;
  }
  .freq-row:nth-child(even) { background: #191d20; }
  .freq-word { color: #d3c6aa; }
  .freq-count { color: #7a8478; min-width: 5ch; text-align: right; }
  .freq-bar {
    flex: 1;
    margin: 0 8px;
    display: flex;
    align-items: center;
  }
  .freq-bar-fill {
    height: 8px;
    border-radius: 2px;
  }

  #mode-toggle {
    position: fixed; top: 0; right: 8px; z-index: 65;
    background: #272e33; border: 1px solid #374145;
    color: #9da9a0; padding: 5px 12px; font-family: monospace;
    font-size: 13px; cursor: pointer;
  }
  #mode-toggle:hover { color: #d3c6aa; border-color: #7fbbb3; }
</style>
</head>
<body>
<div id="view-tabs">
  <a href="/terminal/graph">Graph</a>
  <a href="/terminal/depth">Depth</a>
  <a class="active" href="/terminal/words">Words</a>
  <a href="/terminal/communities">Communities</a>
</div>

<button id="mode-toggle" onclick="toggleMode()">table view</button>

<div id="treemap"></div>
<div id="freq-table"></div>

<div id="info-panel">
  <button class="close-btn" onclick="closeInfo()">[x]</button>
  <div id="info-content">Click a cell to see details</div>
</div>

<div id="stats-bar">Loading...</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const PALETTE = ${JSON.stringify(PALETTE)};

let wordData = [];
let mode = 'treemap';
let selectedWord = null;

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function closeInfo() {
  document.getElementById('info-panel').classList.remove('open');
  d3.selectAll('.cell').classed('selected', false);
  selectedWord = null;
}

function showWordInfo(word, count, rank, cellEl) {
  d3.selectAll('.cell').classed('selected', false);
  if (cellEl) d3.select(cellEl).classed('selected', true);

  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  const pct = wordData.length > 0
    ? (count / wordData.reduce((s, w) => s + w.count, 0) * 100).toFixed(1)
    : '0';
  content.innerHTML =
    '<div class="name">' + esc(word) + '</div>' +
    '<div class="meta">' + count + ' mentions (' + pct + '% of total)</div>' +
    '<div class="meta">Rank #' + rank + ' of ' + wordData.length + '</div>';
  panel.classList.add('open');
  selectedWord = word;
}

function toggleMode() {
  const btn = document.getElementById('mode-toggle');
  if (mode === 'treemap') {
    mode = 'table';
    btn.textContent = 'treemap view';
    document.getElementById('treemap').style.display = 'none';
    document.getElementById('freq-table').classList.add('active');
  } else {
    mode = 'treemap';
    btn.textContent = 'table view';
    document.getElementById('treemap').style.display = 'block';
    document.getElementById('freq-table').classList.remove('active');
  }
}

function renderTreemap(words) {
  const container = document.getElementById('treemap');
  container.innerHTML = '';

  if (words.length === 0) return;

  const width = Math.max(window.innerWidth - 32, 768);
  const height = Math.max(window.innerHeight - 78, 500);

  // Build hierarchy for d3.treemap
  const root = d3.hierarchy({ children: words.map((w, i) => ({ ...w, rank: i })) })
    .sum(d => d.count)
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
      showWordInfo(d.data.text, d.data.count, d.data.rank + 1, this);
    });

  cells.append('rect')
    .attr('width', d => d.x1 - d.x0)
    .attr('height', d => d.y1 - d.y0)
    .attr('fill', d => PALETTE[d.data.rank % PALETTE.length])
    .attr('rx', 2);

  // Fit text into cells with word-wrapping and proper centering
  cells.each(function(d) {
    const cellW = d.x1 - d.x0;
    const cellH = d.y1 - d.y0;
    const name = d.data.text;
    const pad = 6;

    if (cellW < 30 || cellH < 16) return;

    const g = d3.select(this);
    const usableW = cellW - pad * 2;
    const usableH = cellH - pad * 2;

    // Start with a font size based on cell height, then shrink if needed
    const charRatio = 0.65; // monospace char width / font size (tuned for carbonyl)
    let fontSize = Math.min(usableH * 0.35, 36);

    function wrapText(fs) {
      const cw = fs * charRatio;
      const maxChars = Math.max(Math.floor(usableW / cw), 1);
      const words = name.split(/\\s+/);
      const lines = [];
      let cur = '';
      for (const w of words) {
        // If a single word is wider than the cell, force-break it
        if (w.length > maxChars) {
          if (cur) { lines.push(cur); cur = ''; }
          for (let j = 0; j < w.length; j += maxChars) {
            lines.push(w.slice(j, j + maxChars));
          }
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

  // Click background to deselect
  svg.on('click', closeInfo);
}

function renderTable(words) {
  const container = document.getElementById('freq-table');
  container.innerHTML = '';

  if (words.length === 0) return;
  const maxCount = words[0].count;

  words.forEach((w, i) => {
    const row = document.createElement('div');
    row.className = 'freq-row';

    const rank = document.createElement('span');
    rank.style.color = '#495156';
    rank.style.minWidth = '4ch';
    rank.textContent = (i + 1) + '.';

    const word = document.createElement('span');
    word.className = 'freq-word';
    word.style.color = PALETTE[i % PALETTE.length];
    word.style.minWidth = '20ch';
    word.textContent = w.text;

    const bar = document.createElement('span');
    bar.className = 'freq-bar';
    const fill = document.createElement('span');
    fill.className = 'freq-bar-fill';
    fill.style.width = Math.round((w.count / maxCount) * 100) + '%';
    fill.style.background = PALETTE[i % PALETTE.length];
    bar.appendChild(fill);

    const count = document.createElement('span');
    count.className = 'freq-count';
    count.textContent = w.count;

    row.appendChild(rank);
    row.appendChild(word);
    row.appendChild(bar);
    row.appendChild(count);
    container.appendChild(row);
  });
}

// Load data
fetch('/graph/words/api/words?limit=200')
  .then(r => r.json())
  .then(data => {
    wordData = data;
    document.getElementById('stats-bar').textContent =
      data.length + ' words from episodic memory';
    renderTreemap(data);
    renderTable(data);
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
