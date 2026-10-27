// buoyancy — how a body floats on the water surface (shared/waves.js): the same law per body or per part.
// A body is a COLUMN of height H floating at rest with SWIM_AT·H under water (chest at the surface). Buoyancy ∝ submerged,
// gravity pulls, drag damps the vertical (ζ ≈ 0.6): a long swell lifts it nearly fully, a short steep wave climbs it first.
// The surface is averaged over the body's footprint, not a point, so chop averages out instead of jolting it.

import { SWIM_AT } from './terrainshape.js';

const G = 9.8;
export const FLOAT_ZETA = 0.6;      // damping ratio: settles in about one rise, without a long ring
export const FOOTPRINT = 0.35;      // metres: the surface is averaged over the body's own width

/** `surfaceAt(x, z)` is the surface there. */
export function footprintSurface(surfaceAt, x, z, r = FOOTPRINT) {
  return (surfaceAt(x, z) * 2 + surfaceAt(x + r, z) + surfaceAt(x - r, z) + surfaceAt(x, z + r) + surfaceAt(x, z - r)) / 6;
}

/** `s` is {y, vy}, y the column's foot, under a surface at `surfaceY`, body height `H`; `floor` keeps it off the bed. Mutates
 *  and returns `s`. Substepped, so a 10 Hz agent tick and a 60 Hz browser frame trace the same motion. */
export function floatStep(s, surfaceY, H, dt, floor = -Infinity) {
  const sub0 = SWIM_AT * H;
  const c = 2 * FLOAT_ZETA * Math.sqrt(G / sub0);
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const sub = Math.min(H, Math.max(0, surfaceY - s.y));
    const a = G * (sub / sub0 - 1) - c * s.vy;
    s.vy += a * h;
    s.y += s.vy * h;
    if (s.y < floor) { s.y = floor; if (s.vy < 0) s.vy = 0; }
  }
  return s;
}

// ---- floating bodies, part by part ------------------------------------------------
// a ragdoll (client/lib/ammodoll.js) floats by the same law per part, PART_FLOAT submerged at rest, dragged toward the
// water's own motion so it drifts with a current and is pushed ashore by surf

export const PART_FLOAT = 0.82;
export const WATER_DRAG = 2.0;       // 1/s, on what is under water, relative to the water's motion
export const WATER_DRAG2 = 1.6;      // 1/m: quadratic, so a body dropping in fast stops within half a metre
export const WATER_ANG_DRAG = 3.0;   // 1/s, on spin

/** m/s, where `w` (a shared/waterkind.js sample) was taken: a river's flow; the sea's drift shoreward, strongest in the surf; still water none. */
export function waterCurrent(w) {
  if (!w) return [0, 0];
  if (w.kind === 'river' && w.flow) return [w.flow[0] * w.speed, w.flow[1] * w.speed];
  if (w.kind === 'ocean' && w.toShore) {
    const surf = 1 - Math.min(1, Math.max(0, w.depth / 2.5));
    const k = 0.12 + 0.38 * surf * surf * (3 - 2 * surf);
    return [w.toShore[0] * k, w.toShore[1] * k];
  }
  return [0, 0];
}

/** Water force on one floating part, excluding gravity: `mass` kg, centre at `y`, extent `r` (m either side), velocity `v`
 *  [x,y,z], under `surface`. The water moves at `current` [x, z, y?] (the optional third is the swell's rise and fall); drag is
 *  linear plus quadratic in the RELATIVE velocity. Writes newtons into `out` [x,y,z]; → the submerged share (0 when clear). */
export function partWaterForce(mass, y, r, v, surface, current, out) {
  const sub = Math.min(1, Math.max(0, (surface - (y - r)) / (2 * r)));
  if (sub <= 0) { out[0] = out[1] = out[2] = 0; return 0; }
  const rx = v[0] - current[0], ry = v[1] - (current[2] ?? 0), rz = v[2] - current[1];
  const d = mass * sub * (WATER_DRAG + WATER_DRAG2 * Math.hypot(rx, ry, rz));
  out[0] = -d * rx;
  out[1] = mass * G * sub / PART_FLOAT - d * ry;
  out[2] = -d * rz;
  return sub;
}

/** The surface's own rise rate fading as e^(−k·below) (orbits shrink with depth). `eta(t)` is the surface offset at the point. */
export function swellRise(eta, t, below, k = 0.2) {
  const dt = 0.05;
  return ((eta(t + dt) - eta(t - dt)) / (2 * dt)) * Math.exp(-k * Math.max(0, below));
}
