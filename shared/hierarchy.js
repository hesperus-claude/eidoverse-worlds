// hierarchy — the scene tree as a pure function of the fold (design §3 "Children", §5 "Left: Hierarchy"). Pure (no DOM,
// no renderer); read by the Hierarchy panel, its VR quad, the inspector's Parent field and the agent's tools.
// `world` is the fold's entities map ({ id: record }). A record's `parent` ({ to, socket?, offset?, yaw?, q? }) is the only edge.
// A child's transform is LOCAL to its parent, exactly as the renderer realizes it (client/lib/realize/models.js execMount):
//   position = parent.offset ?? socket.pos ?? [0,0,0]   (carrier frame)
//   rotation = parent.q ?? R_y(parent.yaw ?? socket.yaw ?? 0)
//   scale    = the child's own `scale` (the carrier's scale multiplies it)
// and while mounted the fold's `pos`/`q` on the child are its pre-mount pose, unused until a dismount stamps a new one.

import * as OP from './protocol/requests.js';
import { enc } from './protocol/names.js';
import { scale3, scaleWire, entScale } from './scale3.js';
import { qNorm, qMul, qRotate, qFromYaw, qHeading, qConj as conj, composePose } from './rot.js';
import { socketQ, lightOf } from './components.js';
import { kindOf } from './protocol/kind.js';
import { socketRole } from './sockbody.js';
import { r9 } from './protocol/round.js';
import { modelWord } from './eido.js';

/** No tilt: such an orientation travels as a bare yaw. */
const upright = (q) => Math.abs(q[0]) < 1e-9 && Math.abs(q[2]) < 1e-9;

/** Resolved on its carrier, or null. Only the old spelling has one: an imported old-protocol fold's
 *  (tools/protocol/import-v1/fold.js) and a blueprint's own published parts (blueprint.js). A live record's socket is a
 *  child entity, and its mount names that entity (PLAN-sockets-entities). */
export function socketOf(world, rel) {
  if (!rel?.socket) return null;
  const s = world?.[rel.to]?.sockets?.[rel.socket];
  return s && typeof s === 'object' ? s : null;
}

/** Is `rel.to` present in the world? The renderer leaves a child whose carrier is missing where the fold put it. */
const ridden = (world, ent) => !!ent?.parent?.to && !!world?.[ent.parent.to];

/** Its own pose for a root, the mount's for a child (see the header). `q` is null for a yaw-only pose. `part` names the
 *  carrier's moving part a part socket glues it into (its pose is then baked at the part's current phase). */
export function localOf(ent, world = null) {
  if (!ent) return null;
  const scale = entScale(ent) ?? 1;
  if (!ent.parent || (world && !ridden(world, ent))) {
    return { mounted: false, pos: [...(ent.pos ?? [0, 0, 0])], q: qNorm(ent.q) ?? null, yaw: ent.yaw ?? 0, scale, part: null };
  }
  const rel = ent.parent;
  const sock = socketOf(world, rel);
  const q = qNorm(rel.q) ?? (rel.yaw == null && sock ? socketQ(sock) : null);
  return {
    mounted: true, to: rel.to, ...(rel.socket ? { socket: rel.socket } : {}),
    pos: [...(Array.isArray(rel.offset) ? rel.offset : sock?.pos ?? [0, 0, 0])].map((v) => Number(v) || 0),
    q, yaw: q ? qHeading(q) : (rel.yaw ?? 0), scale,
    part: sock?.part ? String(sock.part) : null,
  };
}

/** Nearest first. Stops at a missing carrier or a cycle (an old log may hold one; the authority refuses new ones). */
export function ancestors(world, id) {
  const out = [];
  const seen = new Set([id]);
  for (let ent = world?.[id]; ent?.parent?.to && world[ent.parent.to] && !seen.has(ent.parent.to); ent = world[ent.parent.to]) {
    out.push(ent.parent.to); seen.add(ent.parent.to);
  }
  return out;
}

/** Composing its chain as three.js composes the realized Object3Ds: parent ∘ local (shared/rot.js composePose, the authority's composer). */
export function worldPose(world, id) {
  const ent = world?.[id];
  if (!ent) return null;
  const ids = [id, ...ancestors(world, id)].reverse();
  // a root's own pose IS its world pose ({} = "treat as root": no carrier lookups)
  const chain = ids.map((k, i) => { const L = localOf(world[k], i === 0 ? {} : world); return { pos: L.pos, q: L.q ?? qFromYaw(L.yaw), scale: L.scale }; });
  if (chain.length === 1) return chain[0];
  // a scale is one number or [x,y,z] (shared/scale3.js)
  const w = composePose(chain.map((L) => ({ ...L, scale: scale3(L.scale) })));
  return { ...w, scale: scaleWire(w.scale) };
}

