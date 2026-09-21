/**
 * Spark colour system shared by the graph, depth, galaxy and terminal depth
 * pages. Defines TYPE_COLORS / TYPE_RGB / REL_RGB for the page's script and the
 * energy-blend + spark-fade colour functions.
 */

import { TYPE_COLORS, REL_COLORS, hexToRgb } from './theme.js';

export interface SparkColorOptions {
  /** Page background the resting colour is blended toward. */
  bg: [number, number, number];
  /** Share of the type colour kept at energy 0 (isolated node) and energy 1 (hub). */
  minBlend: number;
  maxBlend: number;
}

export function sparkColorsJs(opts: SparkColorOptions): string {
  const typeRgb = Object.fromEntries(Object.entries(TYPE_COLORS).map(([k, hex]) => [k, hexToRgb(hex)]));
  const relRgb = Object.fromEntries(Object.entries(REL_COLORS).map(([k, hex]) => [k, hexToRgb(hex)]));
  return `
// ─── Spark colour system ─────────────────────────────────────────
// A node rests at its type colour blended toward the page background; the
// blend grows with node.energy (0..1, degree-based). A sparked node
// (node.lastSpark) flashes to full brightness and fades back over FADE_DURATION.
const TYPE_COLORS = ${JSON.stringify(TYPE_COLORS)};
const TYPE_RGB = ${JSON.stringify(typeRgb)};
const REL_RGB = ${JSON.stringify(relRgb)};
const BG_RGB = ${JSON.stringify(opts.bg)};
const FADE_DURATION = 60000;
const MIN_ENERGY_BLEND = ${opts.minBlend};
const MAX_ENERGY_BLEND = ${opts.maxBlend};

function typeRgb(type) { return TYPE_RGB[type] || [136, 136, 136]; }

function restingColor(type, energy) {
  const bright = typeRgb(type);
  const blend = MIN_ENERGY_BLEND + (MAX_ENERGY_BLEND - MIN_ENERGY_BLEND) * (energy || 0);
  return bright.map((c, i) => Math.round(c * blend + BG_RGB[i] * (1 - blend)));
}

function sparkNodeColor(node) {
  const resting = restingColor(node.type, node.energy);
  const bright = typeRgb(node.type);
  const age = node.lastSpark ? Date.now() - node.lastSpark : FADE_DURATION;
  const t = Math.min(age / FADE_DURATION, 1);
  return 'rgb(' + resting.map((c, i) => Math.round(bright[i] + (c - bright[i]) * t)).join(',') + ')';
}

// Log-scaled energy from node.degree: 0 connections → 0, the best-connected node → 1
function assignEnergy(nodes) {
  let maxDeg = 1;
  for (const n of nodes) if ((n.degree || 0) > maxDeg) maxDeg = n.degree;
  for (const n of nodes) n.energy = Math.log2((n.degree || 0) + 1) / Math.log2(maxDeg + 1);
}
`;
}
