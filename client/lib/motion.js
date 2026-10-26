// motion — the world's moving parts, as functions of time.
//
// PARAMETERS, never frames: every client evaluates the same closed form f(params, t) onto the logged base pose.
// Nothing integrates, no ongoing traffic; the server folds types blindly, older clients just don't animate them.
//
// Types:
//   pendulum {axis, pivot, amp, period, phase, damp, maxAmp, t0}   — swings
//   spin     {axis?, pivot?, degPerSec|period, phase?, t0}         — windmills, carousels
//   orbit    {center?, radius, degPerSec|period, phase?, face?, t0} — ferries, birds (rateOf: the one reading)
//   oscillate {axis?, amp, period, phase?, t0}                     — back and forth along an axis (a sine): hover, buoys, pistons
//   path     {points, speed|duration, loop?: 'loop'|'pingpong'|'once', face?, t0}
//
// Parts: a `motion:<slot>` naming a `node` animates that node. Pivot/axis are in the node's own frame; oscillate/orbit/
// path positions in its parent's (the frame `measure` reports). A removed part motion returns to rest. See docs/research/motion.md.

import { THREE, camera } from './core.js';
import { entities, bags, bagOf, findPart } from './world.js';
import { reindexCollider } from './colliders.js';
import { serverNow } from './remotes.js';
// the closed forms are motioneval.js's (shared with the agent's perception, #82); this file applies them to THREE objects
import { evalWholeMotion, evalPath, axisOf, ampOf, since, pendulumTheta, rateOf } from './motioneval.js';
import { motionNode, motionType } from '../../shared/protocol/names.js';

const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _rp = new THREE.Vector3();

// colliders re-index every 500 ms, not per frame: a mover's collider trails it by up to half a second
const lastIndexed = new Map();

// ---- sub-object machinery ---------------------------------------------------

const _qb = new THREE.Quaternion();

/** theta about `axis` at `pivot` (part-local) onto the rest transform; the pivot stays fixed (a hinge, not a wobble). */
function rotatePartAtPivot(obj, pbase, axis, pivot, theta) {
  _ax.set(...(axis ?? [0, 1, 0])).normalize();
  _q.setFromAxisAngle(_ax, theta);
  _qb.fromArray(pbase.quat);
  obj.quaternion.copy(_qb).multiply(_q);
  _pv.set(...(pivot ?? [0, 0, 0]));
  _rp.copy(_pv).applyQuaternion(_q);          // pivot after rotation
  _pv.sub(_rp).applyQuaternion(_qb);          // shift that keeps the pivot fixed
  obj.position.set(...pbase.pos).add(_pv);
}

function evalPart(m, t, obj, pbase) {
  switch (motionType(m)) {
    case 'pendulum':
      rotatePartAtPivot(obj, pbase, axisOf(m, [1, 0, 0]), m.pivot ?? [0, 0, 0], pendulumTheta(m, t));
      return true;
    case 'spin': {
      const rate = rateOf(m, 36);
      rotatePartAtPivot(obj, pbase, axisOf(m, [0, 1, 0]), m.pivot ?? [0, 0, 0],
        (m.phase ?? 0) + (rate * Math.PI / 180) * t);
      return true;
    }
    case 'oscillate': {
      const off = Math.sin((2 * Math.PI / (m.period ?? 4)) * t + (m.phase ?? 0)) * ampOf(m, 0.3);
      _ax.set(...axisOf(m, [0, 1, 0])).normalize();
      obj.position.set(...pbase.pos).addScaledVector(_ax, off);
      return true;
    }
    case 'orbit': {
      const c = m.center ?? pbase.pos;
      const r = m.radius ?? 1;
      const a = (m.phase ?? 0) + (rateOf(m, 12) * Math.PI / 180) * t;
      obj.position.set(c[0] + r * Math.sin(a), (c[1] ?? pbase.pos[1]), c[2] + r * Math.cos(a));
      if (m.face !== false) obj.rotation.set(0, a + Math.PI / 2, 0);
      return true;
    }
    case 'path': {
      const r = evalPath(m, t, { pos: pbase.pos, yaw: 0 });
      if (!r.ok) return false;   // malformed path: the part rests, like an unknown type
      obj.position.set(...r.pos);
      if (r.rot) obj.rotation.set(0, r.yaw, 0);
      return true;
    }
    default:
      return false;   // unknown type: the part rests here, moves for newer clients
  }
}

/** "id\u0000part" -> part animated last frame, so a vanished part motion returns to rest (world.js does wholes only). */
const _liveParts = new Map();
const _seenParts = new Set();

const _eye = new THREE.Vector3();
const _wp = new THREE.Vector3();
/** Once per frame. The sequencer's clock, NOT rAF's or the wall's: t0s are server stamps; agree with clients, not vsync. */
export function tickMotion() {
  camera.getWorldPosition(_eye);   // WORLD: in XR camera.position is rig-local, and motion froze 90 m from spawn
  const nowMs = serverNow();
  _seenParts.clear();
  for (const [id, bag] of bags()) {
    for (const key in bag) {
      const isWhole = key === 'motion';
      if (!isWhole && !key.startsWith('motion:')) continue;
      const m = bag[key];
      if (!m || !m.type) continue;
      const obj = entities.get(id);
      if (!obj) continue;
      // distance gate (§14.2 6a): closed-form f(t), so a skipped far swing re-enters at the right phase
      const at = obj.userData.mountedTo ? obj.getWorldPosition(_wp) : obj.position;
      if (at.distanceToSquared(_eye) > 8100) continue;   // 90 m
      const t = since(m, nowMs);
      const partName = motionNode(key, m);

      if (partName) {
        const part = findPart(obj, partName);
        if (!part) continue;   // not loaded yet (or misnamed) — retry next second
        const pbase = part.userData.mbase
          ?? (part.userData.mbase = { pos: part.position.toArray(), quat: part.quaternion.toArray() });
        if (evalPart(m, t, part, pbase)) {
          const k = `${id}\u0000${partName}`;
          _seenParts.add(k);
          _liveParts.set(k, part);
        }
      } else {
        const base = obj.userData.base
          ?? (obj.userData.base = { pos: obj.position.toArray(), yaw: obj.rotation.y });
        // the pivot component is the default hinge, in the parent's units: scaled by the entity's own scale
        const pv = bagOf(id)?.pivot?.pos;
        const r = evalWholeMotion(Array.isArray(pv) && pv.length === 3 ? { ...base, pivot: [pv[0] * obj.scale.x, pv[1] * obj.scale.y, pv[2] * obj.scale.z] } : base, m, nowMs);
        if (!r.ok) {
          // unknown type or malformed path: stands still here, moves for newer clients; never an error
          continue;
        }
        obj.position.set(...r.pos);
        // rot:false leaves authored rotation alone (oscillate; face:false orbit/path)
        if (r.rot) obj.quaternion.set(...r.quat);
      }
      const li = lastIndexed.get(id) ?? 0;
      if (nowMs - li > 500) { lastIndexed.set(id, nowMs); reindexCollider(id); }
    }
  }
  // vanished part motions return to rest
  for (const [k, part] of _liveParts) {
    if (_seenParts.has(k)) continue;
    _liveParts.delete(k);
    const b = part.userData.mbase;
    if (b && part.parent) {
      part.position.set(...b.pos);
      part.quaternion.fromArray(b.quat);
    }
    delete part.userData.mbase;
  }
}

// Motion ended ({type: null}): world.js restores the base pose (an import back would be circular); stopping away from
// base (a ferry mid-route) needs a `place` from the stopper. Fields: shared/editschema.js; no live preview (not our bag).
