// thingphysics — physics in a world, on the client.
//
// Every act is a REQUEST and every client draws the same truth: this client's choice, not the protocol's limit (spec/PHYSICS.md §4.1).
//
//   carrying   grab / put / throw / drop / punt are requests (shared/protocol/authority.js); who holds what is presence
//              (`holds`, never logged), and every client draws a held thing in its holder's hand.
//   flights    a launch is a `sim` entry folded with the SAME engine the authority runs, so it rests bit for bit where the
//              authority logs it (tools/protocol/physlive-check.ts F4/F6); drawn as a copy advanced to serverNow.
//   the body   the authority measures reach from its own track of your body, kept current by `move` requests.
// Rotations are the engine's (eidosim), slerped between ticks; at rest, the realizer's.

import { THREE } from './core.js';
import { bus } from './base.js';
import { entities } from './world.js';
import { outOfMyView } from './myview.js';
import { remotes, serverNow } from './remotes.js';
import { colliders, suspendCollider } from './colliders.js';
import { pushHostHook } from './autohooks.js';
import { colliderFor } from './bodyscale.js';
import { TRACK } from '../../shared/mover.js';
const CHUNK = TRACK.cap - 0.5;   // m: half a metre under the cap, so a rounding never tips a step over it
import { replica, net, sendRequest as rawSend, identities } from './net.js';
import { flashHint } from './ui.js';
import { logChat } from './chat.js';
import { register as registerAction } from './actions.js';
import { setPressFx, pressFxOn } from './emitters.js';
import { advanceSim, tickOf, ENGINES, engineViewM, worldPose } from '../../shared/protocol/simlayer.js';
import { createShover, obbOf, aabbOfObb, contactOf, smoother } from '../../shared/shove.js';
import { simEntry } from '../../shared/sim.js';
import { shapeReady, requestGrid } from '../../shared/terrainshape.js';
import { planLaunch } from '../../shared/protocol/launchplan.js';
import { REACH, HAND_Y, KICK } from '../../shared/protocol/physconst.js';
import { r3 } from '../../shared/protocol/round.js';
import { clockRtt } from './serverclock.js';
import { onWorldChange } from './state.js';
import { plain, nameOf, called } from './plainwords.js';
import { html } from './markup.js';
import { xrActive } from './xrask.js';
import { grabOf, holdPoseOf, fingerPose, armPose, bothArms, pickGrip, HAND_REACH, NEAR_GRAB } from '../../shared/grab.js';

const TRACK_MS = 200, TRACK_MIN = 0.05;           // ms, m: at most 5 moves a second, only when moved
const THROW = { speed: 8, arc: 0.45, lob: 0.6 };   // m/s, rad: unaimed ~26° up the way my body faces; aimed, a lob of ~34° or steeper
const PUNT_POWER = 4;                             // the authority's default (shared/protocol/authority/bodyverbs.js punt)

let hooks = null;   // { myPos(): {x,y,z}, me(): Avatar|null, camera, editing(): bool }
// hooks get SECONDS since boot but frame() takes SERVER ms: wrap it, never pass the bare function, or flights freeze
export function initThingPhysics(h) { hooks = h; pushHostHook(() => frame()); }
export const myAvatar = () => hooks?.me() ?? null;
// xr.js binds this (it imports this module, never the reverse); a tracked body holds with its own hands, no hold-pose arms
let presenting = () => false;
export const bindPresenting = (fn) => { presenting = fn; };

// ---------------------------------------------------------------- who holds what (the authority's presence plane)
let holds = {};     // id -> { by: identity, hand?, grip? | offset?, second? } (shared/grab.js holdWire)
const pulls = new Map();   // id -> { from: Vector3, t0, dur }: a new hold eases into the hand
bus.on('holds', (h) => {
  const before = holds; holds = h && typeof h === 'object' ? h : {};
  for (const id of Object.keys(before)) if (!holds[id]) { released(id); pulls.delete(id);
    // a hold ending with no fold change (a put to the very pose it had) gets no change event: ask for the fold's pose
    if (!flying(id) && entities.has(id) && !compsOf(id)?.motion) { startSettle(id); bus.emit('pose-revert', { id }); } }
  for (const id of Object.keys(holds)) if (!before[id] || before[id].by !== holds[id].by) { suspendCollider(id, true); startPull(id); }
  // a use still pressed on a thing that left my hand: its up goes now, and the press stops riding my presence
  if (pressing && holds[pressing]?.by !== net.you) void useHeld('up', pressing);
});
// presence only, every client the same; a far grab flies a little longer
function startPull(id) {
  const obj = entities.get(id); if (!obj) return;
  obj.updateWorldMatrix(true, false); const from = obj.getWorldPosition(new THREE.Vector3());
  const hand = handOf(holds[id].by, holds[id].hand ?? 'right'); const d = hand ? from.distanceTo(hand) : 0;
  pulls.set(id, { from, t0: performance.now(), dur: Math.min(400, Math.max(120, d / 8 * 1000)) });
}
// A put's change entry arrives BEFORE the holds message (the log, then presence): from it on, stop drawing it in the
// hand, or a frame between the two would draw it there after the realizer placed it.
onWorldChange((ev) => {
  if (ev.type === 'change' && holds[ev.id] && ['pose', 'parent', 'gone', 'born'].includes(ev.what)) { const { [ev.id]: _, ...rest } = holds; holds = rest; released(ev.id);
    if (ev.what === 'pose' || ev.what === 'parent') startSettle(ev.id); }
  else if (ev.type === 'change' && settles.has(ev.id)) { if (ev.what === 'pose' || ev.what === 'parent') startSettle(ev.id); else if (ev.what === 'gone' || ev.what === 'born') endSettle(ev.id, false); }
  else if (ev.type === 'reset') { holds = {}; settles.clear(); }
});
// ---- settling: the truth takes the rest at once; what is DRAWN eases from the hand over SETTLE_MS. Presence only:
// nothing sent or logged; the collider sits the ease out. A launch is the engine's flight, not this.
let SETTLE_MS = 120;   // lab knob (physicsApi.settle(ms))
// the canonical fold too: the presentation copy lags a frame, and the fold has a launch's body before the holds message
const flying = (id) => presOwns(id) || !!replica.sim?.sim?.bodies?.[id];
const settles = new Map();   // id -> { from, drawn: {p, q} world, t0, dur, truth: {p, q} local | null (read on the first frame, after the realizer wrote it) }
const drawnHeld = new Map();   // id -> {p, q} world, as drawHeld last drew it
function startSettle(id) {
  const obj = entities.get(id); if (!obj || flying(id) || compsOf(id)?.motion) return;
  const s = settles.get(id); const at = s?.drawn ?? drawnHeld.get(id);
  if (!at) return;   // never drawn in a hand here (a joiner mid-hold): snap, never slide from the old rest
  if (s?.truth) { obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); }   // the realizer's write lands on the truth, never on a drawn pose
  const from = { p: at.p.clone(), q: at.q.clone() };
  settles.set(id, { from, drawn: { p: from.p.clone(), q: from.q.clone() }, t0: performance.now(), dur: SETTLE_MS, truth: null });
  drawnHeld.delete(id);
}
function endSettle(id, restore = true) {
  const s = settles.get(id); if (!s) return; settles.delete(id);
  const obj = entities.get(id);
  if (restore && obj && s.truth) { obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); obj.updateWorldMatrix(true, false); }
  if (s.truth && !holds[id] && !presOwns(id)) suspendCollider(id, false);
}
const easeOut = (k) => 1 - (1 - k) ** 3;
const _sp = new THREE.Vector3(), _sq = new THREE.Quaternion(), _st = new THREE.Quaternion();
function drawSettles(now) {
  for (const [id, s] of settles) {
    const obj = entities.get(id);
    if (!obj || holds[id] || presOwns(id)) { endSettle(id, false); continue; }
    if (!s.truth) { s.truth = { p: obj.position.clone(), q: obj.quaternion.clone() }; suspendCollider(id, true); }
    const k = s.dur > 0 ? Math.min(1, (now - s.t0) / s.dur) : 1;
    if (k >= 1) { endSettle(id); continue; }
    obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(_sp); obj.getWorldQuaternion(_st);
    const e = easeOut(k);
    _sp.lerpVectors(s.from.p, _sp, e); _sq.copy(s.from.q).slerp(_st, e);
    setWorldPose(obj, _sp, _sq); s.drawn.p.copy(_sp); s.drawn.q.copy(_sq);
  }
}
/** The truth's world position of a settling thing (what a request may read: Covenant III), or null. */
function settledTruth(id) {
  const s = settles.get(id), obj = entities.get(id); if (!s?.truth || !obj) return null;
  const p = obj.position.clone(), q = obj.quaternion.clone();
  obj.position.copy(s.truth.p); obj.quaternion.copy(s.truth.q); obj.updateWorldMatrix(true, false); const w = obj.getWorldPosition(new THREE.Vector3());
  obj.position.copy(p); obj.quaternion.copy(q); obj.updateWorldMatrix(true, false);
  return w;
}
export const holdsNow = () => holds;
// newest first: the last thing picked up is put down first; the order is this client's own (the wire carries none)
const heldSeen = new Map(); let heldN = 0;
export const myHolds = () => { const mine = Object.keys(holds).filter((id) => holds[id].by === net.you);
  for (const id of mine) if (!heldSeen.has(id)) heldSeen.set(id, ++heldN);
  for (const id of heldSeen.keys()) if (!mine.includes(id)) heldSeen.delete(id);
  return mine.sort((a, b) => heldSeen.get(b) - heldSeen.get(a)); };
