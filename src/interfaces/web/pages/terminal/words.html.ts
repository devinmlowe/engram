/**
 * Terminal-optimized Words page — HTML/CSS grid word cloud.
 * Designed for viewing in carbonyl (terminal Chromium).
 *
 * Key differences from the standard words.html.ts:
 * - Uses HTML text elements instead of SVG d3-cloud (terminal text is crisp)
 * - Inline-block layout with CSS font-size scaling
 * - No animation — static render
 * - Click a word to see its frequency in the info panel
 * - Monospace font renders cleanly at character-cell resolution
 */

import { terminalSharedCss } from "./shared-css.js";

export function terminalWordsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram words [terminal]</title>
<style>
  ${terminalSharedCss()}

  #cloud {
    margin-top: 34px;
    margin-bottom: 28px;
    padding: 16px 24px;
    text-align: center;
    line-height: 1.8;
    overflow: auto;
  }

  .word {
    display: inline-block;
    padding: 2px 6px;
    margin: 2px 4px;
    cursor: pointer;
    font-family: monospace;
    font-weight: 700;
    border-bottom: 2px solid transparent;
    transition: none;
  }
  .word:hover {
    border-bottom-color: #89b4fa;
  }
  .word.selected {
    border-bottom-color: #f9e2af;
    background: #313244;
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
    border-bottom: 1px solid #313244;
    font-family: monospace;
    font-size: 13px;
  }
  .freq-row:nth-child(even) { background: #181825; }
  .freq-word { color: #cdd6f4; }
  .freq-count { color: #6c7086; min-width: 5ch; text-align: right; }
  .freq-bar {
    flex: 1;
    margin: 0 8px;
    display: flex;
    align-items: center;
  }
  .freq-bar-fill {
    height: 8px;
    background: #89b4fa;
    border-radius: 2px;
  }

  #mode-toggle {
    position: fixed; top: 0; right: 8px; z-index: 65;
    background: #313244; border: 1px solid #45475a;
    color: #a6adc8; padding: 5px 12px; font-family: monospace;
    font-size: 13px; cursor: pointer;
  }
  #mode-toggle:hover { color: #cdd6f4; border-color: #89b4fa; }
</style>
</head>
<body>
<div id="view-tabs">
  <a href="/terminal/graph">Graph</a>
  <a href="/terminal/depth">Depth</a>
  <a class="active" href="/terminal/words">Words</a>
</div>

<button id="mode-toggle" onclick="toggleMode()">table view</button>

<div id="cloud"></div>
<div id="freq-table"></div>

<div id="info-panel">
  <button class="close-btn" onclick="closeInfo()">[x]</button>
  <div id="info-content">Click a word to see details</div>
</div>

<div id="stats-bar">Loading...</div>

<script>
const PALETTE = [
  '#f38ba8', '#89b4fa', '#a6e3a1', '#fab387', '#cba6f7',
  '#74c7ec', '#f9e2af', '#94e2d5', '#f2cdcd', '#b4befe',
  '#eba0ac', '#89dceb',
];

let wordData = [];
let mode = 'cloud';
let selectedWord = null;

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function closeInfo() {
  document.getElementById('info-panel').classList.remove('open');
  document.querySelectorAll('.word.selected').forEach(el => el.classList.remove('selected'));
  selectedWord = null;
}

function showWordInfo(word, count, rank, el) {
  document.querySelectorAll('.word.selected').forEach(w => w.classList.remove('selected'));
  if (el) el.classList.add('selected');

  const panel = document.getElementById('info-panel');
  const content = document.getElementById('info-content');
  content.innerHTML =
    '<div class="name">' + esc(word) + '</div>' +
    '<div class="meta">' + count + ' mentions</div>' +
    '<div class="meta">Rank #' + rank + ' of ' + wordData.length + '</div>';
  panel.classList.add('open');
  selectedWord = word;
}

function toggleMode() {
  const btn = document.getElementById('mode-toggle');
  if (mode === 'cloud') {
    mode = 'table';
    btn.textContent = 'cloud view';
    document.getElementById('cloud').style.display = 'none';
    document.getElementById('freq-table').classList.add('active');
  } else {
    mode = 'cloud';
    btn.textContent = 'table view';
    document.getElementById('cloud').style.display = 'block';
    document.getElementById('freq-table').classList.remove('active');
  }
}

function renderCloud(words) {
  const container = document.getElementById('cloud');
  container.innerHTML = '';

  if (words.length === 0) return;
  const maxCount = words[0].count;
  const minCount = words[words.length - 1].count;

  // Font size range in px: 12 to 48 for terminal readability
  const sizeScale = (count) => {
    if (maxCount === minCount) return 24;
    const t = (count - minCount) / (maxCount - minCount);
    return Math.round(12 + t * 36);
  };

  words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = w.text;
    span.style.fontSize = sizeScale(w.count) + 'px';
    span.style.color = PALETTE[i % PALETTE.length];
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      showWordInfo(w.text, w.count, i + 1, span);
    });
    container.appendChild(span);
  });
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
    rank.style.color = '#585b70';
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
    renderCloud(data);
    renderTable(data);
  });

document.addEventListener('click', (e) => {
  if (!e.target.closest('#info-panel') && !e.target.closest('.word')) {
    closeInfo();
  }
});
</script>
</body>
</html>`;
}
