// models_field — the models realizer's pure half (TEL0S_NOTES §11.4): folded entities vs what is realized → which ids
// to create, retire, or rebuild. No THREE, DOM or scheduler calls (tools/models-field-test.ts); models.js executes it.

import { P } from '../scheduler.js';
import { COMPONENTS } from '../../../shared/protocol/componentspec.js';
import { kindOf, isMeshBag } from '../../../shared/protocol/kind.js';
export { kindOf, isMeshBag };

/** A realized id, enough to detect identity drift; lib only for models.
 *  @typedef {{ kind: 'model'|'mesh'|'light'|'empty', lib?: string }} RealizedView */

/** (A thing with both a model and a mesh is its model.) The `mesh` component as a client reads it: malformed is absent
 *  (an Empty), never a throw; out-of-range clamps; a capsule is at least its diameter tall. */
export const MESH_SHAPES = COMPONENTS.mesh.enums.shape;
const { min: SMIN, max: SMAX } = COMPONENTS.mesh.ranges.size;
export function readMesh(m) {
  if (!isMeshBag(m)) return null;
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(SMAX, Math.max(SMIN, x)) : 1);
  const size = Array.isArray(m.size) && m.size.length === 3 ? m.size.map(n) : [1, 1, 1];
  if (m.shape === 'capsule') size[1] = Math.max(size[0], size[1]);
  return { shape: m.shape, size };
}
/** One string per distinct geometry: a change is a rebuild, as a changed lib is. */
export const meshKeyOf = (ent) => { const m = readMesh(ent?.mesh); return m ? `${m.shape}|${m.size.join(',')}` : null; };

/** Switched off, itself or anything it hangs under: not loaded, not drawn, no collider. Same rule as the engine's offChain. */
export function offIn(stEntities, id) { for (let k = id, n = 0; k && n < 33; k = stEntities[k]?.parent?.to, n++) if (stEntities[k]?.disabled === true) return true; return false; }

/** Diff folded entities against the realized view.
 *
 *  Identity rules:
 *  - an id in state but not realized → create
 *  - realized but gone from state → retire
 *  - realized as one kind, folded as another (the id namespace is flat) → rebuild (retire + create)
 *  - a model whose `lib` changed → rebuild (the fold overwrites a same-id spawn)
 *  - everything else is an in-place refresh by the hosted half
 *
 *  @param {Record<string, any>} stEntities  state.st.entities
 *  @param {Map<string, RealizedView>} realized
 *  @returns {{ create: {id: string, ent: any}[], retire: string[] }} */
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

/** Load priority by distance, re-evaluated at dequeue so walking toward something promotes it. */
export function bandForDistance(d) {
  if (!Number.isFinite(d)) return P.VISIBLE;
  if (d <= 12) return P.NEAR;
  if (d <= 40) return P.VISIBLE;
  return P.FAR;
}

/** Ids whose folded parent involves `touchedId` (child or carrier), to re-check after a spawn realizes; the fold is the
 *  pending list: a mount stays there until both ends are live. */
export function mountsTouching(stEntities, touchedId, childrenOf = null) {
  // the fold's own index: O(children), not O(world); the same set as the scan below
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


/** No inferred box when collision is owned elsewhere: mounted cargo collides as its carrier; a `structure`'s lib is a
 *  hidden placeholder (inferring leaves an invisible obstacle).
 *
 *  @param {any} ent   the folded entity record
 *  @param {boolean} mounted  the scene object rides a carrier */
export function collisionOwnedElsewhere(ent, mounted = false) {
  // switched off: physics {kind: 'none'}, or a legacy stored collision {enabled: false}
  return !!mounted || !!ent?.structure || ent?.physics?.kind === 'none' || ent?.collision?.enabled === false;
}