function released(id) {
  // the last drawn pose stays until the fold or the sim owns it again (both arrive BEFORE this message)
  if (!presOwns(id)) suspendCollider(id, false);
}
/** The people map's key for an authority identity: null is me, undefined unknown. */
function presenceIdOf(actorId) {
  if (actorId === net.you) return null;               // me
  for (const [pid, vid] of identities) if (vid === actorId) return pid;
  return undefined;
}

// ---------------------------------------------------------------- the body the authority tracks
let arrived = false, moving = null, lastTrack = 0, trackedAt = null, lastMove = null, lastTeleport = 0, arriveFails = 0;
const feet = () => { const p = hooks?.myPos(); return p ? [p.x, p.y, p.z] : null; };
const worldHasPhysics = () => { const es = replica.st?.entities; if (!es) return false; if (es['@world']?.c['physics-engine']) return true;
  for (const id in es) if (es[id].c.physics?.kind === 'dynamic' || es[id].c.grabbable) return true; return false; };
bus.on('cut-adopted', () => { arrived = false; trackedAt = null; holds = {}; stuck = null; arriveFails = 0; });   // a fresh cut: try at once
let lagMs = 0;   // lab knob (physicsApi.lag): delay a throw/drop/punt, as a slow round trip would
// the authority judges my body with my walker's height and scale (controller.js stepWalk), so every move carries them
function bodyArgs() {
  const me = hooks?.me?.(); if (!me) return {};
  const h = me.bodyHeight?.(), s = me.userScale;
  return { ...(typeof h === 'number' && Number.isFinite(h) && h > 0 ? { height: h } : {}), ...(typeof s === 'number' && Number.isFinite(s) && s > 0 ? { scale: s } : {}) };   // always, 1 too: absent, the authority keeps the last size
}
async function sendRequest(verb, args) {
  if (verb === 'move') args = { ...args, ...bodyArgs() };
  if (lagMs && (verb === 'throw' || verb === 'drop' || verb === 'punt')) await new Promise((res) => setTimeout(res, lagMs));
  const r = await rawSend(verb, args);
  if (verb === 'move' || r?.refused?.code !== 'not-here') return r;   // not-here: no body for me there; re-arrive once and resend
  arrived = false; trackedAt = null; arriveFails = 0; stuck = null;
  return (await track(true)) ? rawSend(verb, args) : r;
}
export { sendRequest as requestWithBody };
/** Resolves true when the authority's track of my body is where I stand (or close enough to act). */
async function track(force = false, { noTeleport = false } = {}) {
  if (!replica.active || !net.joined) return false;
  // seated, a move (even forced) is a step off the seat, and the authority vacates on it (shared/protocol/authority/occupants.js)
  if (hooks?.seated?.()) return arrived;
  const to = feet(); if (!to) return false;
  if (moving) { await moving; if (!force) return arrived; }
  const go = async () => {
    if (!arrived) {   // arriving: one act on the record, as an agent's first move is
      const r = await sendRequest('move', { to: to.map(r3) }); lastMove = { arrive: true, ok: !!r?.ok, refused: r?.refused?.code };
      if (r?.ok) { arrived = true; trackedAt = r.at ?? to; }
      if (arrived) { arriveFails = 0; stuck = null; return true; }   // no leftover back-off
      // refused: back off doubling by TIME only (2, 4, 8, 16 s; walking doesn't clear it); too-fast or solid re-arrives
      // as a teleport (empty hands only, ≤ once in 3 s)
      arriveFails++; stuck = { at: to, until: performance.now() + 2000 * 2 ** Math.min(arriveFails - 1, 3), arrival: true };
      if (['too-fast', 'solid'].includes(r?.refused?.code) && !myHolds().length && performance.now() - lastTeleport > 3000) {
        lastTeleport = performance.now();
        const t = await sendRequest('move', { to: to.map(r3), teleport: true }); lastMove = { arrive: true, teleport: true, ok: !!t?.ok, refused: t?.refused?.code };
        if (t?.ok) { arrived = true; arriveFails = 0; stuck = null; trackedAt = t.at ?? to; return true; }
        if (t?.refused) refused('move', t);
      } else if (r?.refused) refused('move', r);
      return false;
    }
    const d = trackedAt ? Math.hypot(to[0] - trackedAt[0], to[1] - trackedAt[1], to[2] - trackedAt[2]) : Infinity;
    if (!force && d < TRACK_MIN) return true;
    // in steps it accepts: TRACK.speed m/s, TRACK.cap m at most at once (shared/mover.js)
    const k = d > CHUNK ? CHUNK / d : 1; const step = trackedAt ? trackedAt.map((v, i) => r3(v + (to[i] - v) * k)) : to.map(r3);
    let r = await sendRequest('move', { to: step }); lastMove = { to: step, ok: !!r?.ok, refused: r?.refused?.code, reason: r?.refused?.reason };
    if (r?.ok) { trackedAt = r.at ?? step; return true; }
    if (r?.refused?.at) trackedAt = r.refused.at;
    stuck = { at: to, until: performance.now() + 2000 };
    // the authority lost me: re-arrive (refused while holding: a teleport can't carry things); ≤ once in 3 s, forced or not: each is an act on the record
    if (!noTeleport && ['too-fast', 'solid'].includes(r?.refused?.code) && !myHolds().length && performance.now() - lastTeleport > 3000) {
      lastTeleport = performance.now();
      r = await sendRequest('move', { to: to.map(r3), teleport: true }); lastMove = { teleport: true, ok: !!r?.ok, refused: r?.refused?.code, reason: r?.refused?.reason };
      if (r?.ok) { trackedAt = r.at ?? to; stuck = null; return true; }
    }
    return false;
  };
  moving = go().catch(() => false).finally(() => { moving = null; lastTrack = performance.now(); });
  return moving;
}
let stuck = null;   // {at, until}: a refused step isn't re-sent until I've moved on from it, or a while has passed
function tickTrack(now) {
  if (!replica.active || moving || now - lastTrack < TRACK_MS) return;
  if (hooks?.seated?.()) return;
  if (stuck) { const f = feet(); if (now < stuck.until && (stuck.arrival || (f && Math.hypot(f[0] - stuck.at[0], f[2] - stuck.at[2]) < 0.3))) return; stuck = null; }
  if (!arrived) { if (worldHasPhysics()) track(); else lastTrack = now; return; }
  const to = feet(); if (!to || !trackedAt) return;
  if (Math.hypot(to[0] - trackedAt[0], to[1] - trackedAt[1], to[2] - trackedAt[2]) >= TRACK_MIN) track();
}

