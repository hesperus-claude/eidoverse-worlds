// ragdoll — a body going limp, simulated by ONE machine and streamed.
//
// Single authority, not determinism: only the body's OWNER simulates; it streams sparse bone rotations on the
// presence `pose` field (remotes see an ordinary changing pose); when it settles the owner CAPTURES the bones as a
// held pose, so late joiners get the result, never a replay (a permanent one commits as a `pose` verb). The server
// never simulates and never sees a bone.
//
// A Verlet particle skeleton, not a rigid-body solver, carrying four things:
//   MASS         — constraints split by inverse mass, so a hand can't throw the pelvis around.
//   VOLUME       — bones are CAPSULES, not beads, or limbs pass through the torso.
//   HANDEDNESS   — knees and elbows bend one way, from a body frame the particles supply (see _frame).
//   A FIXED STEP — Verlet's inertia term is a position delta, so raw frame time makes physics framerate-dependent.
//
// Everything anatomical is MEASURED from the rig at construction: shipped avatars disagree on height, rest pose
// (T to A) and whether an upperChest + shoulder pair sits between chest and arm.

import { THREE } from './core.js';
import { BEHIND, CONE, HINGE, TWIST, TWIST_PARENT, RADIUS_FRAC, torsoRadius } from '../../shared/joints.js';
import { heightAt } from './terrain.js';
import { resolveColliders } from './colliders.js';
import { SEGMENTS, JOINTS, DRIVEN_BONES, closestParams, snapshotPacker, seedJoints } from './rigmeasure.js';
import { BodyEngineBase } from './bodyengine.js';

// ---------------------------------------------------------------------------
// topology
// ---------------------------------------------------------------------------

// body cut, joint list and driven bones live in rigmeasure.js (one table for both engines); re-exported for
// avatar.setLimp and bodydrag
const CHAINS = SEGMENTS;
export { JOINTS, DRIVEN_BONES, closestParams };

// BONES: segments with physical volume (collided and drawn). On rigs with an upperChest/shoulder pair a span covers
// three real bones, which is why goLimp neutralizes the in-between bones first (avatar.js setLimp).
const BONES = [
  ...CHAINS,
  ['hips', 'leftUpperLeg'], ['hips', 'rightUpperLeg'],
  ['chest', 'leftUpperArm'], ['chest', 'rightUpperArm'],
];

// BRACES: volumeless diagonals that truss the trunk so it can't shear and fold like a noodle. Rest lengths come from
// the NEUTRAL pose (the `rest` constructor argument): a diagonal's length changes with the pose it's measured in.
const BRACES = [
  ['leftUpperArm', 'rightUpperArm'],     // shoulder bar
  ['leftUpperLeg', 'rightUpperLeg'],     // pelvis bar
  ['hips', 'chest'],                     // trunk column
  ['spine', 'neck'],
];
const LINKS = [...BONES, ...BRACES];

// relative mass per joint (only ratios matter: constraints split by inverse mass); roughly anatomical, so a
// flailing forearm can't hurl the torso
const MASS = {
  hips: 12, spine: 8, chest: 10, neck: 2, head: 5,
  leftUpperArm: 2.5, rightUpperArm: 2.5,
  leftLowerArm: 1.5, rightLowerArm: 1.5,
  leftHand: 0.5, rightHand: 0.5,
  leftUpperLeg: 7, rightUpperLeg: 7,
  leftLowerLeg: 4, rightLowerLeg: 4,
  leftFoot: 1.2, rightFoot: 1.2,
};

const FIXED_DT = 1 / 60;   // the sim's only clock — see the header
const MAX_FRAMES = 4;
const PIN_JUMP = 0.12;     // metres/frame — past this a pin jumped, it did not move

// Everything tunable, in one mutable object so a sweep can drive it without
// editing the file — which is what the old parameter study had to do, and why
// its findings were never re-checked against anything.
export const TUNING = {
  GRAVITY: -9.8,
  // substeps buy framerate independence (2 lands a fall within 1mm across 30–120fps) at the same constraint-pass
  // cost; past 2 the braced torso starves for relaxation passes. Swept in tools/rag-tune.mjs.
  SUBSTEPS: 2,
  ITER: 3,                 // relaxation passes per substep
  // a body hanging from a pin needs far more passes: Gauss-Seidel moves tension one link per pass, so a dragged body
  // stretches until they reach the far end (69% at 3 passes, 8% at 16). Paid only while something is pinned.
  ITER_PINNED: 16,
  DAMP: 0.98,              // per FRAME, spread across the substeps
  SLEEP_DAMP: 0.8,         // ...harder once nearly still, see _solve
  YIELD: 0.5,              // fraction of an angular violation fixed per pass
  CAPSULE_SOFT: 0.6,       // fraction of an overlap resolved per pass
  TWIST_DAMP: 0.88,        // per frame, on the twist velocity
  TWIST_STIFF: 26,         // rad/s per rad — passive pull back to neutral
  // twist driver, off: with no torque to answer, any lag only ADDS twist; the state below bounds it if a dragged or
  // puppeted limb ever drives it
  TWIST_LAG: 0,
  // live debug-panel switches: turn rules off mid-tumble to find which one makes a shape look wrong
  ON_FLEX: 1, ON_CONE: 1, ON_BEHIND: 1, ON_HINGE: 1,
  ON_CAPSULE: 1, ON_BRACE: 1, ON_TWIST: 1, ON_GROUND: 1,
  PAUSED: 0,
  // PIN_VEL: give a pinned joint the PIN's velocity rather than the distance it travelled (which injects energy as
  // torsion). Off by default: headless drags don't show it helping; a switch so a real hand can settle it.
  PIN_VEL: 0,
  SETTLE_V: 0.06,          // speed below which we call it settled...
  SETTLE_TIME: 0.4,        // ...for this long, in SECONDS (not frames: framerate-independent)
  // hysteresis: the settle test takes the fastest joint, so restarting the countdown needs real motion, not a flicker
  SETTLE_RESET: 3,         // multiple of SETTLE_V that cancels a settle
  // Force the capture after this long even if the velocity test never fires:
  // the contract is that a tumble always ENDS as a held pose, it must never
  // stream presence forever.
  DEADLINE: 8,
};

// ---------------------------------------------------------------------------
// joint limits
// ---------------------------------------------------------------------------

