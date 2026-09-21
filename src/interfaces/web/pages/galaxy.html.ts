/**
 * Galaxy page — orbital mechanics knowledge graph visualization.
 */

import { sharedPanelCss } from "./shared-css.js";
import { sharedJs, panelToggleJs } from "./shared-js.js";
import { sparkColorsJs } from "./spark-colors.js";
import { diffPollingJs } from "./diff-polling.js";
import { growthAnimationJs } from "./growth-animation.js";
import { threeHelpersJs } from "./three-helpers.js";

export function galaxyPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram galaxy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #191d20;
    color: #d3c6aa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  #graph-3d { width: 100vw; height: 100vh; }

  #tooltip {
    position: fixed;
    display: none;
    background: rgba(39,46,51,0.95);
    border: 1px solid #374145;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 360px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  }
  #tooltip .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  #tooltip .type { color: #9da9a0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .desc { margin-top: 6px; color: #d3c6aa; line-height: 1.4; }
  #tooltip .community { margin-top: 6px; color: #83c092; font-size: 11px; }
  #tooltip .time { margin-top: 6px; color: #9da9a0; font-size: 11px; }

  #stats-bar {
    position: fixed; bottom: 12px; left: 16px; z-index: 50;
    font-size: 11px; color: #495156; pointer-events: none;
  }

  ${sharedPanelCss()}
</style>
</head>
<body>
<div id="graph-3d"></div>
<div id="tooltip"></div>
<div id="view-tabs">
  <a href="/graph">Graph</a>
  <a href="/graph/depth">Depth</a>
  <a class="active" href="/graph/galaxy">Galaxy</a>
  <a href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-nodes">-</span> nodes &middot; <span id="stat-edges">-</span> edges &middot; <span id="stat-hubs">-</span> systems</div>

<button id="animate-btn" title="Animate growth">&#x25B6;</button>
<div id="anim-progress"><span id="anim-date"></span><div id="anim-bar-wrap"><div id="anim-bar"></div></div><span id="anim-speed" title="Click to cycle speed">1x</span></div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Galaxy view</h2>
    <div class="panel-header-actions">
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Filters</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Min mentions <span class="val" id="threshold-val">5</span></div>
        <input type="range" id="threshold" min="1" max="50" value="5" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Galaxy</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Hub min degree <span class="val" id="hub-degree-val">15</span></div>
        <input type="range" id="hub-degree" min="5" max="50" value="15" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Disk flatness <span class="val" id="flatness-val">80</span></div>
        <input type="range" id="flatness" min="0" max="100" value="80" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">System spacing <span class="val" id="spacing-val">5</span></div>
        <input type="range" id="spacing" min="1" max="10" value="5" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Node size <span class="val" id="node-size-val">1.0</span></div>
        <input type="range" id="node-size" min="2" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link opacity <span class="val" id="link-opacity-val">0.3</span></div>
        <input type="range" id="link-opacity" min="1" max="100" value="30" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link gradient <span class="val" id="link-gradient-val">50</span></div>
        <input type="range" id="link-gradient" min="0" max="100" value="50" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Behavior</span></div>
    <div class="section-body">
      <div class="ctrl-toggle">
        <span class="label">Auto-rotate</span>
        <div class="switch on" id="toggle-autorotate"></div>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Rotate speed <span class="val" id="rotate-speed-val">5</span></div>
        <input type="range" id="rotate-speed" min="1" max="20" value="5" />
      </div>
    </div>
  </div>

</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script src="https://unpkg.com/3d-force-graph@1.79.1"></script>
<script>
${panelToggleJs()}
${sharedJs()}
${sparkColorsJs({ bg: [39, 46, 51], minBlend: 0.15, maxBlend: 0.95 })}

let mentionThreshold = 5;
let hubMinDegree = 15;
let diskFlatness = 0.8;
let systemSpacing = 5;
let nodeSizeMult = 1.0;
let linkOpacity = 0.3;
let linkGradient = 0.5;