// ---------------------------------------------------------------- the hand
const _hp = new THREE.Vector3(), _fw = new THREE.Vector3();
const avatarOf = (actorId) => { const pid = presenceIdOf(actorId); return pid === null ? hooks?.me() : pid ? remotes.get(pid)?.avatar : null; };
/** A headset: their own hands hold it. */
function tracked(actorId) { const pid = presenceIdOf(actorId); if (pid === null) return presenting(); const r = pid ? remotes.get(pid) : null; return !!(r?.xrSample || r?.lastPose?.xr); }
/** The avatar's hand bone, else in front of the chest. */
function handOf(actorId, side = 'right', out = _hp) {
  const av = avatarOf(actorId);
  // the RAW bone: on a cloned avatar the normalized rig can be another body's
  const bone = av?.vrm?.humanoid?.getRawBoneNode?.(`${side}Hand`) ?? av?.vrm?.humanoid?.getNormalizedBoneNode?.(`${side}Hand`);
  if (bone) { bone.updateWorldMatrix(true, false); return bone.getWorldPosition(out); }
  const root = av?.root; if (!root) return null;
  root.getWorldPosition(out); root.getWorldDirection(_fw); _fw.y = 0; if (_fw.lengthSq() > 1e-9) _fw.normalize();
  return out.set(out.x + _fw.x * 0.35, out.y + HAND_Y, out.z + _fw.z * 0.35);
}
// The PALM's world frame (shared/grab.js: +Z out of the palm, +Y little→index), off the raw bones (see handOf);
// a rig without finger bones uses the normalized hand's rotation.
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pd = new THREE.Vector3();
const _px = new THREE.Vector3(), _py = new THREE.Vector3(), _pz = new THREE.Vector3(), _pm = new THREE.Matrix4();
const PALM_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);   // grip frame in a T-pose hand bone
export function palmOf(actorId, side, out) {
  const av = avatarOf(actorId); const H = av?.vrm?.humanoid; if (!H) return null;
  const raw = (n) => H.getRawBoneNode?.(n) ?? null;
  const hand = raw(`${side}Hand`); if (!hand) return null;
  hand.updateWorldMatrix(true, true); hand.getWorldPosition(_pa);
  const mid = raw(`${side}MiddleProximal`), idx = raw(`${side}IndexProximal`), lit = raw(`${side}LittleProximal`);
  if (mid && idx && lit) {
    mid.getWorldPosition(_pb); idx.getWorldPosition(_pc); lit.getWorldPosition(_pd);
    const len = _pb.distanceTo(_pa);
    _px.subVectors(_pb, _pa).normalize();          // along the fingers
    _py.subVectors(_pc, _pd).normalize();          // across the knuckles, little → index
    if (side === 'right') _pz.crossVectors(_py, _px); else _pz.crossVectors(_px, _py);
    _pz.normalize(); _py.sub(_pd.copy(_pz).multiplyScalar(_py.dot(_pz))).normalize(); _px.crossVectors(_py, _pz);
    _pm.makeBasis(_px, _py, _pz); out.q.setFromRotationMatrix(_pm);
    out.p.copy(_pa).lerp(_pb, 0.75).addScaledVector(_pz, len * 0.25);
    return out;
  }
  const n = H.getNormalizedBoneNode?.(`${side}Hand`); if (!n) return null;
  n.updateWorldMatrix(true, false); n.getWorldQuaternion(out.q).multiply(PALM_Q); out.p.copy(_pa);
  return out;
}
// held by its middle, not its base. By WORLD scale: a stacked thing is its host's scene child, its own scale local
const _c = new THREE.Vector3(), _cq = new THREE.Quaternion(), _sc = new THREE.Vector3();
const worldScaleOf = (obj) => (obj?.getWorldScale ? (obj.updateWorldMatrix?.(true, false), obj.getWorldScale(_sc)) : (obj?.scale ?? { x: 1, y: 1, z: 1 }));
function localCentre(id, obj) {
  const b = colliders.get(id)?.box; if (!b) return _c.set(0, 0.1, 0);
  const s = worldScaleOf(obj);
  return _c.set((b.min.x + b.max.x) / 2 * (s.x || 1), (b.min.y + b.max.y) / 2 * (s.y || 1), (b.min.z + b.max.z) / 2 * (s.z || 1));
}
/** collider box × world scale, or null. */
function sizeOf(id, obj) { const b = colliders.get(id)?.box; if (!b) return null; const s = worldScaleOf(obj);
  return [(b.max.x - b.min.x) * (s.x || 1), (b.max.y - b.min.y) * (s.y || 1), (b.max.z - b.min.z) * (s.z || 1)]; }
