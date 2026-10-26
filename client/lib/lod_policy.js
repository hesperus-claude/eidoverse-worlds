// lod_policy — which geometry tier a placement fetches, decided BEFORE the fetch, from three local inputs:
//   the resident's dial   models⚙ auto / full / eco; persisted per browser, never a verb
//   the distance          from the eye vs the entity's residency radius (shared/lod-distance.js)
//   device pressure       GPU memory vs budget (assets.js gpuPressure) and the governor's shed
// No published recipe on /version → never asks 'lod'; colliders/support/raycast never read the reduced mesh.
// Hysteresis: the upgrade edge sits inside the downgrade edge by LOD_HYST on each side. Pure: tools/lod-policy-test.ts.

import { negotiate, withLod } from '../../shared/ktx2.js';

export const MODEL_QUALITY = ['auto', 'full', 'eco'];
export { LOD_FRACTION, LOD_HYST } from '../../shared/lod-distance.js';
import { LOD_FRACTION, LOD_HYST } from '../../shared/lod-distance.js';
/** Under pressure, and on 'eco', the edge halves (never to arm's length: LOD_NEAR_MIN). */
export const PRESSURE_EDGE = 0.5;
/** GPU memory / proto budget. */
export const PRESSURE_AT = 0.8;
/** Metres inside which EVERY placement is full detail, on every dial and scale: a lod tier owns no collider or
 *  support surface, and what is in reach must have them (a 0.1× rack would otherwise reduce at 4 m). */
export const LOD_NEAR_MIN = 10;

const KEY = 'ew-model-quality';

/** `store`: anything with getItem/setItem, or absent (session-only). */
export function makeModelQuality(store) {
  const saved = store?.getItem?.(KEY);
  let quality = MODEL_QUALITY.includes(saved) ? saved : 'auto';
  let shed = false;   // the governor's: never persisted
  return {
    get quality() { return quality; },
    get shed() { return shed; },
    setQuality(q) {
      if (!MODEL_QUALITY.includes(q)) return quality;
      quality = q;
      store?.setItem?.(KEY, q);
      return quality;
    },
    setShed(v) { shed = !!v; return shed; },
  };
}

/** `dist` m from the eye; `pressure` gpu memory / budget (0..∞); `current` for hysteresis. `scale` s moves the edge by
 *  exactly s (the server's budget is for the unscaled model); a non-positive or non-finite scale reads as 1. */
export function chooseTier({ dist, radius, quality = 'auto', recipe = null, pressure = 0, shed = false, current = null, scale = 1 }) {
  if (!recipe || quality === 'full') return 'full';
  // never reduce what you stand beside (near girders become slabs across the camera)
  const squeezed = quality === 'eco' || pressure >= PRESSURE_AT || shed;
  const n = Number(scale), s = Number.isFinite(n) && n > 0 ? n : 1;
  const edge = Math.max((radius > 0 ? radius : 80) * LOD_FRACTION * (squeezed ? PRESSURE_EDGE : 1) * s,
    LOD_NEAR_MIN / (1 - LOD_HYST));   // the UPGRADE edge (edge × (1 − H)) never inside LOD_NEAR_MIN
  if (current === 'lod') return dist < edge * (1 - LOD_HYST) ? 'full' : 'lod';
  if (current === 'full') return dist > edge * (1 + LOD_HYST) ? 'lod' : 'full';
  return dist > edge ? 'lod' : 'full';
}

/** From the reducer's stamp (asset.extras, #156): lod only with lodOf AND the running recipe; anything else is 'full'
 *  (an authored `recipe` extra must not strip a source model of its collider). */
export function tierOf(gltfJson, recipe) {
  const x = gltfJson?.asset?.extras;
  if (!recipe || !x || typeof x !== 'object') return 'full';
  return typeof x.lodOf === 'string' && x.lodOf.length > 0 && x.recipe === recipe ? 'lod' : 'full';
}

/** What is actually asked: a lod ask needs KTX2 negotiation, so no transcoder, key/recipe or .glb means 'full'. The
 *  realizer keys hysteresis on THIS. */
export function askFor({ libPath, key = null, capable = false, recipe = null, tier = 'full' }) {
  const glb = typeof libPath === 'string' && libPath.endsWith('.glb');
  const k = glb && capable && key ? key : null;
  const url = negotiate(libPath, k);
  if (tier === 'lod' && k && recipe) return { url: withLod(url, recipe), tier: 'lod' };
  return { url, tier: 'full' };
}
