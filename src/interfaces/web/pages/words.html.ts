/**
 * Words page — D3 word cloud from episodic conversation data.
 */

import { sharedPanelCss } from "./shared-css.js";
import { PALETTE } from './theme.js';

export function wordsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram words</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e2326;
    color: #d3c6aa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #cloud { width: 100vw; height: 100vh; }

  #tooltip {
    position: fixed;
    display: none;
    background: #272e33;
    border: 1px solid #374145;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }

  #stats-bar {
    position: fixed; bottom: 12px; left: 16px; z-index: 50;
    font-size: 11px; color: #495156; pointer-events: none;
  }

  ${sharedPanelCss()}
</style>
</head>
<body>
<div id="cloud"></div>
<div id="tooltip"></div>
<div id="view-tabs">
  <a href="/graph">Graph</a>
  <a href="/graph/depth">Depth</a>
  <a href="/graph/galaxy">Galaxy</a>
  <a class="active" href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-words">-</span> words from episodic memory</div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Word cloud</h2>
    <div class="panel-header-actions">
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Word count <span class="val" id="word-count-val">200</span></div>
        <input type="range" id="word-count" min="50" max="400" value="200" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Min frequency <span class="val" id="min-freq-val">3</span></div>
        <input type="range" id="min-freq" min="1" max="20" value="3" />
      </div>
    </div>
  </div>

</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3-cloud/1.2.7/d3.layout.cloud.min.js"></script>
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

const PALETTE = ${JSON.stringify(PALETTE)};

let wordData = [];
let wordCount = 200;

function renderCloud(words) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (words.length === 0) return;
  const maxCount = words[0].count;
  const minCount = words[words.length - 1].count;

  const fontScale = d3.scaleSqrt()
    .domain([minCount, maxCount])
    .range([10, Math.min(width, height) / 7]);

  const container = document.getElementById('cloud');
  container.innerHTML = '';

  d3.layout.cloud()
    .size([width, height])
    .words(words.map((d, i) => ({
      text: d.text,
      size: fontScale(d.count),
      count: d.count,
      ci: i,
    })))
    .padding(3)
    .rotate(() => {
      const r = Math.random();
      if (r < 0.65) return 0;
      if (r < 0.85) return 90;
      return (~~(Math.random() * 5) - 2) * 15;
    })
    .font('-apple-system, system-ui, sans-serif')
    .fontWeight(d => d.size > fontScale(maxCount) * 0.6 ? '700' : d.size > fontScale(maxCount) * 0.3 ? '600' : '400')
    .fontSize(d => d.size)
    .spiral('archimedean')
    .on('end', (drawn) => {
      const svg = d3.select('#cloud').append('svg')
        .attr('width', width)
        .attr('height', height);

      const g = svg.append('g')
        .attr('transform', 'translate(' + width / 2 + ',' + height / 2 + ')');

      g.selectAll('text')
        .data(drawn)
        .enter().append('text')
        .style('font-size', d => d.size + 'px')
        .style('font-family', '-apple-system, system-ui, sans-serif')
        .style('font-weight', d => d.weight || '400')
        .style('fill', d => PALETTE[d.ci % PALETTE.length])
        .style('cursor', 'default')
        .style('opacity', 0)
        .style('transition', 'opacity 0.2s')
        .attr('text-anchor', 'middle')
        .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')rotate(' + d.rotate + ')')
        .text(d => d.text)
        .transition()
        .delay((d, i) => i * 3)
        .duration(400)
        .style('opacity', 0.88);

      g.selectAll('text')
        .on('mouseover', function(event, d) {
          d3.select(this)
            .style('opacity', 1)
            .attr('transform', 'translate(' + d.x + ',' + d.y + ')rotate(' + d.rotate + ')scale(1.1)');
          const tip = document.getElementById('tooltip');
          tip.innerHTML = '<strong>' + esc(d.text) + '</strong> &mdash; ' + d.count + ' mentions';
          tip.style.display = 'block';
          tip.style.left = (event.clientX + 12) + 'px';
          tip.style.top = (event.clientY - 8) + 'px';
        })
        .on('mousemove', function(event) {
          const tip = document.getElementById('tooltip');
          tip.style.left = (event.clientX + 12) + 'px';
          tip.style.top = (event.clientY - 8) + 'px';
        })
        .on('mouseout', function(event, d) {
          d3.select(this)
            .style('opacity', 0.88)
            .attr('transform', 'translate(' + d.x + ',' + d.y + ')rotate(' + d.rotate + ')');
          document.getElementById('tooltip').style.display = 'none';
        });
    })
    .start();

  document.getElementById('stat-words').textContent = words.length;
}

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ─── Word count tracking for pulse highlights ───────────────────
const lastWordCounts = new Map();
let lastRelayoutTime = 0;
const RELAYOUT_INTERVAL = 60000;

function load(isInitial) {
  fetch('/graph/words/api/words?limit=' + wordCount)
    .then(r => r.json())
    .then(data => {
      wordData = data;
      renderCloud(data);
      // Initialize word count tracking
      if (isInitial) {
        for (const w of data) lastWordCounts.set(w.text, w.count);
      }
      lastRelayoutTime = Date.now();
    });
}

function pollWords() {
  fetch('/graph/words/api/words?limit=' + wordCount)
    .then(r => r.json())
    .then(data => {
      const changedWords = [];
      const newWords = [];

      for (const w of data) {
        const prev = lastWordCounts.get(w.text);
        if (prev == null) {
          newWords.push(w.text);
        } else if (w.count > prev) {
          changedWords.push(w.text);
        }
        lastWordCounts.set(w.text, w.count);
      }

      if (changedWords.length > 0 || newWords.length > 0) {
        // Show live indicator
        const live = document.getElementById('live');
        const total = changedWords.length + newWords.length;
        live.textContent = '+' + total + ' word' + (total !== 1 ? 's' : '') + ' changed';
        live.classList.add('show');
        setTimeout(() => live.classList.remove('show'), 2000);

        // Pulse existing changed words
        const allText = document.querySelectorAll('#cloud svg text');
        for (const el of allText) {
          const text = el.textContent;
          if (changedWords.includes(text)) {
            el.classList.remove('word-sparked');
            void el.offsetWidth; // force reflow
            el.classList.add('word-sparked');
          }
        }

        // Re-layout periodically or if new words appeared
        if (newWords.length > 0 && Date.now() - lastRelayoutTime > RELAYOUT_INTERVAL) {
          wordData = data;
          renderCloud(data);
          lastRelayoutTime = Date.now();
          // Apply spark to new words after re-layout
          setTimeout(() => {
            const allText2 = document.querySelectorAll('#cloud svg text');
            for (const el of allText2) {
              if (newWords.includes(el.textContent)) {
                el.classList.add('word-sparked');
              }
            }
          }, 500);
        }
      }
    })
    .catch(() => {});
}

document.getElementById('word-count').addEventListener('input', (e) => {
  wordCount = parseInt(e.target.value, 10);
  document.getElementById('word-count-val').textContent = wordCount;
});
document.getElementById('word-count').addEventListener('change', () => load(false));

document.getElementById('min-freq').addEventListener('change', () => load(false));

window.addEventListener('resize', () => {
  if (wordData.length > 0) renderCloud(wordData);
});

load(true);
setInterval(pollWords, 10000);
</script>
</body>
</html>`;
}