const _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
/** A WORLD pose whatever its scene parent (a thing on a table may hang under it). */
function setWorldPose(obj, pos, quat) {
  if (!obj.parent || obj.parent.isScene) { obj.position.copy(pos); if (quat) obj.quaternion.copy(quat); return; }
  obj.parent.updateWorldMatrix(true, false);
  _m.copy(obj.parent.matrixWorld).invert();
  obj.position.copy(pos).applyMatrix4(_m);
  if (quat) { obj.parent.matrixWorld.decompose(_w, _q, _s); obj.quaternion.copy(_q.invert().multiply(quat)); }
}
const compsOf = (id) => replica.st?.entities?.[id]?.c ?? null;
const _held = new THREE.Vector3(), _hq = new THREE.Quaternion(), _ws = new THREE.Vector3(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3();
const _gq = new THREE.Quaternion(), _gv = new THREE.Vector3(), _v2 = new THREE.Vector3(), _aq = new THREE.Quaternion();
const P1 = { p: new THREE.Vector3(), q: new THREE.Quaternion() }, P2 = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
/** Every client computes the same: a grip puts the palm on it, an offset keeps it where taken, else by its centre;
 *  a second hand on a twoHanded thing steers it. World {p, q}; q null keeps its rotation. */
function heldPose(id, h, obj) {
  const g = grabOf(compsOf(id)); const side = h.hand ?? 'right';
  const grip = h.grip ? g?.grips?.[h.grip] : null;
  obj.getWorldScale(_ws);
  if (!tracked(h.by) && g && bothArms(holdPoseOf(g, sizeOf(id, obj))) && !grip) {
    const a = palmOf(h.by, 'right', P1), b = palmOf(h.by, 'left', P2);
    if (a && b) { _tp.copy(a.p).lerp(b.p, 0.5);
      // in both arms it sits AGAINST the body, not around it: out in front by its depth, less the arm's reach
      const av = avatarOf(h.by), sz = sizeOf(id, obj);
      if (av?.root && Array.isArray(sz)) { const fx = _tp.x - av.root.position.x, fz = _tp.z - av.root.position.z, fl = Math.hypot(fx, fz);
        const push = Math.max(0, Math.max(sz[0], sz[2]) / 2 - Math.max(0, fl - 0.12));
        if (fl > 1e-3 && push > 0) { _tp.x += fx / fl * push; _tp.z += fz / fl * push; } }
      return { p: _tp, q: null, centre: localCentre(id, obj) }; }
  }
  const palm = (grip || h.offset) ? palmOf(h.by, side, P1) : null;
  if (palm && grip) {
    _gq.fromArray(grip.q); _tq.copy(palm.q).multiply(_gq.invert());
    _tp.copy(palm.p).sub(_gv.fromArray(grip.pos).multiply(_ws).applyQuaternion(_tq));
    const sg = h.second?.grip ? g.grips[h.second.grip] : null;
    if (g.twoHanded && h.second && sg) { const p2 = palmOf(h.by, h.second.hand, P2);
      if (p2) { _gv.fromArray(sg.pos).sub(_v2.fromArray(grip.pos)).multiply(_ws).applyQuaternion(_tq);
        _v2.subVectors(p2.p, palm.p);
        if (_gv.lengthSq() > 1e-8 && _v2.lengthSq() > 1e-8) { _aq.setFromUnitVectors(_gv.normalize(), _v2.normalize()); _tq.premultiply(_aq); _tp.sub(palm.p).applyQuaternion(_aq).add(palm.p); } } }
    return { p: _tp, q: _tq };
  }
  if (palm && h.offset) { _tq.copy(palm.q).multiply(_gq.fromArray(h.offset.q)); _tp.copy(palm.p).add(_gv.fromArray(h.offset.pos).applyQuaternion(palm.q)); return { p: _tp, q: _tq }; }
  const hand = handOf(h.by, side); if (!hand) return null;
  return { p: _tp.copy(hand), q: null, centre: localCentre(id, obj) };
}
// a gripless hold keeps the turn it had relative to the holder's body when taken (yaw only)
const heldTurn = new Map();   // `${id}|${by}` → rotation in the holder's yaw frame
const _bq = new THREE.Quaternion(), _bodyQ = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
function bodyYawQ(by) { const av = avatarOf(by); if (!av?.root) return null; av.root.getWorldQuaternion(_bq);
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(_bq); return _bodyQ.setFromAxisAngle(_up, Math.atan2(f.x, f.z)); }
// origin = hand - q * centre with THIS frame's q (last frame's draws an off-centre model metres off the hand)
function placeHeld(id, h, obj) {
  const at = heldPose(id, h, obj); if (!at) return null;
  if (at.q) return at;
  const bq = bodyYawQ(h.by); let q;
  if (bq) { const key = `${id}|${h.by}`; let r = heldTurn.get(key);
    if (!r) { r = bq.clone().invert().multiply(obj.getWorldQuaternion(new THREE.Quaternion())); heldTurn.set(key, r); }
    q = bq.clone().multiply(r); }
  else q = obj.getWorldQuaternion(new THREE.Quaternion());
  at.p.sub(_held.copy(at.centre).applyQuaternion(q)); at.q = q;
  return at;
}
function drawHeld() {
  const now = performance.now();
  for (const k of heldTurn.keys()) { const [id, by] = k.split('|'); if (holds[id]?.by !== by) heldTurn.delete(k); }
  for (const [id, h] of Object.entries(holds)) {
    if (pres?.bodies?.[id]) continue;              // the flight draws it
    const obj = entities.get(id); if (!obj) continue;
    const at = placeHeld(id, h, obj); if (!at) continue;
    const pull = pulls.get(id);
    if (pull) { const k = Math.min(1, (now - pull.t0) / pull.dur); if (k >= 1) pulls.delete(id); else at.p.lerpVectors(pull.from, at.p, easeOut(k)); }
    setWorldPose(obj, at.p, at.q);
    let d = drawnHeld.get(id); if (!d) drawnHeld.set(id, (d = { p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    obj.updateWorldMatrix(true, false); obj.getWorldPosition(d.p); obj.getWorldQuaternion(d.q);
  }
  for (const id of drawnHeld.keys()) if (!holds[id]) drawnHeld.delete(id);
  poseHolders();
}
// avatar.js setHoldPose, every frame from the record: finger presets per holding hand; arms only without tracked hands
const posed = new Set();
function poseHolders() {
  const want = new Map();
  for (const [id, h] of Object.entries(holds)) {
    const av = avatarOf(h.by); if (!av?.vrm) continue;
    const g = grabOf(compsOf(id)); const side = h.hand ?? 'right';
    let m = want.get(av); if (!m) want.set(av, (m = { bones: {}, fingers: {} }));
    const grip = h.grip ? g?.grips?.[h.grip] : null;
    if (g?.source === 'physics') continue;   // no grabbable: no hold pose, VR fingers keep the controller's curl
    Object.assign(m.bones, fingerPose(grip?.grasp ?? 'fist', side, grip?.hold ?? {})); m.fingers[side] = true;
    if (h.second) { const sg = h.second.grip ? g?.grips?.[h.second.grip] : null; Object.assign(m.bones, fingerPose(sg?.grasp ?? 'fist', h.second.hand, sg?.hold ?? {})); m.fingers[h.second.hand] = true; }
    if (!tracked(h.by) && g && g.source !== 'physics') { const preset = holdPoseOf(g, sizeOf(id, entities.get(id)));
      Object.assign(m.bones, armPose(preset, side));
      if (bothArms(preset)) { const o = side === 'right' ? 'left' : 'right'; Object.assign(m.bones, fingerPose('fist', o)); m.fingers[o] = true; } }
  }
  for (const av of posed) if (!want.has(av)) { av.setHoldPose?.(null); if (av.vrm?.userData) av.vrm.userData._holdFingers = null; posed.delete(av); }
  for (const [av, m] of want) { av.setHoldPose?.(m.bones); (av.vrm.userData ||= {})._holdFingers = m.fingers; posed.add(av); }
}
/** The release pose sent with throw/drop: its drawn origin. */
function heldPos(id) { const obj = entities.get(id); if (!obj) return null; obj.updateWorldMatrix(true, false); return obj.getWorldPosition(new THREE.Vector3()); }

// ---------------------------------------------------------------- flights (the engine's, at display time)
let pres = null, presV = -1, tickSeen = -1;
const prev = new Map();      // id -> [x, y, z] at the tick before pres.tick
const spins = new Map();     // id -> presentation state {q, dp?}
const presOwns = (id) => !!pres?.bodies?.[id];
const _dq = new THREE.Quaternion(), _p = new THREE.Vector3();
/** Probe surface: the displayed sim (a copy). */
export const simShown = () => pres;
// ---- my own release, predicted into the PRESENTATION copy only, at now + rtt/2 + one tick with the authority's inputs.
// The real entry replaces it; a draw offset decays any difference, never a blend of states. A refusal or PENDING_MS
// eases it back to the hand. Nothing provisional is ever read back into a request.
const pending = new Map();   // id -> { ts, args, sentAt }
const PENDING_MS = 1500, OFFSET_SNAP = 3, OFFSET_DEAD = 0.02;   // ms, m, m; a reply normally lands within 300 ms
let predictOn = true;        // lab knob (physicsApi.predict(false)): the old shape, for the probe's control arm
const swapFrom = new Map();  // id -> drawn world position before a copy swap (the offset starts from it)
function planRelease(id, pos, v, w) {
  const canon = replica.sim; if (!predictOn || !canon?.sim || canon.foreign || !pos || clockRtt() === null) return null;
  const obj = entities.get(id); if (!obj) return null;
  const q = obj.getWorldQuaternion(new THREE.Quaternion()).normalize().toArray();
  const { notes: _n, ...entry } = planLaunch({ id, p: pos, q, v, ...(w ? { w } : {}) }, grabOf(compsOf(id)), ENGINES[canon.spec?.engine]?.maxSpeed, 'throw');   // the authority's own arithmetic
  return entry;
}
function predict(args) {
  if (presV !== replica.simVersion || !pres) { pres = replica.simClone(); presV = replica.simVersion; tickSeen = -1; stats.clones++; if (!pres) return false; }
  const now = serverNow(); const ts = now + clockRtt() / 2 + pres.epoch.tickMs;
  pending.set(args.id, { ts, args, sentAt: now }); applyPending(args.id); return true;
}
function applyPending(id) {
  const pd = pending.get(id); if (!pd || !pres?.epoch || !replica.st) return;
  const floor = pres.epoch.ts + pres.tick * pres.epoch.tickMs; const ts = Math.max(pd.ts, floor);   // never earlier than what's drawn
  const view = engineViewM(replica.st, {}); const base = view.entities[id]; if (!base) return;
  view.entities[id] = { ...base, pos: pd.args.p };
  simEntry(pres, { seq: -1, ts, actor: net.you, verb: 'launch', args: pd.args }, view);
  if (pres.bodies[id]) pres.bodies[id].provisional = true;
}
function unpredict(id) {
  if (!pending.delete(id)) return;
  const obj = entities.get(id); if (obj) { obj.updateWorldMatrix(true, false); pulls.set(id, { from: obj.getWorldPosition(new THREE.Vector3()), t0: performance.now(), dur: 150 }); }
  presV = -1;   // next frame: a fresh copy of the truth, still in the hand
}
const pendingNow = () => Object.fromEntries([...pending].map(([id, p]) => [id, { ts: p.ts, sentAt: p.sentAt }]));
function drawFlights(wall, now) {
  const canon = replica.sim;
  if (!canon?.sim || canon.foreign) { if (pres) { for (const id of Object.keys(pres.bodies)) suspendCollider(id, false); } pres = null; prev.clear(); return; }
  // while a release is a guess, keep this copy: a fresh one may be past the guess's tick and would restart it from the hand.
  // Other bodies' news waits one round trip, no more.
  const guessing = pres && presV !== -1 && pending.size > 0 && ![...pending].some(([id, pd]) => canon.launched[id] || wall - pd.sentAt > PENDING_MS);
  if (presV !== replica.simVersion && !guessing) {
    const was = pres ? Object.keys(pres.bodies) : [];
    swapFrom.clear(); if (pres) for (const id of was) { const o = entities.get(id); if (o) { o.updateWorldMatrix(true, false); swapFrom.set(id, o.getWorldPosition(new THREE.Vector3())); } }
    pres = replica.simClone(); presV = replica.simVersion; tickSeen = -1; stats.clones++;
    // the real launch folded drops the guess; not yet, re-fold it into this copy
    for (const [id, pd] of pending) { if (canon.launched[id] || wall - pd.sentAt > PENDING_MS) pending.delete(id); else applyPending(id); }
    for (const id of was) if (!pres.bodies[id] && !holds[id]) suspendCollider(id, false);   // its rest is the fold's now
  }
  // until a heightmap's grid arrives the law answers noise: hold the drawing, catch up once it lands (upstream #237)
  const shape = pres.terrain?.shape;
  if (!shapeReady(shape)) { void requestGrid(shape.heightmap.grid); return; }
  const target = tickOf(pres, wall);
  if (pres.tick !== tickSeen) prev.clear();
  if (pres.tick < target) {
    if (pres.tick < target - 1) advanceSim(pres, target - 1);
    for (const id in pres.bodies) { const b = pres.bodies[id]; let pv = prev.get(id); if (!pv) prev.set(id, (pv = [0, 0, 0])); pv[0] = b.p[0]; pv[1] = b.p[1]; pv[2] = b.p[2];
      if (b.q) { if (!pv.q) pv.q = new THREE.Quaternion(); pv.q.set(b.q[0], b.q[1], b.q[2], b.q[3]); } }
    advanceSim(pres, target);
  }
  tickSeen = pres.tick;
  const k = Math.min(1, Math.max(0, (wall - pres.epoch.ts) / pres.epoch.tickMs - (pres.tick - 1)));
  for (const id in pres.bodies) {
    // a body here was launched AFTER any grab (a grab lifts it out), so it wins over a hold not yet said over
    const b = pres.bodies[id]; const obj = entities.get(id); if (!obj) continue;
    let sp = spins.get(id);
    if (!sp) { obj.getWorldQuaternion(_hq); sp = { q: _hq.clone() }; spins.set(id, sp); suspendCollider(id, true);
      // until its rest it hangs from the scene, not from what it rode on
      if (obj.parent && !obj.parent.isScene) bus.emit('flight-detach', { id }); }
    const pv = b.resting ? undefined : prev.get(id);
    if (pv) _p.set(pv[0] + (b.p[0] - pv[0]) * k, pv[1] + (b.p[1] - pv[1]) * k, pv[2] + (b.p[2] - pv[2]) * k);
    else _p.set(b.p[0], b.p[1], b.p[2]);
    // a copy swap that moved its drawn place: a decaying draw offset (< 2 cm gone, ≥ 1 m fast, ≥ 3 m snap). The truth never carries it.
    const from = swapFrom.get(id); if (from) { swapFrom.delete(id); const d = from.sub(_p); if (d.length() >= OFFSET_DEAD) { stats.swaps.push({ id, tick: pres.tick, target, k: +k.toFixed(2), prov: !!b.provisional, resting: !!b.resting, d: +d.length().toFixed(3), from: from.toArray().map((n) => +n.toFixed(3)), to: _p.toArray().map((n) => +n.toFixed(3)) }); if (stats.swaps.length > 12) stats.swaps.shift(); }
      if (d.length() >= OFFSET_DEAD && d.length() < OFFSET_SNAP) sp.dp = d; else delete sp.dp; }
    if (sp.dp) { if (sp.dp.length() < OFFSET_DEAD) delete sp.dp; else { _p.add(sp.dp); sp.dp.multiplyScalar(sp.dp.length() >= 1 ? 0.8 : 0.9); } }
    const q = sp.q;
    // the engine's rotation, nothing invented; without one it keeps its own
    if (b.q) { q.set(b.q[0], b.q[1], b.q[2], b.q[3]); if (pv?.q) q.copy(_dq.copy(pv.q).slerp(q, k)); }
    setWorldPose(obj, _p, q);
    if (obj.userData.base?.pos) { obj.userData.base.pos[0] = b.p[0]; obj.userData.base.pos[1] = b.p[1]; obj.userData.base.pos[2] = b.p[2]; }
  }
  for (const id of spins.keys()) if (!pres.bodies[id]) spins.delete(id);
  swapFrom.clear();
}

const stats = { frames: 0, ms: 0, clones: 0, maxMs: 0, swaps: [] };   // swaps: the last copy swaps that moved a drawn body
/** `wall` (server ms) lets a probe sample at exact display times, independent of the frame rate. */
function frame(wall) {
  if (!replica.active) return;
  const now = performance.now();
  drawFlights(wall ?? serverNow(), now);
  drawHeld();
  drawSettles(now);
  drawPressFx();
  tickTrack(now);
  tickShove(now);
  const ms = performance.now() - now; stats.frames++; stats.ms += ms; if (ms > stats.maxMs) stats.maxMs = ms;
}

// ---------------------------------------------------------------- acts (requests)
const say = (t) => logChat('*', t);
// the same refusal within REPEAT_MS is said once; keyed with numbers stripped, since reasons name a changing distance
const REPEAT_MS = 5000, saidAt = new Map();
const refused = (what, r, id = '') => { const x = r?.refused, now = performance.now();
  // a let-go out of reach is the server's body track a step behind, not the person's doing
  const text = x?.code === 'out-of-reach' && (what === 'throw' || what === 'drop') ? `Couldn't ${what} it from there: the server still has you a step back from where you see yourself. Try again — standing still a moment helps` : plain(what, r);
  // the status bar EVERY time; the event below (a headset's card, probes) keeps REPEAT_MS
  if (!xrActive()) flashHint(text, 3800, 'attn');
  const key = `${what}|${id}|${x?.code ?? ''}|${text.replace(/-?\d+(?:\.\d+)?/g, '#')}`;   // + the id: 'crate 2' and 'crate 3' stay two
  if (now - (saidAt.get(key) ?? -Infinity) < REPEAT_MS) return r;
  saidAt.delete(key); saidAt.set(key, now); if (saidAt.size > 64) saidAt.delete(saidAt.keys().next().value);
  bus.emit('thingphysics-refused', { verb: what, refused: x, text }); return r; };   // a person's words (plainwords.js)
// grabOf is the authority's own reader (a dynamic thing with no grabbable counts); a foot punts physics {kind: 'dynamic'}
let gIds = { st: null, head: -2, ids: [] };   // the fold is applied in place: keyed by its object and its head
const grabbableIds = () => { const st = replica.st; if (gIds.st !== st || gIds.head !== replica.head) { const es = st?.entities ?? {}; gIds = { st, head: replica.head, ids: Object.keys(es).filter((id) => grabOf(es[id].c)?.enabled) }; } return gIds.ids; };
const dynamicIds = () => { const es = replica.st?.entities ?? {}; return Object.keys(es).filter((id) => es[id].c.physics?.kind === 'dynamic'); };
/** As the authority sees it: someone's hand, the air, or the log. */
function whereIs(id) {
  const b = pres?.bodies?.[id]; if (b && !b.resting) return b.p;
  const st = settledTruth(id); if (st) return st.toArray();
  const obj = entities.get(id); if (obj) { obj.updateWorldMatrix(true, false); return obj.getWorldPosition(new THREE.Vector3()).toArray(); }
  return null;
}
// hidden or isolated out: no verb by proximity; naming it still works (grab(name))
const hiddenToMe = (id) => { const o = entities.get(id); return !!o && !!outOfMyView(o); };
// for grabbing, the highest grabbable.priority first
function nearest(ok, ids = dynamicIds(), prio = () => 0) {
  const f = feet(); if (!f) return null; let best = null, bd = Infinity, bp = -Infinity;
  for (const id of ids) { if (holds[id] || hiddenToMe(id)) continue; const p = whereIs(id); if (!p) continue; const d = ok(p, f, id); if (d === null) continue;
    const pr = prio(id); if (pr > bp || (pr === bp && d < bd)) { bd = d; bp = pr; best = id; } }
  return best;
}
const rangeOf = (id) => grabOf(compsOf(id))?.range ?? REACH;
const prioOf = (id) => grabOf(compsOf(id))?.priority ?? 0;
const _rh = new THREE.Vector3(), _rn = new THREE.Vector3();
/** reach is to the box's NEAREST POINT: an origin at the base reads out of reach while standing against it */
const nearestOf = (p, id, hand) => { const o = id && !myHolds().includes(id) ? entities.get(id) : null; if (!o) return p;
  try { _bx.setFromObject(o); if (_bx.isEmpty()) return p; _bx.clampPoint(_rh.set(hand[0], hand[1], hand[2]), _rn); return [_rn.x, _rn.y, _rn.z]; } catch { return p; } };
const inHand = (p, f, id) => { const hand = [f[0], f[1] + HAND_Y, f[2]], q = nearestOf(p, id, hand); const d = Math.hypot(q[0] - hand[0], q[1] - hand[1], q[2] - hand[2]); return d <= (id ? rangeOf(id) : REACH) ? d : null; };
const atFeet = (p, f) => { const dh = Math.hypot(p[0] - f[0], p[2] - f[2]), dy = p[1] - f[1]; return dh <= KICK.reach && dy >= KICK.below && dy <= KICK.above ? dh : null; };

/** The named thing, or the nearest you can reach. */
export async function grab(name) {
  if (!replica.active) return say('carrying works in worlds');
  const id = name || nearest(inHand, grabbableIds(), prioOf);
  if (!id) return say('nothing here you can pick up within reach (things with a grabbable component)');
  await track(true);
  const r = await sendRequest('grab', { id });
  if (!r?.ok) return refused('grab', r, id);
  flashHint(`holding ${called(id)}${r.notes?.some((n) => n.takenFrom) ? ' (taken from someone)' : ''} — T puts it down, C throws`);
  return r;
}
/** Onto what's below: at a spot [x, z], else in front of my feet. */
export async function put(name, spot = null) {
  const id = name || myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  await track(true);
  // the authority checks my reach
  if (Array.isArray(spot)) { const r = await sendRequest('put', { id, at: [r3(spot[0]), r3(spot[1])] }); return r?.ok ? r : refused('put', r, id); }
  // clear of my body: the authority's default (under the hand) is inside my footprint and shoves me aside
  const f = feet(), yaw = hooks?.myState?.()?.yaw, obj = entities.get(id), sz = obj ? sizeOf(id, obj) : null;
  // capsule + half-width + gap, within REACH in 3D (bodyverbs put): a base-origin thing lands HAND_Y below the hand
  const out = Math.min(1.2, Math.sqrt(Math.max(0, (REACH - 0.1) ** 2 - HAND_Y ** 2)), colliderFor(hooks?.me?.()?.userScale).r + (Array.isArray(sz) ? Math.max(sz[0], sz[2]) / 2 : 0.15) + 0.12);
  // facing the world's edge: beside me, else behind (the authority refuses a spot past its bounds)
  const B = compsOf('@world')?.bounds, half = Array.isArray(sz) ? Math.max(sz[0], sz[2]) / 2 : 0.15;
  const inside = (x, z) => !B?.min || (x - half >= B.min[0] && x + half <= B.max[0] && z - half >= B.min[2] && z + half <= B.max[2]);
  let at = null;
  if (f && Number.isFinite(yaw)) for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) { const x = f[0] + Math.sin(yaw + turn) * out, z = f[2] + Math.cos(yaw + turn) * out;
    if (inside(x, z)) { at = [r3(x), r3(z)]; break; } }
  const r = await sendRequest('put', { id, ...(at ? { at } : {}) });
  return r?.ok ? r : refused('put', r, id);
}
/** It falls from where your hand is. */
export async function drop(name) {
  const id = name || myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  await track(true);
  const pos = letGoAt(heldPos(id)); const r = await sendRequest('drop', { id, ...(pos ? { pos: pos.toArray().map(r3) } : {}) });
  return r?.ok ? r : refused('drop', r, id);
}
/** The newest held. `aim` [x, y, z]: a lob that lands there, up to the engine's limit; none: the way my body faces; a number: a speed. */
export async function throwHeld(arg) {
  const id = myHolds()[0]; if (!id) return say('you aren\'t holding anything');
  // the guess goes up BEFORE track(): a move's round trip can queue behind the engine's beat
  const pos = letGoAt(heldPos(id)), aim = Array.isArray(arg) && arg.length === 3 && arg.every(Number.isFinite) ? arg : null;
  let v;
  if (aim && pos) {
    const dx = aim[0] - pos.x, dz = aim[2] - pos.z, d = Math.hypot(dx, dz), dy = aim[1] - pos.y;
    if (d < 0.3) v = [0, 1, 0];   // at my own feet: let it go
    else { // a lob at THROW.lob that passes through the point: v² = g d² / (2 cos²θ (d tanθ − Δy)); steeper when the point is high
      let th = Math.max(THROW.lob, Math.atan2(dy, d) + 0.35); th = Math.min(1.25, th);
      const den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - dy);
      const sp = Math.min(20, Math.max(1.5, den > 1e-6 ? Math.sqrt(9.81 * d * d / den) : 20));
      v = [dx / d * Math.cos(th) * sp, Math.sin(th) * sp, dz / d * Math.cos(th) * sp].map(r3); }
  } else {
    const speed = Math.min(20, Math.max(1, parseFloat(arg) || THROW.speed)), yaw = hooks?.myState?.()?.yaw ?? 0;
    v = [Math.sin(yaw) * Math.cos(THROW.arc) * speed, Math.sin(THROW.arc) * speed, Math.cos(yaw) * Math.cos(THROW.arc) * speed].map(r3);
  }
  // tumbles forward like an overhand throw, faster when harder; a VR hand sends its measured spin instead
  const fl = Math.hypot(v[0], v[2]), sp = Math.hypot(...v), mag = Math.min(8, 0.8 * sp);
  const w = fl > 0.2 ? [v[2] / fl * mag, 0, -v[0] / fl * mag].map(r3) : null;
  const sent = pos ? pos.toArray().map(r3) : null; const plan = planRelease(id, sent, v, w); if (plan) predict(plan);
  await track(true);
  const r = await sendRequest('throw', { id, v, ...(w ? { w } : {}), ...(sent ? { pos: sent } : {}), ...(plan ? { q: plan.q } : {}) });
  if (!r?.ok) unpredict(id);
  return r?.ok ? r : refused('throw', r, id);
}
/** The nearest carriable thing within reach of `at` [x, y, z] and of the authority's hand. */
export async function grabNear(at, within = 0.6) {
  const f = feet(); if (!f) return null; let best = null, bd = within;
  for (const id of grabbableIds()) { if (holds[id]) continue; const obj = entities.get(id); if (!obj || outOfMyView(obj)) continue;
    const c = obj.getWorldPosition(new THREE.Vector3()).add(localCentre(id, obj).applyQuaternion(obj.getWorldQuaternion(_cq))); const d = Math.hypot(c.x - at[0], c.y - at[1], c.z - at[2]);
    if (d < bd && inHand(c.toArray(), f, id) !== null) { bd = d; best = id; } }
  return best ? grab(best) : null;
}
/** [0,0,0] is a drop; from where it is drawn. */
export async function release(v = [0, 0, 0], name) {
  const id = name || myHolds()[0]; if (!id) return null;
  await track(true);
  const pos = letGoAt(heldPos(id)); const still = v.every((n) => Math.abs(n) < 0.05);
  const sent = pos ? pos.toArray().map(r3) : null; const plan = still ? null : planRelease(id, sent, v.map(r3), null); if (plan) predict(plan);
  const r = await sendRequest(still ? 'drop' : 'throw', { id, ...(still ? {} : { v: v.map(r3) }), ...(sent ? { pos: sent } : {}), ...(plan ? { q: plan.q } : {}) });
  if (!r?.ok) unpredict(id);
  return r?.ok ? r : refused(still ? 'drop' : 'throw', r, id);
}
/** /punt [thing] [power]: the named thing, or the nearest low beside you. */
export async function punt(arg) {
  if (!replica.active) return say('punting works in worlds');
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const named = parts.find((x) => !/^[\d.]+$/.test(x));
  const power = Math.min(20, Math.max(0.5, parseFloat(parts.find((x) => /^[\d.]+$/.test(x))) || PUNT_POWER));
  const id = named || nearest(atFeet);
  if (!id) return say('nothing beside you to punt (things with physics {kind: dynamic})');
  await track(true);
  const r = await sendRequest('punt', { id, power });
  if (!r?.ok) return refused('punt', r, id);
  flashHint(`you punt ${called(id)}${r.volley ? ' (a volley)' : ''}`);
  return r;
}

// ---------------------------------------------------------------- body shove (shared/shove.js)
// MY body only, one punt {contact: true} per contact, predicted like a throw; a refusal is quiet and never repeats
const shover = createShover();
let shoveOn = true;          // lab knob (physicsApi.shove.on(false)); off for the session when the server doesn't know shove
const shoveLog = [];         // probe surface
const headV = smoother();    // VR room-scale: the head's smoothed walking speed
const _hw = new THREE.Vector3();
let dynIds = { st: null, head: -2, ids: [] };   // per fold, as grabbableIds
const dynamicCached = () => { const st = replica.st; if (dynIds.st !== st || dynIds.head !== replica.head) dynIds = { st, head: replica.head, ids: dynamicIds() }; return dynIds.ids; };
function tickShove(now) {
  if (!shoveOn || !replica.active || !net.joined || !arrived) return;
  const canon = replica.sim; if (!canon?.sim || canon.foreign) return;
  const st = hooks?.myState?.(), me = hooks?.me?.(); let f = feet();
  // walking only: not in edit mode (a builder would nudge crates), seated, down or flying
  if (!st || !me || !f || hooks?.editing?.() || hooks?.seated?.() || hooks?.flying?.() || st.clip === 'ragdoll') { headV.reset(); return; }
  const cap = colliderFor(me.userScale), sp = Number.isFinite(st.speed) ? st.speed : 0;
  let vel = [Math.sin(st.yaw) * sp, Math.cos(st.yaw) * sp];
  // room-scale moves the head, not the root: shove by its smoothed motion above vrSpeed only (leaning or jitter never)
  if (presenting() && hooks?.camera) { hooks.camera.getWorldPosition(_hw); const hv = headV.step([_hw.x, f[1], _hw.z], now);
    if (sp < shover.feel.minSpeed && Math.hypot(hv[0], hv[1]) >= shover.feel.vrSpeed) { f = [_hw.x, f[1], _hw.z]; vel = hv; } }
  else headV.reset();
  if (Math.hypot(vel[0], vel[1]) < shover.feel.minSpeed) { shover.step({ st: replica.st, feet: f, vel: [0, 0], r: cap.r, now }); return; }
  const rank = Number.isFinite(net.myRights?.rank) ? net.myRights.rank : null;
  const mounted = new Set(); for (const [, m] of hooks?.mounts?.() ?? []) if (m?.to) mounted.add(m.to);
  const bodies = []; for (const r of remotes.values()) { const p = r.avatar?.root?.position; if (p) bodies.push([p.x, p.y, p.z]); }
  const go = shover.step({ st: replica.st, ids: dynamicCached(), feet: f, vel, r: cap.r, tall: cap.tall, now, rank, holds, mounted, bodies,
    skip: (id) => flying(id) || settles.has(id) || pending.has(id) || !entities.has(id) });
  for (const p of go) { hooks?.capSpeed?.(p.kept, p.keepMs); void shove(p.id, p.v, now); }
}
function planPunt(id, v) {
  const canon = replica.sim; if (!predictOn || !canon?.sim || canon.foreign || clockRtt() === null) return null;
  const wp = worldPose(replica.st, id); if (!wp) return null;
  const { notes: _n, ...entry } = planLaunch({ id, p: wp.pos, q: wp.q, v }, null, ENGINES[canon.spec?.engine]?.maxSpeed, 'punt');
  return entry;
}
async function shove(id, v, now) {
  const plan = planPunt(id, v); if (plan) predict(plan);
  await track(true, { noTeleport: true });   // a shove never re-arrives the body
  const r = await sendRequest('punt', { id, v, contact: true });
  shoveLog.push({ id, v, t: now, ok: !!r?.ok, code: r?.refused?.code ?? null }); if (shoveLog.length > 32) shoveLog.shift();
  if (!r?.ok) { shover.refused(id, performance.now(), r?.refused?.code); if (pending.delete(id)) presV = -1; bus.emit('shove-refused', { id, refused: r?.refused ?? null });
    if (r?.refused?.code === 'unknown-arg') shoveOn = false; }   // a server without shove
  return r;
}

// ---------------------------------------------------------------- use while held (grabbable.use)
// one request per press and release; the fx ride presence (pose.use): the authority rate-limits acts on purpose
const usable = () => myHolds().find((id) => grabOf(compsOf(id))?.use) ?? null;
let pressing = null;   // the id my use is held down on
/** The authority's reply, or null if nothing to use. */
export async function useHeld(phase = 'down', name) {
  const id = name || (phase === 'up' ? pressing : usable()); if (!id) return null;
  const h = holds[id]; const g = grabOf(compsOf(id));
  const st = hooks?.myState?.();
  if (phase === 'down') { pressing = id; if (st && g?.fx) st.useHeld = { id, hand: h?.hand ?? 'right' }; }
  else { if (pressing === id) pressing = null; if (st?.useHeld?.id === id) st.useHeld = null; }
  if (!g?.use || !(phase === 'down' ? g.use.down : g.use.up)) return { ok: true, recorded: false, note: `nothing happens on use ${phase}` };
  const r = await sendRequest('use', { id, args: { held: true, hand: h?.hand ?? 'right', phase } });
  return r?.ok ? r : refused('use', r, id);
}
// from presence: mine myState, theirs their latest pose sample
function drawPressFx() {
  for (const [id, h] of Object.entries(holds)) {
    const g = grabOf(compsOf(id)); if (!g?.fx) { setPressFx(id, null); continue; }
    const pid = presenceIdOf(h.by);
    const use = pid === null ? hooks?.myState?.()?.useHeld : pid ? remotes.get(pid)?.buf?.at(-1)?.use : null;
    setPressFx(id, use?.id === id ? g.fx : null);
  }
  for (const id of fxIds) if (!holds[id]) setPressFx(id, null);
  fxIds = new Set(Object.keys(holds));
}
let fxIds = new Set();
if (typeof document !== 'undefined') {
  // capture phase: while I hold something usable, the left button is its use, not a look-drag
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target?.tagName !== 'CANVAS' || hooks?.editing?.() || !replica.active || !usable()) return;
    e.stopImmediatePropagation(); e.preventDefault(); void useHeld('down');
  }, true);
  addEventListener('mouseup', (e) => { if (e.button === 0 && pressing) void useHeld('up'); }, true);
  // the phone's use button, labelled with what it does
  let btn = null;
  const sync = () => { const box = document.getElementById('touchbtns'); if (!box || !document.body.classList.contains('touch')) return;
    const id = usable(); const g = id ? grabOf(compsOf(id)) : null;
    if (!btn) { btn = document.createElement('button'); btn.className = 'panel usebtn'; btn.style.display = 'none';
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); void useHeld('down'); });
      btn.addEventListener('pointerup', () => { if (pressing) void useHeld('up'); }); btn.addEventListener('pointercancel', () => { if (pressing) void useHeld('up'); });
      box.prepend(btn); }
    btn.style.display = id ? '' : 'none'; if (g) btn.textContent = g.use.down ?? g.use.up; };
  bus.on('holds', () => setTimeout(sync, 0));
}

