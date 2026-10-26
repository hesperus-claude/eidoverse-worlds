// lod_policy — which geometry tier a placement fetches, decided BEFORE the fetch, from three local inputs:
//   the resident's dial   models⚙ auto / full / eco; persisted per browser, never a verb
//   the distance          from the eye vs the entity's residency radius (shared/lod-distance.js)
//   device pressure       GPU memory vs budget (assets.js gpuPressure) and the governor's shed
// No published recipe on /version (shared/ktx2.js lodFromVersion) → never asks 'lod'; a lod answer is never a worse
// model; colliders/support/raycast never read the reduced mesh (models.js).
// Hysteresis: the upgrade edge sits inside the downgrade edge by LOD_HYST on each side.
// DOM-free and side-effect-free: tools/lod-policy-test.ts.

import { negotiate, withLod } from '../../shared/ktx2.js';

export const MODEL_QUALITY = ['auto', 'full', 'eco'];
// the distance geometry is shared with the server's LOD budget (shared/lod-distance.js)
export { LOD_FRACTION, LOD_HYST } from '../../shared/lod-distance.js';
import { LOD_FRACTION, LOD_HYST } from '../../shared/lod-distance.js';
/** Under pressure — and on the 'eco' dial — the edge halves: reduced
 *  tiers come in much closer, but never to arm's length. */
export const PRESSURE_EDGE = 0.5;
/** GPU memory / proto budget at which the policy calls it pressure. */
export const PRESSURE_AT = 0.8;
/** Metres inside which EVERY placement is full detail, on every dial and at every scale: a lod-tier placement owns no
 *  collider, no support surface (models.js), and what is in reach must have them. The unscaled radius never came this
 *  close (R ≥ 80m → an eco upgrade edge of 13.5m); a scaled-down placement would — a 0.1× rack at 4m. */
export const LOD_NEAR_MIN = 10;

const KEY = 'ew-model-quality';

/** The dial state. `store` is localStorage in the browser, anything with
 *  getItem/setItem in tests, or absent (state then lives for the session). */
export function makeModelQuality(store) {
  const saved = store?.getItem?.(KEY);
  let quality = MODEL_QUALITY.includes(saved) ? saved : 'auto';
  let shed = false;   // the governor's session dial — never persisted
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

/** The tier to fetch for a placement. `dist` m from the eye; `recipe` null → never negotiate; `pressure` gpu memory /
 *  budget (0..∞); `current` for hysteresis. `scale` s moves the LOD edge by exactly s (the server's 2 px budget is for
 *  the unscaled model; floor LOD_NEAR_MIN); a non-positive or non-finite scale reads as 1. */
export function chooseTier({ dist, radius, quality = 'auto', recipe = null, pressure = 0, shed = false, current = null, scale = 1 }) {
  if (!recipe || quality === 'full') return 'full';
  // 'eco' halves the edge but never reduces what you stand beside (near girders become slabs across the camera).
  // Near stays full on every dial; only 'full' ignores distance.
  const squeezed = quality === 'eco' || pressure >= PRESSURE_AT || shed;
  const n = Number(scale), s = Number.isFinite(n) && n > 0 ? n : 1;
  const edge = Math.max((radius > 0 ? radius : 80) * LOD_FRACTION * (squeezed ? PRESSURE_EDGE : 1) * s,
    LOD_NEAR_MIN / (1 - LOD_HYST));   // the UPGRADE edge, edge × (1 − H), never inside LOD_NEAR_MIN
  if (current === 'lod') return dist < edge * (1 - LOD_HYST) ? 'full' : 'lod';
  if (current === 'full') return dist > edge * (1 + LOD_HYST) ? 'lod' : 'full';
  return dist > edge ? 'lod' : 'full';
}

/** Which tier a parsed GLB is, from the reducer's stamp (asset.extras {lodOf, recipe}, #156): lod only if lodOf is
 *  present AND recipe equals the running one; anything else is 'full' (an authored `recipe` extra must not strip a
 *  source model of its collider). */
export function tierOf(gltfJson, recipe) {
  const x = gltfJson?.asset?.extras;
  if (!recipe || !x || typeof x !== 'object') return 'full';
  return typeof x.lodOf === 'string' && x.lodOf.length > 0 && x.recipe === recipe ? 'lod' : 'full';
}

/** The wire truth of a tier choice: the URL fetched and the tier it asks for. A lod ask rides KTX2 negotiation, so no
 *  transcoder, no key/recipe or a non-.glb path means 'full' and no `lod=`. The realizer keys hysteresis on THIS. */
export function askFor({ libPath, key = null, capable = false, recipe = null, tier = 'full' }) {
  const glb = typeof libPath === 'string' && libPath.endsWith('.glb');
  const k = glb && capable && key ? key : null;
  const url = negotiate(libPath, k);
  if (tier === 'lod' && k && recipe) return { url: withLod(url, recipe), tier: 'lod' };
  return { url, tier: 'full' };
}
