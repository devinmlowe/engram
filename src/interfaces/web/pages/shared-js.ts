/**
 * Shared client-side JavaScript for the visualizer pages. Each function returns
 * a JS source string that a page interpolates into its inline <script>, the way
 * shared-css.ts does for CSS.
 */

/** `esc` (HTML-escape), `formatAge` (relative time) and `linkId` (source/target id). */
export function sharedJs(): string {
  return `
function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function formatAge(ts) {
  if (!ts) return 'unknown';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.round(diff / 86400) + 'd ago';
  return Math.round(diff / 2592000) + 'mo ago';
}

// d3-force replaces a link's source/target id with the node object once it runs.
function linkId(x) { return typeof x === 'object' ? x.id : x; }
`;
}

/** Settings panel open/close and collapsible sections (markup from shared-css.ts). */
export function panelToggleJs(): string {
  return `
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => hdr.parentElement.classList.toggle('open'));
});
`;
}
