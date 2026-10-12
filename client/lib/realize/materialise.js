// A thing that has just arrived grows into place instead of popping (wishlist "Pretty loading for assets", R 09-27:
// "a placeholder that reads as 'coming', then a fade/materialise"). The grow is a scale ease from nothing to the
// thing's own scale over GROW_MS — and it exists ONLY DURING THE DRAW: beginDraw() writes the eased scale right before
// renderer.render, endDraw() restores the true scale right after. Every other reader of obj.scale (colliders bucketed by
// size, refitCollider, scene.attach of children, the tumble arm, the grass mask, the scenegraph, riders through a
// parent's matrixWorld) sees the thing at its real size all frame; the review of the first version (10-12) found all of
// those caching a 0.001 scale for good. No material is touched: a fade would need transparency on every mesh, which
// re-sorts opaque geometry and clones shared materials. Only a FIRST appearance grows; a tier swap or a promote of a
// thing already drawn keeps its size.
const GROW_MS = 450;
const growing = new Map();   // obj -> { t0, saved: Vector3|null (the true scale, held across one draw) }
const easeOut = (x) => 1 - (1 - x) * (1 - x) * (1 - x);

/** Start a grow on an object just added to the scene. Idempotent per object; writes nothing. */
export function materialise(obj, now = performance.now()) {
  if (!obj || growing.has(obj)) return;
  growing.set(obj, { t0: now, saved: null });
}

/** Right before the draw: wear the eased scale. Grows that have finished (or whose object left the scene) are forgotten. */
export function beginDraw(now = performance.now()) {
  for (const [obj, g] of growing) {
    const k = Math.min(1, (now - g.t0) / GROW_MS);
    if (!obj.parent || k >= 1) { growing.delete(obj); continue; }
    g.saved = obj.scale.clone();
    obj.scale.multiplyScalar(Math.max(0.001, easeOut(k)));   // never exactly 0: a zero matrix breaks the draw
    obj.updateMatrix();
  }
}

/** Right after the draw: the true scale is back before anyone else reads it. */
export function endDraw() {
  for (const obj of watched) { if (obj.parent) obj.userData.drawnOnce = true; }
  watched.clear();
  for (const [obj, g] of growing) {
    if (!g.saved) continue;
    obj.scale.copy(g.saved); g.saved = null;
    obj.updateMatrixWorld(true);   // the draw propagated the eased matrix into matrixWorld (self and children): put the true one back
  }
}

/** A stand-in (placeholder) to watch: after the next draw it has been seen. Lets a real thing replacing a ghost the
 *  visitor saw take its place at full size, while one replacing a ghost that never reached a draw grows in. */
const watched = new Set();
export function watchDrawn(obj) { if (obj) watched.add(obj); }
export const wasDrawn = (obj) => obj?.userData?.drawnOnce === true;

/** True while obj is still growing (tests; nothing in the client needs to ask, since the true scale is always there). */
export const isGrowing = (obj) => growing.has(obj);
