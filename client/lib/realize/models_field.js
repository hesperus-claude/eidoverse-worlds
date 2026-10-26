// models_field — the models realizer's pure half (TEL0S_NOTES §11.4).
//
// Given the folded state's entity record and a view of what is currently
// realized in the scene, decide WHAT must change: which ids to create,
// which to retire, which to rebuild because their identity changed out
// from under them. No THREE, no DOM, no scheduler calls — the hosted half
// (models.js) executes the plan; this half is the part a headless test can
// hold to the light (tools/models-field-test.ts). Same discipline as
// flora_field.js / emitter_field.js.

import { P } from '../scheduler.js';
import { COMPONENTS } from '../../../shared/protocol/componentspec.js';
import { kindOf, isMeshBag } from '../../../shared/protocol/kind.js';
export { kindOf, isMeshBag };

/** What the realizer needs to know about a realized id to detect identity
 *  drift. kind: kindOf's word; lib only meaningful for models.
 *  @typedef {{ kind: 'model'|'mesh'|'light'|'empty', lib?: string }} RealizedView */

/** Diff folded entities against the realized view.
 *
 *  Identity rules:
 *  - an id in state but not realized → create
 *  - realized but gone from state → retire
 *  - realized as one kind, folded as another (the id namespace is flat) → rebuild (retire + create)
 *  - a model whose `lib` changed → rebuild (the fold overwrites a same-id spawn; this planner projects the fold)
 *  - everything else (transform, params, comps) is an in-place refresh the hosted half applies.
 *
 *  @param {Record<string, any>} stEntities  state.st.entities
 *  @param {Map<string, RealizedView>} realized
 *  @returns {{ create: {id: string, ent: any}[], retire: string[] }} */
/** (kindOf is shared/protocol/kind.js's; a thing with both a model and a mesh is its model.)
 *  The registered `mesh` component (shared/protocol/componentspec.js), read as a client reads it: a malformed value is
 *  absent (an Empty), never a throw; out-of-range fields clamp; a capsule is at least its diameter tall. */
export const MESH_SHAPES = COMPONENTS.mesh.enums.shape;
const { min: SMIN, max: SMAX } = COMPONENTS.mesh.ranges.size;
export function readMesh(m) {
  if (!isMeshBag(m)) return null;
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(SMAX, Math.max(SMIN, x)) : 1);
  const size = Array.isArray(m.size) && m.size.length === 3 ? m.size.map(n) : [1, 1, 1];
  if (m.shape === 'capsule') size[1] = Math.max(size[0], size[1]);
  return { shape: m.shape, size };
}
/** One string per distinct geometry: a changed shape or size is a rebuild (planReconcile), as a changed lib is. */
export const meshKeyOf = (ent) => { const m = readMesh(ent?.mesh); return m ? `${m.shape}|${m.size.join(',')}` : null; };

/** Switched off (componentspec `disabled`), itself or anything it hangs under: not loaded, not drawn, no collider (R 10-11:
 *  "present in the world as links, but not downloaded… until someone re-enables it"). Same rule as the engine's offChain. */
export function offIn(stEntities, id) { for (let k = id, n = 0; k && n < 33; k = stEntities[k]?.parent?.to, n++) if (stEntities[k]?.disabled === true) return true; return false; }

export function planReconcile(stEntities, realized) {
  const create = [];
  const retire = [];
  for (const [id, view] of realized) {
    const ent = stEntities[id];
    if (!ent || offIn(stEntities, id)) { retire.push(id); continue; }
    const foldedKind = kindOf(ent);
    if (view.kind !== foldedKind || (foldedKind === 'model' && view.model !== ent.model) || (foldedKind === 'mesh' && view.mesh !== meshKeyOf(ent))) {
      retire.push(id);
      create.push({ id, ent });
    }
  }
  for (const [id, ent] of Object.entries(stEntities)) {
    if (!realized.has(id) && !offIn(stEntities, id)) create.push({ id, ent });
  }
  return { create, retire };
}

/** Load priority by distance, re-evaluated at dequeue so walking toward something promotes it. Bands, not a curve:
 *  what matters is in front of you vs behind you. */
export function bandForDistance(d) {
  if (!Number.isFinite(d)) return P.VISIBLE;
  if (d <= 12) return P.NEAR;
  if (d <= 40) return P.VISIBLE;
  return P.FAR;
}

/** The ids whose folded parent involves `touchedId` (as child or carrier): the set to re-check after a spawn realizes.
 *  State is the pending list: a mount that can't execute yet stays in the fold until both ends are live. */
export function mountsTouching(stEntities, touchedId, childrenOf = null) {
  // `childrenOf(id)` (the fold's own index, world.js) answers the carrier direction in O(children) instead of
  // O(world); membership is the scan's below by construction (the index is kept at every ingest).
  if (childrenOf) {
    const out = stEntities[touchedId]?.parent ? [touchedId] : [];
    for (const cid of childrenOf(touchedId)) out.push(cid);
    return out;
  }
  const out = [];
  for (const [id, ent] of Object.entries(stEntities)) {
    if (!ent.parent) continue;
    if (id === touchedId || ent.parent.to === touchedId) out.push(id);
  }
  return out;
}


/** Collision owned elsewhere gets no inferred box: mounted cargo collides as its carrier; a `structure` entity's boxes
 *  are declared by the structure realizer, and its lib is a hidden placeholder (inferring leaves an invisible obstacle).
 *
 *  @param {any} ent   the folded entity record
 *  @param {boolean} mounted  whether the scene object rides a carrier */
export function collisionOwnedElsewhere(ent, mounted = false) {
  // a collision switched off has no box either: physics {kind: 'none'} (the authority's sim skips it too, simlayer.js), or
  // a stored collision {enabled: false} from before physics replaced it (house I243)
  return !!mounted || !!ent?.structure || ent?.physics?.kind === 'none' || ent?.collision?.enabled === false;
}
