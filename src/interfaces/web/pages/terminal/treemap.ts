/**
 * Treemap renderer shared by the terminal words and communities pages: one
 * SVG cell per item, area proportional to `value`, label wrapped and shrunk
 * to fit the cell (tuned for carbonyl's monospace character cells).
 */

export function terminalTreemapJs(): string {
  return `
// ─── Treemap ─────────────────────────────────────────────────────
// items: [{ label, value, fill, ...data }]; opts.onClick(item, cellEl), opts.maxFont.
function renderTreemap(container, items, opts) {
  container.innerHTML = '';
  if (items.length === 0) return;

  const width = Math.max(window.innerWidth - 32, 768);
  const height = Math.max(window.innerHeight - 78, 500);

  const root = d3.hierarchy({ children: items })
    .sum(d => d.value)
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
      opts.onClick(d.data, this);
    });

  cells.append('rect')
    .attr('width', d => d.x1 - d.x0)
    .attr('height', d => d.y1 - d.y0)
    .attr('fill', d => d.data.fill)
    .attr('rx', 2);

  cells.each(function(d) {
    fitCellText(d3.select(this), d.x1 - d.x0, d.y1 - d.y0, d.data.label, opts.maxFont);
  });

  // Click background to deselect
  svg.on('click', closeInfo);
}

// Word-wrap the label into the cell, shrinking the font until it fits, and centre it.
function fitCellText(g, cellW, cellH, name, maxFont) {
  const pad = 6;
  if (cellW < 30 || cellH < 16) return;

  const usableW = cellW - pad * 2;
  const usableH = cellH - pad * 2;

  // Start with a font size based on cell height, then shrink if needed
  const charRatio = 0.65; // monospace char width / font size (tuned for carbonyl)
  let fontSize = Math.min(usableH * 0.35, maxFont);

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
}
`;
}
