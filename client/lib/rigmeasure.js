// rigmeasure — what the Verlet (ragdoll.js) and Bullet (ammodoll.js) body engines must agree on: the 12-segment cut,
// the segment closest-point solve, the rest rig frame, and the {j,p,v} handover snapshot (a wire format, so pack and
// parse stay one).

import { THREE } from './core.js';

// ---------------------------------------------------------------------------
// the body cut
// ---------------------------------------------------------------------------

// (bone -> the child joint it points at). Parents before children: both engines walk this order.
// Driving the PELVIS is what lets a body lie down. The one place a segment is added or renamed.
export const SEGMENTS = [
  ['hips', 'spine'],
  ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
];

// bones + leaf children
export const JOINTS = [...new Set(SEGMENTS.flat())];

// everything else is the locomotion mixer's, parked by avatar.setLimp
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

/** Closest points between two segments, as parameters along each (a zero-length segment falls back to an endpoint). */
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

export function segDistance(p1, q1, p2, q2) {
  closestParams(p1, q1, p2, q2, _sd);
  _p1.copy(p1).lerp(q1, _sd.s);
  _p2.copy(p2).lerp(q2, _sd.t);
  return _p1.distanceTo(_p2);
}

// ---------------------------------------------------------------------------
// the rig frame
// ---------------------------------------------------------------------------

/** From rest WORLD positions: lateral across the shoulders (hips fallback); forward is right for VRM 0.x and 1.0
 *  alike. Fresh vectors: callers own them. */
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

/** {j,p,v}: joint names, world positions and velocities, flat-packed. Both engines speak through it so it can't fork. */
export function snapshotPacker() {
  const j = [], p = [], v = [];
  return {
    add(name, pos, vel) {
      j.push(name);
      // FULL PRECISION: the same chaotic body on another machine; rounding diverges by cm within eighty steps (§24t-8)
      p.push(pos.x, pos.y, pos.z);
      v.push(vel.x, vel.y, vel.z);
    },
    pack() { return { j, p, v }; },
  };
}

/** The parse half of snapshotPacker: { name, px,py,pz, vx,vy,vz } per joint, the optional dy height shift applied. */
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