let allNodes = [], allLinks = [];
let graph;
let gradLinkMat;
let galaxyData = null; // result of classifyNodes + computeRotation

// ─── Hub Detection + Satellite Assignment ────────────────────────

function classifyNodes(filtered, links) {
  // Build adjacency + compute degree
  const adj = new Map();
  const degree = new Map();
  const weightedDegree = new Map();
  for (const n of filtered) {
    adj.set(n.id, []);
    degree.set(n.id, 0);
    weightedDegree.set(n.id, 0);
  }
  for (const l of links) {
    const s = linkId(l.source), t = linkId(l.target);
    if (adj.has(s) && adj.has(t)) {
      adj.get(s).push({ id: t, weight: l.weight || 1 });
      adj.get(t).push({ id: s, weight: l.weight || 1 });
      degree.set(s, (degree.get(s) || 0) + 1);
      degree.set(t, (degree.get(t) || 0) + 1);
      weightedDegree.set(s, (weightedDegree.get(s) || 0) + (l.weight || 1));
      weightedDegree.set(t, (weightedDegree.get(t) || 0) + (l.weight || 1));
    }
  }

  // Normalize values for hub scoring
  let maxDeg = 1, maxBridge = 0.001, maxMentions = 1;
  for (const n of filtered) {
    const d = degree.get(n.id) || 0;
    if (d > maxDeg) maxDeg = d;
    if ((n.bridgeScore || 0) > maxBridge) maxBridge = n.bridgeScore;
    if (n.mentionCount > maxMentions) maxMentions = n.mentionCount;
  }

  // hubScore = 0.5 * norm(degree) + 0.3 * norm(bridgeScore) + 0.2 * norm(mentions)
  const hubScore = new Map();
  for (const n of filtered) {
    const d = (degree.get(n.id) || 0) / maxDeg;
    const b = (n.bridgeScore || 0) / maxBridge;
    const m = n.mentionCount / maxMentions;
    hubScore.set(n.id, 0.5 * d + 0.3 * b + 0.2 * m);
  }

  // Select hubs: nodes with degree >= hubMinDegree, sorted by hubScore, capped at 50
  let hubs = filtered
    .filter(n => (degree.get(n.id) || 0) >= hubMinDegree)
    .sort((a, b) => (hubScore.get(b.id) || 0) - (hubScore.get(a.id) || 0))
    .slice(0, 50);

  const hubSet = new Set(hubs.map(h => h.id));

  // Assign satellites to hubs by affinity
  const hubOf = new Map(); // nodeId -> hubId
  const systemMembers = new Map(); // hubId -> Set<nodeId>
  const bridges = new Set();

  for (const h of hubs) {
    hubOf.set(h.id, h.id);
    systemMembers.set(h.id, new Set([h.id]));
  }

  // Compute affinity of each non-hub node to each hub
  for (const n of filtered) {
    if (hubSet.has(n.id)) continue;
    const neighbors = adj.get(n.id) || [];

    const affinities = new Map(); // hubId -> score
    for (const nb of neighbors) {
      if (hubSet.has(nb.id)) {
        affinities.set(nb.id, (affinities.get(nb.id) || 0) + nb.weight);
      }
    }

    // Add secondary affinity: 0.3 * edges to hub's other satellites
    // (deferred to second pass after initial assignment for efficiency)

    if (affinities.size > 0) {
      let bestHub = null, bestScore = -1, secondScore = 0;
      for (const [hid, score] of affinities) {
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          bestHub = hid;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      hubOf.set(n.id, bestHub);
      systemMembers.get(bestHub).add(n.id);

      // Bridge detection: secondary affinity > 40% of primary
      if (secondScore > bestScore * 0.4) {
        bridges.add(n.id);
      }
    }
  }

  // Fallback: unassigned nodes go to closest hub by community, then largest hub
  const largestHub = hubs.length > 0 ? hubs[0].id : null;
  for (const n of filtered) {
    if (hubOf.has(n.id)) continue;
    // Try community match
    let assigned = false;
    if (n.community) {
      for (const h of hubs) {
        if (h.community === n.community) {
          hubOf.set(n.id, h.id);
          systemMembers.get(h.id).add(n.id);
          assigned = true;
          break;
        }
      }
    }
    if (!assigned && largestHub) {
      hubOf.set(n.id, largestHub);
      systemMembers.get(largestHub).add(n.id);
    }
  }

  // Store degree on nodes
  for (const n of filtered) {
    n.degree = degree.get(n.id) || 0;
    n.isHub = hubSet.has(n.id);
    n.isBridge = bridges.has(n.id);
    n.hubId = hubOf.get(n.id) || null;
  }

  return { hubs, hubOf, bridges, degree, adj, systemMembers, hubSet };
}

// ─── Rotation Assignment ─────────────────────────────────────────

function computeRotation(systemMembers, adj, hubSet, filtered) {
  const nodeMap = new Map();
  for (const n of filtered) nodeMap.set(n.id, n);

  for (const [hubId, members] of systemMembers) {
    const satellites = [...members].filter(id => !hubSet.has(id));
    if (satellites.length === 0) {
      const h = nodeMap.get(hubId);
      if (h) h.diskNormal = { x: 0, y: 1, z: 0 };
      continue;
    }

    // Build intra-system neighbor sets
    const memberSet = new Set(members);
    const intraNeighbors = new Map();
    for (const sid of satellites) {
      const nbs = (adj.get(sid) || []).filter(nb => memberSet.has(nb.id)).map(nb => nb.id);
      intraNeighbors.set(sid, new Set(nbs));
    }

    // Compute pairwise Jaccard similarity
    function jaccard(a, b) {
      const setA = intraNeighbors.get(a) || new Set();
      const setB = intraNeighbors.get(b) || new Set();
      let inter = 0;
      for (const x of setA) if (setB.has(x)) inter++;
      const union = setA.size + setB.size - inter;
      return union === 0 ? 0 : inter / union;
    }

    // Greedy angular placement
    // Sort satellites by intra-system degree (descending)
    const satDegrees = satellites.map(id => ({
      id,
      deg: (intraNeighbors.get(id) || new Set()).size
    })).sort((a, b) => b.deg - a.deg);

    const placed = new Map(); // id -> angle
    const angleStep = (2 * Math.PI) / Math.max(satellites.length, 1);

    // Seed: highest-degree satellite at angle 0
    placed.set(satDegrees[0].id, 0);

    for (let i = 1; i < satDegrees.length; i++) {
      const sid = satDegrees[i].id;
      // Find most similar already-placed neighbor
      let bestSim = -1, bestAngle = 0;
      for (const [pid, pAngle] of placed) {
        const sim = jaccard(sid, pid);
        if (sim > bestSim) {
          bestSim = sim;
          bestAngle = pAngle;
        }
      }
      // Place near most similar, with offset to avoid overlap
      const offset = angleStep * (0.3 + 0.4 * (1 - bestSim));
      const sign = i % 2 === 0 ? 1 : -1;
      placed.set(sid, bestAngle + sign * offset);
    }

    // Store orbital angle on each satellite
    for (const [sid, angle] of placed) {
      const n = nodeMap.get(sid);
      if (n) n.orbitalAngle = angle;
    }

    // Compute per-system disk normal — each system gets a unique orientation
    // derived from a hash of the hubId so it's stable across rebuilds.
    // We want normals spread across the full sphere, not clustered near Y-up.
    const hubNode = nodeMap.get(hubId);

    // Hash hubId into two angles for spherical coordinates
    let h = 0;
    for (let ci = 0; ci < hubId.length; ci++) {
      h = ((h << 5) - h + hubId.charCodeAt(ci)) | 0;
    }
    // Use golden-ratio-based distribution for better spread across hubs
    const hubIndex = [...systemMembers.keys()].indexOf(hubId);
    const goldenAngle = 2.399963; // pi * (3 - sqrt(5))
    const theta = goldenAngle * hubIndex; // azimuthal — spreads evenly around Y
    const phi = Math.acos(1 - 2 * ((Math.abs(h) % 997) / 997)); // polar — uniform on sphere

    const diskNormal = {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta),
    };

    if (hubNode) hubNode.diskNormal = diskNormal;
  }
}