// FLEX — symmetric cones between two adjacent links, for the spine and neck. Symmetric is anatomically wrong (too
// much backbend) and deliberate: a signed limit needs the sign of a near-zero lean, which flickers; doing it
// properly needs a stable rigid-body bone frame, which this deliberately is not.
const FLEX = [
  // a         b        c         max° from the rig's own rest angle
  ['hips',   'spine', 'chest',    25],   // lower spine: stiff
  ['spine',  'chest', 'neck',     25],
  ['chest',  'neck',  'head',     45],   // neck: floppier
];

// the joint envelope (BEHIND, CONE, HINGE, TWIST) lives in shared/joints.js, shared with the reach solver; each
// value's rationale is there

// Self-collision radii moved to shared/joints.js with the joint envelope —
// the reach solver needs the same idea of how thick a body is.

const D2R = Math.PI / 180;

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _by = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _qd2 = new THREE.Quaternion();
const _qBody = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _qsi = new THREE.Quaternion();
const _qL = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _qpi = new THREE.Quaternion();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _qtw = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _s1 = new THREE.Vector3();   // swing: correction direction
const _s2 = new THREE.Vector3();   // swing: velocity probe
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _qd = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
// closestParams' two outputs, hoisted: it runs once per capsule pair per pass
const _pr = { s: 0, t: 0 };

/** An orthonormal basis with X down the bone and its roll pinned by `ref`.
 *  Leaves the orthonormalized reference in `_bz` so the caller can carry it
 *  forward. Returns false only when the bone lies along `ref`, where roll is
 *  undefined and the caller must reseed. */
function basisOf(dir, ref, out) {
  _bz.copy(ref).addScaledVector(dir, -ref.dot(dir));
  if (_bz.lengthSq() < 1e-4) return false;
  _bz.normalize();
  _by.crossVectors(_bz, dir);
  _mat.makeBasis(dir, _by, _bz);
  out.setFromRotationMatrix(_mat);
  return true;
}

/** The roll reference for a bone, TRANSPORTED rather than rebuilt.
 *
 *  Choosing a body axis per bone and re-deriving from it each frame has a hole:
 *  a limb that swings onto its own reference has no roll defined against it,
 *  and falling through to a different axis moves the roll discontinuously. That
 *  is not a corner case — measured, the arms sat at dir·ref = 0.99 and snapped
 *  178° in one frame. Carrying the reference and only ever re-squaring it
 *  against the bone cannot flip: it rotates exactly as much as the bone does,
 *  and no more, which is also what an untorqued limb does with its twist. */
function rollRef(dir, up, frame) {
  if (basisOf(dir, up, _qd2)) { up.copy(_bz); return true; }
  for (const ax of [frame.r, frame.u, frame.f]) {
    if (basisOf(dir, ax, _qd2)) { up.copy(_bz); return true; }
  }
  return false;
}

/** World positions of the simulated joints — the shape a sim is in, so the
 *  next one can be handed both it and the motion it had. */
export function jointPositions(avatar, out = new Map()) {
  const h = avatar?.vrm?.humanoid;
  if (!h) return out;
  for (const j of JOINTS) {
    const n = h.getNormalizedBoneNode(j);
    if (n) out.set(j, n.getWorldPosition(out.get(j) ?? new THREE.Vector3()));
  }
  return out;
}

/** The roll component of `q` about `axis` — the twist half of a swing-twist
 *  decomposition, signed, in radians. */
function twistAbout(q, axis) {
  _t3.set(q.x, q.y, q.z);
  const along = _t3.dot(axis);
  _qtw.set(axis.x * along, axis.y * along, axis.z * along, q.w);
  if (_qtw.lengthSq() < 1e-12) return 0;
  _qtw.normalize();
  let a = 2 * Math.acos(THREE.MathUtils.clamp(_qtw.w, -1, 1));
  if (a > Math.PI) a -= Math.PI * 2;
  return along < 0 ? -a : a;
}