// ---------------------------------------------------------------- VR hands (xr.js calls xrHand per hand)
// grip takes the nearest within NEAR_GRAB × scale (priority, a grip for this hand, distance), else the laser to grabbable.range.
// Release throws at the velocity averaged over AVG_MS; trigger is use; the other hand takes or swaps.
const AVG_MS = 100;
const vrHands = { left: { grip: false, trig: false, hist: [], hover: null, busy: false }, right: { grip: false, trig: false, hist: [], hover: null, busy: false } };
const _bx = new THREE.Box3(), _hv = new THREE.Vector3();
const heldIn = (side) => { for (const [id, h] of Object.entries(holds)) if (h.by === net.you && (h.hand === side || h.second?.hand === side)) return id; return null; };
function nearest4(side, at, scale) {
  const R = NEAR_GRAB * (scale || 1); let best = null;
  for (const id of grabbableIds()) {
    if (holds[id]?.by === net.you && (holds[id].hand === side || holds[id].second?.hand === side)) continue;   // already in this hand
    const obj = entities.get(id); if (!obj || outOfMyView(obj)) continue;
    const d = _bx.setFromObject(obj).distanceToPoint(at); if (d > R) continue;
    const g = grabOf(compsOf(id)); const k = [g.priority, pickGrip(g, side) ? 1 : 0, -d];
    if (!best || k[0] > best.k[0] || (k[0] === best.k[0] && (k[1] > best.k[1] || (k[1] === best.k[1] && k[2] > best.k[2])))) best = { id, k };
  }
  return best?.id ?? null;
}
/** One hand, one frame. pick(): the laser's first entity {id, dist} or null; haptic(v, ms).
 *  {holding, took} tells xr.js the hand is busy (no panel chord or select with it). */
