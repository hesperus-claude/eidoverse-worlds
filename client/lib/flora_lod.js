// flora_lod — far-LOD index subsets over the SHARED vertex buffers of tiled 'blades' strokes, DOM-free (tools/flora.test.ts). §17b.
// The layout is re-verified at runtime: vegetation.js skew degrades to null (no LOD), never a torn tuft.

export const BLADE_VERTS = 10;    // (LOOPS+1) × 2 — vegetation.js LOOPS = 4
export const BLADE_INDICES = 24;  // LOOPS × 6

/** Far-LOD index subset: keep ceil(blades × keep) whole blades, strided across the tuft (every kth, NOT the first k:
 *  construction order scatters blades radially). Null when the geometry isn't blade-shaped or nothing would drop. */
export function bladeLodIndex(index, vertexCount, keep) {
  if (!index || !(keep > 0) || keep >= 1) return null;
  const blades = index.length / BLADE_INDICES;
  if (!Number.isInteger(blades) || blades < 2) return null;
  if (vertexCount !== blades * BLADE_VERTS) return null;
  for (let b = 0; b < blades; b++) {          // whole-blade contiguity proof
    const lo = b * BLADE_VERTS, hi = lo + BLADE_VERTS;
    for (let e = b * BLADE_INDICES; e < (b + 1) * BLADE_INDICES; e++) {
      const v = index[e];
      if (v < lo || v >= hi) return null;     // cross-blade reference: not our layout
    }
  }
  const kept = Math.ceil(blades * keep);
  if (kept >= blades) return null;            // nothing to save
  const out = new index.constructor(kept * BLADE_INDICES);
  for (let i = 0; i < kept; i++) {
    const b = Math.floor((i * blades) / kept);    // even stride across the tuft
    const s = b * BLADE_INDICES, d = i * BLADE_INDICES;
    for (let e = 0; e < BLADE_INDICES; e++) out[d + e] = index[s + e];
  }
  return out;
}

// §22n vertex LOD: keeps EVERY blade (no count pop, §22d) but spans quads across loops 0→2→4: 12 entries over 6 of
// 10 verts. An index subset never renumbers vertices, so the §22h dither's bladeId (vertexIndex / 10) still holds.
export const BLADE_COARSE_INDICES = 12;   // 2 quads: loops 0→2→4
const COARSE_QUADS = [0, 1, 4, 1, 5, 4, 4, 5, 8, 5, 9, 8];  // original winding, loops skipped

/** Coarse far index: every blade at 2 segments instead of 4; skew degrades to null, as in bladeLodIndex. */
export function bladeCoarseIndex(index, vertexCount) {
  if (!index) return null;
  const blades = index.length / BLADE_INDICES;
  if (!Number.isInteger(blades) || blades < 1) return null;
  if (vertexCount !== blades * BLADE_VERTS) return null;
  for (let b = 0; b < blades; b++) {          // whole-blade contiguity proof
    const lo = b * BLADE_VERTS, hi = lo + BLADE_VERTS;
    for (let e = b * BLADE_INDICES; e < (b + 1) * BLADE_INDICES; e++) {
      const v = index[e];
      if (v < lo || v >= hi) return null;     // cross-blade reference: not our layout
    }
  }
  const out = new index.constructor(blades * BLADE_COARSE_INDICES);
  for (let b = 0; b < blades; b++) {
    const base = b * BLADE_VERTS, d = b * BLADE_COARSE_INDICES;
    for (let e = 0; e < BLADE_COARSE_INDICES; e++) out[d + e] = base + COARSE_QUADS[e];
  }
  return out;
}
