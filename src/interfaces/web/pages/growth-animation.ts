/**
 * Growth animation shared by the graph, depth and galaxy pages: replays the
 * graph's growth in `firstSeen` order (~45 s at 1x) behind the `#animate-btn`
 * / `#anim-progress` controls from shared-css.ts.
 *
 * The page calls `setupGrowthAnimation(show, restore)`: `show(nodes, links)`
 * renders a partial graph (called with `[], []` at the start), `restore()`
 * returns to the normal view once the mention threshold has been put back.
 * Requires `sharedJs()` (linkId) and the page's `allNodes` / `allLinks` /
 * `mentionThreshold`.
 */

export function growthAnimationJs(): string {
  return `
// ─── Growth animation ────────────────────────────────────────────
let animating = false;
let animTime = 0;
let animMinTime = 0;
let animMaxTime = 0;
let animSpeed = 1;
const ANIM_SPEEDS = [1, 2, 5, 10, 20];
let animSpeedIdx = 0;
let animLastFrame = 0;
let animNodeOrder = [];
let animVisibleCount = 0;
let animSavedThreshold = 0;
let animShow = null;
let animRestore = null;

const animBtn = document.getElementById('animate-btn');
const animProgress = document.getElementById('anim-progress');
const animBar = document.getElementById('anim-bar');
const animDate = document.getElementById('anim-date');
const animSpeedEl = document.getElementById('anim-speed');

function setupGrowthAnimation(show, restore) {
  animShow = show;
  animRestore = restore;
  animBtn.addEventListener('click', () => {
    if (animating) stopAnimation();
    else startAnimation();
  });
  animSpeedEl.addEventListener('click', () => {
    animSpeedIdx = (animSpeedIdx + 1) % ANIM_SPEEDS.length;
    animSpeed = ANIM_SPEEDS[animSpeedIdx];
    animSpeedEl.textContent = animSpeed + 'x';
  });
}

function formatAnimDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startAnimation() {
  // Animate within the current threshold — keeps node count manageable
  animNodeOrder = allNodes
    .filter(n => (n.mentionCount || 0) >= mentionThreshold && (n.firstSeen || 0) > 0)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  if (animNodeOrder.length < 2) return;

  animMinTime = animNodeOrder[0].firstSeen;
  animMaxTime = animNodeOrder[animNodeOrder.length - 1].firstSeen;
  animTime = animMinTime;
  animVisibleCount = 0;
  animSavedThreshold = mentionThreshold;

  animating = true;
  animLastFrame = performance.now();
  animBtn.classList.add('playing');
  animBtn.innerHTML = '&#x25A0;';
  animProgress.classList.add('show');

  animShow([], []);
  requestAnimationFrame(animTick);
}

function stopAnimation() {
  animating = false;
  animBtn.classList.remove('playing');
  animBtn.innerHTML = '&#x25B6;';
  animProgress.classList.remove('show');

  mentionThreshold = animSavedThreshold;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;
  animRestore();
}

function animTick(now) {
  if (!animating) return;
  const dt = (now - animLastFrame) / 1000;
  animLastFrame = now;

  // Compress the full time span into ~45 seconds at 1x
  const BASE_DURATION = 45;
  const timeSpan = animMaxTime - animMinTime || 1;
  animTime += dt * (timeSpan / BASE_DURATION) * animSpeed;

  if (animTime >= animMaxTime) {
    animTime = animMaxTime;
    // Let it settle on the final frame, then stop
    animVisibleCount = animNodeOrder.length;
    animRebuild();
    updateAnimUI();
    setTimeout(stopAnimation, 1500);
    return;
  }

  let newCount = animVisibleCount;
  while (newCount < animNodeOrder.length && (animNodeOrder[newCount].firstSeen || 0) <= animTime) {
    newCount++;
  }

  if (newCount > animVisibleCount) {
    const sparkTime = Date.now();
    for (let i = animVisibleCount; i < newCount; i++) animNodeOrder[i].lastSpark = sparkTime;
    animVisibleCount = newCount;
    animRebuild();
  }

  updateAnimUI();
  requestAnimationFrame(animTick);
}

function animRebuild() {
  const visible = animNodeOrder.slice(0, animVisibleCount);
  const visibleIds = new Set(visible.map(n => n.id));
  const links = allLinks.filter(l => visibleIds.has(linkId(l.source)) && visibleIds.has(linkId(l.target)));
  animShow(visible, links);
}

function updateAnimUI() {
  animBar.style.width = ((animTime - animMinTime) / (animMaxTime - animMinTime || 1)) * 100 + '%';
  animDate.textContent = formatAnimDate(animTime);
}
`;
}