export class Ragdoll extends BodyEngineBase {
  /** @param avatar   the OWNER's Avatar.
   *  @param lean     optional topple velocity in m/s — see below.
   *  @param rest     optional map joint -> neutral-rest WORLD position, from
   *                  Avatar.restBonePositions(). It must be captured with the
   *                  root where it is NOW: everything else read out of it is a
   *                  difference and so translation-free, but hipsOffset is the
   *                  pelvis's height above the ROOT, and a snapshot taken at a
   *                  different root height is wrong by exactly that difference.
   *  @param seedVel  optional map joint -> velocity (m/s), to inherit motion
   *                  from a sim being replaced mid-flight. Everything anatomical is
   *                  measured against THIS, not against the live skeleton: a
   *                  body that goes limp mid-stride must not inherit the
   *                  stride's angles as its idea of "rest", or its knees adopt
   *                  the walk cycle's bend as their zero. */
  constructor(avatar, lean = null, rest = null, seedVel = null) {
    super(avatar);                    // lifecycle fields — see bodyengine.js
    this.acc = 0;
    this.steps = 0;                   // step() calls; see the debug panel
    this.frames = 0;                  // ...and substeps actually simulated
    const h = avatar.vrm.humanoid;

    // capture live references in WORLD space, before anything moves
    this.nodes = {};        // joint -> node
    this.p = {};            // joint -> current world pos
    this.prev = {};         // joint -> previous world pos (verlet)
    this.pre = {};          // joint -> position at the start of this step
    for (const j of JOINTS) {
      const node = h.getNormalizedBoneNode(j);
      if (!node) continue;
      this.nodes[j] = node;
      const wp = node.getWorldPosition(new THREE.Vector3());
      this.p[j] = wp.clone();
      // a sim built mid-motion must INHERIT that motion: Verlet keeps velocity in p - prev, and prev = p is a dead stop,
      // which would drop every re-created body (a nail pulled, a drag let go) where it was
      const v = seedVel?.get?.(j) ?? (seedVel && !seedVel.j ? seedVel[j] : null);
      this.prev[j] = v ? wp.clone().addScaledVector(v, -FIXED_DT) : wp.clone();
      this.pre[j] = wp.clone();      // step-start position, for the settle test
    }
    // a handover snapshot outranks the bones (it's where the particles actually were, at what speed); applied after the
    // bone read so a caller with no snapshot still works
    if (seedVel?.j) {
      for (const s of seedJoints(seedVel)) {
        if (!this.p[s.name]) continue;
        this.p[s.name].set(s.px, s.py, s.pz);
        this.prev[s.name].copy(this.p[s.name]).addScaledVector(
          _v.set(s.vx, s.vy, s.vz), -FIXED_DT);
      }
    }

    // the neutral skeleton every limit is measured against; falls back to the
    // live one joint-by-joint so a caller that has no rest map still works
    this.rest = {};
    for (const j of Object.keys(this.p)) {
      this.rest[j] = (rest && rest[j]) ? rest[j].clone() : this.p[j].clone();
    }

    // ---- how it goes over: `lean` (m/s) is weighted by height, zero at the lowest joint: a topple about the feet.
    // A uniform shove pancakes the body straight down and jams the knees against their stops.
    if (lean) this._topple(lean);

    // inverse mass. A missing entry gets the lightest plausible weight rather
    // than infinite mass — an unpinned particle that never moves is worse.
    this.iw = {};
    for (const j of Object.keys(this.p)) this.iw[j] = 1 / (MASS[j] ?? 1);
    this._pinFrom = new Map();        // each pin's target at frame start

    // rest length of each link, from the neutral pose (see BRACES)
    this.links = LINKS.filter(([a, b]) => this.p[a] && this.p[b])
      .map(([a, b]) => ({
        a, b, len: this.rest[a].distanceTo(this.rest[b]),
        brace: BRACES.some((x) => x[0] === a && x[1] === b),
      }))
      .filter((l) => l.len > 1e-5);

    // the rig's own body frame, in which the CONE and HINGE limits are stated
    this.frame = { r: new THREE.Vector3(), u: new THREE.Vector3(), f: new THREE.Vector3() };
    this._frame(this.rest);
    const r0 = this.frame.r.clone(), u0 = this.frame.u.clone(), f0 = this.frame.f.clone();
    const toLocal = (world, out) =>
      out.set(world.dot(r0), world.dot(u0), world.dot(f0));

    // ---- FLEX: symmetric cones between adjacent links, off the rest angle. A row whose rest link is too short to
    // carry a direction (FLEX_MIN_LINK; e.g. a spine authored millimetres above the hips) is skipped, or solver jitter
    // reads as flexion and thrashes the real spine link; the next row's longer links still bound the trunk.
    this.flex = [];
    const FLEX_MIN_LINK = 0.03;
    for (const [a, b, c, max] of FLEX) {
      if (!this.rest[a] || !this.rest[b] || !this.rest[c]) continue;
      if (this.rest[b].distanceTo(this.rest[a]) < FLEX_MIN_LINK
        || this.rest[c].distanceTo(this.rest[b]) < FLEX_MIN_LINK) continue;
      _a.copy(this.rest[b]).sub(this.rest[a]).normalize();
      _b.copy(this.rest[c]).sub(this.rest[b]).normalize();
      const at = Math.acos(THREE.MathUtils.clamp(_a.dot(_b), -1, 1));
      this.flex.push({ a, b, c, max: Math.min(Math.PI, at + max * D2R) });
    }

    // ---- BEHIND: the frontal-plane stop, as a minimum forward component
    this.behind = [];
    for (const [b, c, deg] of BEHIND) {
      if (this.p[b] && this.p[c]) this.behind.push({ b, c, minFwd: -Math.sin(deg * D2R) });
    }

    // ---- CONE: limb direction vs the torso, stored in body-frame coordinates
    // so it survives any rig's rest pose. The axis is the rest direction leaned
    // `tilt` degrees toward forward.
    this.cone = [];
    for (const [b, c, half, tilt] of CONE) {
      if (!this.rest[b] || !this.rest[c]) continue;
      const axis = new THREE.Vector3();
      toLocal(_a.copy(this.rest[c]).sub(this.rest[b]).normalize(), axis);
      if (tilt) {
        // the forward component perpendicular to the axis, so the lean is a
        // pure rotation in the sagittal plane rather than a shortening
        _v.set(0, 0, 1).addScaledVector(axis, -axis.z);
        if (_v.lengthSq() > 1e-8) axis.addScaledVector(_v.normalize(), Math.tan(tilt * D2R));
      }
      this.cone.push({ b, c, axis: axis.normalize(), cos: Math.cos(half * D2R) });
    }

    // ---- HINGE: signed, one-sided, with a sideways tolerance. The hinge AXIS
    // is seeded here from the rest pose and then transported with the limb
    // (see _limits) rather than rebuilt from the body each pass.
    this.hinge = [];
    for (const [a, b, c, dir, maxFlex, side] of HINGE) {
      if (!this.rest[a] || !this.rest[b] || !this.rest[c]) continue;
      _a.copy(this.rest[b]).sub(this.rest[a]);
      if (_a.lengthSq() < 1e-8) continue;
      _a.normalize();
      _c.copy(f0).multiplyScalar(dir);          // which way this joint folds
      _c.addScaledVector(_a, -_c.dot(_a));      // ...perpendicular to the limb
      if (_c.lengthSq() < 1e-8) continue;
      this.hinge.push({
        a, b, c, max: maxFlex * D2R, side: Math.sin(side * D2R),
        n: new THREE.Vector3().crossVectors(_a, _c.normalize()).normalize(),
      });
    }
    // a handover must carry the transported hinge axes (`h`, in this.hinge order, §24t-8): rest normals mid-tumble
    // fire the full correction into the hands on the first step. A snapshot without them (another engine's) gets normals
    // derived from where the limbs ARE.
    if (seedVel?.j) {
      const h = Array.isArray(seedVel.h) && seedVel.h.length === this.hinge.length * 3 ? seedVel.h : null;
      this.hinge.forEach((H, i) => {
        if (h) { H.n.set(h[i * 3], h[i * 3 + 1], h[i * 3 + 2]); if (H.n.lengthSq() > 1e-8) { H.n.normalize(); return; } }
        _a.copy(this.p[H.b]).sub(this.p[H.a]);
        if (_a.lengthSq() < 1e-8) return;
        _a.normalize();
        // keep the rest normal's fold sense, re-squared against the live limb
        _c.copy(H.n).cross(_a);                    // the fold direction implied by the rest normal
        _c.addScaledVector(_a, -_c.dot(_a));
        if (_c.lengthSq() < 1e-8) return;
        H.n.crossVectors(_a, _c.normalize()).normalize();
      });
    }

    // ---- capsules: every BONE is a fat segment, and pairs of them push apart
    this._buildCapsules();

    // per-driven-bone rest reference, in its TWIST PARENT's frame: each step the live direction is carried across by the
    // minimal arc from restLocal's axis (current state only, so no drift); roll is `tw`, integrated below.
    this._frame(this.p);
    _mat.makeBasis(this.frame.r, this.frame.u, this.frame.f);
    const bodyRest = new THREE.Quaternion().setFromRotationMatrix(_mat);
    const axes = [this.frame.r, this.frame.u, this.frame.f];

    this.drive = [];
    this.driveBy = new Map();
    for (const [bone, child] of CHAINS) {
      const bn = this.nodes[bone];
      if (!bn || !this.p[child]) continue;
      const bwp = bn.getWorldPosition(new THREE.Vector3());
      _v.copy(this.p[child]).sub(bwp);
      if (_v.lengthSq() < 1e-8) continue;
      const dir = _v.clone().normalize();
      // any stable reference will do for the REST frame — it is only ever used
      // as the fixed thing the live frame is measured against
      let ref = 0;
      for (let i = 1; i < 3; i++) {
        if (Math.abs(dir.dot(axes[i])) < Math.abs(dir.dot(axes[ref]))) ref = i;
      }
      const restFrame = new THREE.Quaternion();
      if (!basisOf(dir, axes[ref], restFrame)) continue;

      const tp = TWIST_PARENT[bone] ?? null;
      const parentRest = tp ? this.driveBy.get(tp)?.restFrame : bodyRest;
      if (tp && !parentRest) continue;                 // parent bone absent on this rig
      const restLocal = parentRest.clone().invert().multiply(restFrame);

      const d = {
        bone, child, twistParent: tp,
        restFrame,
        restFrameInv: restFrame.clone().invert(),
        restLocal,
        restLocalAxis: new THREE.Vector3(1, 0, 0).applyQuaternion(restLocal),
        restQuat: bn.getWorldQuaternion(new THREE.Quaternion()),
        parent: bn.parent,
        // ---- twist, as state
        tw: 0, twv: 0,
        twMax: (TWIST[bone] ?? 180) * D2R,
        frameW: restFrame.clone(),                     // resolved each step
        swingW: restFrame.clone(),                     // ...before twist
      };
      this.drive.push(d);
      this.driveBy.set(bone, d);
    }
    this.bodyRest = bodyRest;

    this.rootStartY = avatar.root.position.y;
    // model origin below the hips, MEASURED (avatars range ~0.55–0.91) and from the NEUTRAL pose, or a walk cycle's
    // hip bob bakes in as a permanent offset
    this.hipsOffset = this.rest.hips
      ? this.rest.hips.y - avatar.root.position.y
      : 0.82;
    this._measureHipsLocal(this.rest.hips);   // ...and sideways (bodyengine.js)
  }

