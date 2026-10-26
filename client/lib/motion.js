// motion — the world's moving parts, as functions of time.
//
// A motion component is PARAMETERS, never frames: every client evaluates the same closed form f(params, t) at its own
// now, composed onto the logged base pose. Nothing integrates; zero ongoing traffic. The server folds types blindly;
// older clients just don't animate them.
//
// Types:
//   pendulum {axis, pivot, amp, period, phase, damp, maxAmp, t0}   — swings
//   spin     {axis?, pivot?, degPerSec|period, phase?, t0}         — windmills, carousels
//   orbit    {center?, radius, degPerSec|period, phase?, face?, t0} — ferries, birds (rateOf: the one reading)
//   oscillate {axis?, amp, period, phase?, t0}                     — back and forth along an axis (a sine): hover, buoys, pistons
//   path     {points, speed|duration, loop?: 'loop'|'pingpong'|'once', face?, t0}
//
// Parts: a `motion:<slot>` component naming a `node` (motioneval.js motionNode) animates one named node of the model.
// Pivot/axis are in the part node's own frame (default pivot = its origin); oscillate/orbit/path positions in its
// parent's frame, the frame `measure` reports. A removed part motion eases back to rest.

import { THREE, camera } from './core.js';
import { entities, bags, bagOf, findPart } from './world.js';
import { reindexCollider } from './colliders.js';
import { serverNow } from './remotes.js';
// The closed forms and the generous reader live in motioneval.js (shared with the agent's perception, #82); this
// file applies evaluated transforms to THREE objects and owns the part-frame machinery.
import { evalWholeMotion, evalPath, axisOf, ampOf, since, pendulumTheta, rateOf } from './motioneval.js';
import { motionNode, motionType } from '../../shared/protocol/names.js';

const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _rp = new THREE.Vector3();

// Colliders re-index at a walk, not at frame rate — a moving thing's collider
// trails it by up to half a second, which is invisible next to the cost of
// re-indexing every mover every frame.
const lastIndexed = new Map();

// ---- sub-object machinery ---------------------------------------------------
// findPart (name → node, async-load-safe) lives in world.js now — mounting
// rides the same parts this module animates, so they share one lookup.

const _qb = new THREE.Quaternion();

/** rotateAtPivot's part-frame sibling: theta about `axis` at `pivot` (part-local) onto the rest transform; the pivot
 *  stays fixed in the parent's frame (a hinge, not a wobble). */
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

/** One motion type evaluated on a part, in part-local terms. */
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

/** "id\u0000part" -> part animated last frame, so a part whose motion vanishes returns to rest here (world.js only
 *  does that for whole entities). */
const _liveParts = new Map();
const _seenParts = new Set();

/** Once per frame, over entities with a motion component only. Epoch clock, NOT the rAF timestamp: t0s are sequencer
 *  stamps, and agreeing with other clients beats agreeing with vsync. */
// the camera's WORLD position: in XR camera.position is rig-local, so motion near you froze 90 m from spawn (11a M1)
const _eye = new THREE.Vector3();
const _wp = new THREE.Vector3();
export function tickMotion() {
  camera.getWorldPosition(_eye);   // in XR camera.position is only the head's offset inside the rig
  // The sequencer's clock, not the wall's: t0s are server stamps, and a skewed client would render the wrong phase.
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
      // a parented thing (userData.mountedTo) moves in its parent's frame: its base is execMount's local pose
      // distance gate (§14.2 6a): closed-form f(t), so a skipped far swing re-enters at exactly the right phase
      const at = obj.userData.mountedTo ? obj.getWorldPosition(_wp) : obj.position;
      if (at.distanceToSquared(_eye) > 8100) continue;   // 90m, from the camera's WORLD position (review 11a M1)
      const t = since(m, nowMs);
      const partName = motionNode(key, m);   // the node it moves: its value's `node` (motioneval.js)

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
        // motioneval.js is the single source of the closed forms; the agent's look() runs the same call (#82)
        // the entity's pivot component is the default hinge, in its parent's units: scaled by its own scale
        const pv = bagOf(id)?.pivot?.pos;
        const r = evalWholeMotion(Array.isArray(pv) && pv.length === 3 ? { ...base, pivot: [pv[0] * obj.scale.x, pv[1] * obj.scale.y, pv[2] * obj.scale.z] } : base, m, nowMs);
        if (!r.ok) {
          // A motion this evaluator won't vouch for (unknown type, malformed
          // path): the thing stands still here and moves for newer clients.
          // Forward-compatible, never an error.
          continue;
        }
        obj.position.set(...r.pos);
        // rot:false = this motion leaves authored rotation alone (oscillate;
        // face:false orbit/path) — matching the old per-case behavior.
        if (r.rot) obj.quaternion.set(...r.quat);
      }
      const li = lastIndexed.get(id) ?? 0;
      if (nowMs - li > 500) { lastIndexed.set(id, nowMs); reindexCollider(id); }
    }
  }
  // parts whose motion vanished this frame return to their rest pose
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

// Motion ended ({type: null}): world.js restores the base pose itself (importing us back would be circular). A thing
// resting away from base (a ferry stopping mid-route) gets a `place` from the stopper.

// Motion fields are declared in shared/editschema.js. No live preview on purpose: this module doesn't own the bag.