export function xrHand(side, { pos, grip, mayTake = true, trig, pick, scale = 1, haptic = () => {}, now = performance.now() }) {
  const H = vrHands[side]; if (!H || !pos || !replica.active) return { holding: null };
  H.hist.push({ t: now, p: [pos.x, pos.y, pos.z] }); while (H.hist.length > 2 && now - H.hist[0].t > AVG_MS) H.hist.shift();
  const mine = heldIn(side); const g = mine ? grabOf(compsOf(mine)) : null;
  const near = !mine && !H.busy ? nearest4(side, pos, scale) : null;
  if (near && near !== H.hover) haptic(0.15, 10); H.hover = near;
  let took = false;
  if (grip && !H.grip && !H.busy) {
    if (mine && g?.hold === 'toggle') void vrLetGo(side, mine);
    else if (!mine && mayTake) { let id = near;
      if (!id) { const hit = pick?.(); const hg = hit ? grabOf(compsOf(hit.id)) : null; const obj = hit ? entities.get(hit.id) : null;
        if (hg?.enabled && obj && obj.getWorldPosition(_hv).distanceTo(pos) <= hg.range) id = hit.id; }
      if (id) { took = true; void vrTake(side, id, !near, haptic); } }
  }
  if (!grip && H.grip && mine && g?.hold !== 'toggle') void vrLetGo(side, mine);
  if (mine && g?.use) { if (trig && !H.trig) void useHeld('down', mine); else if (!trig && H.trig) void useHeld('up', mine); }
  H.grip = grip; H.trig = trig;
  return { holding: mine, took };
}
// held where grabbed, in the palm's frame
function offsetIn(side, id) {
  const obj = entities.get(id); const palm = palmOf(net.you, side, { p: new THREE.Vector3(), q: new THREE.Quaternion() }); if (!obj || !palm) return null;
  obj.updateWorldMatrix(true, false); const qi = palm.q.clone().invert();
  const p = obj.getWorldPosition(new THREE.Vector3()).sub(palm.p).applyQuaternion(qi);
  if (p.length() > 1.9) return null;
  const q = qi.multiply(obj.getWorldQuaternion(new THREE.Quaternion()));
  return { pos: p.toArray().map(r3), q: q.normalize().toArray().map((n) => Math.round(n * 1e6) / 1e6) };
}
async function vrTake(side, id, far, haptic) {
  const H = vrHands[side]; H.busy = true;
  try {
    const g = grabOf(compsOf(id)); const off = !far && !Object.keys(g?.grips ?? {}).length ? offsetIn(side, id) : null;
    await track(true);
    const r = await sendRequest('grab', { id, hand: side, ...(off ? { offset: off } : {}) });
    if (r?.ok) haptic(0.4, 30); else { haptic(0.25, 25); setTimeout(() => haptic(0.25, 25), 90); refused('grab', r, id); }   // a refusal: two short pulses
    H.busy = false;
    // the grip let go before the answer: press-to-hold lets go now, never stuck
    if (r?.ok && !H.grip && grabOf(compsOf(id))?.hold !== 'toggle') await vrLetGo(side, id);
    return r;
  } finally { H.busy = false; }
}
async function vrLetGo(side, id) {
  const H = vrHands[side]; const h = holds[id]; H.busy = true;
  try {
    if (h?.second) { await track(true); return await sendRequest('drop', { id, hand: side }); }   // the other hand keeps it
    const a = H.hist[0], b = H.hist[H.hist.length - 1]; const dt = a && b ? (b.t - a.t) / 1000 : 0;
    const v = dt > 0.02 ? b.p.map((x, i) => (x - a.p[i]) / dt) : [0, 0, 0];
    return await release(v, id);
  } finally { H.busy = false; }
}

