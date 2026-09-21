/**
 * Three.js helpers shared by the depth and galaxy pages: the gradient link
 * shader, camera fit after settle, turntable auto-rotation and spark colour
 * refresh. All of them operate on the page's `graph` (a ForceGraph3D instance)
 * and `sparkNodeColor` from spark-colors.ts.
 */

export function threeHelpersJs(): string {
  return `
// ─── Gradient link lines ─────────────────────────────────────────
// One ShaderMaterial shared by every link: bright at the endpoints, dim in the
// middle (uGradient), scaled by uOpacity and a per-link dimFactor attribute.
function makeGradientLinkMaterial(opacity, gradient) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: opacity }, uGradient: { value: gradient } },
    vertexShader: [
      'attribute float t;',
      'attribute vec3 vColor;',
      'attribute float dimFactor;',
      'varying float vT;',
      'varying vec3 fColor;',
      'varying float vDim;',
      'void main() {',
      '  vT = t; fColor = vColor; vDim = dimFactor;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\\n'),
    fragmentShader: [
      'uniform float uOpacity;',
      'uniform float uGradient;',
      'varying float vT;',
      'varying vec3 fColor;',
      'varying float vDim;',
      'void main() {',
      '  float fz = (1.0 - uGradient) * 0.5;',
      '  float dim = uGradient * uGradient;',
      '  float a;',
      '  if (fz < 0.001) { a = 1.0; }',
      '  else if (vT < fz) { a = mix(1.0, dim, vT / fz); }',
      '  else if (vT > 1.0 - fz) { a = mix(dim, 1.0, (vT - (1.0 - fz)) / fz); }',
      '  else { a = dim; }',
      '  a *= min(uGradient * 3.0, 1.0);',
      '  gl_FragColor = vec4(fColor, a * uOpacity * vDim);',
      '}',
    ].join('\\n'),
  });
}

// A 10-segment line for one link; rgb is [r, g, b] 0..255, dim multiplies its alpha.
function gradientLinkObject(material, rgb, dim) {
  const SEGS = 10;
  const pts = SEGS + 1;
  const tAttr = new Float32Array(pts);
  const colorAttr = new Float32Array(pts * 3);
  const dimAttr = new Float32Array(pts);
  for (let i = 0; i < pts; i++) {
    tAttr[i] = i / SEGS;
    colorAttr[i*3]   = rgb[0] / 255;
    colorAttr[i*3+1] = rgb[1] / 255;
    colorAttr[i*3+2] = rgb[2] / 255;
    dimAttr[i] = dim;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts * 3), 3));
  geo.setAttribute('t', new THREE.BufferAttribute(tAttr, 1));
  geo.setAttribute('vColor', new THREE.BufferAttribute(colorAttr, 3));
  geo.setAttribute('dimFactor', new THREE.BufferAttribute(dimAttr, 1));
  const line = new THREE.Line(geo, material);
  line.renderOrder = -1;
  return line;
}

function gradientLinkPositionUpdate(obj, { start, end }) {
  const pos = obj.geometry.attributes.position;
  const arr = pos.array;
  const segs = (arr.length / 3) - 1;
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    arr[i*3]   = start.x + (end.x - start.x) * f;
    arr[i*3+1] = start.y + (end.y - start.y) * f;
    arr[i*3+2] = start.z + (end.z - start.z) * f;
  }
  pos.needsUpdate = true;
  return true;
}

// ─── Camera fit ──────────────────────────────────────────────────
// Move the camera to see the full extent of the visible nodes.
function fitCameraToGraph() {
  const gd = graph.graphData();
  if (!gd.nodes.length) return;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const n of gd.nodes) {
    if (n.x == null) continue;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    const z = n.z || 0;
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const maxSpan = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
  // Distance needed to see the full extent (rough FOV estimate ~60deg)
  const dist = maxSpan * 1.2;

  graph.cameraPosition(
    { x: cx, y: cy - dist * 0.3, z: cz + dist },
    { x: cx, y: cy, z: cz },
    1500
  );
}

// ─── Spark colour refresh ────────────────────────────────────────
// Re-evaluate node colours now and again once the spark glow has faded a bit.
function refreshSparkColors(delay) {
  graph.nodeColor(n => sparkNodeColor(n));
  setTimeout(() => { if (graph) graph.nodeColor(n => sparkNodeColor(n)); }, delay);
}

// ─── Turntable rotation ──────────────────────────────────────────
// Orbit the camera around the node centroid; pauses while the user drags and
// resumes 5 s after they let go. Controlled by #toggle-autorotate / #rotate-speed.
let autoRotateEnabled = true;
let autoRotateSpeed = 5; // degrees per second
let turntablePaused = false;
let idleTimer = null;
let lastTurntableTime = 0;

function getCentroid() {
  const gd = graph ? graph.graphData() : null;
  if (!gd || !gd.nodes.length) return { x: 0, y: 0, z: 0 };
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const n of gd.nodes) {
    if (n.x != null) { cx += n.x; cy += n.y; cz += n.z || 0; count++; }
  }
  if (count === 0) return { x: 0, y: 0, z: 0 };
  return { x: cx / count, y: cy / count, z: cz / count };
}

function turntableTick(now) {
  if (!graph || !autoRotateEnabled || turntablePaused) {
    lastTurntableTime = now;
    requestAnimationFrame(turntableTick);
    return;
  }

  if (!lastTurntableTime) lastTurntableTime = now;
  const dt = (now - lastTurntableTime) / 1000; // seconds
  lastTurntableTime = now;

  const cam = graph.cameraPosition();
  const center = getCentroid();

  // Vector from centroid to camera, in the XZ plane
  const dx = cam.x - center.x;
  const dz = (cam.z || 0) - center.z;
  const radius = Math.sqrt(dx * dx + dz * dz);

  if (radius > 0.1) {
    const newAngle = Math.atan2(dz, dx) + autoRotateSpeed * dt * (Math.PI / 180);
    graph.cameraPosition({
      x: center.x + radius * Math.cos(newAngle),
      y: cam.y, // keep Y (height) unchanged
      z: center.z + radius * Math.sin(newAngle),
    });
  }

  requestAnimationFrame(turntableTick);
}

setTimeout(() => {
  if (!graph) return;

  // Pause on user interaction, resume after 5s idle
  const controls = graph.controls();
  if (controls) {
    controls.addEventListener('start', () => {
      turntablePaused = true;
      if (idleTimer) clearTimeout(idleTimer);
    });
    controls.addEventListener('end', () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { turntablePaused = false; }, 5000);
    });
  }

  requestAnimationFrame(turntableTick);
}, 500);

document.getElementById('toggle-autorotate').addEventListener('click', function() {
  this.classList.toggle('on');
  autoRotateEnabled = this.classList.contains('on');
});

document.getElementById('rotate-speed').addEventListener('input', (e) => {
  autoRotateSpeed = parseInt(e.target.value, 10);
  document.getElementById('rotate-speed-val').textContent = autoRotateSpeed;
});
`;
}