  /** The body's own frame, from its own particles: right across the pelvis, up
   *  the spine, forward as their cross product.
   *
   *  That cross product IS the anatomical forward — verified against the toe
   *  direction on all 12 shipped rigs that have toes, and it comes out correct
   *  for VRM 0.x and 1.0 alike without needing to know which (they face
   *  opposite ways on +Z, and the pelvis right-vector flips with them, so the
   *  cross product cancels the convention out). That is the whole reason a
   *  knee can be told which way to bend. */
  _frame(p) {
    const { r, u, f } = this.frame;
    if (p.leftUpperLeg && p.rightUpperLeg) r.copy(p.leftUpperLeg).sub(p.rightUpperLeg);
    else if (p.leftUpperArm && p.rightUpperArm) r.copy(p.leftUpperArm).sub(p.rightUpperArm);
    else r.set(1, 0, 0);
    if (p.head && p.hips) u.copy(p.head).sub(p.hips);
    else if (p.chest && p.hips) u.copy(p.chest).sub(p.hips);
    else u.set(0, 1, 0);
    if (r.lengthSq() < 1e-10) r.set(1, 0, 0);
    if (u.lengthSq() < 1e-10) u.set(0, 1, 0);
    r.normalize(); u.normalize();
    // a fully folded body has no definable forward: keep the last good one, or a hinge's handedness jumps and a knee
    // reads as bent 180° the wrong way
    _v.crossVectors(r, u);
    if (_v.lengthSq() > 1e-8) f.copy(_v).normalize();
    else if (f.lengthSq() < 1e-8) f.set(0, 0, 1);      // first call, none to keep
    _v.crossVectors(u, f);
    if (_v.lengthSq() > 1e-8) r.copy(_v).normalize();
  }

  /** Bone capsules, and which pairs of them should push each other apart.
   *
   *  Pairs are excluded two ways. Sharing a joint means they meet there by
   *  construction and always touch. And any pair whose NEUTRAL separation is
   *  already inside the combined radius is dropped as anatomically overlapping
   *  — the chest capsule genuinely does overlap the neck capsule on every real
   *  body, and a constraint that is violated in the rest pose is not a
   *  constraint, it is a motor that would inflate the torso forever. Measuring
   *  that per rig is the same trick RADIUS_FRAC uses for the radii. */
  _buildCapsules() {
    // shared/joints.js's torsoRadius IS this derivation (the reach solver uses it too); it takes plain [x,y,z] triples
    const P = {};
    for (const j of ['leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg', 'hips', 'head']) {
      if (this.rest[j]) P[j] = [this.rest[j].x, this.rest[j].y, this.rest[j].z];
    }
    const torsoR = torsoRadius(P);

    this.radius = {};
    for (const j of Object.keys(this.p)) this.radius[j] = torsoR * (RADIUS_FRAC[j] ?? 0.4);

    this.caps = BONES
      .filter(([a, b]) => this.p[a] && this.p[b])
      .map(([a, b]) => ({ a, b, r: (this.radius[a] + this.radius[b]) / 2 }));

    this.pairs = [];
    for (let i = 0; i < this.caps.length; i++) {
      for (let k = i + 1; k < this.caps.length; k++) {
        const A = this.caps[i], B = this.caps[k];
        if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
        const min = A.r + B.r;
        closestParams(this.rest[A.a], this.rest[A.b], this.rest[B.a], this.rest[B.b], _pr);
        _ca.copy(this.rest[A.a]).lerp(this.rest[A.b], _pr.s);
        _cb.copy(this.rest[B.a]).lerp(this.rest[B.b], _pr.t);
        if (_ca.distanceTo(_cb) < min * 1.02) continue;   // overlapping at rest
        this.pairs.push({ A, B, min });
      }
    }
  }

