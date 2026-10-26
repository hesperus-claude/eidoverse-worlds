// rigmeasure — what the body engines MEASURE and how they SPEAK. The Verlet (ragdoll.js) and Bullet (ammodoll.js)
// engines stay different machines; this holds only what they must agree on: the 12-segment body cut, the
// segment-vs-segment closest-point solve, the rest rig frame, and the {j,p,v} handover snapshot. That snapshot is a
// wire format across engines and machines, so pack and parse stay one. Shared lifecycle: bodyengine.js.

import { THREE } from './core.js';

// ---------------------------------------------------------------------------
// the body cut
// ---------------------------------------------------------------------------

// Which bones a body engine drives, each as (bone -> the child joint it points at): a reduced set, stable and small on
// the wire. Order matters: parents before children (verlet drive walk and limit sweep, bullet build order).
// Driving the PELVIS is what lets a body lie down. The one place a segment is added or renamed.
export const SEGMENTS = [
  ['hips', 'spine'],
  ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
];

// Every joint tracked as a particle / segment endpoint (bones + leaf children).
export const JOINTS = [...new Set(SEGMENTS.flat())];

// The bones an engine writes; everything else is the locomotion mixer's and is parked by avatar.setLimp around this list.
export const DRIVEN_BONES = SEGMENTS.map(([bone]) => bone);

// ---------------------------------------------------------------------------
// segment geometry
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _sd = { s: 0, t: 0 };

/** Closest points between two segments, as parameters along each. The classic
 *  clamped-parametric solve; degenerate (zero-length) segments fall back to an
 *  endpoint rather than dividing by zero. Both engines' self-collision builds
 *  run this — it was spelled twice, differently, before this file. */
export function closestParams(p1, q1, p2, q2, out) {
  _a.copy(q1).sub(p1); _b.copy(q2).sub(p2); _c.copy(p1).sub(p2);
  const A = _a.dot(_a), E = _b.dot(_b), F = _b.dot(_c);
  let s, t;
  if (A < 1e-9 && E < 1e-9) { out.s = 0; out.t = 0; return; }
  if (A < 1e-9) { s = 0; t = THREE.MathUtils.clamp(F / E, 0, 1); }
  else {
    const C = _a.dot(_c);
    if (E < 1e-9) { t = 0; s = THREE.MathUtils.clamp(-C / A, 0, 1); }
    else {
      const B = _a.dot(_b), den = A * E - B * B;
      s = den > 1e-9 ? THREE.MathUtils.clamp((B * F - C * E) / den, 0, 1) : 0;
      t = (B * s + F) / E;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-C / A, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((B - C) / A, 0, 1); }
    }
  }
  out.s = s; out.t = t;
}

/** Distance between two segments — closestParams, evaluated. */
export function segDistance(p1, q1, p2, q2) {
  closestParams(p1, q1, p2, q2, _sd);
  _p1.copy(p1).lerp(q1, _sd.s);
  _p2.copy(p2).lerp(q2, _sd.t);
  return _p1.distanceTo(_p2);
}

// ---------------------------------------------------------------------------
// the rig frame
// ---------------------------------------------------------------------------

/** The rig's anatomical frame, measured from a map of rest WORLD positions:
 *  up along the trunk, lateral across the shoulders (hips as fallback),
 *  forward as their cross product — which comes out correct for VRM 0.x and
 *  1.0 alike without needing to know which (they face opposite ways on +Z,
 *  and the lateral vector flips with them, so the cross product cancels the
 *  convention out). Every value is a fresh vector; callers own them. */
export function rigFrameOf(restP) {
  const up = (restP.neck ?? restP.chest ?? restP.spine ?? restP.head)
    ?.clone().sub(restP.hips ?? new THREE.Vector3()).normalize() ?? new THREE.Vector3(0, 1, 0);
  const lateral = restP.leftUpperArm && restP.rightUpperArm
    ? restP.leftUpperArm.clone().sub(restP.rightUpperArm)
    : (restP.leftUpperLeg && restP.rightUpperLeg
      ? restP.leftUpperLeg.clone().sub(restP.rightUpperLeg)
      : new THREE.Vector3(1, 0, 0));
  lateral.addScaledVector(up, -lateral.dot(up));
  if (lateral.lengthSq() < 1e-9) lateral.set(1, 0, 0);
  lateral.normalize();
  const forward = new THREE.Vector3().crossVectors(lateral, up).normalize();
  return { up, lateral, forward };
}

// ---------------------------------------------------------------------------
// the handover format
// ---------------------------------------------------------------------------

/** Builder for the {j,p,v} handover snapshot — joint names, world positions,
 *  world velocities, flat-packed and rounded. Rounded on purpose: this rides a
 *  presence message, and a millimetre and a millimetre-per-second are far
 *  below what anyone can see. Both engines' snapshot() speaks through this so
 *  the format cannot fork. */
export function snapshotPacker() {
  const j = [], p = [], v = [];
  return {
    add(name, pos, vel) {
      j.push(name);
      // FULL PRECISION: a handover is the same chaotic body on another machine, and rounding diverges by cm within
      // eighty steps (§24t-8). JSON's shortest round-trip formatting is exact.
      p.push(pos.x, pos.y, pos.z);
      v.push(vel.x, vel.y, vel.z);
    },
    pack() { return { j, p, v }; },
  };
}

/** Iterate a handover snapshot ({j,p,v}, optional dy height shift): yields
 *  { name, px,py,pz, vx,vy,vz } per joint, dy already applied to the position.
 *  The parse half of snapshotPacker, and the other place the format used to
 *  be spelled twice. */
export function* seedJoints(seed) {
  const { j: names, p: pos, v: vel, dy = 0 } = seed;
  for (let i = 0; i < names.length; i++) {
    const k = i * 3;
    yield {
      name: names[i],
      px: pos[k], py: pos[k + 1] + dy, pz: pos[k + 2],
      vx: vel[k], vy: vel[k + 1], vz: vel[k + 2],
    };
  }
}
