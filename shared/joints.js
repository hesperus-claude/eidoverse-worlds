// shared/joints.js — what a humanoid joint may do, measured against the shipped rigs (tools/ragdoll-test.ts). One table for
// the ragdoll (tumbling) and the IK (shared/reach.js), so a reach and a fall are one body. DEGREES, as authored; consumers convert.

// BEHIND — how far a limb may point behind the frontal plane: one-sided, since tilting the cone to bound a hip's back walls off abduction
export const BEHIND = [
  ['leftUpperLeg', 'leftLowerLeg', 30],
  ['rightUpperLeg', 'rightLowerLeg', 30],
  ['leftUpperArm', 'leftLowerArm', 65],       // a shoulder does reach back
  ['rightUpperArm', 'rightLowerArm', 65],
];

// CONE — relative to the BODY, not the parent link, so a limit means the same on T- and A-pose rigs. `tilt` leans the axis
// forward (a thigh swings far forward, barely back).
export const CONE = [
  // bone           child            half°  tilt° (toward body forward)
  // arms carry a fifth number, ACROSS below (reach only; the ragdoll reads [2] and [3])
  ['leftUpperArm',  'leftLowerArm',   85,    0,   135],
  ['rightUpperArm', 'rightLowerArm',  85,    0,   135],
  ['leftUpperLeg',  'leftLowerLeg',   55,   25],
  ['rightUpperLeg', 'rightLowerLeg',  55,   25],
];

// HINGE — a signed fold (knees back, elbows forward); handedness from _frame, `dir` the fold direction. `sideways` is slop,
// not range, and can't be zero (no hip or shoulder rotation to absorb twist): smallest stable values.
// TWIST — a bone's roll as real state (inertia, damping, spring to neutral, hard stop at `max`°). Measured against the
// parent, never the world (which drifts by holonomy); well posed because the limits forbid a 180° swing from the parent.
export const TWIST = {
  spine: 25, chest: 25, neck: 45,
  leftUpperArm: 75, rightUpperArm: 75,
  leftLowerArm: 80, rightLowerArm: 80,     // pronation/supination
  leftUpperLeg: 40, rightUpperLeg: 40,
  leftLowerLeg: 25, rightLowerLeg: 25,
};
// Which bone each one twists AGAINST. The drive walks CHAINS parents-first, so a parent's frame resolves before its children ask.
export const TWIST_PARENT = {
  spine: 'hips', chest: 'spine', neck: 'chest',
  leftUpperArm: 'chest', rightUpperArm: 'chest',
  leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm',
  leftUpperLeg: 'hips', rightUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg',
};

export const HINGE = [
  // a               b                 c            dir  maxFlex°  sideways°
  ['leftUpperArm',  'leftLowerArm',  'leftHand',    +1,   145,      12],
  ['rightUpperArm', 'rightLowerArm', 'rightHand',   +1,   145,      12],
  ['leftUpperLeg',  'leftLowerLeg',  'leftFoot',    -1,   150,       6],
  ['rightUpperLeg', 'rightLowerLeg', 'rightFoot',   -1,   150,       6],
];

/** Radians. */
export const D2R = Math.PI / 180;

/**
 * The rest direction leaned `tilt` degrees forward, in BODY-FRAME coordinates: centred where that rig's limb rests, turning with the torso.
 * @param {number[]} restDirBody bone->child rest direction, already expressed
 *        in body-frame coordinates [right, up, forward]
 * @param {number} tiltDeg lean toward forward, degrees
 * @returns {number[]} unit axis in body-frame coordinates
 */