// ─── Gravitation computation ─────────────────────────────────────

function computeGravitation(filtered, links, hubOf, hubSet) {
  // Per satellite: gravitation = sum of edge weights to hub + 0.3 * edges to hub's other satellites
  const nodeMap = new Map();
  for (const n of filtered) nodeMap.set(n.id, n);

  for (const n of filtered) {
    if (hubSet.has(n.id)) {
      n.gravitation = 1.0; // hubs have max gravitation (they ARE the center)
      continue;
    }
    const myHub = hubOf.get(n.id);
    if (!myHub) { n.gravitation = 0.1; continue; }

    let directWeight = 0;
    let satelliteWeight = 0;
    for (const l of links) {
      const s = linkId(l.source), t = linkId(l.target);
      const other = s === n.id ? t : t === n.id ? s : null;
      if (!other) continue;
      if (other === myHub) {
        directWeight += l.weight || 1;
      } else if (hubOf.get(other) === myHub) {
        satelliteWeight += l.weight || 1;
      }
    }
    n.gravitation = directWeight + 0.3 * satelliteWeight;
  }

  // Normalize gravitation
  let maxGrav = 0.001;
  for (const n of filtered) {
    if (!hubSet.has(n.id) && n.gravitation > maxGrav) maxGrav = n.gravitation;
  }
  for (const n of filtered) {
    if (!hubSet.has(n.id)) {
      n.gravitation = n.gravitation / maxGrav;
    }
  }
}

