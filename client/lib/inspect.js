// inspect — the client's half of shared/editschema.js, which declares ONCE what a thing can edit (desktop inspector,
// VR quad and a model's `inspect`/`edit` tools all read it). This is the part only a live scene can add:
//
//   commitEdit(id, key, value, {live})
//     live   → PREVIEW: the group's handler moves the realized object; no log traffic
//     final  → COMMIT: editOps() → the fewest ops as ONE request (editwrites.sendOps), one authority undo;
//              expect carries the values as the gesture began
//
//   registerHandler(group, fn(id, obj, k, value, opts) → handled?)
//     previews and viewport GESTURES; true = "done, don't commit" (a live preview always; a final edit usually not)
//
// registerEditor (html+wire) survives only for the legacy World›Scene section, through the same commit path.

import { materialsOf } from './matoverride.js';
import { isMineMuted, allowUntrusted } from './mediaprefs.js';
import { rotOrderFor, setRotOrder } from './viewprefs.js';
import { entities } from './world.js';
import { boxOf, previewMesh } from './realize/models.js';
import { state } from './state.js';
import { net, sendDrag, replica } from './net.js';
import { serverNow } from './serverclock.js';   // the sky's and roles' stamps are the authority's
import { trustedOf } from '../../shared/drafts.js';
import { enc } from '../../shared/protocol/names.js';
import { THREE } from './core.js';
import { renderDOM } from './panels.js';
import { inspectSchema, editOps, fieldAt } from '../../shared/editschema.js';
import { namedParts } from './parts.js';
import { sameRotation } from '../../shared/euler.js';
import { localOf } from '../../shared/hierarchy.js';
import { kindOf } from '../../shared/protocol/kind.js';
import { lightOf } from '../../shared/components.js';
import { WORLD_ID, worldSchema, worldEditOps } from '../../shared/worldentity.js';
import * as Edits from './editwrites.js';   // component edits are requests
import { effectLookup } from './emitters.js';
import { isOwner } from '../../shared/protocol/roles.js';
const R2D = 180 / Math.PI;

const handlers = new Map();      // group → [fn] — consulted in order; the first to return true handled it
const htmlEditors = [];
let hooks = { casting: null };

export function registerHandler(group, fn) { if (!handlers.has(group)) handlers.set(group, []); handlers.get(group).push(fn); }
// a mesh card scrub (size x/y/z, shape) shows on the thing before release; the commit goes through editOps as any field's
registerHandler('mesh', (id, _obj, k, value, opts) => {
  if (!opts?.live) return false;
  const cur = { ...(recordFor(id)?.mesh ?? {}) }; const n = Number(value);
  if (k === 'shape') cur.shape = String(value); else if (/^size\.[xyz]$/.test(k) && Number.isFinite(n)) { cur.size = [...(Array.isArray(cur.size) ? cur.size : [1, 1, 1])]; cur.size['xyz'.indexOf(k.slice(5))] = n; } else return false;
  return previewMesh(id, cur);
});
export function registerEditor(fn) { htmlEditors.push(fn); }
/** Injected by editpanels at init: importing build.js here would close a loop through scenegraph.js. */
export function setEditHooks(h) { hooks = { ...hooks, ...h }; }

