// terrainmath — the terrain height law as owned numerics (Covenant I): the toolkit's makeTerrain (mulberry32 → 64² value
// noise → fBm → flat-radius blend) with Math.pow → repeated halving and Math.hypot → sqrt. Every SIM consumer uses this;
// the client mesh uses the toolkit's (agrees to ~1 ulp). THE CONSTANTS AND EVALUATION ORDER ARE THE VERSION (Covenant II):
// moving a conformance digest (tools/protocol/engine-check.ts) is a new engine version, never a patch.

import { shapeParams, shapeHeight } from './terrainshape.js';

/** Canonical parameters with the TOOLKIT's own defaults: the sim must assume exactly what the mesh builder assumes.
 *  @param {Record<string, unknown>} a */
export function terrainParams(a) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const shape = shapeParams(a);
  return {
    ...(shape ? { shape } : {}),
    size: num(a?.size, 80),
    amplitude: num(a?.amplitude, 3),
    seed: Number.isFinite(a?.seed) ? Math.trunc(/** @type {number} */(a.seed)) : 1,
    flatRadius: num(a?.flatRadius, 0),
    flatHeight: num(a?.flatHeight, 0),
    octaves: Math.max(1, Math.min(8, Math.trunc(num(a?.octaves, 4)))),
    frequency: num(a?.frequency, 2.5),
  };
}

/** Pure of everything but its params; the grid build is integer-hash exact.
 *  @param {ReturnType<typeof terrainParams>} P
 *  @returns {(x: number, z: number) => number} */
export function makeHeightField(P) {
  // integer ops only, bit-exact on every engine
  let s = (P.seed | 0) || 1;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const GS = 64;
  // Float32Array rounds exactly per IEEE, as the toolkit's does: the grids are bit-identical
  const grid = new Float32Array(GS * GS);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const lerp = (a, b, t) => a + (b - a) * t;
  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const g = (X, Y) => grid[((Y % GS + GS) % GS) * GS + ((X % GS + GS) % GS)];
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    return lerp(lerp(g(xi, yi), g(xi + 1, yi), sm(xf)),
      lerp(g(xi, yi + 1), g(xi + 1, yi + 1), sm(xf)), sm(yf));
  };
  // 1 - 0.5^octaves, accumulated by exact halving (no Math.pow)
  let norm = 1, half = 1;
  for (let o = 0; o < P.octaves; o++) { half *= 0.5; }
  norm = 1 - half;
  const fbm = (x, y) => {
    let v = 0, a = 0.5, f = 1;
    for (let o = 0; o < P.octaves; o++) { v += a * vnoise(x * f, y * f); a *= 0.5; f *= 2; }
    return v / norm;
  };
  const { size, amplitude, frequency, flatRadius, flatHeight } = P;
  const base = (x, z) => {
    const u = (x / size + 0.5) * frequency, v = (z / size + 0.5) * frequency;
    let h = (fbm(u, v) - 0.5) * 2 * amplitude;
    if (flatRadius > 0) {
      const d = Math.sqrt(x * x + z * z);          // not hypot: see header
      const k = sm((d - flatRadius) / Math.max(0.001, flatRadius * 0.6));
      h = lerp(flatHeight, h, k);
    }
    return h;
  };
  return P.shape ? shapeHeight(base, P.shape, size) : base;
}