// ─── Filter + Build ──────────────────────────────────────────────

// Classify into hub systems, then compute rotation vectors and gravitation
function classifyGalaxy(filtered, links) {
  galaxyData = classifyNodes(filtered, links);
  computeRotation(galaxyData.systemMembers, galaxyData.adj, galaxyData.hubSet, filtered);
  computeGravitation(filtered, links, galaxyData.hubOf, galaxyData.hubSet);
}

// Colour by degree and update the stats bar; classifyGalaxy must have run for these nodes
function layoutGalaxy(filtered, links) {
  assignEnergy(filtered);

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;
  document.getElementById('stat-hubs').textContent = galaxyData ? galaxyData.hubs.length : 0;

  return { nodes: filtered, links };
}

function filterAndBuild() {
  const nodeSet = new Set();
  const filtered = allNodes.filter(n => {
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  const links = allLinks.filter(l => nodeSet.has(linkId(l.source)) && nodeSet.has(linkId(l.target)));

  classifyGalaxy(filtered, links);
  return layoutGalaxy(filtered, links);
}

// Hub of a link's endpoint, for the intra- vs inter-system distinction
function hubOfEnd(x) { return galaxyData ? galaxyData.hubOf.get(linkId(x)) : null; }
function isIntraSystem(l) { const s = hubOfEnd(l.source); return s && s === hubOfEnd(l.target); }

// ─── Main Initialization ─────────────────────────────────────────

Promise.all([
  fetch('/graph/galaxy/api/graph').then(r => r.json()),
  fetch('/graph/galaxy/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
  mentionThreshold = thresholdData.value;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;

  allNodes = data.nodes;
  allLinks = data.links;

  const graphData = filterAndBuild();

  gradLinkMat = makeGradientLinkMaterial(linkOpacity, linkGradient);

  graph = ForceGraph3D({ controlType: 'orbit' })
    (document.getElementById('graph-3d'))
    .graphData(graphData)
    .backgroundColor('#191d20')
    .nodeThreeObject(node => {
      if (!node.isHub) return undefined;
      const group = new THREE.Group();
      const innerSize = Math.log2((node.degree || 1) + 1) * 2.0 * nodeSizeMult;
      const innerGeo = new THREE.SphereGeometry(innerSize, 16, 12);
      const col = TYPE_COLORS[node.type] || '#495156';
      const innerMat = new THREE.MeshLambertMaterial({ color: col, transparent: false });
      group.add(new THREE.Mesh(innerGeo, innerMat));
      const outerGeo = new THREE.SphereGeometry(innerSize * 1.6, 16, 12);
      const outerMat = new THREE.MeshLambertMaterial({
        color: col,
        transparent: true,
        opacity: 0.15,
      });
      group.add(new THREE.Mesh(outerGeo, outerMat));
      return group;
    })
    .nodeColor(n => sparkNodeColor(n))
    .nodeVal(n => {
      return Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * (n.isHub ? 1.5 : 0.4) * nodeSizeMult);
    })
    .nodeOpacity(0.85)
    .nodeLabel(null)
    // Inter-system links are drawn at half alpha
    .linkThreeObject(l => gradientLinkObject(gradLinkMat, REL_RGB[l.type] || [65,75,80], isIntraSystem(l) ? 1.0 : 0.5))
    .linkPositionUpdate(gradientLinkPositionUpdate)
    .linkWidth(0)
    .linkOpacity(1.0)
    // Force 1: Variable-strength charge — hubs repel strongly to separate systems
    .d3Force('charge', d3.forceManyBody()
      .strength(n => n.isHub ? -400 * systemSpacing : -8)
      .distanceMax(1200)
    )
    // Force 2: Link force — only intra-system links participate in the simulation
    // Inter-system links are rendered visually but have zero force, allowing
    // hub repulsion to separate systems into distinct clusters.
    .d3Force('link', d3.forceLink().id(d => d.id)
      .distance(l => isIntraSystem(l) ? 15 : 300)
      .strength(l => isIntraSystem(l) ? (l.weight || 0.5) * 0.3 : 0.002)
    )
    // Force 6: Gentle centering
    .d3Force('center', d3.forceCenter(0, 0, 0).strength(0.003))
    // Custom forces: hub-repel + hub-attract + disk-flatten + orbital-align
    .d3Force('galaxy-custom', () => {
      if (!galaxyData) return;
      const nodes = graph.graphData().nodes;
      const nodeMap = new Map();
      for (const n of nodes) nodeMap.set(n.id, n);

      // Hub-to-hub repulsion: O(H^2) where H=50, ensures systems separate
      // Uses a minimum-distance threshold so hubs settle at a characteristic spacing
      const hubNodes = galaxyData.hubs.map(h => nodeMap.get(h.id)).filter(h => h && h.x != null);
      const minHubDist = 80 * systemSpacing; // desired minimum separation
      for (let i = 0; i < hubNodes.length; i++) {
        for (let j = i + 1; j < hubNodes.length; j++) {
          const a = hubNodes[i], b = hubNodes[j];
          const dx = (a.x || 0) - (b.x || 0);
          const dy = (a.y || 0) - (b.y || 0);
          const dz = (a.z || 0) - (b.z || 0);
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          if (dist >= minHubDist) continue; // only repel when too close
          // Spring-like push: stronger the closer they are to minDist
          const overlap = 1 - dist / minHubDist;
          const force = overlap * 8 * systemSpacing;
          const fx = dx / dist * force;
          const fy = dy / dist * force;
          const fz = dz / dist * force;
          a.vx = (a.vx || 0) + fx;
          a.vy = (a.vy || 0) + fy;
          a.vz = (a.vz || 0) + fz;
          b.vx = (b.vx || 0) - fx;
          b.vy = (b.vy || 0) - fy;
          b.vz = (b.vz || 0) - fz;
        }
      }

      for (const n of nodes) {
        if (n.isHub || !n.hubId) continue;
        const hub = nodeMap.get(n.hubId);
        if (!hub || hub.x == null) continue;

        // Force 3: Hub attraction — pull satellites toward their hub
        const dx = hub.x - (n.x || 0);
        const dy = hub.y - (n.y || 0);
        const dz = (hub.z || 0) - (n.z || 0);
        const grav = (n.gravitation || 0.1) * 0.15;
        n.vx = (n.vx || 0) + dx * grav;
        n.vy = (n.vy || 0) + dy * grav;
        n.vz = (n.vz || 0) + dz * grav;

        // Force 4: Disk flatten — push satellites toward consensus plane
        // Strength scales with off-plane distance: behaves like a spring
        // pulling nodes back to the disk plane
        if (hub.diskNormal && diskFlatness > 0) {
          const rx = (n.x || 0) - hub.x;
          const ry = (n.y || 0) - hub.y;
          const rz = (n.z || 0) - (hub.z || 0);
          const dn = hub.diskNormal;
          const dot = rx * dn.x + ry * dn.y + rz * dn.z;
          // Strong spring: 0.4 base * flatness, damping the normal-component velocity
          const flatForce = diskFlatness * 0.4;
          n.vx = (n.vx || 0) - dot * dn.x * flatForce;
          n.vy = (n.vy || 0) - dot * dn.y * flatForce;
          n.vz = (n.vz || 0) - dot * dn.z * flatForce;
        }

        // Force 5: Orbital alignment — connected satellites share plane
        if (n.orbitalAngle != null && galaxyData.adj) {
          const neighbors = galaxyData.adj.get(n.id) || [];
          for (const nb of neighbors) {
            const nbNode = nodeMap.get(nb.id);
            if (!nbNode || nbNode.hubId !== n.hubId || nbNode.isHub) continue;
            if (nbNode.orbitalAngle == null) continue;
            // Pull orbital angles toward each other
            const angleDiff = nbNode.orbitalAngle - n.orbitalAngle;
            const pull = Math.sin(angleDiff) * 0.005;
            n.orbitalAngle += pull;
          }
        }

        // Bridge nodes: pull toward weighted midpoint of their top-2 hubs
        if (n.isBridge && galaxyData.hubOf) {
          // Find secondary hub
          const neighbors = galaxyData.adj.get(n.id) || [];
          let secondHub = null, secondWeight = 0;
          for (const nb of neighbors) {
            if (galaxyData.hubSet.has(nb.id) && nb.id !== n.hubId) {
              if (nb.weight > secondWeight) {
                secondWeight = nb.weight;
                secondHub = nb.id;
              }
            }
          }
          if (secondHub) {
            const hub2 = nodeMap.get(secondHub);
            if (hub2 && hub2.x != null) {
              // Pull toward 60/40 weighted midpoint
              const mx = hub.x * 0.6 + hub2.x * 0.4;
              const my = hub.y * 0.6 + hub2.y * 0.4;
              const mz = (hub.z || 0) * 0.6 + (hub2.z || 0) * 0.4;
              n.vx = (n.vx || 0) + (mx - (n.x || 0)) * 0.02;
              n.vy = (n.vy || 0) + (my - (n.y || 0)) * 0.02;
              n.vz = (n.vz || 0) + (mz - (n.z || 0)) * 0.02;
            }
          }
        }
      }
    })
    .onNodeHover(node => {
      document.getElementById('graph-3d').style.cursor = node ? 'pointer' : 'default';
      const tip = document.getElementById('tooltip');
      if (!node) { tip.style.display = 'none'; return; }
      let html = '<div class="name">' + esc(node.name) + '</div>';
      html += '<div class="type">' + node.type + ' &middot; ' + node.mentionCount + ' mentions</div>';
      if (node.description) html += '<div class="desc">' + esc(node.description) + '</div>';
      if (node.community) html += '<div class="community">' + esc(node.community) + '</div>';
      html += '<div class="time">Last active: ' + formatAge(node.lastActive) + '</div>';
      if (node.firstSeen) html += '<div class="time">First seen: ' + formatAge(node.firstSeen) + '</div>';
      if (node.isHub) html += '<div class="time" style="color:#dbbc7f">Hub node (degree: ' + node.degree + ')</div>';
      if (node.hubId && !node.isHub) html += '<div class="time">System: ' + esc(node.hubId.slice(0,20)) + '</div>';
      if (node.orbitalAngle != null) html += '<div class="time">Orbital angle: ' + (node.orbitalAngle * 180 / Math.PI).toFixed(1) + '&deg;</div>';
      if (node.gravitation != null && !node.isHub) html += '<div class="time">Gravitation: ' + node.gravitation.toFixed(2) + '</div>';
      if (node.isBridge) html += '<div class="time" style="color:#a7c080">Bridge node</div>';
      tip.innerHTML = html;
      tip.style.display = 'block';
    })
    .onBackgroundClick(() => {
      document.getElementById('tooltip').style.display = 'none';
    })
    .warmupTicks(120)
    .cooldownTicks(300);

  document.addEventListener('mousemove', (e) => {
    const tip = document.getElementById('tooltip');
    if (tip.style.display === 'block') {
      tip.style.left = (e.clientX + 16) + 'px';
      tip.style.top = (e.clientY - 10) + 'px';
    }
  });

  // Fit camera after simulation settles
  setTimeout(fitCameraToGraph, 3500);

  startDiffPolling('/graph/galaxy', () => {
    graph.graphData(filterAndBuild());
    refreshSparkColors(1500);
  });
});

// ─── Settings Controls ───────────────────────────────────────────

document.getElementById('threshold').addEventListener('input', (e) => {
  mentionThreshold = parseInt(e.target.value, 10);
  document.getElementById('threshold-val').textContent = mentionThreshold;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('hub-degree').addEventListener('input', (e) => {
  hubMinDegree = parseInt(e.target.value, 10);
  document.getElementById('hub-degree-val').textContent = hubMinDegree;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('flatness').addEventListener('input', (e) => {
  diskFlatness = parseInt(e.target.value, 10) / 100;
  document.getElementById('flatness-val').textContent = parseInt(e.target.value, 10);
  if (graph) graph.d3ReheatSimulation();
});

document.getElementById('spacing').addEventListener('input', (e) => {
  systemSpacing = parseInt(e.target.value, 10);
  document.getElementById('spacing-val').textContent = systemSpacing;
  if (graph) {
    graph.d3Force('charge').strength(n => n.isHub ? -400 * systemSpacing : -8);
    graph.d3ReheatSimulation();
  }
});

document.getElementById('node-size').addEventListener('input', (e) => {
  nodeSizeMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);
  if (graph) {
    graph.nodeVal(n => {
      if (n.isHub) return 0;
      return Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult);
    });
  }
});

document.getElementById('link-opacity').addEventListener('input', (e) => {
  linkOpacity = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-opacity-val').textContent = linkOpacity.toFixed(2);
  gradLinkMat.uniforms.uOpacity.value = linkOpacity;
});

document.getElementById('link-gradient').addEventListener('input', (e) => {
  linkGradient = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-gradient-val').textContent = e.target.value;
  gradLinkMat.uniforms.uGradient.value = linkGradient;
});

${diffPollingJs()}
${threeHelpersJs()}
${growthAnimationJs()}

// Reclassifying hub systems is expensive, so the animation does it every 30
// nodes, every 500 ms, or on the final frame.
let animLastClassify = 0;
let animLastClassifyTime = 0;

setupGrowthAnimation(
  (nodes, links) => {
    if (nodes.length === 0) { animLastClassify = 0; animLastClassifyTime = 0; }
    const now = performance.now();
    const shouldClassify = nodes.length > 0 && links.length > 0 &&
      (nodes.length - animLastClassify >= 30 || now - animLastClassifyTime > 500 || nodes.length === animNodeOrder.length);
    if (shouldClassify) {
      classifyGalaxy(nodes, links);
      animLastClassify = nodes.length;
      animLastClassifyTime = now;
    }
    graph.graphData(layoutGalaxy(nodes, links));
    refreshSparkColors(1200);
  },
  () => graph.graphData(filterAndBuild()),
);
</script>
</body>
</html>`;
}