/** The view record (shared/protocol/view.js viewOf): what the gizmo and the euler hint still read. */
export const foldRecord = (id) => state.st.entities?.[id] ?? null;
/** The fold record (`c`), exactly what the schema reads; frozen in dev, never written here. */
export const recordFor = (id) => replica.st?.entities?.[enc(String(id))]?.c ?? null;
// the Euler triple this viewer last composed (shared/euler.js), so channels read back as typed past 90° and at gimbal
// lock; void once the folded q differs; never stored
const eulerHints = new Map();   // id → { order, e, q }
function eulerHint(id, rec) {
  const h = eulerHints.get(id);
  if (!h) return undefined;
  const order = rotOrderFor(id);
  // a child's channels read its RELATIVE q (the mount's), so that is the q the hint is for
  const q = rec ? localOf(rec, state.st.entities).q : null;
  // never deleted on a mismatch: the post-commit repaint reads the fold BEFORE the echo lands
  return q && h.order === order && sameRotation(h.q, q, 1e-12) ? h.e : undefined;
}
/** The schema AND the commit path read the same live facts. */
export function liveFor(id) {
  const obj = entities.get(id); const rec = foldRecord(id);
  const light = kindOf(rec) === 'light';
  return { casting: lightOf(rec) ? hooks.casting?.(id) : undefined, parts: obj && !light ? namedParts(obj) : undefined, materials: obj && !light ? materialsOf(obj) : undefined,
    euler: eulerHint(id, foldRecord(id)),
    // this viewer's rotate order (viewprefs.js), never sent
    rotOrder: rotOrderFor(id),
    // the hierarchy needs the whole fold (local poses, sockets, children, in-place parenting)
    world: state.st.entities ?? {},
    // the model's own box (the pivot's centre / base snaps)
    box: boxOf(id),
    // this viewer's own media choices (mediaprefs.js), never logged
    mutedForMe: isMineMuted(id), untrusted: allowUntrusted(),
    // this viewer's stored particle effects (emitters.js): their params are the knobs
    effects: effectLookup,
    // @world.trusted-components, and whether this viewer (the owner) may change it
    trusted: trustedHere(), mayTrust: mayTrust(),
  };
}
export const trustedHere = () => trustedOf(replica.st?.entities?.['@world']?.c);
export const mayTrust = () => (net.myRights?.role === undefined ? undefined : isOwner(net.myRights));
// `@world` (shared/worldentity.js) aliases state.sky/terrain/grass. mayShape: false = not allowed, undefined = not
// known yet; the right is editWorld, falling back to owner rank on an older server.
export const mayShape = () => { const r = net.myRights; if (Array.isArray(r?.permissions)) return r.permissions.includes('editWorld'); return r?.role === undefined ? undefined : isOwner(r); };
export const worldLive = () => ({ now: serverNow(), mayShape: mayShape(), trusted: trustedHere(), mayTrust: mayTrust() });
export function schemaFor(id) {
  if (id === WORLD_ID) return worldSchema(state.st, worldLive());
  const rec = recordFor(id); if (!rec) return { id, groups: [] };
  return inspectSchema(rec, id, liveFor(id));
}

let gesture = null;   // { id, comps } as they stood when a drag began
export function endGesture() { gesture = null; }