  // ---- one rendered frame's worth of physics --------------------------------
  _solve() {
    // approach to sleep (island sleeping): once nearly still, damp hard, or the lightest distal particle (a hand) keeps
    // chattering and the body streams presence to the deadline
    const damp = this.maxV < TUNING.SETTLE_V * 4 ? TUNING.SLEEP_DAMP : TUNING.DAMP;
    const n = Math.max(1, TUNING.SUBSTEPS | 0);
    const sdt = FIXED_DT / n;
    const sdamp = Math.pow(damp, 1 / n);   // keeps DAMP meaning "per frame"

    // where the frame started, for the settle test at the bottom
    for (const j of JOINTS) { const p = this.p[j]; if (p) this.pre[j].copy(p); }

    const iters = this.pinned ? TUNING.ITER_PINNED : TUNING.ITER;
    for (let s = 0; s < n; s++) this._substep(sdt, sdamp, iters);

    // full world collision once per FRAME (resolveColliders is a spatial-hash query); substeps keep a cheap terrain
    // clamp so nothing tunnels
    this._world();
    this._limits();

    // ---- how fast is it REALLY moving? Distance travelled this frame, not Verlet's p - prev: limit corrections carry
    // into prev, so a joint parked on its limit shows phantom velocity and would never settle.
    let moved = 0;
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      moved = Math.max(moved, p.distanceToSquared(this.pre[j]));
    }
    this.maxV = Math.sqrt(moved) / FIXED_DT;
  }

  _substep(dt, damp, iters = TUNING.ITER) {
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      const pr = this.prev[j];
      _v.copy(p).sub(pr).multiplyScalar(damp);
      pr.copy(p);
      p.add(_v);
      p.y += TUNING.GRAVITY * dt * dt;
    }
    this._pin(dt);
    this._frame(this.p);
    for (let it = 0; it < iters; it++) {
      this._links();
      this._capsules();
      this._terrain();
      this._limits();
    }
    // ...and again at the end: the constraints have had their say, and a nail
    // is a nail. Position only — prev already carries the pin's velocity, so
    // putting the joint back where the pin is does not invent any more of it.

  }

  /** Pinned joints go exactly where their pins say.
   *
   *  A pin used to set POSITION alone. In Verlet the velocity IS p - prev, so
   *  writing p and leaving prev where it was hands the joint the whole distance
   *  the pin travelled as speed — every substep, on top of whatever it already
   *  had. Dragging a body by one hand therefore injected energy in proportion
   *  to how fast the cursor moved, and it came out as torsion: measured against
   *  an unpinned fall, a moving pin took peak joint speed 1.7 -> 5.6 m/s, bone
   *  stretch 3% -> 16%, and twist 101° -> a full 180°.
   *
   *  prev now carries the PIN's own velocity — where the pin was at the start
   *  of this frame versus where it is — scaled to the substep, so a pinned
   *  joint moves at the speed the cursor is actually moving and no faster. It
   *  is also what lets a swung body keep its momentum when you let go.
   *
   *  Left deliberately alone: making a pinned joint immovable (infinite mass)
   *  and re-asserting the pin after the solve. Both are defensible and both
   *  measured WORSE here — the body then cannot satisfy its own bone lengths
   *  while hanging, and stretch went to several hundred percent. The pin stays
   *  a normal particle that something else is moving. */
  _pin(dt) {
    if (!this.pins?.size) { this._pinFrom.clear(); return; }
    const k = dt / FIXED_DT;               // this substep, as a fraction of a frame
    for (const [j, t] of this.pins) {
      if (!this.p[j]) continue;
      const from = this._pinFrom.get(j);
      this.p[j].copy(t);
      if (!TUNING.PIN_VEL) continue;                       // position only
      // a pin just set, or one that jumped (> PIN_JUMP), is a TELEPORT: land it dead; only continuous motion carries
      // velocity
      _v.copy(t).sub(from ?? t);
      if (!from || _v.lengthSq() > PIN_JUMP * PIN_JUMP) this.prev[j].copy(t);
      else this.prev[j].copy(t).sub(_v.multiplyScalar(k));
    }
    for (const j of [...this._pinFrom.keys()]) if (!this.pins.has(j)) this._pinFrom.delete(j);
  }

  _links() {
    for (const { a, b, len, brace } of this.links) {
      if (brace && !TUNING.ON_BRACE) continue;
      const pa = this.p[a], pb = this.p[b];
      const wa = this.iw[a], wb = this.iw[b], ws = wa + wb;
      if (ws <= 0) continue;
      _v.copy(pb).sub(pa);
      const d = _v.length() || 1e-4;
      _v.multiplyScalar((d - len) / d / ws);
      pa.addScaledVector(_v, wa);
      pb.addScaledVector(_v, -wb);
    }
  }

  /** Capsule-vs-capsule: the bone SHAFTS push apart, not just their endpoints.
   *  The correction lands on all four endpoints, weighted by where along each
   *  segment the contact fell and by inverse mass — so a wrist bounces off the
   *  chest rather than shoving it. */
  _capsules() {
    if (!TUNING.ON_CAPSULE) return;
    for (const { A, B, min } of this.pairs) {
      const a0 = this.p[A.a], a1 = this.p[A.b], b0 = this.p[B.a], b1 = this.p[B.b];
      closestParams(a0, a1, b0, b1, _pr);
      const s = _pr.s, t = _pr.t;
      _ca.copy(a0).lerp(a1, s);
      _cb.copy(b0).lerp(b1, t);
      _n.copy(_cb).sub(_ca);
      const d = _n.length();
      if (d >= min || d < 1e-6) continue;
      _n.divideScalar(d);
      const wA0 = (1 - s) * this.iw[A.a], wA1 = s * this.iw[A.b];
      const wB0 = (1 - t) * this.iw[B.a], wB1 = t * this.iw[B.b];
      const tot = wA0 + wA1 + wB0 + wB1;
      if (tot <= 1e-9) continue;
      const pen = (min - d) * TUNING.CAPSULE_SOFT / tot;
      a0.addScaledVector(_n, -pen * wA0);
      a1.addScaledVector(_n, -pen * wA1);
      b0.addScaledVector(_n, pen * wB0);
      b1.addScaledVector(_n, pen * wB1);
      // inelastic, like the joint limits (see _stop): a soft push never fully clears an overlap, so if each push read as
      // separation velocity two resting limbs would trade energy forever
      _s1.copy(_n);
      this._stop(A.a, -1); this._stop(A.b, -1);
      this._stop(B.a, 1); this._stop(B.b, 1);
    }
  }

  _terrain() {
    // this contact is a pure vertical clamp, so a grounded joint keeps its horizontal velocity and a downed body can
    // creep (ragdoll-test names it, §24t-8). The fix is a tuned ground-friction law (tools/rag-tune.mjs).
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      const g = heightAt(p.x, p.z) + this._clear(j);
      if (p.y < g) p.y = g;
    }
  }

  /** Vertical clearance for a joint. colliders.resolveColliders treats its
   *  radius as a HORIZONTAL one (it is a vertical cylinder, not a sphere), so
   *  nothing was ever holding a joint up off the floor by its own thickness —
   *  a single 6cm constant did that job for a 0.63m avatar and a 1.53m one
   *  alike. The joint's own measured radius is the right number. */
  _clear(j) { return Math.max(0.02, this.radius[j] ?? 0.05); }

  /** Terrain AND props. resolveColliders is the SAME routine the walking
   *  controller uses — it pushes a point out of any collider box's sides and
   *  returns the height to rest on (terrain, or a box's top if the point is
   *  above it). Running each joint through it makes a body drape over a crate
   *  or a desk instead of sinking through it, using the exact OBBs everything
   *  else collides against. Lights carry no collider, so a ragdoll never snags
   *  on a bulb. */
  _world() {
    if (!TUNING.ON_GROUND) return;
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      const x0 = p.x, z0 = p.z;
      const r = this._clear(j);
      // `r` twice: horizontal radius and height above the point (a joint is a bead, not a standing figure), so a limb
      // can rest UNDER a table
      const g = resolveColliders(p, heightAt, r, r) + r;
      const pushed = Math.abs(p.x - x0) > 1e-5 || Math.abs(p.z - z0) > 1e-5;
      if (p.y < g) {
        p.y = g;
        // friction: bleed horizontal motion on contact so it doesn't slide
        this.prev[j].x += (p.x - this.prev[j].x) * 0.4;
        this.prev[j].z += (p.z - this.prev[j].z) * 0.4;
      }
      // a sideways push out of a prop should also lose momentum, or the joint
      // just springs back in next step
      if (pushed) {
        this.prev[j].x += (p.x - this.prev[j].x) * 0.3;
        this.prev[j].z += (p.z - this.prev[j].z) * 0.3;
      }
    }
  }

  /** Move the distal particle of a joint so its bone points at `dir`, and
   *  carry the move into `prev` so the correction does not read as velocity.
   *  Without that carry the limits pump energy every frame and the body
   *  twitches forever instead of settling (measured: settle never fires, a
   *  0.7 m/s limit cycle). Distal-only because the tables are ordered
   *  proximal->distal, which makes the sweep feed-forward: no clamp ever
   *  disturbs a triple that has already been solved this pass. */
  _swing(b, c, dir, lb) {
    const pb = this.p[b], pc = this.p[c];
    const wb = this.iw[b], wc = this.iw[c], ws = wb + wc;
    if (ws <= 0) return;
    _t.copy(dir).multiplyScalar(lb).sub(pc).add(pb);   // Δ = dir·lb − (pc − pb)
    // a correction worth half the bone is a teleport: land it DEAD (prev = p). Merely skipping the carry is the opposite:
    // prev stays behind while p jumps, and the next integrate flings the limb.
    const dead = _t.lengthSq() > lb * lb * 0.25;
    _s1.copy(_t).normalize();                // the direction we are correcting
    _u.copy(_t).multiplyScalar(wc / ws);
    pc.add(_u);
    if (dead) this.prev[c].copy(pc); else { this.prev[c].add(_u); this._stop(c, 1); }
    _u.copy(_t).multiplyScalar(-wb / ws);
    pb.add(_u);
    if (dead) this.prev[b].copy(pb); else { this.prev[b].add(_u); this._stop(b, -1); }
  }

  /** A joint limit is a hard STOP, not a spring.
   *
   *  Carrying the whole correction into prev keeps the velocity that drove the
   *  joint past its limit — so the limit stores that energy and hands it back
   *  the moment the joint unwinds. That is a body collapsing straight down,
   *  folding its knees into their stop under its own weight, and then kicking
   *  its legs out from under itself: measured 12.9 m/s of foot after landing.
   *  Dropping the carry entirely is worse (the correction then reads as fresh
   *  velocity and pumps), so take the middle, which is also the physical
   *  answer: keep the position, and remove only the velocity component that
   *  was driving INTO the limit. Contact, not restitution. 12.9 -> 4.1 m/s.
   *
   *  `side` is +1 for the particle moved along the correction and -1 for the
   *  one moved against it; the violating component has the opposite sign in
   *  each case, and both are removed by the same projection. */
  _stop(j, side) {
    const vn = _s2.copy(this.p[j]).sub(this.prev[j]).dot(_s1);
    if (vn * side < 0) this.prev[j].addScaledVector(_s1, vn);
  }

  _limits() {
    // ---- FLEX: symmetric cone between adjacent links
    if (TUNING.ON_FLEX) for (const { a, b, c, max } of this.flex) {
      const pa = this.p[a], pb = this.p[b], pc = this.p[c];
      _a.copy(pb).sub(pa); const la = _a.length();
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (la < 1e-5 || lb < 1e-5) continue;
      _a.divideScalar(la); _b.divideScalar(lb);
      const ang = Math.acos(THREE.MathUtils.clamp(_a.dot(_b), -1, 1));
      if (ang <= max) continue;
      _n.crossVectors(_a, _b);
      if (_n.lengthSq() < 1e-10) continue;      // parallel: already at 0, can't exceed
      _n.normalize();
      // SOFT correction, a fraction of the excess per pass: an exact snap teleports a limb (length constraints turn it into
      // velocity) and a fixed per-pass cap starves when contested; a multiplicative yield does neither
      _qd.setFromAxisAngle(_n, (max - ang) * TUNING.YIELD);
      this._swing(b, c, _b.applyQuaternion(_qd), lb);
    }

    // ---- CONE: limb direction vs the torso
    const { r, u, f } = this.frame;
    if (TUNING.ON_CONE) for (const { b, c, axis, cos } of this.cone) {
      const pb = this.p[b], pc = this.p[c];
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (lb < 1e-5) continue;
      _b.divideScalar(lb);
      // the stored axis is in body-frame coordinates; rebuild it in the world
      _n.copy(r).multiplyScalar(axis.x)
        .addScaledVector(u, axis.y)
        .addScaledVector(f, axis.z).normalize();
      const d = _b.dot(_n);
      if (d >= cos) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(d, -1, 1));
      const lim = Math.acos(cos);
      _v.crossVectors(_n, _b);
      if (_v.lengthSq() < 1e-10) continue;      // exactly antipodal: no unique plane
      _v.normalize();
      _qd.setFromAxisAngle(_v, -(ang - lim) * TUNING.YIELD);
      this._swing(b, c, _b.applyQuaternion(_qd), lb);
    }

    // ---- BEHIND: a one-sided frontal-plane stop on the limb's direction
    if (TUNING.ON_BEHIND) for (const { b, c, minFwd } of this.behind) {
      const pb = this.p[b], pc = this.p[c];
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (lb < 1e-5) continue;
      _b.divideScalar(lb);
      const fwd = _b.dot(this.frame.f);
      if (fwd >= minFwd) continue;
      // rotating about (limb x forward) swings the limb toward forward, which
      // is the only direction that reduces the violation
      _v.crossVectors(_b, this.frame.f);
      if (_v.lengthSq() < 1e-10) continue;      // limb already along forward
      _v.normalize();
      const need = Math.asin(THREE.MathUtils.clamp(minFwd, -1, 1))
        - Math.asin(THREE.MathUtils.clamp(fwd, -1, 1));
      _qd.setFromAxisAngle(_v, need * TUNING.YIELD);
      this._swing(b, c, _b.applyQuaternion(_qd), lb);
    }

    // ---- HINGE: signed one-sided fold, plus a sideways tolerance
    if (TUNING.ON_HINGE) for (const H of this.hinge) {
      const pa = this.p[H.a], pb = this.p[H.b], pc = this.p[H.c];
      _a.copy(pb).sub(pa); const la = _a.length();
      _b.copy(pc).sub(pb); const lb = _b.length();
      if (la < 1e-5 || lb < 1e-5) continue;
      _a.divideScalar(la); _b.divideScalar(lb);
      // TRANSPORT the hinge axis, never rebuild it from the body frame: the projection of forward flips sign when the limb
      // lines up with it, which reads as hyperextended by 180° and throws the foot
      const n = _n.copy(H.n);
      n.addScaledVector(_a, -n.dot(_a));
      if (n.lengthSq() < 1e-8) {
        n.crossVectors(_a, this.frame.f);
        if (n.lengthSq() < 1e-8) continue;
      }
      H.n.copy(n.normalize());
      _c.crossVectors(n, _a);                   // the allowed fold direction

      let changed = false;
      // sideways: how far out of the hinge plane the lower link has strayed
      const oop = _b.dot(n);
      const lim2 = THREE.MathUtils.clamp(oop, -H.side, H.side);
      if (oop !== lim2) { _b.addScaledVector(n, (lim2 - oop) * TUNING.YIELD); changed = true; }
      // hyperextension: the lower link never crosses to the wrong side of straight. Deadband: at flex 0 the sign is noise,
      // and correcting every flicker chatters instead of settling.
      const flexC = _b.dot(_c);
      if (flexC < -0.03) { _b.addScaledVector(_c, -flexC * TUNING.YIELD); changed = true; }
      if (changed) _b.normalize();
      // and the fold has an end
      const ang = Math.acos(THREE.MathUtils.clamp(_b.dot(_a), -1, 1));
      if (ang > H.max) {
        _v.crossVectors(_a, _b);
        if (_v.lengthSq() > 1e-10) {
          _qd.setFromAxisAngle(_v.normalize(), (H.max - ang) * TUNING.YIELD);
          _b.applyQuaternion(_qd);
          changed = true;
        }
      }
      if (changed) this._swing(H.b, H.c, _b, lb);
    }
  }

  /** Apply a velocity height-weighted about the lowest joint: none at the
   *  bottom, all of it at the top. On a standing body that is a topple about
   *  the feet (see the constructor note); on a lying one the span is shallow,
   *  so the same rule rolls it away from the push instead. */
  _topple(lean) {
    let lo = Infinity, hi = -Infinity;
    for (const j of JOINTS) {
      const p = this.p[j]; if (!p) continue;
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    const span = (hi - lo) || 1;
    for (const j of JOINTS) {
      if (this.prev[j]) this.prev[j].addScaledVector(lean, -(this.p[j].y - lo) / span * FIXED_DT);
    }
  }

  /** Pin a joint to a world-space target — a grabbed joint in a hand, or a
   *  joint NAILED somewhere (the persistent pins bodydrag places). A body may
   *  carry several at once: hung by both wrists, dragged by an ankle while a
   *  hand stays nailed. While set, the joint has infinite mass (constraints
   *  move the REST of the body toward the pin, never the pin toward the body)
   *  and is snapped to the target each substep. `prev` is deliberately left
   *  alone: the gap between the snap and where the joint was IS the drag
   *  velocity, so releasing mid-swing throws the body the way it was moving.
   *  setPin(joint, null) releases that joint alone; setPin(null) releases
   *  everything. */
  setPin(joint, target, _firm = false) {
    // `_firm` (nail vs hand — see ammodoll.setPin) is accepted for engine
    // interface parity and deliberately unused: a Verlet pin zeroes inverse
    // mass, which IS the rigid nail — there is no softer hand mode to pick.
    this.pins ??= new Map();
    const unpin = (j) => { this.iw[j] = 1 / (MASS[j] ?? 1); this.pins.delete(j); };
    if (!joint) { for (const j of [...this.pins.keys()]) unpin(j); return; }
    if (!this.p[joint]) return;
    if (!target) { unpin(joint); return; }
    const t = this.pins.get(joint) ?? new THREE.Vector3();
    t.copy(target);
    if (!Number.isFinite(t.x + t.y + t.z)) { unpin(joint); return; }
    this.pins.set(joint, t);
    this.iw[joint] = 0;
  }

  // pinned + impulse live on BodyEngineBase — the cap, the topple application
  // and the clock restarts are the shared law; _topple above is this engine's
  // half of it.

  /** Everything this sim IS, as plain numbers: where every joint is and how
   *  fast it is going, in world coordinates.
   *
   *  Handing a body from one machine to another has been lossy at every seam.
   *  A streamed POSE is where the bones point — not where the particles are,
   *  and not what they were doing — so a receiver rebuilding a sim from a pose
   *  has to invent the velocity, and invents zero. That is why a body swung
   *  across a room and let go of settled on the spot, and why a takeover began
   *  by discarding whatever the body was already doing. A handover carries
   *  this instead, and the receiver continues rather than restarts.
   *
   *  Format and rounding are rigmeasure.js's (snapshotPacker) — the parse on
   *  the far side may be the OTHER engine's, so the two halves must be one
   *  truth. */
  snapshot() {
    const pack = snapshotPacker();
    for (const name of JOINTS) {
      const q = this.p[name];
      if (!q) continue;
      _v.copy(q).sub(this.prev[name]).divideScalar(FIXED_DT);
      pack.add(name, q, _v);
    }
    const s = pack.pack();
    // the transported hinge axes — physical state the particles alone do not
    // carry (see the constructor's handover note). Optional in the format:
    // a receiver without hinges (another engine) ignores it.
    s.h = this.hinge.flatMap((H) => [H.n.x, H.n.y, H.n.z]);   // exact, like p/v
    return s;
  }

  /** Advance the sim and push the result into the avatar as a held pose.
   *  Returns the sparse pose (for streaming) while active, or null once it has
   *  been captured and handed off. */
  step(dt) {
    if (this.done) return null;
    dt = Math.min(0.25, Math.max(0, dt || 0));

    // ---- fixed timestep: the sim advances only in FIXED_DT slices, so the outcome doesn't depend on display rate;
    // a long hitch drops its backlog (MAX_FRAMES) rather than simulating a second in one frame
    if (TUNING.PAUSED) dt = 0;
    this.acc += dt;
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_FRAMES) { this._solve(); this.acc -= FIXED_DT; n++; }
    if (n === MAX_FRAMES) this.acc = 0;
    // pin positions sampled per FRAME (the cursor's rate): per substep would read the same target twice and call it still
    if (this.pins?.size) {
      for (const [j, t] of this.pins) {
        const f = this._pinFrom.get(j);
        if (f) f.copy(t); else this._pinFrom.set(j, t.clone());
      }
    }

    this.steps++;
    this.frames += n;
    // the clock law is the base's; the thresholds (and the hysteresis band —
    // it takes real motion to restart the countdown, not a flicker) are this
    // engine's tuned numbers. Settle is measured in SECONDS, not frames.
    this._settleTick(dt, this.maxV < TUNING.SETTLE_V,
      this.maxV > TUNING.SETTLE_V * TUNING.SETTLE_RESET);

    if (n === 0 && this.pose) return this.pose;   // nothing moved; nothing to resend

    this._followRoot();   // the body lies where it fell — see bodyengine.js

    // ---- map particles back to bone rotations (parent-relative + twist state)
    _mat.makeBasis(this.frame.r, this.frame.u, this.frame.f);
    _qBody.setFromRotationMatrix(_mat);
    const dtF = Math.max(1e-4, n * FIXED_DT);

    const pose = {};
    for (const d of this.drive) {
      const bn = this.nodes[d.bone];
      // a bone's direction runs from the joint's PARTICLE to its child's, not the skeleton's bone position: on a rig whose
      // hips sit off the root origin the two disagree and the chest inherits a bogus roll (§24t-8)
      const bwp = this.p[d.bone] ?? bn.getWorldPosition(_a);
      _b.copy(this.p[d.child]).sub(bwp);
      if (_b.lengthSq() < 1e-6) continue;
      _b.normalize();

      // the frame this bone hangs off, already resolved (parents come first)
      const par = d.twistParent ? this.driveBy.get(d.twistParent) : null;
      _qp.copy(par ? par.frameW : _qBody);

      // live direction, in that parent frame
      _t2.copy(_b).applyQuaternion(_qpi.copy(_qp).invert());
      if (_t2.dot(d.restLocalAxis) < -0.999) continue;   // 180° from rest: the
      // joint limits are supposed to make this unreachable; if it ever happens,
      // hold the previous frame rather than invent a roll
      _qs.setFromUnitVectors(d.restLocalAxis, _t2);
      _qs.multiply(d.restLocal);                         // swing-free, in parent
      _qL.copy(_qp).multiply(_qs);                       // ...and in the world

      // ---- twist: a limp bone LAGS its parent's roll, then springs back
      const rollRate = twistAbout(_qt.copy(_qL).multiply(_qsi.copy(d.swingW).invert()), _b);
      d.swingW.copy(_qL);
      d.twv -= rollRate * TUNING.TWIST_LAG / dtF;
      d.twv *= TUNING.TWIST_DAMP;
      d.twv -= d.tw * TUNING.TWIST_STIFF * dtF;
      d.tw += d.twv * dtF;
      if (!TUNING.ON_TWIST) { d.tw = 0; d.twv = 0; }
      if (d.tw > d.twMax) { d.tw = d.twMax; d.twv = 0; }
      else if (d.tw < -d.twMax) { d.tw = -d.twMax; d.twv = 0; }

      _qs.multiply(_qt.setFromAxisAngle(_X, d.tw));      // roll in the bone frame
      d.frameW.copy(_qp).multiply(_qs);

      _qd.copy(d.frameW).multiply(d.restFrameInv).multiply(d.restQuat);
      // world -> local (parent may itself have moved this frame)
      d.parent.getWorldQuaternion(_qpi).invert();
      _qpi.multiply(_qd);
      bn.quaternion.copy(_qpi);
      pose[d.bone] = [+_qpi.x.toFixed(4), +_qpi.y.toFixed(4), +_qpi.z.toFixed(4), +_qpi.w.toFixed(4)];
    }
    this.pose = pose;
    // apply locally too, held, so the owner sees its own flop this frame
    this.avatar.setPose(pose);

    // ---- settle detection: hand off to a captured held pose and stop
    if (this.settledFor >= TUNING.SETTLE_TIME || this.elapsed >= TUNING.DEADLINE) {
      this.done = true;
      this.finalPose = pose;
    }
    return pose;
  }
}