export function coneAxisBody(restDirBody, tiltDeg) {
  const a = [...restDirBody];
  if (tiltDeg) {
    // the forward component perpendicular to the axis: a pure sagittal rotation, not a shortening
    const f = [-a[2] * a[0], -a[2] * a[1], 1 - a[2] * a[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl > 1e-4) {
      const t = Math.tan(tiltDeg * D2R) / fl;
      a[0] += f[0] * t; a[1] += f[1] * t; a[2] += f[2] * t;
    }
  }
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** In the shape shared/reach.js wants. Angles come out in RADIANS. */
export function limitsFor(bone) {
  const cone = CONE.find((c) => c[0] === bone);
  const behind = BEHIND.find((b) => b[0] === bone);
  const hinge = HINGE.find((h) => h[0] === bone);
  return {
    ...(cone ? { coneHalf: cone[2] * D2R, coneTilt: cone[3],
                 ...(cone[4] != null ? { coneAcross: cone[4] * D2R } : {}) } : {}),
    ...(behind ? { behind: behind[2] * D2R } : {}),
    ...(hinge ? { maxFlex: hinge[4] * D2R, hingeDir: hinge[3], hingeSide: hinge[5] * D2R } : {}),
    ...(TWIST[bone] != null ? { twistMax: TWIST[bone] * D2R } : {}),
    // the forearm's roll turns a palm over, so a chain rooted at the upper arm needs its CHILD's twist limit
    ...(hinge && TWIST[hinge[1]] != null ? { foreTwistMax: TWIST[hinge[1]] * D2R } : {}),
    ...(TWIST_PARENT[bone] ? { twistParent: TWIST_PARENT[bone] } : {}),
  };
}

/** root -> mid -> end. */
export const REACH_CHAINS = {
  leftHand:  { root: 'leftUpperArm',  mid: 'leftLowerArm',  end: 'leftHand' },
  rightHand: { root: 'rightUpperArm', mid: 'rightLowerArm', end: 'rightHand' },
  leftFoot:  { root: 'leftUpperLeg',  mid: 'leftLowerLeg',  end: 'leftFoot' },
  rightFoot: { root: 'rightUpperLeg', mid: 'rightLowerLeg', end: 'rightFoot' },
};

/**
 * The ragdoll's `_frame` construction (pelvis bar right, hips to head up, their cross forward), but pure: from the REST pose,
 * which is never degenerate.
 * @param {Record<string, number[]>} P bone -> [x,y,z]
 * @returns {{r: number[], u: number[], f: number[]}|null}
 */
export function bodyFrame(P) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-5 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

  let r = (P.leftUpperLeg && P.rightUpperLeg) ? norm(sub(P.leftUpperLeg, P.rightUpperLeg))
        : (P.leftUpperArm && P.rightUpperArm) ? norm(sub(P.leftUpperArm, P.rightUpperArm)) : null;
  let u = (P.head && P.hips) ? norm(sub(P.head, P.hips))
        : (P.chest && P.hips) ? norm(sub(P.chest, P.hips)) : null;
  r ??= [1, 0, 0];
  u ??= [0, 1, 0];
  const f = norm(cross(r, u));
  if (!f) return null;
  const r2 = norm(cross(u, f)) ?? r;
  return { r: r2, u, f };
}

/** A world-space direction, expressed in body-frame coordinates. */
export const toBody = (v, F) => [
  v[0] * F.r[0] + v[1] * F.r[1] + v[2] * F.r[2],
  v[0] * F.u[0] + v[1] * F.u[1] + v[2] * F.u[2],
  v[0] * F.f[0] + v[1] * F.f[1] + v[2] * F.f[2],
];

/** ...and back out again. */
export const fromBody = (b, F) => [
  b[0] * F.r[0] + b[1] * F.u[0] + b[2] * F.f[0],
  b[0] * F.r[1] + b[1] * F.u[1] + b[2] * F.f[1],
  b[0] * F.r[2] + b[1] * F.u[2] + b[2] * F.f[2],
];

// self-collision radii as fractions of the torso radius, which is measured from the body's shoulder/hip span
export const RADIUS_FRAC = {
  hips: 1.0, spine: 0.95, chest: 1.0, neck: 0.5, head: 0.75,
  leftUpperArm: 0.5, rightUpperArm: 0.5, leftLowerArm: 0.35, rightLowerArm: 0.35,
  leftHand: 0.3, rightHand: 0.3,
  leftUpperLeg: 0.55, rightUpperLeg: 0.55, leftLowerLeg: 0.4, rightLowerLeg: 0.4,
  leftFoot: 0.35, rightFoot: 0.35,
};


/**
 * MEASURED as the ragdoll does: half the wider of the shoulder or hip span, else a fraction of the spine.
 * @param {Record<string, number[]>} P rest bone positions
 */
export function torsoRadius(P) {
  const d = (a, b) => (P[a] && P[b]
    ? Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]) : 0);
  const shoulderW = d('leftUpperArm', 'rightUpperArm');
  const hipW = d('leftUpperLeg', 'rightUpperLeg');
  const spineLen = d('hips', 'head') || 0.5;
  return Math.min(0.25, Math.max(0.05, (Math.max(shoulderW, hipW) * 0.42) || spineLen * 0.26));
}

/** Capsule radius for one bone on a body of the given torso radius. */
export const boneRadius = (bone, torsoR) => torsoR * (RADIUS_FRAC[bone] ?? 0.4);

/** The torso column, the head, the thighs and the OTHER arm. The caller excludes chain-owned bones (a limb can't hit itself). */
export const GUARD_SEGMENTS = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['hips', 'leftUpperLeg'], ['hips', 'rightUpperLeg'],
  ['leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightLowerLeg'],
  ['leftUpperArm', 'leftLowerArm'], ['rightUpperArm', 'rightLowerArm'],
  ['leftLowerArm', 'leftHand'], ['rightLowerArm', 'rightHand'],
];

// ACROSS — how far a limb may swing toward the midline. Safe only with shared/reach.js's torso projection, or the arm swings
// into the chest. Reach only; the ragdoll keeps the plain cone.