/** The ops ONE edit would send, unsent: a multi-selection batches them into one request (one Ctrl+Z). */
export function planEdit(id, key, value) {
  if (id === WORLD_ID) { const r = worldEditOps(state.st, { [key]: value }, worldLive()); return { ops: r.ops, errors: r.errors }; }
  const rec = recordFor(id);
  if (!rec) return { ops: [], errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = liveFor(id);
  const f = fieldAt(inspectSchema(rec, id, live), key);
  if (f?.deg && typeof value === 'number') value = value * R2D;   // panel steppers speak wire (radians); editOps takes the face
  if (group === 'comp' && k !== '+' && value === '') return { ops: [], errors: [`${k}: empty — use "remove ${k}" to remove it`] };
  const { ops, errors, euler, asks, rotOrder } = editOps(rec, id, { [key]: value }, live);
  return { ops, errors, euler, asks, rotOrder };
}
/** A rotate-order pick stays this viewer's: nothing is sent. */
export const keepView = (id, plan) => { if (plan?.rotOrder) setRotOrder(id, plan.rotOrder); };
/** The euler hint follows the pose. */
export const movesPose = (ops) => ops.some((o) => (o.verb === 'batch' ? o.args.ops : [o]).some((x) => x.args?.component === 'transform'));

// a scrubbed transform is a live drag for everyone else (the gizmo's presence lane); the release sends the last sample
function dragOut(id, obj, end) {
  obj.updateWorldMatrix(true, false);
  const p = obj.getWorldPosition(new THREE.Vector3()), q = obj.getWorldQuaternion(new THREE.Quaternion());
  sendDrag(id, p.toArray(), new THREE.Euler().setFromQuaternion(q, 'YXZ').y, q.toArray(), { end, scale: obj.scale.toArray() });
}
export function commitEdit(id, key, value, opts = {}) {
  if (id === WORLD_ID) {   // no live preview: commits on release, one request, one undo step
    if (opts.live) return { ok: true, live: true };
    const { ops, errors } = planEdit(id, key, value);
    if (ops.length) Edits.sendOps(ops, { what: `${key} of the world`, expect: false });
    return { ok: !errors.length, errors, ops };
  }
  const rec = recordFor(id);
  const obj = entities.get(id);
  if (!rec) return { ok: false, errors: [`${id} is not in the fold`] };
  const dot = key.indexOf('.');
  const group = key.slice(0, dot), k = key.slice(dot + 1);
  const live = !!opts.live;
  if (live && (!gesture || gesture.id !== id)) gesture = { id, comps: Edits.compsOf(id) };
  for (const h of handlers.get(group) ?? []) {
    try { if (h(id, obj, k, value, opts)) { if (!live) gesture = null; return { ok: true, handled: true }; } } catch (e) { console.warn(`[inspect] ${group} handler`, e); }
  }
  if (group === 'pos' && obj) dragOut(id, obj, !live);   // no handler previews a transform: still a drag for everyone else
  if (live) return { ok: true, live: true };
  const baseComps = gesture?.id === id ? gesture.comps : null;   // the components before the drag began
  gesture = null;
  // planEdit holds the seam rules: steppers speak WIRE units (radians), editOps the FACE, converted once there;
  // a cleared raw-JSON box must not delete the component ('remove <type>' is the deliberate act)
  const { ops, errors, euler, asks, rotOrder } = planEdit(id, key, value);
  keepView(id, { rotOrder });
  // ONE request, one Ctrl+Z; expect names the values as this viewer saw them (a scrub: as it began)
  const reply = ops.length ? Edits.sendOps(ops, { what: `${key} of ${id}`, base: baseComps ? { [id]: baseComps } : null, revert: () => Edits.revertPose(id) }) : null;
  if (euler) eulerHints.set(id, euler); else if (movesPose(ops)) eulerHints.delete(id);
  return { ok: !errors.length, errors, ops, reply, ...(euler ? { euler } : {}), ...(asks?.length ? { asks } : {}) };   // reply: a promise of the authority's answer
}

/** Several channels in ONE request, one Ctrl+Z: {'pos.x': 0, …}, FACE values (degrees for rotate).
 *  `id` may be an array (a multi-select) or WORLD_ID (every field at once, so one component is one write). */
export function commitMany(id, edits, what) {
  if (id === WORLD_ID) {
    const { ops, errors } = worldEditOps(state.st, edits, worldLive());
    if (ops.length) Edits.sendOps(ops, { what: `${what} of the world`, expect: false });
    return { ok: !errors.length, errors, ops };
  }
  const ids = Array.isArray(id) ? id : [id];
  const ops = [], errors = [];
  for (const one of ids) {
    const rec = recordFor(one); if (!rec) { errors.push(`${one} is not in the fold`); continue; }
    const r = editOps(rec, one, edits, liveFor(one));
    keepView(one, { rotOrder: r.rotOrder });
    ops.push(...r.ops); errors.push(...r.errors);
    if (r.euler) eulerHints.set(one, r.euler); else if (movesPose(r.ops)) eulerHints.delete(one);
  }
  if (ops.length) Edits.sendOps(ops, { what: `${what} of ${ids.length > 1 ? `${ids.length} things` : ids[0]}`, revert: () => ids.forEach((x) => Edits.revertPose(x)) });
  return { ok: !errors.length, errors, ops };
}

/** The legacy section's html+wire editors: the registered ones, then the schema's groups. */
export function editorsFor(ctx) {
  const out = [];
  for (const fn of htmlEditors) { try { const e = fn(ctx); if (e) out.push(e); } catch { /* skip it */ } }
  const schema = schemaFor(ctx.id);
  // picture/sound keep their registered html blocks here until this panel retires
  schema.groups.filter((g) => !['pos', 'flags', 'comp', 'picture', 'sound'].includes(g.group)).forEach((g, i) => {
    const host = `data-fe="${i}"`;
    out.push({
      html: `<div style="margin:4px 0"><b>${ctx.esc?.(g.label ?? g.group) ?? g.group}</b><div ${host}></div></div>`,
      wire(root) {
        const div = root.querySelector(`[${host}]`);
        if (div) renderDOM(div, g.fields, (k, v, _f, o) => { if (k === 'fold') return; commitEdit(ctx.id, `${g.group}.${k}`, v, o); });
      },
    });
  });
  return out;
}
