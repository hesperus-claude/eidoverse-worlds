// shared/reach.js — two-bone inverse kinematics, bounded by the joint limits the ragdoll measures (shared/joints.js).
// Closed form, not CCD/FABRIK: every client solves the same reach independently, and only a closed form draws the same arm
// everywhere with no starting-state memory. The limits are consumed, never second-guessed: a reach and a fall are one body.
// Pure: numbers in, numbers out; the caller measures the skeleton and converts the answer back into rotations.

import { qMul as qMulq, qConj, qRotate as qRot, qAxisAngle } from './rot.js';

// ---- vector ops ------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : null; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Rodrigues: `v` about unit `axis` by `ang` radians. */
export function rotateAbout(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ];
}

/** Into a cone of half-angle `half` (radians) about `axis`; v unchanged when already inside. */
export function clampToCone(v, axis, half) {
  const c = dot(v, axis);
  const cosHalf = Math.cos(half);
  if (c >= cosHalf) return { v, clamped: false };
  // degenerate only when v is exactly antiparallel to the axis: pick a plane deterministically, never NaN
  let n = norm(cross(axis, v));
  if (!n) {
    const alt = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    n = norm(cross(axis, alt));
  }
  return { v: rotateAbout(axis, n, half), clamped: true };
}

/** Its forward component may not fall below `minFwd`: projects onto the frontal plane and renormalizes. */
export function clampBehind(v, fwd, minFwd) {
  const f = dot(v, fwd);
  if (f >= minFwd) return { v, clamped: false };
  let planar = norm(sub(v, mul(fwd, f)));
  if (!planar) {
    // v exactly antiparallel to forward: pick a direction deterministically (returning `fwd` would flip a limb reaching
    // backwards 180° in one frame)
    const alt = Math.abs(fwd[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    planar = norm(sub(alt, mul(fwd, dot(alt, fwd))));
    if (!planar) return { v, clamped: false };
  }
  const s = Math.sqrt(Math.max(0, 1 - minFwd * minFwd));
  return { v: add(mul(fwd, minFwd), mul(planar, s)), clamped: true };
}

/**
 * The end effector reaches `target` as nearly as the joints allow. World-space; lengths from the REST skeleton, never the
 * live one (live limits change with the walk cycle).
 * @param {object} o
 * @param {number[]} o.root    shoulder (or hip) world position
 * @param {number[]} o.target  where the hand (or foot) is wanted
 * @param {number} o.L1        rest length root->mid
 * @param {number} o.L2        rest length mid->end
 * @param {number[]} o.pole    world-space hint for which way the elbow points
 * @param {number[]} [o.fwd]   body forward axis, for the frontal-plane stop
 * @param {number[]} [o.coneAxis] cone axis in WORLD space (joints.js coneAxisBody's answer, carried out of the body frame by the caller)
 * @param {object} [o.limits]  { coneHalf, behind, maxFlex, minFlex } radians
 * @returns {{ok: true, upper: number[], lower: number[], elbow: number[],
 *            hand: number[], reached: boolean, gap: number,
 *            bound: string[], flex: number}
 *          | {ok: false, why: string}}
 */
export function solveTwoBone(o) {
  const { root, target, L1, L2 } = o;
  if (!(L1 > 1e-6) || !(L2 > 1e-6)) return { ok: false, why: "a bone in this limb has no length in this body's rig, so the limb can't be solved" };
  const to = sub(target, root);
  const d0 = len(to);
  if (d0 < 1e-6) {
    return { ok: false, why: "the target is on the limb's root joint itself (the shoulder, or the hip for a leg), so there's no direction to reach in; aim at a point away from that joint" };
  }

  const lim = o.limits ?? {};
  const bound = [];
  const aim = mul(to, 1 / d0);

  // ---- the triangle closes only for |L1-L2| <= d <= L1+L2; EPS keeps acos off its singular ends
  const EPS = 1e-6;
  let d = clamp(d0, Math.abs(L1 - L2) + EPS, L1 + L2 - EPS);
  if (d < d0 - 1e-12) bound.push('reach');

  let interior = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  let flex = Math.PI - interior;
  const maxFlex = lim.maxFlex ?? Math.PI;
  const minFlex = lim.minFlex ?? 0;
  if (flex > maxFlex || flex < minFlex) {
    flex = clamp(flex, minFlex, maxFlex);
    bound.push('hinge');
    // a clamped elbow changes the hand's distance, so rebuild the triangle from the angle; else the hand reaches the
    // target anyway by stretching the forearm
    interior = Math.PI - flex;
    d = Math.sqrt(Math.max(EPS, L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(interior)));
  }

  // ---- the bend plane, chosen by the pole hint
  let poleDir = o.pole ? norm(sub(o.pole, mul(aim, dot(o.pole, aim)))) : null;
  if (!poleDir) {
    // no usable hint (or one parallel to the aim): something deterministic and anatomically sane, never an arbitrary axis
    const alt = o.fwd ? mul(o.fwd, -1) : [0, -1, 0];
    poleDir = norm(sub(alt, mul(aim, dot(alt, aim))))
      ?? norm(sub([0, -1, 0], mul(aim, dot([0, -1, 0], aim))))
      ?? [0, 0, 1];
  }
  const axis = norm(cross(aim, poleDir));
  if (!axis) return { ok: false, why: 'cannot resolve a bend plane' };

  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));

  // ---- the upper bone's own direction is limited, not the aim line (they differ by alpha). Alternate cone and half-space
  // projections to a fixed point (convex caps < 90°, so it converges); bounded, and infeasibility is reported.
  let upper = rotateAbout(aim, axis, alpha);
  let hitCone = false, hitBehind = false, hitBody = false;

  // ---- the shoulder's envelope is not a circle: `inward` opens a wider allowance toward the midline, keyed on the
  // adduction the reach ASKS for before clamping (keyed on the clamped vector it never opens)
  const wantAdduction = o.inward ? clamp(dot(upper, o.inward), 0, 1) : 0;
  const coneHalfEff = (lim.coneAcross != null && o.inward)
    ? lim.coneHalf + (lim.coneAcross - lim.coneHalf) * wantAdduction
    : lim.coneHalf;

  // ---- the torso pushes the UPPER BONE in the same loop as the joint limits: widening the envelope alone points it through
  // the chest, and the elbow swivel can't fix that (the offending bone is the swivel's axis)
  const pushOutOfBody = (v) => {
    if (!o.guards?.length) return { v, moved: false };
    const rU = o.rUpper ?? 0;
    let out = v, moved = false;
    for (const g of o.guards) {
      // the upper bone only: resolving a forearm collision with the shoulder swings the whole arm away; the forearm stays
      // the swivel's business
      const min = g.r + rU * CONTACT;
      const w = g.warp;
      const elbow = add(root, mul(out, L1));
      const cc = segSegClosest(warpPt(root, w), warpPt(elbow, w), warpPt(g.a, w), warpPt(g.b, w));
      if (cc.d >= min) continue;
      const arm = sub(cc.c1, warpPt(root, w));
      const armLen = len(arm);
      if (armLen < 1e-4) continue;
      // the push direction is found in warped space and carried back, or the arm is shoved along an axis the body doesn't have
      const n = unwarpDir(norm(sub(cc.c1, cc.c2)) ?? [0, 0, 0], w);
      if (!n || !len(n)) continue;            // dead centre: no direction to push
      const ax = norm(cross(sub(elbow, root), n));
      if (!ax) continue;                      // already pushing along the bone
      const theta = Math.min(0.6, (min - cc.d) / Math.max(armLen, 1e-4));
      out = norm(rotateAbout(out, ax, theta)) ?? out;
      moved = true;
    }
    return { v: out, moved };
  };


  if ((o.coneAxis && lim.coneHalf != null) || (o.fwd && lim.behind != null) || o.guards?.length) {
    const minFwd = lim.behind != null ? -Math.sin(lim.behind) : null;
    let feasible = false;
    for (let pass = 0; pass < 24; pass++) {
      let moved = false;
      if (o.coneAxis && lim.coneHalf != null) {
        const c = clampToCone(upper, o.coneAxis, coneHalfEff);
        if (c.clamped) { upper = c.v; moved = true; hitCone = true; }
      }
      if (o.fwd && minFwd != null) {
        const b = clampBehind(upper, o.fwd, minFwd);
        if (b.clamped) { upper = b.v; moved = true; hitBehind = true; }
      }
      const p = pushOutOfBody(upper);
      if (p.moved) { upper = p.v; moved = true; hitBody = true; }
      if (!moved) { feasible = true; break; }
    }
    // report what binds AT THE FIXED POINT, not what fired on the way: a caller falls back on this list
    const onBoundary = (v, ref, want) => Math.abs(dot(v, ref) - want) < 1e-6;
    if (hitCone && o.coneAxis && onBoundary(upper, o.coneAxis, Math.cos(coneHalfEff))) bound.push('cone');
    if (hitBehind && o.fwd && onBoundary(upper, o.fwd, minFwd)) bound.push('behind');
    if (hitBody) bound.push('body');
    if (!feasible) bound.push('infeasible');
  }

  // ---- the forearm: aim at the target from wherever the elbow ended up, then the hinge has the last word. With nothing
  // bound above, this reproduces the analytic triangle exactly.
  const elbow = add(root, mul(upper, L1));
  const toTargetFromElbow = sub(target, elbow);
  let lower = norm(toTargetFromElbow) ?? [...upper];
  const back = mul(upper, -1);
  const inter = Math.acos(clamp(dot(back, lower), -1, 1));   // elbow interior angle
  const wantInter = clamp(inter, Math.PI - maxFlex, Math.PI - minFlex);
  if (Math.abs(wantInter - inter) > 1e-12) {
    if (!bound.includes('hinge')) bound.push('hinge');
    const n = norm(cross(back, lower)) ?? axis;
    lower = rotateAbout(back, n, wantInter);
  }
  const hand = add(elbow, mul(lower, L2));

  const gap = len(sub(target, hand));
  return {
    ok: true, upper, lower, elbow, hand,
    reached: gap <= 1e-4, gap, bound, flex,
  };
}