/** The inverse of worldPose's compose step. */
export function localUnder(parent, child) {
  const inv = conj(parent.q);
  const d = qRotate(inv, [child.pos[0] - parent.pos[0], child.pos[1] - parent.pos[1], child.pos[2] - parent.pos[2]]);
  const s = scale3(parent.scale || 1), cs = scale3(child.scale);
  return { offset: d.map((v, i) => v / (s[i] || 1)), q: qNorm(qMul(inv, child.q)), scale: scaleWire(cs.map((v, i) => v / (s[i] || 1))) };
}

/** Or null. A thing cannot be its own parent, nor be dropped onto anything inside it. */
export function cycleRefusal(world, id, to) {
  if (to == null) return null;
  if (to === id) return `${id} can't be its own parent`;
  const up = ancestors(world, to);
  const at = up.indexOf(id);
  if (at < 0) return null;
  const path = [to, ...up.slice(0, at + 1)].reverse().join(' › ');
  return `${to} is inside ${id} (${path}) — a thing can't be parented under its own child`;
}

/** In id order (the fold's edges, not the realized scene). */
export function childrenOf(world, id) {
  return Object.keys(world ?? {}).filter((k) => world[k]?.parent?.to === id).sort();
}

/** In a word or two: kindOf's word, or a model's file stem (+ light for an imported lamp). */
export function kindHint(ent) {
  if (!ent) return '?';
  const kind = kindOf(ent);
  if (kind === 'socket') return socketRole(ent.c ?? ent);   // station, snap or attach (never stored)
  const plus = lightOf(ent) ? ' + light' : '';
  if (kind === 'mesh') return `${(ent.c ?? ent).mesh.shape}${plus}`;
  if (kind !== 'model') return kind;
  return `${modelWord(ent.model).split('_').slice(0, 3).join(' ')}${plus}`;   // the word for an address, never its hex (shared/eido.js)
}

/** A thing whose carrier is absent, or whose chain loops back, is a root (a hand-written cycle can't hide its members). */
export function treeOf(world) {
  const kids = new Map(); const roots = [];
  // by the name a person sees, numbers as numbers ('domino 3' before 'domino 11')
  const nm = (id) => { const l = world[id]?.label; return typeof l === 'string' && l ? l : id; };
  const order = Object.keys(world ?? {}).sort((a, b) => nm(a).localeCompare(nm(b), 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of order) {
    const to = world[id]?.parent?.to;
    const loops = to && ancestors(world, id).length && ancestors(world, to).includes(id);
    if (to && world[to] && !loops && to !== id) { if (!kids.has(to)) kids.set(to, []); kids.get(to).push(id); }
    else roots.push(id);
  }
  return { roots, kids };
}

/** [{ id, depth, kids, open, dim }] in paint order. `collapsed` folds children away; `matches(id)` filters (non-matching
 *  ancestors dimmed; a match in a folded parent still shows); `extra(id)` lists non-entity rows (seated people) as children. */
export function treeRows(world, { collapsed = new Set(), matches = null, extra = null } = {}) {
  const { roots, kids } = treeOf(world);
  const rows = [];
  const walk = (id, depth) => {
    const ch = kids.get(id) ?? [];
    const ex = extra?.(id) ?? [];
    const mine = !matches || matches(id);
    const at = rows.length;
    const folded = collapsed.has(id);
    const row = { id, depth, kids: ch.length + ex.length, open: !folded || !!matches, ...(matches && !mine ? { dim: true } : {}) };
    rows.push(row);
    let any = mine;
    if (!folded || matches) {
      for (const x of ex) if (!matches || x.match) { rows.push({ id: x.id, depth: depth + 1, kids: 0, extra: true }); any = true; }
      for (const k of ch) if (walk(k, depth + 1)) any = true;
    }
    if (!any) rows.splice(at);
    return any;
  };
  for (const id of roots) walk(id, 0);
  return rows;
}

/** Parent `id` under `to` (null: a root) WHERE IT STANDS: the world pose is kept. One gesture, one act; undo and locks are the
 *  authority's. */
export function parentOps(world, id, to) {
  const errors = [];
  const ent = world?.[id];
  if (!ent) return { ops: [], errors: [`${id} is not in the world`] };
  to = to == null || to === '' ? null : String(to);
  const was = ent.parent?.to ?? null;   // a gone carrier still counts: unparenting clears the dangling edge
  if (to === was) return { ops: [], errors: [to ? `${id} is already under ${to}` : `${id} already has no parent`] };
  if (to && !world[to]) return { ops: [], errors: [`no ${to} here to parent under`] };
  const cyc = cycleRefusal(world, id, to);
  if (cyc) return { ops: [], errors: [cyc] };
  const W = worldPose(world, id);
  if (to) {
    const L = localUnder(worldPose(world, to), W);
    return { ops: [OP.batch([OP.set(id, 'parent', { to: enc(to) }), OP.set(id, 'transform', { pos: L.offset.map(r9), q: L.q.map(r9), scale: scale3(L.scale).map(r9) })])], errors: [] };
  }
  return { ops: [OP.batch([OP.unset(id, 'parent'), OP.set(id, 'transform', { pos: W.pos.map(r9), q: W.q.map(r9), scale: scale3(W.scale).map(r9) })])], errors: [] };
}