// ---------------------------------------------------------------- keys: T take/put · C throw/punt
const KEYS = [
  { code: 'KeyT', key: 'T', id: 'body:take', title: 'pick up / put down', keywords: ['grab', 'carry', 'hold', 'take', 'put'], icon: 'hand',
    run: () => (myHolds().length ? put() : grab()) },
  { code: 'KeyC', key: 'C', id: 'body:throw', title: 'throw what you hold / punt what\'s beside you', keywords: ['throw', 'kick', 'punt', 'toss'],
    run: () => (myHolds().length ? throwHeld(hooks?.aim?.() ?? undefined) : punt()) },   // aim(): the spot under the cursor (main.js)
];
for (const { code, ...a } of KEYS) registerAction({ ...a, group: 'body' });
bus.on('key', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || hooks?.editing?.()) return;
  KEYS.find((k) => k.code === e.code)?.run();
});

/** The hint bar's hands line (localbody.js updateSeatHint). Null in a headset, in edit mode, outside a world. */
export function handsHint() {
  if (!replica.active || hooks?.editing?.() || xrActive()) return null;
  const held = myHolds()[0];
  if (held) return html`holding <b>${nameOf(held) ?? held}</b> — click a spot to set it down there · <kbd>T</kbd> at your feet · <kbd>C</kbd> throws at the cursor · right-click for more`;
  const near = nearest(inHand, grabbableIds(), prioOf);
  return near ? html`click or <kbd>T</kbd> to pick up <b>${nameOf(near) ?? near}</b>` : null;
}