// ---- directions -> bone rotations ------------------------------------------
// a normalized VRM rig has identity rest rotations, so a bone's rotation IS the arc from rest to wanted direction, minus its
// parent's. Minimal arc leaves twist at zero: two-bone IK fixes the pole, twist belongs to the hand's aim.

/** Quaternion (x,y,z,w) taking unit `a` to unit `b`, by the shortest arc. */
export function qFromUnitVectors(a, b) {
  let w = 1 + dot(a, b);
  if (w < 1e-8) {
    // antiparallel: any perpendicular axis is a valid 180° turn
    const alt = Math.abs(a[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const ax = norm(cross(a, alt)) ?? [0, 0, 1];
    return [ax[0], ax[1], ax[2], 0];
  }
  const c = cross(a, b);
  const l = Math.hypot(c[0], c[1], c[2], w) || 1;
  return [c[0] / l, c[1] / l, c[2] / l, w / l];
}

export { qMulq, qConj, qRot, qAxisAngle };

/**
 * Rest and wanted directions in ONE common frame (where the rest pose has identity rotations: the avatar root's local
 * frame, not the world).
 * @returns {{upper: number[], lower: number[]}} local quaternions, ready to
 *          write onto the normalized bone nodes.
 */
export function chainLocalQuats(dRestUpper, dRestLower, dWantUpper, dWantLower, rest = null) {
  // `rest`: the rig's real rest orientations in the root's frame (qU/qL the two bones, qP the parent). null assumes identity,
  // which is false on Mixamo-derived rigs (180° from root): the arm reaches the mirror image.
  const qP0 = rest?.qP ?? [0, 0, 0, 1];
  const qU0 = rest?.qU ?? [0, 0, 0, 1];
  const qL0 = rest?.qL ?? [0, 0, 0, 1];
  const qPnow = rest?.qPnow ?? qP0;

  // how far the parent has turned since rest: the only thing that carries a rest-frame direction into the current pose
  const dP = qMulq(qPnow, qConj(qP0));

  // upper: rest direction carried by the parent, then swung onto the target
  const restU = qRot(dP, dRestUpper);
  const U = qMulq(qFromUnitVectors(restU, dWantUpper), qMulq(dP, qU0));

  // lower: its rest is carried by the upper's OWN change since rest, not by the parent's
  const dU = qMulq(U, qConj(qU0));
  const restL = qRot(dU, dRestLower);
  const V = qMulq(qFromUnitVectors(restL, dWantLower), qMulq(dU, qL0));

  return {
    upper: qMulq(qConj(qPnow), U),
    lower: qMulq(qConj(U), V),
    upperFrame: U,
    lowerFrame: V,
  };
}


// ---- not through your own body ---------------------------------------------
// the elbow's swivel about the shoulder-hand axis clears the torso without moving the hand, so the reach still touches
// what it was asked to. Thicknesses come from shared/joints.js.

/** The standard clamped-parameter method; zero-length segments fall through to point cases. */
export function segSegClosest(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
  else if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = add(p1, mul(d1, s)), c2 = add(p2, mul(d2, t));
  return { d: len(sub(c1, c2)), c1, c2 };
}

export function segSegDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return len(sub(p1, p2));
  if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return len(sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
}

// share of a limb's radius allowed into the body (NOT 1): contact is touching; only the centreline must stay outside, or an
// arm resting at the side reads as penetrating and a hand can't reach its own hip
const CONTACT = 0.25;


// ---- bodies are not round ---------------------------------------------------
// a guard's WARP (an elliptical body-frame basis) measures distance where the ellipse is a circle (linear, so segment
// distance survives), or a forearm in front of the belly reads as inside a capsule with no front
const warpPt = (p, w) => (!w ? p : [
  dot(p, w.r), dot(p, w.u), dot(p, w.f) * w.k,
]);
/** Carry a direction measured in warped space back to the real one. */
const unwarpDir = (n, w) => {
  if (!w) return n;
  const v = [
    n[0] * w.r[0] + n[1] * w.u[0] + (n[2] / w.k) * w.f[0],
    n[0] * w.r[1] + n[1] * w.u[1] + (n[2] / w.k) * w.f[1],
    n[0] * w.r[2] + n[1] * w.u[2] + (n[2] / w.k) * w.f[2],
  ];
  return norm(v) ?? n;
};

/** Metres summed over every offending pair; zero means clear. */
export function penetration(root, elbow, hand, rUpper, rLower, guards) {
  let pen = 0;
  for (const g of guards) {
    const w = g.warp;
    const R = warpPt(root, w), E = warpPt(elbow, w), H = warpPt(hand, w);
    const A = warpPt(g.a, w), B = warpPt(g.b, w);
    const min1 = g.r + rUpper * CONTACT, min2 = g.r + rLower * CONTACT;
    const d1 = segSegDist(R, E, A, B);
    if (d1 < min1) pen += min1 - d1;
    const d2 = segSegDist(E, H, A, B);
    if (d2 < min2) pen += min2 - d2;
  }
  return pen;
}

/** Within `R` of the target (at most two pieces kept): dropping the whole guard lets the forearm pass through the torso unreported. */
export function clipGuardNear(g, target, R) {
  const d = sub(g.b, g.a), m = sub(g.a, target);
  const A = dot(d, d);
  if (A < 1e-12) return segSegDist(target, target, g.a, g.b) < R ? [] : [g];
  const B = 2 * dot(m, d), C = dot(m, m) - R * R;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [g];                       // never within R: keep whole
  const rt = Math.sqrt(disc);
  const s0 = (-B - rt) / (2 * A), s1 = (-B + rt) / (2 * A);
  const lo = clamp(s0, 0, 1), hi = clamp(s1, 0, 1);
  const out = [];
  if (lo > 1e-3) out.push({ ...g, b: add(g.a, mul(d, lo)) });
  if (hi < 1 - 1e-3) out.push({ ...g, a: add(g.a, mul(d, hi)) });
  return out;
}

const SWIVELS = (() => {
  // ordered by |angle|, so the FIRST clear one is the least departure from the pole hint's pose; every client sweeps the same
  // list in the same order and picks the same arm
  const out = [0];
  for (let a = 10; a <= 170; a += 10) { out.push(a * Math.PI / 180, -a * Math.PI / 180); }
  return out;
})();

/**
 * If the arm comes out inside the body, swivel the elbow until it doesn't; else the least-bad swivel (2 cm into a hip reads
 * better than giving up). A previously REACHED elbow is tried as an incumbent, never fed back as the sweep's basis (that
 * self-excites an oscillator).
 * @param {object} o the same options solveTwoBone takes
 * @param {Array<{a:number[],b:number[],r:number}>} guards live segments to avoid
 */
export function solveTwoBoneClear(o, guards) {
  const rU = o.rUpper ?? 0, rL = o.rLower ?? 0;
  const lim = o.limits ?? {};
  // a millimetre of tolerance: a pose exactly on the boundary flickers feasible/infeasible as the body breathes
  const CLEAR = 0.001;

  // clip each guard near the target, never drop it: the torso is ONE capsule, and dropping it lets the forearm cross the chest
  guards = (guards ?? []).flatMap((g) => clipGuardNear(g, o.target, g.r + rL * CONTACT));
  o = { ...o, guards };

  const root = o.root;
  const toTarget = sub(o.target, root);
  const reachDir = norm(toTarget);
  const fullDist = len(toTarget);

  // ---- best pose for ONE target: the least swivel that clears the body. The chord test proxies which way an elbow folds,
  // sound only while the arm isn't adducted, so it is gated on how far across the reach asks to go.
  const sideOf = (res, target) => {
    if (!o.fwd || !lim.hingeDir || !res?.ok) return 1;
    const chord = norm(sub(res.hand, root));
    if (!chord) return 1;
    const e = sub(res.elbow, root);
    const perp = sub(e, mul(chord, dot(e, chord)));
    const pl = len(perp);
    if (pl < 1e-4) return 1;                       // straight arm: no bend to judge
    return dot(mul(perp, 1 / pl), o.fwd) * -Math.sign(lim.hingeDir);
  };

  const bestFor = (target) => {
    const oo = { ...o, target };
    const base = solveTwoBone(oo);
    if (!base.ok) return null;
    const aim = norm(sub(target, root));
    const basePole = o.pole ?? base.elbow;
    const at = (th) => (th === 0 || !aim)
      ? base : solveTwoBone({ ...oo, pole: rotateAbout(basePole, aim, th) });
    const penOf = (res) => (res?.ok && guards.length)
      ? penetration(root, res.elbow, res.hand, rU, rL, guards) : 0;
    const aimDir = aim;
    const adducted = o.inward && aimDir ? Math.max(0, dot(aimDir, o.inward)) : 0;
    const judgeSide = !!(lim.hingeDir && o.fwd) && adducted < 0.35;
    // accepting a fresh pose is strict (an elbow the wrong side of the chord is the artefact); keeping the incumbent is
    // tolerant by a few degrees, or noise on the plane flips it and the search chatters
    const okSide = (res) => !judgeSide || sideOf(res, target) >= 0;
    const okSideHeld = (res) => !judgeSide || sideOf(res, target) >= -0.08;

    // the swivel basis flips when a lateral target crosses the pole axis, so try the previous physical bend first (only if it
    // reached). Never the sweep's base pole: that would rotate our own output each frame and oscillate.
    if (Number.isFinite(o.lastGap) && o.lastGap <= 1e-4 && Array.isArray(o.lastElbow) && o.lastElbow.length === 3 && o.lastElbow.every(Number.isFinite)) {
      const held = solveTwoBone({ ...oo, pole: o.lastElbow });
      if (held?.ok && penOf(held) <= CLEAR && okSideHeld(held) && held.gap <= base.gap + 0.005) {
        return { res: held, pen: 0, swivel: o.lastSwivel ?? 0 };
      }
    }

    // ---- keep the swivel we had while it still works (tried FIRST, kept if clear), so penetration hovering near zero can't
    // make the winner alternate frame to frame
    if (o.lastSwivel != null) {
      const held = at(o.lastSwivel);
      if (held?.ok && penOf(held) <= CLEAR && okSideHeld(held)) {
        return { res: held, pen: 0, swivel: o.lastSwivel };
      }
    }

    let best = null, fallback = { res: base, pen: penOf(base), swivel: 0 };
    if (fallback.pen <= CLEAR && okSide(base)) return fallback;
    for (const th of SWIVELS) {
      if (th === 0) continue;
      const res = at(th);
      if (!res.ok) continue;
      const pen = penOf(res);
      if (pen <= CLEAR && okSide(res)) return { res, pen: 0, swivel: th };
      // keep the least-bad CORRECT-SIDE option ahead of any inverted one
      const cand = { res, pen, swivel: th };
      if (okSide(res) && (!best || pen < best.pen)) best = cand;
      if (pen < fallback.pen) fallback = cand;
    }
    return best ?? fallback;
  };

  if (o.trace) o.trace.push({ t: 1, pen: null, note: 'full attempt below' });
  const full = bestFor(o.target);
  if (!full) return solveTwoBone(o);
  if (o.trace) o.trace[o.trace.length - 1].pen = +(full.pen * 1000).toFixed(1);
  if (full.pen <= CLEAR) {
    return { ...full.res, swivel: full.swivel, penetration: 0, retreat: 1 };
  }

  // ---- unreachable: the nearest pose the body allows, never on the line to the target (that penetrates throughout): sample
  // directions in a cone and distances along each, scored by where the hand lands; cheap probe first.
  if (!reachDir || fullDist < 1e-6) {
    return { ...full.res, swivel: full.swivel, penetration: full.pen, retreat: 1 };
  }
  const perp = norm(cross(reachDir, Math.abs(reachDir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
    ?? norm(cross(reachDir, [0, 0, 1])) ?? [1, 0, 0];
  const perp2 = norm(cross(reachDir, perp)) ?? [0, 1, 0];
  const DEV = [0, 20, 40, 60].map((deg) => deg * Math.PI / 180);
  const AZ = [0, 60, 120, 180, 240, 300].map((deg) => deg * Math.PI / 180);
  const FRAC = [1, 0.85, 0.7, 0.55, 0.4];

  const cheapPen = (target) => {
    const r = solveTwoBone({ ...o, target });
    if (!r.ok) return null;
    return { r, pen: guards.length ? penetration(root, r.elbow, r.hand, rU, rL, guards) : 0 };
  };

  // ---- stickiness: a DEADBAND LATCH, not feedback. A rival must beat the incumbent by STICK to switch (and again to switch
  // back), so sub-margin noise can't drive a cycle.
  const STICK = 0.03;                       // metres of "clearly better"
  const prev = o.lastPick ?? null;
  const shortlist = [];
  for (const dev of DEV) {
    for (const az of (dev === 0 ? [0] : AZ)) {
      const axis = norm(add(mul(perp, Math.cos(az)), mul(perp2, Math.sin(az))));
      const dir = axis ? norm(rotateAbout(reachDir, axis, dev)) : reachDir;
      if (!dir) continue;
      for (const f of FRAC) {
        const target = add(root, mul(dir, fullDist * f));
        const c = cheapPen(target);
        if (!c) continue;
        // score by where the HAND lands against what was asked: closeness to the target, not to a proxy
        shortlist.push({ target, miss: len(sub(o.target, c.r.hand)), pen: c.pen });
      }
    }
  }
  shortlist.sort((a, b) => (a.pen > 0) - (b.pen > 0) || a.miss - b.miss);

  let best = null;
  for (const cand of shortlist.slice(0, 6)) {
    const r = bestFor(cand.target);
    if (!r || r.pen > CLEAR) continue;
    const miss = len(sub(o.target, r.res.hand));
    if (!best || miss < best.miss) best = { ...r, miss, pick: cand.target };
  }

  // the incumbent gets a full evaluation outside the shortlist: the latch is useless if its pose is never asked
  if (prev) {
    const r = bestFor(prev);
    if (r && r.pen <= CLEAR) {
      const miss = len(sub(o.target, r.res.hand));
      if (!best || miss <= best.miss + STICK) best = { ...r, miss, pick: prev };
    }
  }
  if (!best) {
    return { ...full.res, swivel: full.swivel, penetration: full.pen, retreat: 1 };
  }
  return {
    ...best.res, swivel: best.swivel, penetration: 0,
    gap: best.miss, pick: best.pick,
    bound: [...(best.res.bound ?? []), 'body'],
  };
}

// ---- and which way the palm faces ------------------------------------------
// position IK leaves the hand's turn free, and touching is done with the palm. Most of the correction goes to the forearm
// (pronation; TWIST.leftLowerArm / rightLowerArm in joints.js), the rest to the wrist, clamped to its range.

/** Shorten a rotation to at most `maxAng`, keeping its axis. */
export function qClampAngle(q, maxAng) {
  const w = clamp(Math.abs(q[3]), -1, 1);
  const ang = 2 * Math.acos(w);
  if (ang <= maxAng || ang < 1e-6) return q;
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-8) return [0, 0, 0, 1];
  const sign = q[3] < 0 ? -1 : 1;
  const axis = [sign * q[0] / s, sign * q[1] / s, sign * q[2] / s];
  return qAxisAngle(axis, maxAng);
}

function stepQuaternion(from, to, maxAngle) {
  let d = from.reduce((s, v, i) => s + v * to[i], 0);
  const target = d < 0 ? to.map(v => -v) : to;
  d = clamp(Math.abs(d), -1, 1);
  const half = Math.acos(d);
  if (half < 1e-8 || 2 * half <= maxAngle) return target;
  const t = maxAngle / (2 * half), sin = Math.sin(half);
  return from.map((v, i) => (Math.sin((1-t)*half)*v + Math.sin(t*half)*target[i]) / sin);
}

/**
 * By twisting the forearm, then bending the wrist for the remainder.
 * @param {object} o
 * @param {number[]} o.lowerFrame solved orientation of the forearm
 * @param {number[]} o.dLower     forearm direction (unit), same frame
 * @param {number[]} o.palmRest   palm normal at rest, same frame
 * @param {number[]} o.qL0        forearm rest orientation
 * @param {number[]} o.qH0        hand rest orientation
 * @param {number[]} o.want       desired palm direction (unit)
 * @returns {{lowerFrame: number[], handLocal: number[], residualDeg: number}}
 */
export function orientPalm(o) {
  const relH = qMulq(qConj(o.qL0), o.qH0);          // hand, relative to forearm
  const aPalm = qRot(qConj(o.qH0), o.palmRest);      // palm axis in the hand's own frame
  const twistMax = o.twistMax ?? (80 * Math.PI / 180);
  const wristMax = o.wristMax ?? (50 * Math.PI / 180);

  const axis = norm(o.dLower);
  let lowerFrame = o.lowerFrame;
  let H = qMulq(lowerFrame, relH);
  let palm = qRot(H, aPalm);
  if (!axis) return { lowerFrame, handLocal: relH, residualDeg: 0 };
  let twist = 0;

  // ---- pronation: the component of the correction the forearm can make
  const flat = (v) => norm(sub(v, mul(axis, dot(v, axis))));
  const p0 = flat(palm), p1 = flat(o.want);
  if (p0 && p1) {
    const c = clamp(dot(p0, p1), -1, 1);
    const angle = Math.atan2(dot(cross(p0, p1), axis), c);
    twist = clamp(angle, -twistMax, twistMax);
    if (Number.isFinite(o.lastTwist)) {
      const previous = clamp(o.lastTwist, -twistMax, twistMax);
      const error = (t) => Math.acos(clamp(dot(rotateAbout(p0, axis, t), p1), -1, 1));
      // across the ±π boundary both saturated choices nearly tie: keep the incumbent until the alternative is materially better
      if (previous * twist < 0 && error(previous) <= error(twist) + 5 * Math.PI / 180) twist = previous;
      if (Number.isFinite(o.dt)) {
        const step = Math.PI * clamp(o.dt, 0, 0.1); // <=180 degrees/sec
        twist = clamp(twist, previous - step, previous + step);
      }
    }
  } else if (Number.isFinite(o.lastTwist)) twist = clamp(o.lastTwist, -twistMax, twistMax);
  lowerFrame = qMulq(qAxisAngle(axis, twist), lowerFrame);
  H = qMulq(lowerFrame, relH);
  palm = qRot(H, aPalm);

  // ---- the wrist takes what is left, within its range
  const delta = qClampAngle(qFromUnitVectors(palm, o.want), wristMax);
  let handLocal = qMulq(qConj(lowerFrame), qMulq(delta, H));
  if (o.lastWrist && Number.isFinite(o.dt)) handLocal = stepQuaternion(o.lastWrist, handLocal, Math.PI * clamp(o.dt, 0, .1));
  const H2 = qMulq(lowerFrame, handLocal);
  const after = qRot(H2, aPalm);
  const residual = Math.acos(clamp(dot(after, o.want), -1, 1));
  return {
    lowerFrame,
    handLocal,
    residualDeg: residual * 180 / Math.PI,
    twist,
  };
}
