/**
 * Live-update polling shared by the graph, depth and galaxy pages. Every 1.5 s
 * it fetches `<prefix>/api/diff?since=<last>`, merges new and updated
 * nodes/links into the page's `allNodes` / `allLinks` (sparking what changed),
 * flashes the `#live` indicator and hands the new node ids to the page.
 *
 * Requires `sharedJs()` (linkId) and the page's `allNodes` / `allLinks`.
 */

export function diffPollingJs(): string {
  return `
// ─── Diff polling ────────────────────────────────────────────────
let lastDiffTimestamp = Math.floor(Date.now() / 1000);
const nodeMap = new Map();
const linkKey = new Set();

function linkKeyOf(l) { return linkId(l.source) + '|' + linkId(l.target) + '|' + l.type; }

function startDiffPolling(prefix, onChanged) {
  for (const n of allNodes) nodeMap.set(n.id, n);
  for (const l of allLinks) linkKey.add(linkKeyOf(l));
  setInterval(() => {
    fetch(prefix + '/api/diff?since=' + lastDiffTimestamp)
      .then(r => r.json())
      .then(diff => mergeDiff(diff, onChanged))
      .catch(() => {});
  }, 1500);
}

function mergeDiff(diff, onChanged) {
  if (!diff) return;
  lastDiffTimestamp = diff.timestamp;
  const sparkTime = Date.now();
  let changed = false;
  const newNodeIds = [];

  for (const n of diff.newNodes) {
    if (nodeMap.has(n.id)) continue;
    n.lastSpark = sparkTime;
    n.lastActive = n.lastActive || 0;
    n.firstSeen = n.firstSeen || 0;
    n.bridgeScore = n.bridgeScore || 0;
    allNodes.push(n);
    nodeMap.set(n.id, n);
    newNodeIds.push(n.id);
    changed = true;
  }

  for (const n of diff.updatedNodes) {
    const existing = nodeMap.get(n.id);
    if (!existing) continue;
    existing.name = n.name;
    existing.description = n.description;
    existing.mentionCount = n.mentionCount;
    existing.community = n.community;
    existing.lastActive = n.lastActive || existing.lastActive;
    existing.firstSeen = n.firstSeen || existing.firstSeen;
    existing.bridgeScore = n.bridgeScore ?? existing.bridgeScore;
    existing.lastSpark = sparkTime;
    changed = true;
  }

  for (const l of diff.newLinks) {
    const key = linkKeyOf(l);
    if (linkKey.has(key)) continue;
    l.lastSpark = sparkTime;
    allLinks.push(l);
    linkKey.add(key);
    changed = true;
    // Also spark the connected nodes
    const sn = nodeMap.get(l.source);
    const tn = nodeMap.get(l.target);
    if (sn) sn.lastSpark = sparkTime;
    if (tn) tn.lastSpark = sparkTime;
  }

  for (const l of diff.updatedLinks) {
    const key = linkKeyOf(l);
    const existing = allLinks.find(el => linkKeyOf(el) === key);
    if (!existing) continue;
    existing.weight = l.weight;
    existing.context = l.context;
    existing.lastSpark = sparkTime;
    changed = true;
  }

  if (!changed) return;

  const live = document.getElementById('live');
  live.textContent = '+' + (diff.newNodes.length + diff.updatedNodes.length) + ' changes';
  live.classList.add('show');
  setTimeout(() => live.classList.remove('show'), 2000);

  onChanged(newNodeIds);
}
`;
}
