// A thing that has just arrived grows into place instead of popping (wishlist "Pretty loading for assets", R 09-27:
// "a placeholder that reads as 'coming', then a fade/materialise"). The grow is a scale ease from nothing to the
// thing's own scale over GROW_MS, driven from the frame loop: no material is touched (a fade would need transparency on
// every mesh, which re-sorts opaque geometry and clones shared materials). A tier swap of a thing already on screen does
// not grow again; only a FIRST appearance does. Scale is restored exactly at the end, so a scale set during the grow (an
// edit, a motion) wins: the grow reads the target at every frame and writes only the eased fraction of it.
const GROW_MS = 450;
const growing = new Map();   // obj -> { t0, target: Vector3 (the scale it will wear) }
const easeOut = (x) => 1 - (1 - x) * (1 - x) * (1 - x);

/** Start a grow on an object just added to the scene. Idempotent per object. */
export function materialise(obj, now = performance.now()) {
  if (!obj || growing.has(obj)) return;
  growing.set(obj, { t0: now, target: obj.scale.clone() });
  obj.scale.setScalar(0.001);   // never exactly 0: a zero matrix breaks raycasts and bounds
}

/** One frame of every grow in flight; the last frame writes the target exactly and forgets the object. */
export function drainMaterialise(now = performance.now()) {
  for (const [obj, g] of growing) {
    if (!obj.parent) { growing.delete(obj); continue; }   // removed before it finished: nothing to restore
    const k = Math.min(1, (now - g.t0) / GROW_MS);
    if (k >= 1) { obj.scale.copy(g.target); growing.delete(obj); continue; }
    obj.scale.copy(g.target).multiplyScalar(Math.max(0.001, easeOut(k)));
  }
}

/** True while obj is still growing (tests, and anything that must not read a mid-grow scale as the thing's own). */
export const isGrowing = (obj) => growing.has(obj);

/** Set the scale a growing object will end at (an edit landed mid-grow). */
export function retarget(obj, scale) { const g = growing.get(obj); if (g) g.target.copy(scale); }