// a let-go starts as drawn, but never past REACH of the authority's hand (a two-armed carry is drawn out; the track lags)
const letGoAt = (pos) => { const f = feet(); if (!pos || !f) return pos; const h = new THREE.Vector3(f[0], f[1] + HAND_Y, f[2]);
  const d = pos.distanceTo(h), lim = REACH - 0.15; return d <= lim ? pos : h.lerp(pos, lim / d); };
const canPutAt = (x, y, z) => { const f = feet(); return !!f && Math.hypot(x - f[0], y - (f[1] + HAND_Y), z - f[2]) <= REACH - 0.08; };   // reach, with a margin
const inReach = (id) => { const f = feet(), p = whereIs(id); return !!f && !!p && inHand(p, f, id) !== null; };
const canPunt = (id) => { const f = feet(), p = whereIs(id); return !!f && !!p && atFeet(p, f) !== null; };
/** {at: [x, y, z], flat: distance along the floor} or null. */
const whereFromMe = (id) => { const f = feet(), p = whereIs(id); return f && p ? { at: p, flat: Math.hypot(p[0] - f[0], p[2] - f[2]) } : null; };
/** The surface a runtime mod scripts against (mods.js EW.physics): the same requests the keys send. */
export const physicsApi = { grab, put, drop, throw: throwHeld, punt, canPunt, grabNear, release, use: useHeld, xrHand, holds: holdsNow, mine: myHolds, shown: simShown, pending: pendingNow, swaps: () => stats.swaps, predict: (on) => (predictOn = on !== false), lag: (ms) => (lagMs = Math.max(0, ms | 0)), settle: (ms) => (SETTLE_MS = Math.max(0, ms | 0)), settling: () => [...settles.keys()], whereIs, inReach, whereFromMe, canPutAt,
  /** body shove: the lab knob, the log, the things my body is against now */
  shove: { on: (on) => (shoveOn = on !== false), log: () => shoveLog.slice(), touching: () => shover.touching(), feel: () => shover.feel,
    against: () => { const f = feet(), cap = colliderFor(hooks?.me?.()?.userScale); if (!f || !replica.st) return [];
      return dynamicIds().filter((id) => { const obb = obbOf(replica.st, id); return obb && contactOf(f, cap.r, cap.tall, { obb, box: aabbOfObb(obb) }, shover.feel.slack); }); } },
  /** the held things whose fx this client is drawing now (grabbable's presence tier) */
  fx: () => pressFxOn(),
  /** shared/grab.js grabOf over this client's fold, or null */
  grabbable: (id) => grabOf(compsOf(id)),
  /** probe surface: where a held thing should be drawn now beside where it is drawn */
  heldAt: (id) => { const h = holds[id], obj = entities.get(id); if (!h || !obj) return null; obj.updateWorldMatrix(true, false);
    const at = placeHeld(id, h, obj); return { want: at ? { p: at.p.toArray(), q: at.q?.toArray() ?? null } : null, drawn: { p: obj.getWorldPosition(new THREE.Vector3()).toArray(), q: obj.getWorldQuaternion(new THREE.Quaternion()).toArray() }, rec: h }; },
  /** probe surface: the palm frame a holder's hand gives ({p, q} world arrays), and the hold pose a body wears */
  palm: (actorId, side = 'right') => { const o = palmOf(actorId ?? net.you, side, { p: new THREE.Vector3(), q: new THREE.Quaternion() }); return o ? { p: o.p.toArray(), q: o.q.toArray() } : null; },
  track: () => track(true), request: (verb, args) => sendRequest(verb, args), frame: (wall) => frame(wall),
  /** the canonical fold's flights: id -> the launch seq it flies from */
  launched: () => Object.fromEntries(Object.entries(replica.sim?.launched ?? {}).map(([id, l]) => [id, l.seq])),
  /** what this client believes about its authority-tracked body (diagnostics) */
  body: () => ({ arrived, trackedAt, feet: feet(), lastMove, stats: { ...stats, ms: Math.round(stats.ms), maxMs: +stats.maxMs.toFixed(2) } }) };
