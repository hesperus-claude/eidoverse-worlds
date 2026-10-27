// ammodoll — the Bullet (ammo.js) body engine, ported from socketteer/ragdoll-physics; contract: BodyEngineBase (bodyengine.js).
// The source's tuned numbers transfer (Blender's rigid bodies ARE Bullet); the rig is measured from the live VRM skeleton.
// Joint frames are ANATOMICAL (Y along the bone, X flexion from the rig's forward/up), never a node's local axes.
// Laws: bodies are rest-aligned (limits mean "from rest"); a joint must CONTAIN THE POSE IT WAS BORN IN — see docs/research/ammodoll-port.md.
// WASM: every Ammo object is tracked and destroyed in dispose(); per-frame math reuses module temps.

import { THREE } from './core.js';
import { heightAt, waterField } from './terrain.js';
import { surfaceOffset } from '../../shared/waves.js';
import { partWaterForce, waterCurrent, swellRise, WATER_ANG_DRAG } from '../../shared/buoyancy.js';
import { nearColliders, surfaceUnder } from './colliders.js';
import { why } from './debuglog.js';
import { SEGMENTS, segDistance, rigFrameOf, snapshotPacker, seedJoints } from './rigmeasure.js';
import { BodyEngineBase } from './bodyengine.js';

let AMMO = null;
let ammoLoading = null;
/** Exact inertia of rotated child boxes about the body origin, diagonal only (Bullet takes no off-diagonals).
 *  btCompoundShape's AABB approximation over-weights twist ~5x on rotated boxes, and twist limits then don't hold. */
function boxesInertia(boxes, mass) {
  let vol = 0;
  for (const b of boxes) vol += 8 * b.he.x * b.he.y * b.he.z;
  if (!(vol > 0)) return { x: 0, y: 0, z: 0 };
  let xx = 0, yy = 0, zz = 0;
  const m3 = new THREE.Matrix3();
  for (const b of boxes) {
    const m = mass * (8 * b.he.x * b.he.y * b.he.z) / vol;
    const x = 2 * b.he.x, y = 2 * b.he.y, z = 2 * b.he.z;
    // principal moments in the BOX's own frame
    const ix = m / 12 * (y * y + z * z);
    const iy = m / 12 * (x * x + z * z);
    const iz = m / 12 * (x * x + y * y);
    // rotate: I' = R diag(i) R^T  (only the diagonal of I' is kept, below)
    m3.setFromMatrix4(_m4.makeRotationFromQuaternion(b.q));
    const e = m3.elements;   // column-major: e[0..2] = col0
    xx += ix * e[0] * e[0] + iy * e[3] * e[3] + iz * e[6] * e[6];
    yy += ix * e[1] * e[1] + iy * e[4] * e[4] + iz * e[7] * e[7];
    zz += ix * e[2] * e[2] + iy * e[5] * e[5] + iz * e[8] * e[8];
    // parallel axis, to the body origin
    const t = b.t;
    xx += m * (t.y * t.y + t.z * t.z);
    yy += m * (t.x * t.x + t.z * t.z);
    zz += m * (t.x * t.x + t.y * t.y);
  }
  return { x: xx, y: yy, z: zz };
}

/** Interior triangles reach Bullet only this near a fall: a tumble covers a few metres at most. */
const INTERIOR_REACH = 8;
/** Max interior triangles per fall, all interiors together: the build is synchronous and Ammo's heap is finite.
 *  Past it, nearer (INTERIOR_NEAR), then a floor slab. */
export const INTERIOR_MAX_TRIS = 20_000;
const INTERIOR_NEAR = 3;
/** Things already warned about on the console (bounded): a fallback is said
 *  once per thing there, and always to the `ragdoll` debuglog topic, which
 *  keeps the last few. Constructor-time only — never per frame. */
const fallbackWarned = new Set();
function reportInteriorFallback(id, msg) {
  why('ragdoll', `interior fallback — ${msg}; its walls are left out of this fall`);
  if (fallbackWarned.has(id) || fallbackWarned.size >= 64) return;
  fallbackWarned.add(id);
  console.warn(`[ammodoll] interior fallback — ${msg}; its walls are left out of the fall (further ones: lastWhy('ragdoll'))`);
}

/** Does a triangle's xz footprint overlap the square `reach` around `at`? Separating axes, not corner distance:
 *  a big floor's corners can all be far from a body lying on it. */
function overlapsSquare(v, at, reach) {
  const x0 = at.x - reach, x1 = at.x + reach, z0 = at.z - reach, z1 = at.z + reach;
  if (Math.max(v[0].x, v[1].x, v[2].x) < x0 || Math.min(v[0].x, v[1].x, v[2].x) > x1) return false;
  if (Math.max(v[0].z, v[1].z, v[2].z) < z0 || Math.min(v[0].z, v[1].z, v[2].z) > z1) return false;
  for (let k = 0; k < 3; k++) {
    const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
    const nx = -(b.z - a.z), nz = b.x - a.x;          // the edge's normal in xz
    if (nx === 0 && nz === 0) continue;
    const side = Math.sign(nx * (c.x - a.x) + nz * (c.z - a.z));
    if (side === 0) continue;                          // seen edge-on: no axis
    // the square lies wholly on the far side of this edge from the triangle?
    let far = true;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      if (Math.sign(nx * (x - a.x) + nz * (z - a.z)) !== -side) { far = false; break; }
    }
    if (far) return false;
  }
  return true;
}

/** An interior collider's world-space triangles within `reach` of `at` (xz), flat [x,y,z, ...]; geometry is
 *  root-local (colliders.js buildExact), placed by the entity transform. */
export function interiorTriangles(c, at, reach, max = INTERIOR_MAX_TRIS) {
  // Walks the collider's own BVH and stops at `max`: a dense interior costs its budget, never its size.
  const o = c.obj, s = o.scale?.x || 1, q = o.quaternion, p = o.position;
  // the reach square in the thing's frame: it turns about Y only, so a circle of reach·√2 holds it
  const l = new THREE.Vector3(at.x - p.x, 0, at.z - p.z);
  if (q) l.applyQuaternion(q.clone().invert());
  l.divideScalar(s);
  const R = reach * Math.SQRT2 / s;
  const qbox = new THREE.Box3(new THREE.Vector3(l.x - R, -1e9, l.z - R), new THREE.Vector3(l.x + R, 1e9, l.z + R));
  const out = [];
  let over = false;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  c.exact.bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(qbox),
    intersectsTriangle: (tri) => {
      v[0].copy(tri.a); v[1].copy(tri.b); v[2].copy(tri.c);
      for (const w of v) { w.multiplyScalar(s); if (q) w.applyQuaternion(q); w.add(p); }
      if (!overlapsSquare(v, at, reach)) return false;
      if (out.length / 9 >= max) { over = true; return true; }   // stops the walk
      out.push(v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y, v[2].z);
      return false;
    },
  });
  return { tris: out, over };
}

export async function ensureAmmo() {
  if (AMMO) return true;
  if (ammoLoading) return ammoLoading;
  ammoLoading = (async () => {
    try {
      if (typeof document === 'undefined') {
        // headless (bun): the glue has a CommonJS tail
        const [{ createRequire }, { fileURLToPath }] = await Promise.all([
          import('node:module'), import('node:url'),
        ]);
        const req = createRequire(import.meta.url);
        const dir = fileURLToPath(new URL('../vendor/ammo/', import.meta.url));
        AMMO = await req(dir + 'ammo.wasm.js')({ locateFile: (f) => dir + f });
      } else {
        // browser: classic Emscripten script, not an ES module — script tag
        if (!globalThis.Ammo) {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = '/vendor/ammo/ammo.wasm.js';
            s.onload = res;
            s.onerror = () => rej(new Error('vendor/ammo failed to load'));
            document.head.appendChild(s);
          });
        }
        AMMO = await globalThis.Ammo({ locateFile: (f) => '/vendor/ammo/' + f });
      }
      _initTemps();
      return true;
    } catch (e) {
      console.error('[ammodoll] wasm init failed — verlet stays', e);
      AMMO = null;
      return false;
    } finally {
      ammoLoading = null;
    }
  })();
  return ammoLoading;
}
export const ammoReady = () => !!AMMO;

// ---------------------------------------------------------------- constants

const DEG = Math.PI / 180;

// Dempster's segment fractions (rigdef.py BODIES). Never mass from proxy volume: a 0.4 kg pelvis whips like a bead.
const MASS_FRAC = {
  torso: 0.14 + 0.14 + 0.16,   // kept for the degenerate no-spine-bones trunk
  pelvis: 0.14, spineSeg: 0.14, chestSeg: 0.16,   // rigdef.py's rows, used apart
  head: 0.081,
  upperArm: 0.028, lowerArm: 0.016, hand: 0.006,
  upperLeg: 0.100, lowerLeg: 0.047, foot: 0.015,
};
// Depth as a fraction of trunk half-width: the source's proxy boxes are nearly as deep as broad.
const TRUNK_DEPTH = 0.88;
const REAL_H = 1.70;            // rigdef.py: reference height for the mass budget
const BODY_KG = 62.0;           // at REAL_H, scaled by (H/1.70)³
const FINGER_MASS_FRAC = 0.0016; // per phalanx body (~20 g at 62 kg); thumb ×1.4

const FINGER_STIFFNESS = 12.0;  // rigdef.py, measured sag plateau
const FINGER_DAMPING = 0.9;
const FINGER_TENDON = 8.0;

const ERP_LIMIT = 0.35;         // source default: how hard limits are held
// limits go through setParam: this ammo build binds no getRotationalLimitMotor (so no muscle-tone motors)
const BT_CONSTRAINT_STOP_ERP = 3; // this build's setParam id (source, verbatim)
const ACTIVE_TAG = 1;
// Bullet's enum values: ammo.js exports no constants, and an undefined global throws at the first hair lock.
const CF_KINEMATIC = 2;            // btCollisionObject::CF_KINEMATIC_OBJECT
const DISABLE_DEACTIVATION = 4;    // never sleep — a kinematic anchor must not

const LIN_DAMP = 0.12;          // source setDamping(0.12, —)
// 0.7, not the source's 0.45: ours tumbles, and at 0.45 hands and head ring at 1-12 rad/s and never sleep.
const ANG_DAMP = 0.7;
const ANG_DAMP_FINGER = 0.95;   // spring-driven 20 g boxes: dissipate hard
const LIN_DAMP_FINGER = 0.3;
const FRICTION = 0.85;
const RESTITUTION = 0.03;

const FIXED_DT = 1 / 120;       // source stepSimulation(dt, 8, 1/120)
const MAX_SUBSTEPS = 8;
const SETTLE_V = 0.07;          // the house settle law
const SETTLE_W = 0.6;
const SETTLE_TIME = 0.45;
const DEADLINE = 8;
const ANG_CEIL = 20;            // rad/s backstop
const BUILD_WIDEN = 0.12;       // rad of slack over the born excursion
const PIN_TAU = 0.9;            // source: the shift-click pin, held firm
const PIN_CLAMP_X = 8;          // × total mass
// The source's grab setting, a hand not a nail: a nail-stiff grab overpowers the joint stops.
const GRAB_TAU = 0.4;
const GRAB_CLAMP_X = 1.2;       // × total mass

/** Hair tuning, live (retuneHair); dimensionless values port from the source playground, mass doesn't. */
export const HAIR_TUNING = {
  // Tuned by eye on a falling body (hair has no headless metric for "flows" vs "whips"); close to the source's defaults.
  mass: 0.003,      // kg per segment
  tension: 7.25,    // 6DOF angular spring stiffness
  damping: 0.31,    // both the spring's and the body's angular damping
  gravity: 0.45,    // fraction of world gravity
  limit: 25,        // degrees at the TIP
  rootExp: 1.2,     // ramp exponent: lim = limit * ((j+1)/n)^rootExp
};

/** Wing tuning, live, same shape as HAIR_TUNING: a limp wing swings from the shoulder and trails, never flaps. */
export const WING_TUNING = {
  mass: 0.55,       // kg per segment: a 20 g metre-long plate is all lever and reads as paper
  // Tension 8 is the knee (swept over 4 leans): most kept bend, least jitter; stiffer reads rigid and twitchy — see docs/research/ragdoll-tuning.md.
  tension: 8,       // 6DOF angular spring stiffness
  damping: 0.15,    // spring and body angular damping; Bullet's spring damping is a velocity GAIN: more is snappier
  gravity: 1.0,     // fraction of world gravity: full, unlike hair
  // A linear ramp (70/1.0) beat steeper ones on fold and jitter both; 0.7 was no better on a paired re-test — see docs/research/ragdoll-tuning.md.
  limit: 70,        // degrees at the outermost segment
  rootExp: 1.0,     // linear: the shoulder gets a third of the range, the tip all of it
};

// rigdef.py JOINTS (degrees) on the _jointBasis axes: Y twist, X primary swing, Z = X×Y. X's sign is derived
// from the built axis, never hard-coded, since the sides mirror. ref: 'fwd' | 'up' | 'palm' | 'pinky'.
export const JOINT_SPECS = {
  // Hand-tuned in-world (debug panel "joint limits (live)"); tighter than rigdef, since a ragdoll has no muscle tone.
  // Axes locked at zero (trunk twist, knee side-bend) are exempt from the born-widening (BUILD_WIDEN).
  spine: { ref: 'fwd', x: [-10, 10], twist: 0, z: [-4, 4] },
  chest: { ref: 'fwd', x: [-20, 20], twist: 0, z: [-6, 6] },
  head: { ref: 'fwd', x: [-33, 33], twist: 24, z: [-19, 19] },
  upperArm: { ref: 'fwd', x: [-85, 85], twist: 56, z: [-85, 85] },
  lowerArm: { ref: 'fwd', flex: 145, ext: 2, want: 'fwd', twist: 5, z: [-5, 5] },
  hand: { ref: 'palm', flex: 45, ext: 45, want: 'palm', twist: 8, z: [-15, 15] },
  // Hand-tuned leg rows; safe because the range-centering below keeps Bullet's wrap point out of reach
  // (pinned by tools/ammodoll-test.ts).
  upperLeg: { ref: 'fwd', flex: 90, ext: 8, want: 'fwd', twist: 0, z: [-13, 13] },
  lowerLeg: { ref: 'fwd', flex: 123, ext: 0, want: 'back', twist: 3, z: [0, 0] },
  foot: { ref: 'up', x: [-35, 35], twist: 12, z: [-12, 12] },
  fingerProx: { ref: 'palm', flex: 90, ext: 6, want: 'palm', twist: 8, z: [-12, 12] },
  fingerMid: { ref: 'palm', flex: 100, ext: 0, want: 'palm', twist: 4, z: [-4, 4] },
  thumb: { ref: 'pinky', flex: 55, ext: 10, want: 'pinky', twist: 12, z: [-25, 25] },
};

// The body cut is rigmeasure.js's SEGMENTS (shared with ragdoll.js); torso rows share bodies (TORSO_KEYS),
// hands and feet are extra segments, and fingers ride on the hands.
const TORSO_KEYS = new Set(['hips|spine', 'spine|chest', 'chest|neck']);
const CORE_SEGMENTS = SEGMENTS;
const EXTRA_SEGMENTS = [
  { a: 'leftHand', b: 'leftMiddleProximal', part: 'hand' },
  { a: 'rightHand', b: 'rightMiddleProximal', part: 'hand' },
  { a: 'leftFoot', b: 'leftToes', part: 'foot' },
  { a: 'rightFoot', b: 'rightToes', part: 'foot' },
];
const CORE_JOINTS = [
  { at: 'spine', parent: 'hips|spine', child: 'spine|chest', spec: 'spine' },
  { at: 'chest', parent: 'spine|chest', child: 'chest|neck', spec: 'chest' },
  { at: 'neck', parent: 'chest', child: 'neck|head', spec: 'head' },
  { at: 'leftUpperArm', parent: 'chest', child: 'leftUpperArm|leftLowerArm', spec: 'upperArm' },
  { at: 'rightUpperArm', parent: 'chest', child: 'rightUpperArm|rightLowerArm', spec: 'upperArm' },
  { at: 'leftLowerArm', parent: 'leftUpperArm|leftLowerArm', child: 'leftLowerArm|leftHand', spec: 'lowerArm' },
  { at: 'rightLowerArm', parent: 'rightUpperArm|rightLowerArm', child: 'rightLowerArm|rightHand', spec: 'lowerArm' },
  { at: 'leftHand', parent: 'leftLowerArm|leftHand', child: 'leftHand|leftMiddleProximal', spec: 'hand' },
  { at: 'rightHand', parent: 'rightLowerArm|rightHand', child: 'rightHand|rightMiddleProximal', spec: 'hand' },
  { at: 'leftUpperLeg', parent: 'hips', child: 'leftUpperLeg|leftLowerLeg', spec: 'upperLeg' },
  { at: 'rightUpperLeg', parent: 'hips', child: 'rightUpperLeg|rightLowerLeg', spec: 'upperLeg' },
  { at: 'leftLowerLeg', parent: 'leftUpperLeg|leftLowerLeg', child: 'leftLowerLeg|leftFoot', spec: 'lowerLeg' },
  { at: 'rightLowerLeg', parent: 'rightUpperLeg|rightLowerLeg', child: 'rightLowerLeg|rightFoot', spec: 'lowerLeg' },
  { at: 'leftFoot', parent: 'leftLowerLeg|leftFoot', child: 'leftFoot|leftToes', spec: 'foot' },
  { at: 'rightFoot', parent: 'rightLowerLeg|rightFoot', child: 'rightFoot|rightToes', spec: 'foot' },
];
// VRM digit chains [prox, mid, distal] ("little", not "pinky"); tendons couple index→middle→ring→little, never the thumb.
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];

// Filter = AND of both directions, frozen at addRigidBody. ammo.js passes group/mask as SHORT: bits above 14
// truncate (often to 0, which collides with nothing). Budget: bit 0 statics, 1..12 core bodies (hands/feet ride
// their limb's bit), 14 ground-only.
const G_STATIC = 1;
const G_FINGER = 1 << 14;      // 16384 — the top bit a signed short can hold
const BODY_BITS = 12;
const FILTER_MAX = 1 << 14;    // anything above this does not survive the call

// ---------------------------------------------------------------- wasm temps

let _bv1, _bv2, _bt1, _bt2, _bq1;
function _initTemps() {
  if (_bv1) return;
  _bv1 = new AMMO.btVector3(); _bv2 = new AMMO.btVector3();
  _bt1 = new AMMO.btTransform(); _bt2 = new AMMO.btTransform();
  _bq1 = new AMMO.btQuaternion(0, 0, 0, 1);
}
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/** Body world rotation → THREE, consumed IMMEDIATELY: Ammo's value-returning methods share one static temporary,
  *  so two held results alias. Every rotation read goes through here. */
function quatOf2(body, out) {
  const r = body.getCenterOfMassTransform().getRotation();
  return out.set(r.x(), r.y(), r.z(), r.w());
}

/** Deterministic frame with Y along `dir`: setFromUnitVectors answers antiparallel inputs arbitrarily, per call. */
function frameQuat(dir, out = new THREE.Quaternion()) {
  const y = dir.clone().normalize();
  const ref = Math.abs(y.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(ref, y).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Per-bone mesh extents in the bone's bind frame, cached per avatar (bone length misjudges wing membrane); a vertex
  *  goes to its decisive top-weight bone. Map(bone -> {c, he}); empty headless, where callers keep bone-length boxes. */
function boneMeshExtents(avatar, key, match) {
  // Keyed: hair and wings match differently, and one shared map would silently hand the second caller the first's.
  const cache = avatar.__boneExt ??= new Map();
  if (cache.has(key)) return cache.get(key);
  const out = new Map();
  const acc = new Map();      // bone name -> {lo, hi}
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  avatar.root?.traverse?.((o) => {
    if (!o.isSkinnedMesh || !o.skeleton?.bones?.length) return;
    const pos = o.geometry?.attributes?.position;
    const si = o.geometry?.attributes?.skinIndex;
    const sw = o.geometry?.attributes?.skinWeight;
    if (!pos || !si || !sw) return;
    // which of this skeleton's bones are we being asked about
    const want = new Map();
    o.skeleton.bones.forEach((b, i) => { if (match(b.name)) want.set(i, b.name); });
    if (!want.size) return;
    for (let k = 0; k < pos.count; k++) {
      let bi = -1, bw = 0;
      for (let c = 0; c < 4; c++) {
        const w = sw.getComponent(k, c);
        if (w > bw) { bw = w; bi = si.getComponent(k, c); }
      }
      // below 0.4 a vertex straddles a joint and would stretch both boxes past the real geometry
      if (bw < 0.4 || !want.has(bi)) continue;
      const name = want.get(bi);
      m.multiplyMatrices(o.skeleton.boneInverses[bi], o.bindMatrix);
      v.fromBufferAttribute(pos, k).applyMatrix4(m);
      let a = acc.get(name);
      if (!a) acc.set(name, (a = { lo: v.clone(), hi: v.clone(), n: 0 }));
      a.lo.min(v); a.hi.max(v); a.n++;
    }
  });
  for (const [name, a] of acc) {
    // a handful of stray vertices is noise, not a shape: fall back
    if (a.n < 24) continue;
    out.set(name, {
      c: a.lo.clone().add(a.hi).multiplyScalar(0.5),
      he: a.hi.clone().sub(a.lo).multiplyScalar(0.5),
    });
  }
  cache.set(key, out);
  return out;
}

/** A bone's mesh extent carried to world by its live matrix (centre + one bone-oriented box), or null.
 *  `floor`: minimum half-extent per axis, since a zero-depth box has no inertia about two axes. */
function extBox(nd, ext, floor = 0.01) {
  if (!ext) return null;
  nd.updateWorldMatrix(true, false);
  return {
    center: ext.c.clone().applyMatrix4(nd.matrixWorld),
    boxes: [{
      he: new THREE.Vector3(
        Math.max(ext.he.x, floor), Math.max(ext.he.y, floor), Math.max(ext.he.z, floor)),
      t: new THREE.Vector3(0, 0, 0),
      q: nd.getWorldQuaternion(new THREE.Quaternion()),
    }],
  };
}

/** Shortest arc with the antiparallel case answered deterministically. */
const _sa1 = new THREE.Vector3(); const _sa2 = new THREE.Vector3(); const _sa3 = new THREE.Vector3();
function shortestArc(from, to, out = new THREE.Quaternion()) {
  const f = _sa1.copy(from).normalize();
  const t = _sa2.copy(to).normalize();
  const d = f.dot(t);
  if (d > 0.999999) return out.set(0, 0, 0, 1);
  if (d < -0.999999) {
    _sa3.set(Math.abs(f.x) < 0.9 ? 1 : 0, Math.abs(f.x) < 0.9 ? 0 : 1, 0);
    _sa3.crossVectors(f, _sa3).normalize();
    return out.setFromAxisAngle(_sa3, Math.PI);
  }
  _sa3.crossVectors(f, t);
  out.set(_sa3.x, _sa3.y, _sa3.z, 1 + d);
  return out.normalize();
}

const _wv = [0, 0, 0], _wf = [0, 0, 0], _wc = [0, 0, 0];   // water scratch (_water)

export class AmmoRagdoll extends BodyEngineBase {
  constructor(avatar, lean = null, rest = null, seedVel = null) {
    super(avatar);                  // lifecycle fields — see bodyengine.js
    if (!AMMO) throw new Error('ammodoll: wasm not ready — ensureAmmo() first');
    this.pins = new Map();          // joint -> THREE.Vector3 (world) — bodydrag reads this
    this._pinCons = new Map();      // joint -> { con, body }
    this.maxW = Infinity;
    this._refs = [];                // every wasm object we own, freed in dispose()
    const keep = (o) => { this._refs.push(o); return o; };

    const h = avatar.vrm.humanoid;
    avatar.root.updateMatrixWorld(true);
    const node = (j) => h?.getNormalizedBoneNode?.(j) ?? null;

    // ---- live capture + neutral rest (two skeletons) ------------------------
    const wanted = new Set(CORE_SEGMENTS.flat());
    for (const e of EXTRA_SEGMENTS) { wanted.add(e.a); wanted.add(e.b); }
    for (const side of ['left', 'right']) {
      for (const f of FINGERS) {
        for (const lvl of ['Proximal', 'Intermediate', 'Distal']) wanted.add(`${side}${f}${lvl}`);
      }
      for (const lvl of ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal']) wanted.add(`${side}${lvl}`);
    }
    const live = {};
    for (const j of wanted) {
      const n = node(j);
      if (n) live[j] = n.getWorldPosition(new THREE.Vector3());
    }
    if (!live.chest && live.spine && live.neck) {
      live.chest = live.spine.clone().add(live.neck).multiplyScalar(0.5);
    }
    // neck is optional in VRM; a missing bone must not detach the head
    if (!live.neck && live.chest && live.head) {
      live.neck = live.chest.clone().lerp(live.head, 0.75);
    }
    const seedV = {};
    if (seedVel?.j) {
      for (const s of seedJoints(seedVel)) {
        if (live[s.name]) live[s.name].set(s.px, s.py, s.pz);
        seedV[s.name] = new THREE.Vector3(s.vx, s.vy, s.vz);
      }
    } else if (seedVel) {
      for (const j of Object.keys(live)) {
        const v = seedVel.get?.(j) ?? seedVel[j];
        if (v) seedV[j] = new THREE.Vector3(v.x, v.y, v.z);
      }
    }
    const restP = {};
    const restSrc = rest ?? avatar.restBonePositions?.() ?? live;
    for (const [j, v] of Object.entries(restSrc)) {
      restP[j] = v.clone ? v.clone() : new THREE.Vector3(v.x, v.y, v.z);
    }
    // joints the caller didn't sample fill from the avatar's neutral pose, else (a stand-in) from the live skeleton
    const restExtra = avatar.restBonePositions?.([...wanted]) ?? null;
    for (const j of wanted) {
      if (restP[j]) continue;
      const src = restExtra?.[j] ?? live[j];
      if (src) restP[j] = src.clone();
    }
    if (!restP.chest && restP.spine && restP.neck) {
      restP.chest = restP.spine.clone().add(restP.neck).multiplyScalar(0.5);
    }
    if (!restP.neck && restP.chest && restP.head) {
      restP.neck = restP.chest.clone().lerp(restP.head, 0.75);
    }
    this.restP = restP;

    // ---- rig frame + scale --------------------------------------------------
    this.rig = rigFrameOf(restP);   // measured, one derivation — rigmeasure.js
    const rigUp = this.rig.up, rigLat = this.rig.lateral, rigFwd = this.rig.forward;
    // VRM binds palms DOWN and rest IS the bind pose, so finger flexion curls toward the rig's down
    const palmN = rigUp.clone().negate();

    let hiUp = -Infinity, loUp = Infinity;
    for (const v of Object.values(restP)) {
      const d = v.dot(rigUp);
      hiUp = Math.max(hiUp, d); loUp = Math.min(loUp, d);
    }
    const H = Math.min(2.5, Math.max(0.4, (hiUp - loUp) * 1.12));   // + skull/sole
    this.height = H;
    const massScale = BODY_KG * (H / REAL_H) ** 3;
    const span = restP.leftUpperArm && restP.rightUpperArm
      ? restP.leftUpperArm.distanceTo(restP.rightUpperArm) : H * 0.3;
    // Trunk half-width: the wider of shoulder span and the source's proxy boxes (0.093-0.125 of height); narrow is floppy.
    const torsoR = Math.max(0.05, span * 0.22, H * 0.055);

    // ---- extrapolate missing tips so hands/feet can be bodies --------------
    // a VRM without finger/toe bones still gets a hand and foot: ~35% of the parent bone, continuing its direction
    const extrapolate = (m, from, parentFrom, frac = 0.35) => {
      if (!m[from] || !m[parentFrom]) return null;
      const d = m[from].clone().sub(m[parentFrom]);
      if (d.lengthSq() < 1e-8) return null;
      return m[from].clone().addScaledVector(d, frac);
    };
    for (const e of EXTRA_SEGMENTS) {
      const parent = e.part === 'hand'
        ? (e.a === 'leftHand' ? 'leftLowerArm' : 'rightLowerArm')
        : (e.a === 'leftFoot' ? 'leftLowerLeg' : 'rightLowerLeg');
      if (!live[e.b]) {
        const l = extrapolate(live, e.a, parent);
        const r = extrapolate(restP, e.a, parent);
        if (l && r) { live[e.b] = l; restP[e.b] = r; }
      }
    }

    // ---- the physics world -------------------------------------------------
    const cfg = keep(new AMMO.btDefaultCollisionConfiguration());
    const dispatcher = keep(new AMMO.btCollisionDispatcher(cfg));
    const broadphase = keep(new AMMO.btDbvtBroadphase());
    const solver = keep(new AMMO.btSequentialImpulseConstraintSolver());
    this.world = keep(new AMMO.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cfg));
    _bv1.setValue(0, -9.81, 0);
    this.world.setGravity(_bv1);
    const info = this.world.getSolverInfo();
    info.set_m_numIterations(30);                       // source: 30, not stock 4
    info.set_m_splitImpulse(true);
    info.set_m_splitImpulsePenetrationThreshold(-0.02);

    this._statics = [];
    const addStatic = (halfX, halfY, halfZ, pos, quat, friction) =>
      addStaticShape(keep(new AMMO.btBoxShape(new AMMO.btVector3(halfX, halfY, halfZ))), pos, quat, friction);
    const addStaticShape = (shape, pos, quat, friction) => {
      _bt1.setIdentity();
      _bv1.setValue(pos.x, pos.y, pos.z); _bt1.setOrigin(_bv1);
      if (quat) { _bq1.setValue(quat.x, quat.y, quat.z, quat.w); _bt1.setRotation(_bq1); }
      const ms = keep(new AMMO.btDefaultMotionState(_bt1));
      _bv1.setValue(0, 0, 0);
      const ci = keep(new AMMO.btRigidBodyConstructionInfo(0, ms, shape, _bv1));
      const rb = keep(new AMMO.btRigidBody(ci));
      rb.setFriction(friction);
      rb.setRollingFriction(0.05);
      rb.setRestitution(0);
      this.world.addRigidBody(rb, G_STATIC, -1);
      this._statics.push(rb);
      return rb;
    };
    const hips = live.hips ?? avatar.root.position;
    this.groundY = heightAt(hips.x, hips.z);
    // Terrain-following ground: box tiles at the field's sampled heights (one flat cuboid buries heads on slopes);
    // within 2cm everywhere keeps the one-cuboid path. A wide apron at the LOWEST sample catches long tumbles.
    {
      // TILE bounds the stair-step error (slope×TILE/2): 0.75 m keeps a 40% grade within 15 cm
      const GROUND_R = 12, TILE = 0.75;
      const tiles = [];
      let lo = this.groundY, flat = true;
      for (let gx = -GROUND_R; gx <= GROUND_R; gx += TILE) {
        for (let gz = -GROUND_R; gz <= GROUND_R; gz += TILE) {
          const h = heightAt(hips.x + gx, hips.z + gz);
          tiles.push([gx, gz, h]);
          lo = Math.min(lo, h);
          if (Math.abs(h - this.groundY) > 0.02) flat = false;
        }
      }
      if (flat) {
        addStatic(60, 0.5, 60, { x: hips.x, y: this.groundY - 0.5, z: hips.z }, null, FRICTION);
      } else {
        addStatic(60, 0.5, 60, { x: hips.x, y: lo - 0.5, z: hips.z }, null, FRICTION);
        for (const [gx, gz, h] of tiles) {
          addStatic(TILE / 2 + 0.02, 0.5, TILE / 2 + 0.02,
            { x: hips.x + gx, y: h - 0.5, z: hips.z + gz }, null, FRICTION);
        }
      }
    }
    // The spatial hash answers "what is near the fall", never a full scan of `colliders` (§14.2 6a).
    for (const [, c] of nearColliders(hips.x, hips.z, 8)) {
      const obj = c.obj;
      if (!obj || c.interior || !c.box) continue;
      if (Math.hypot(obj.position.x - hips.x, obj.position.z - hips.z) > 8) continue;
      // scale applies to the centre offset too, and rotation places the box (colliders.js)
      const sc = obj.scale ?? { x: 1, y: 1, z: 1 };
      const size = c.box.getSize(new THREE.Vector3()).multiply(_v.set(sc.x, sc.y, sc.z));
      const centre = c.box.getCenter(new THREE.Vector3())
        .multiply(_v.set(sc.x, sc.y, sc.z))
        .applyQuaternion(obj.quaternion ?? new THREE.Quaternion())
        .add(obj.position);
      addStatic(
        Math.max(size.x / 2, 0.02), Math.max(size.y / 2, 0.02), Math.max(size.z / 2, 0.02),
        centre, obj.quaternion ?? null, 0.8,
      );
    }
    // Room-scale interiors (skipped above: a box would seal the room) go to Bullet as their real triangles
    // (colliders.js entry.exact). Over INTERIOR_MAX_TRIS: only INTERIOR_NEAR, then a floor slab; never no floor.
    let budget = INTERIOR_MAX_TRIS;
    this.interiorFallback = null;
    for (const [id, c] of nearColliders(hips.x, hips.z, 8)) {
      if (!c.obj || !c.interior || !c.exact?.bvh) continue;
      let got = interiorTriangles(c, hips, INTERIOR_REACH, budget);
      if (got.over) got = interiorTriangles(c, hips, INTERIOR_NEAR, budget);
      if (got.over) {
        const floor = surfaceUnder(hips.x, hips.z, heightAt, hips.y + 0.3).y;
        addStatic(INTERIOR_NEAR, 0.25, INTERIOR_NEAR, { x: hips.x, y: floor - 0.25, z: hips.z }, null, 0.8);
        this.interiorFallback = `${id}: over ${INTERIOR_MAX_TRIS} triangles within ${INTERIOR_NEAR}m — a floor slab at ${floor.toFixed(2)}m stands in`;
        reportInteriorFallback(id, this.interiorFallback);
        continue;
      }
      const tri = got.tris;
      if (!tri.length) continue;
      budget -= tri.length / 9;
      const mesh = keep(new AMMO.btTriangleMesh());
      const a = keep(new AMMO.btVector3(0, 0, 0)), b = keep(new AMMO.btVector3(0, 0, 0)), d = keep(new AMMO.btVector3(0, 0, 0));
      for (let k = 0; k < tri.length; k += 9) {
        a.setValue(tri[k], tri[k + 1], tri[k + 2]);
        b.setValue(tri[k + 3], tri[k + 4], tri[k + 5]);
        d.setValue(tri[k + 6], tri[k + 7], tri[k + 8]);
        mesh.addTriangle(a, b, d, false);
      }
      addStaticShape(keep(new AMMO.btBvhTriangleMeshShape(mesh, true, true)), { x: 0, y: 0, z: 0 }, null, 0.8);
    }

    // ---- torso: one rigid body, rest-aligned -------------------------------
    const upperOf = (m) => m.chest ?? m.neck ?? m.spine ?? m.head;
    const restUpper = upperOf(restP), liveUpper = upperOf(live);
    if (!restUpper || !liveUpper || !restP.hips || !live.hips) {
      throw new Error('ammodoll: rig has no usable torso chain');
    }
    const topOf = (m) => m.neck ?? m.chest ?? m.spine ?? m.head;
    const torsoQ = shortestArc(
      restUpper.clone().sub(restP.hips), liveUpper.clone().sub(live.hips), new THREE.Quaternion());
    const restTorsoMid = restP.hips.clone().add(topOf(restP)).multiplyScalar(0.5);
    const liveTorsoMid = live.hips.clone().add(topOf(live)).multiplyScalar(0.5);

    // ---- rest-aligned orientation down the chain ---------------------------
    const SEGKEYS = CORE_SEGMENTS.map((s) => s.join('|'));
    const parentSegOf = new Map();
    for (const J of CORE_JOINTS) {
      if (SEGKEYS.includes(J.child) || J.child.includes('|')) parentSegOf.set(J.child, J.parent);
    }
    const bodyQuat = new Map();
    const quatOf = (key, seen = new Set()) => {
      if (bodyQuat.has(key)) return bodyQuat.get(key);
      if (TORSO_KEYS.has(key) || key === 'hips') { bodyQuat.set(key, torsoQ); return torsoQ; }
      if (seen.has(key)) return torsoQ;
      seen.add(key);
      const [a, b] = key.split('|');
      if (!live[a] || !live[b] || !restP[a] || !restP[b]) return torsoQ;
      const pk = parentSegOf.get(key);
      const qParent = pk && pk !== 'hips' && pk !== 'chest' && !TORSO_KEYS.has(pk)
        ? quatOf(pk, seen) : torsoQ;
      const liveLocal = live[b].clone().sub(live[a]).applyQuaternion(qParent.clone().invert());
      const q = qParent.clone().multiply(
        shortestArc(restP[b].clone().sub(restP[a]), liveLocal, new THREE.Quaternion()));
      bodyQuat.set(key, q);
      return q;
    };

    // ---- bodies ------------------------------------------------------------
    // Compounds of boxes; half-width 0.16 × bone length (rigdef.py), except the trunk, which takes torsoR.
    this.segs = new Map();          // segKey -> seg
    this._bodies = [];              // every dynamic body, build order
    this._cores = [];               // non-finger bodies (settle metrics)
    this._waterR = new Map();       // core body -> its extent either side of its centre (floating)
    this._massOf = new Map();       // body -> mass (Bullet only hands back 1/m)
    const bodyIndex = new Map();    // body -> filter bit index (core only)

    this._vol = [];                 // debug: the boxes, body-local, per body
    const mkBody = (mass, originLive, orient, boxes, isFinger) => {
      const compound = keep(new AMMO.btCompoundShape());
      for (const bx of boxes) {
        const shape = keep(new AMMO.btBoxShape(new AMMO.btVector3(bx.he.x, bx.he.y, bx.he.z)));
        _bt1.setIdentity();
        _bv1.setValue(bx.t.x, bx.t.y, bx.t.z); _bt1.setOrigin(_bv1);
        _bq1.setValue(bx.q.x, bx.q.y, bx.q.z, bx.q.w); _bt1.setRotation(_bq1);
        compound.addChildShape(_bt1, shape);
      }
      _bt1.setIdentity();
      _bv1.setValue(originLive.x, originLive.y, originLive.z); _bt1.setOrigin(_bv1);
      _bq1.setValue(orient.x, orient.y, orient.z, orient.w); _bt1.setRotation(_bq1);
      const ms = keep(new AMMO.btDefaultMotionState(_bt1));
      const I = boxesInertia(boxes, mass);
      _bv1.setValue(I.x, I.y, I.z);
      const ci = keep(new AMMO.btRigidBodyConstructionInfo(mass, ms, compound, _bv1));
      const rb = keep(new AMMO.btRigidBody(ci));
      rb.setDamping(isFinger ? LIN_DAMP_FINGER : LIN_DAMP, isFinger ? ANG_DAMP_FINGER : ANG_DAMP);
      rb.setFriction(FRICTION);
      // Rolling friction stops light boxes wobbling on a corner and holding settle off; it needs a value on both
      // bodies of a pair, so the statics carry 0.05 too.
      rb.setRollingFriction(0.05);
      rb.setRestitution(RESTITUTION);
      // Let it sleep once converged (kept awake, residual noise twitches forever). Per island, so the doll settles
      // together; every pin, impulse or seed calls activate().
      rb.setSleepingThresholds(0.02, 0.05);
      rb.setActivationState(ACTIVE_TAG);
      this._bodies.push(rb);
      this._massOf.set(rb, mass);
      if (!isFinger) {
        this._cores.push(rb);
        // the part's reach either side of its centre, for how much of it is under water (_water)
        let r = 0.04;
        for (const bx of boxes) r = Math.max(r, Math.hypot(bx.t.x, bx.t.y, bx.t.z) + Math.hypot(bx.he.x, bx.he.y, bx.he.z) * 0.6);
        this._waterR.set(rb, r);
      }
      // Child boxes for debug.js's overlay (volumes()): the skeleton can't show them, and caps/radius are verlet-only.
      this._vol.push({
        body: rb,
        boxes: boxes.map((bx) => ({ he: bx.he.clone(), t: bx.t.clone(), q: bx.q.clone() })),
      });
      return rb;
    };

    // a box spanning ra→rb in REST coordinates, local to a body whose rest origin is `origin`
    // minLen 0.04 is a LIMB's floor (no degenerate boxes); hair passes its own, since a 4cm floor makes a lock a stick.
    const boxFor = (origin, ra, rb2, halfW, halfD = halfW, minLen = 0.04) => {
      const dir = rb2.clone().sub(ra);
      const len = Math.max(dir.length(), minLen);
      const mid = ra.clone().add(rb2).multiplyScalar(0.5).sub(origin);
      return { he: new THREE.Vector3(halfW, len / 2, halfD), t: mid, q: frameQuat(dir) };
    };
    const limbW = (ra, rb2) => Math.max(0.02, ra.distanceTo(rb2) * 0.16);

    // The trunk is THREE bodies (pelvis, spine, chest) on the source's spine/chest limits: one rigid trunk falls as
    // a plank and overloads the arm joints. MASS_FRAC.torso's three Dempster fractions are used apart.
    const segMeta = new Map();      // segKey -> { body, restOrigin }
    const TRUNK = [
      ['hips|spine', 'pelvis'], ['spine|chest', 'spineSeg'], ['chest|neck', 'chestSeg'],
    ];
    let nextBit = 0;
    let trunkBuilt = 0;
    for (const [key, part] of TRUNK) {
      const [a, b2] = key.split('|');
      if (!restP[a] || !restP[b2] || !live[a] || !live[b2]) continue;
      const ra = restP[a], rb2 = restP[b2];
      const restMid = ra.clone().add(rb2).multiplyScalar(0.5);
      const liveMid = live[a].clone().add(live[b2]).multiplyScalar(0.5);
      const body = mkBody(MASS_FRAC[part] * massScale, liveMid, torsoQ,
        [boxFor(restMid, ra, rb2, torsoR, torsoR * TRUNK_DEPTH)], false);
      const seg = {
        key, a, b: b2, body, torso: true,
        restA: ra.clone(), restB: rb2.clone(),
        localA: ra.clone().sub(restMid), localB: rb2.clone().sub(restMid),
        r: torsoR,
      };
      this.segs.set(key, seg);
      segMeta.set(key, { body, restOrigin: restMid });
      if (nextBit <= BODY_BITS) bodyIndex.set(body, nextBit++);
      trunkBuilt++;
    }
    // Degenerate trunk (no spine/chest bones): the single-body fallback.
    if (!trunkBuilt) {
      const body = mkBody(MASS_FRAC.torso * massScale, liveTorsoMid, torsoQ,
        [boxFor(restTorsoMid, restP.hips, restUpper, torsoR, torsoR * TRUNK_DEPTH)], false);
      segMeta.set('hips|spine', { body, restOrigin: restTorsoMid });
      segMeta.set('chest|neck', { body, restOrigin: restTorsoMid });
      this.segs.set('hips|spine', {
        key: 'hips|spine', a: 'hips', b: 'spine', body, torso: true,
        restA: restP.hips.clone(), restB: restUpper.clone(),
        localA: restP.hips.clone().sub(restTorsoMid),
        localB: restUpper.clone().sub(restTorsoMid), r: torsoR,
      });
      if (nextBit <= BODY_BITS) bodyIndex.set(body, nextBit++);
    }
    // 'torso' is what the arms and head hang off: the chest, once the trunk articulates.
    this.torsoBody = (segMeta.get('chest|neck') ?? segMeta.get('hips|spine'))?.body ?? null;

    // limb + head + hand/foot bodies
    const partOf = (key) => {
      if (key === 'neck|head') return 'head';
      if (/UpperArm\|/.test(key)) return 'upperArm';
      if (/LowerArm\|/.test(key)) return 'lowerArm';
      if (/Hand\|/.test(key)) return 'hand';
      if (/UpperLeg\|/.test(key)) return 'upperLeg';
      if (/LowerLeg\|/.test(key)) return 'lowerLeg';
      if (/Foot\|/.test(key)) return 'foot';
      return null;
    };
    const allSegs = [
      ...CORE_SEGMENTS.filter(([a]) => !TORSO_KEYS.has(`${a}|`)).map(([a, b2]) => `${a}|${b2}`)
        .filter((k) => !TORSO_KEYS.has(k)),
      ...EXTRA_SEGMENTS.map((e) => `${e.a}|${e.b}`),
    ];
    for (const key of allSegs) {
      if (this.segs.has(key)) continue;
      const [a, b2] = key.split('|');
      if (!live[a] || !live[b2] || !restP[a] || !restP[b2]) continue;
      const part = partOf(key);
      if (!part) continue;
      const ra = restP[a], rb2 = restP[b2];
      const restMid = ra.clone().add(rb2).multiplyScalar(0.5);
      const liveMid = live[a].clone().add(live[b2]).multiplyScalar(0.5);
      const qB = quatOf(key);
      // the head is a skull, not a stick: widen toward the trunk's scale
      const w = part === 'head' ? Math.max(limbW(ra, rb2), torsoR * 0.55)
        : part === 'foot' ? Math.max(limbW(ra, rb2), 0.03)
          : limbW(ra, rb2);
      // The skull is a VOLUME (VRM's head bone sits at its base): the box runs on to a crown point AND widens to skull
      // scale, which is what holds a prone head up. Collision only; seg endpoints, .p and pins keep the true bone.
      const isHead = part === 'head';
      const boxEnd = isHead
        ? rb2.clone().addScaledVector(
          rb2.clone().sub(ra).normalize(),
          // only to a real crown: a head is 0.124 of height long, so extend by what's LEFT after the bone
          Math.min(0.16, Math.max(0.05, H * 0.124 - rb2.distanceTo(ra))))
        : rb2;
      const wHead = isHead ? Math.max(w, H * 0.05) : w;
      const dHead = isHead ? Math.max(w, H * 0.058) : w;
      const body = mkBody(
        MASS_FRAC[part] * massScale, liveMid, qB,
        [boxFor(restMid, ra, boxEnd, wHead, dHead)], false);
      const seg = {
        key, a, b: b2, body, torso: false,
        restA: ra.clone(), restB: rb2.clone(),
        localA: ra.clone().sub(restMid), localB: rb2.clone().sub(restMid),
        r: w,
      };
      this.segs.set(key, seg);
      segMeta.set(key, { body, restOrigin: restMid });
      if (nextBit <= BODY_BITS) bodyIndex.set(body, nextBit++);
    }

    // ---- self-collision groups ---------------------------------------------
    // A pair is excluded (both directions) when constraint-adjacent or deeply overlapping at rest. The filter is the
    // only per-pair lever (no setIgnoreCollisionCheck) and freezes at addRigidBody, so compute it all first.
    {
      // segment-vs-segment distance is rigmeasure.js's
      const segList = [...this.segs.values()];
      const adjacent = (x, y) => x.body === y.body
        || x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b;
      const excluded = new Map();   // body -> Set(body)
      const exclude = (x, y) => {
        if (!excluded.has(x)) excluded.set(x, new Set());
        if (!excluded.has(y)) excluded.set(y, new Set());
        excluded.get(x).add(y); excluded.get(y).add(x);
      };
      for (let i = 0; i < segList.length; i++) {
        for (let j2 = i + 1; j2 < segList.length; j2++) {
          const A2 = segList[i], B2 = segList[j2];
          if (A2.body === B2.body) continue;
          if (adjacent(A2, B2)) { exclude(A2.body, B2.body); continue; }
          // deep at rest = buried, pumping contact energy every frame; grazing is fine
          if (segDistance(A2.restA, A2.restB, B2.restA, B2.restB) < (A2.r + B2.r) * 1.05) {
            exclude(A2.body, B2.body);
          }
        }
      }
      // A hand rides its forearm's bit, a foot its calf's: 16 bodies in 12 bits, and the pair still skips itself
      // while every other body still meets the hand.
      for (const seg of this.segs.values()) {
        // by KEY: seg objects built from the extra segments carry no `part`
        if (!/^(left|right)(Hand|Foot)\|/.test(seg.key ?? '')) continue;
        const parent = [...this.segs.values()].find((s) => s !== seg && s.b === seg.a);
        if (parent && bodyIndex.has(parent.body)) bodyIndex.set(seg.body, bodyIndex.get(parent.body));
      }
      // A shared bit excludes if ANY of its bodies does, or thigh/calf collide again via the foot's bit.
      // Over-excluding is the safe direction; under-excluding starts a penetration fight at a joint.
      const bitBodies = new Map();
      for (const [body, bit] of bodyIndex) {
        if (!bitBodies.has(bit)) bitBodies.set(bit, []);
        bitBodies.get(bit).push(body);
      }
      this._groupOf = new Map();
      for (const [body, bit] of bodyIndex) {
        this._groupOf.set(body, (G_STATIC << 1) << bit);
        let mask = G_STATIC;
        for (const [obit, sharers] of bitBodies) {
          if (obit === bit) continue;
          if (sharers.some((o) => excluded.get(body)?.has(o))) continue;
          mask |= (G_STATIC << 1) << obit;
        }
        const group = (G_STATIC << 1) << bit;
        // Loud: an over-budget group truncates to zero in wasm and the body silently stops colliding.
        if (group > FILTER_MAX) {
          console.error(`[ammodoll] filter group ${group} exceeds the short budget `
            + `— this body will collide with nothing`);
        }
        this.world.addRigidBody(body, group, mask);
      }
      // core bodies past the bit budget go ground-only (none today: 13 ≤ 1+12 bits)
      for (const body of this._cores) {
        if (!bodyIndex.has(body)) this.world.addRigidBody(body, G_FINGER, G_STATIC);
      }
    }

    // ---- joint frames: anatomy on the anatomical basis ---------------------
    // Y = rest bone (twist), X = swing from the rig's reference, Z = X×Y. Origin from LIVE transforms, basis from
    // rest (limits mean "from rest"); rest-aligned bodies make both true at once.
    this._constraints = [];
    this._springs = [];
    this.jointMeta = [];            // { name, spec, axisX/Y/Z world-at-rest, lo, hi }
    this.skipped = [];

    const towardPinky = (side) => {
      const a2 = restP[`${side}LittleProximal`] ?? restP[`${side}Hand`];
      const b2 = restP[`${side}ThumbProximal`] ?? restP[`${side}ThumbMetacarpal`];
      if (!a2 || !b2) return rigFwd.clone();
      const d = a2.clone().sub(b2);
      return d.lengthSq() > 1e-8 ? d.normalize() : rigFwd.clone();
    };
    const refVec = (ref, side) =>
      ref === 'up' ? rigUp.clone()
        : ref === 'palm' ? palmN.clone()
          : ref === 'pinky' ? towardPinky(side) : rigFwd.clone();
    const wantVec = (want, side) =>
      want === 'back' ? rigFwd.clone().negate()
        : want === 'palm' ? palmN.clone()
          : want === 'pinky' ? towardPinky(side) : rigFwd.clone();

    const localOf = (body, worldPos) => {
      const t = body.getCenterOfMassTransform();
      const o = t.getOrigin(), r = t.getRotation();
      return worldPos.clone().sub(_v.set(o.x(), o.y(), o.z()))
        .applyQuaternion(_q.set(r.x(), r.y(), r.z(), r.w()).invert()).clone();
    };

    const addJoint = ({ name, parentBody, childBody, parentRestOrigin, childRestOrigin,
      restAt, liveAt, boneDir, spec, side, spring }) => {
      const S = JOINT_SPECS[spec];
      // X: primary swing axis
      let x = new THREE.Vector3().crossVectors(boneDir, refVec(S.ref, side));
      if (x.lengthSq() < 1e-6) x.crossVectors(boneDir, rigLat);
      if (x.lengthSq() < 1e-6) x.copy(rigLat);
      x.normalize();
      const y = boneDir.clone().normalize();
      const z = new THREE.Vector3().crossVectors(x, y).normalize();
      x.crossVectors(y, z).normalize();               // re-orthogonalise
      const basis = new THREE.Quaternion().setFromRotationMatrix(_m4.makeBasis(x, y, z));

      // signed X range: which way does +X rotation move the child's tip?
      let xlo, xhi;
      if (S.flex != null) {
        const move = new THREE.Vector3().crossVectors(x, boneDir);
        const positiveFlexes = move.dot(wantVec(S.want, side)) > 0;
        xlo = (positiveFlexes ? -S.ext : -S.flex) * DEG;
        xhi = (positiveFlexes ? S.flex : S.ext) * DEG;
      } else {
        xlo = S.x[0] * DEG; xhi = S.x[1] * DEG;
      }
      const lo = [xlo, -S.twist * DEG, S.z[0] * DEG];
      const hi = [xhi, S.twist * DEG, S.z[1] * DEG];

      // born excursion per axis: a joint must contain the pose it was born in.
      // ⚠️ ONE getRotation() PER STATEMENT: ammo returns one static temporary per method, so two held results alias
      // (rel = identity). Consume each into a THREE object before the next call.
      quatOf2(parentBody, _q);
      quatOf2(childBody, _qp);
      const rel = _q.invert().multiply(_qp);
      const relF = basis.clone().invert().multiply(rel).multiply(basis);
      const eul = new THREE.Euler().setFromQuaternion(relF, 'XYZ');
      const born = [eul.x, eul.y, eul.z];
      // A seeded body is a HANDOVER, its pose a sim state: widening to contain it would ratchet the limits on every
      // release, so it gets at most BUILD_WIDEN past the table and is pushed back in.
      const cap = seedVel ? BUILD_WIDEN : Infinity;
      const anatLo = lo.slice(), anatHi = hi.slice();
      for (let i = 0; i < 3; i++) {
        // A LOCKED axis (lo === hi) stays locked: widening would hand back ±BUILD_WIDEN of the freedom it removes.
        if (anatHi[i] - anatLo[i] === 0) {
          // …but a rig BORN off its locked axis (§24t-8) moves the lock to the born angle: zero freedom, no fight.
          // On a handover, no further than BUILD_WIDEN from the table's zero.
          lo[i] = hi[i] = Math.max(anatLo[i] - cap, Math.min(anatHi[i] + cap, born[i]));
          continue;
        }
        lo[i] = Math.max(anatLo[i] - cap, Math.min(lo[i], born[i] - BUILD_WIDEN));
        hi[i] = Math.min(anatHi[i] + cap, Math.max(hi[i], born[i] + BUILD_WIDEN));
      }

      // Center the range on the frame: Bullet wraps to the least-violating angle, so a one-sided range (knee −145°..+7°)
      // has a reachable wrap point that holds the joint on the wrong side; rotating by the midpoint pushes it to 180°.
      let mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      let midQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(mid[0], mid[1], mid[2], 'XYZ'));
      // …and contain the born pose as Bullet measures it, in the centred frame (Euler angles don't add across axes,
      // §24t-8): re-measure and widen until the range is a fixed point of its centering (1–2 rounds).
      for (let round = 0; round < 4; round++) {
        const eulC = new THREE.Euler().setFromQuaternion(midQ.clone().invert().multiply(relF), 'XYZ');
        const bornC = [eulC.x + mid[0], eulC.y + mid[1], eulC.z + mid[2]];
        let moved = false;
        for (let i = 0; i < 3; i++) {
          if (anatHi[i] - anatLo[i] === 0) {
            const v = Math.max(anatLo[i] - cap, Math.min(anatHi[i] + cap, bornC[i]));
            if (v !== lo[i]) { lo[i] = hi[i] = v; moved = true; }
            continue;
          }
          const nlo = Math.max(anatLo[i] - cap, Math.min(lo[i], bornC[i] - BUILD_WIDEN));
          const nhi = Math.min(anatHi[i] + cap, Math.max(hi[i], bornC[i] + BUILD_WIDEN));
          if (nlo !== lo[i] || nhi !== hi[i]) { lo[i] = nlo; hi[i] = nhi; moved = true; }
        }
        if (!moved) break;
        mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        midQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(mid[0], mid[1], mid[2], 'XYZ'));
      }
      const basisA = basis.clone().multiply(midQ);

      // frames: basis from rest anatomy (parent's carries the centering), origin from the live anchor
      const mkFrame = (body, frameBasis) => {
        const tr = keep(new AMMO.btTransform());
        tr.setIdentity();
        const o = localOf(body, liveAt);
        _bv2.setValue(o.x, o.y, o.z); tr.setOrigin(_bv2);
        _bq1.setValue(frameBasis.x, frameBasis.y, frameBasis.z, frameBasis.w);
        tr.setRotation(_bq1);
        return tr;
      };
      const fa = mkFrame(parentBody, basisA);
      const fb = mkFrame(childBody, basis);
      const C = spring ? AMMO.btGeneric6DofSpringConstraint : AMMO.btGeneric6DofConstraint;
      const con = keep(new C(parentBody, childBody, fa, fb, true));
      _bv1.setValue(0, 0, 0);
      con.setLinearLowerLimit(_bv1); con.setLinearUpperLimit(_bv1);
      _bv1.setValue(lo[0] - mid[0], lo[1] - mid[1], lo[2] - mid[2]); con.setAngularLowerLimit(_bv1);
      _bv1.setValue(hi[0] - mid[0], hi[1] - mid[1], hi[2] - mid[2]); con.setAngularUpperLimit(_bv1);
      if (spring) {
        for (let ax = 3; ax < 6; ax++) {
          con.enableSpring(ax, true);
          con.setStiffness(ax, FINGER_STIFFNESS);
          con.setDamping(ax, FINGER_DAMPING);
        }
        // built in the relaxed pose, so the current state IS the rest curl (source, verbatim)
        con.setEquilibriumPoint();
        this._springs.push(con);
      }
      for (let ax = 3; ax < 6; ax++) con.setParam(BT_CONSTRAINT_STOP_ERP, ERP_LIMIT, ax);
      this.world.addConstraint(con, true);     // linked pair ignores each other
      this._constraints.push(con);
      this.jointMeta.push({
        name, spec, axisX: x.clone(), axisY: y.clone(), axisZ: z.clone(),
        lo: [...lo], hi: [...hi], born: [...born], mid: [...mid],
        parentBody, childBody, basisA, basisB: basis.clone(),
        // for retune(): the constraint, and which way +X flexes on THIS side (derived at build, never assumed)
        con, positiveFlexes: S.flex != null ? xhi > 0 : null,
      });
      return con;
    };

    // Named trunk anchors: legs hang off the PELVIS, arms and head off the CHEST; one fused body makes the trunk rigid.
    const metaOf = (ref) => {
      if (ref === 'hips') return segMeta.get('hips|spine');
      if (ref === 'chest') return segMeta.get('chest|neck') ?? segMeta.get('hips|spine');
      return segMeta.get(ref);
    };
    for (const J of CORE_JOINTS) {
      const pm = metaOf(J.parent), cm = metaOf(J.child);
      if (!pm || !cm || pm.body === cm.body) {
        // a skipped joint is a DETACHED body part: never skip one silently
        if (cm && pm !== cm && this.segs.get(J.child)) {
          this.skipped.push(J.at);
          console.warn(`[ammodoll] no joint at ${J.at} — ${J.child} is unattached`);
        }
        continue;
      }
      if (!restP[J.at] || !live[J.at]) continue;
      const cs = this.segs.get(J.child);
      addJoint({
        name: J.at, parentBody: pm.body, childBody: cm.body,
        parentRestOrigin: pm.restOrigin, childRestOrigin: cm.restOrigin,
        restAt: restP[J.at], liveAt: live[J.at],
        boneDir: cs.restB.clone().sub(cs.restA).normalize(),
        spec: J.spec, side: J.at.startsWith('left') ? 'left' : 'right',
        spring: false,
      });
    }

    // ---- fingers: spring phalanges + tendons -------------------------------
    // proximal and intermediate only (rigdef.py); the thumb is ONE body, Proximal→Distal, metacarpal fused into the palm
    this._fingerSegs = [];
    const fingerBodies = new Map();  // `${side}|${digit}|${lvl}` -> body
    const fingerQuat = new Map();    // same key -> rest→live orientation
    const addFingerBody = (side, digit, lvl, aName, bName, spec, parentRef) => {
      if (!live[aName] || !live[bName] || !restP[aName] || !restP[bName]) return;
      const handMeta = segMeta.get(`${side}Hand|${side}MiddleProximal`);
      if (!handMeta) return;
      const ra = restP[aName], rb2 = restP[bName];
      if (ra.distanceTo(rb2) < 0.005) return;
      const restMid = ra.clone().add(rb2).multiplyScalar(0.5);
      const liveMid = live[aName].clone().add(live[bName]).multiplyScalar(0.5);
      // rest-aligned DOWN THE CHAIN (zero roll): each phalanx composes from its parent, never independent shortest arcs
      const qParent = (lvl === 2 ? fingerQuat.get(`${side}|${digit}|1`) : null)
        ?? quatOf(`${side}Hand|${side}MiddleProximal`);
      const liveLocal = live[bName].clone().sub(live[aName]).applyQuaternion(qParent.clone().invert());
      const qB = qParent.clone().multiply(
        shortestArc(rb2.clone().sub(ra), liveLocal, new THREE.Quaternion()));
      fingerQuat.set(`${side}|${digit}|${lvl}`, qB);
      const mass = FINGER_MASS_FRAC * massScale * (digit === 'Thumb' ? 1.4 : 1);
      const w = Math.max(0.006, ra.distanceTo(rb2) * 0.22);
      const body = mkBody(mass, liveMid, qB, [boxFor(restMid, ra, rb2, w)], true);
      this.world.addRigidBody(body, G_FINGER, G_STATIC);   // fingers hit the ground only
      const seg = {
        key: `${aName}|${bName}`, a: aName, b: bName, body, torso: false, finger: true,
        restA: ra.clone(), restB: rb2.clone(),
        localA: ra.clone().sub(restMid), localB: rb2.clone().sub(restMid),
        r: w,
      };
      this.segs.set(seg.key, seg);
      segMeta.set(seg.key, { body, restOrigin: restMid });
      this._fingerSegs.push(seg);
      fingerBodies.set(`${side}|${digit}|${lvl}`, body);
      const parentMeta = parentRef ? segMeta.get(parentRef) : handMeta;
      addJoint({
        name: aName, parentBody: parentMeta.body, childBody: body,
        parentRestOrigin: parentMeta.restOrigin, childRestOrigin: restMid,
        restAt: ra, liveAt: live[aName],
        boneDir: rb2.clone().sub(ra).normalize(),
        spec, side, spring: true,
      });
    };
    for (const side of ['left', 'right']) {
      if (!segMeta.get(`${side}Hand|${side}MiddleProximal`)) continue;
      for (const digit of FINGERS) {
        addFingerBody(side, digit, 1,
          `${side}${digit}Proximal`, `${side}${digit}Intermediate`, 'fingerProx', null);
        addFingerBody(side, digit, 2,
          `${side}${digit}Intermediate`, `${side}${digit}Distal`, 'fingerMid',
          `${side}${digit}Proximal|${side}${digit}Intermediate`);
      }
      addFingerBody(side, 'Thumb', 1,
        `${side}ThumbProximal`, `${side}ThumbDistal`, 'thumb', null);
    }
    // tendons: a weak X-only orientation spring between neighbouring fingers at one level, all axes free (lower > upper)
    for (const side of ['left', 'right']) {
      for (const lvl of [1, 2]) {
        for (let k = 0; k + 1 < FINGERS.length; k++) {
          const ra = fingerBodies.get(`${side}|${FINGERS[k]}|${lvl}`);
          const rb2 = fingerBodies.get(`${side}|${FINGERS[k + 1]}|${lvl}`);
          if (!ra || !rb2) continue;
          _bt1.setIdentity(); _bt2.setIdentity();
          const con = keep(new AMMO.btGeneric6DofSpringConstraint(ra, rb2, _bt1, _bt2, true));
          _bv1.setValue(1, 1, 1); con.setLinearLowerLimit(_bv1); con.setAngularLowerLimit(_bv1);
          _bv1.setValue(-1, -1, -1); con.setLinearUpperLimit(_bv1); con.setAngularUpperLimit(_bv1);
          con.enableSpring(3, true);
          con.setStiffness(3, FINGER_TENDON);
          con.setDamping(3, 0.9);
          con.setEquilibriumPoint();
          this.world.addConstraint(con, true);
          this._constraints.push(con);
        }
      }
    }

    // ---- BULLET HAIR: each Hair_<chain>_<idx> bone is a thin box on 6DOF springs (limits ramp ((j+1)/n)^rootExp,
    // fractional gravity, CCD), colliding with the world and skull only. LOCAL DRESSING: excluded from settle,
    // snapshot and the pose wire.
    this._hairSegs = [];
    {
      const headSeg = this.segs.get('neck|head');
      const hairNodes = [];
      avatar.root?.traverse?.((o) => { if (/^Hair_\d+_\d+$/.test(o.name ?? '')) hairNodes.push(o); });
      const chains = new Map();
      for (const nd of hairNodes) {
        const m = nd.name.match(/^Hair_(\d+)_(\d+)$/);
        if (!chains.has(m[1])) chains.set(m[1], []);
        chains.get(m[1]).push({ i: Number(m[2]), node: nd });
      }
      if (headSeg && chains.size) {
        // The combed pose, captured ONCE per avatar (the doll is rebuilt every release): never rebuild a rig from a
        // simulated pose, or the crumple ratchets in.
        if (!avatar.__hairRest) {
          const rest = new Map();
          for (const [, list0] of chains) {
            for (const it of list0) rest.set(it.node, it.node.quaternion.clone());
          }
          avatar.__hairRest = rest;
        }
        // ...and start combed, not mid-tumble; updateMatrix too, since springbone joints have matrixAutoUpdate false.
        for (const [nd0, q0] of avatar.__hairRest) {
          nd0.quaternion.copy(q0); nd0.updateMatrix();
        }
        avatar.root.updateMatrixWorld(true);
        const headGroup = this._groupOf.get(headSeg.body) ?? G_STATIC;
        const R = Math.max(0.004 * H, 0.004);
        const hairExt = boneMeshExtents(avatar, 'hair', (n) => /^Hair_\d+_\d+$/.test(n));
        // Hair is built with isFinger=true, so take its numbers from HAIR_TUNING, not the finger defaults.
        const HT = HAIR_TUNING;      // live — see retuneHair()
        const HAIR_LIM = HT.limit * DEG, HAIR_ROOT = HT.rootExp;
        const HAIR_GRAV = HT.gravity, HAIR_MASS = HT.mass;
        const HAIR_TENS = HT.tension, HAIR_DAMP = HT.damping;
        let built = 0;
        this._hairAnchors = [];
        for (const [, list] of chains) {
          list.sort((x2, y2) => x2.i - y2.i);
          // A KINEMATIC anchor per lock (mass 0, re-driven from the skeleton each step), not the dynamic head:
          // springing to the head makes a feedback loop through every lock.
          const rootW = list[0].node.getWorldPosition(new THREE.Vector3());
          const aShape = keep(new AMMO.btBoxShape(new AMMO.btVector3(R, R, R)));
          _bt1.setIdentity();
          _bv1.setValue(rootW.x, rootW.y, rootW.z); _bt1.setOrigin(_bv1);
          const aMs = keep(new AMMO.btDefaultMotionState(_bt1));
          _bv1.setValue(0, 0, 0);
          const aCi = keep(new AMMO.btRigidBodyConstructionInfo(0, aMs, aShape, _bv1));
          const anchor = keep(new AMMO.btRigidBody(aCi));
          anchor.setCollisionFlags(anchor.getCollisionFlags() | CF_KINEMATIC);
          anchor.setActivationState(DISABLE_DEACTIVATION);
          this.world.addRigidBody(anchor, G_FINGER, 0);   // mask 0: touches nothing
          this._bodies.push(anchor);
          // where the anchor sits in the HEAD's frame, so it can be carried
          this._hairAnchors.push({
            anchor, head: headSeg.body, local: localOf(headSeg.body, rootW),
          });
          let parentBody = anchor;
          let prevLen = 0.05;
          for (let j2 = 0; j2 < list.length; j2++) {
            const nd = list[j2].node;
            const aW = nd.getWorldPosition(new THREE.Vector3());
            const childNd = list[j2 + 1]?.node;
            const bW = childNd ? childNd.getWorldPosition(new THREE.Vector3())
              : aW.clone().add(nd.getWorldDirection(new THREE.Vector3()).multiplyScalar(-prevLen));
            const len = Math.max(aW.distanceTo(bW), 0.015);
            prevLen = len;
            const mid = aW.clone().add(bW).multiplyScalar(0.5);
            // the lock's mesh extents (boneMeshExtents) when measurable, else bone spacing (sparse thin tips)
            const hx = extBox(nd, hairExt.get(nd.name), 0.004);
            const body = hx
              ? mkBody(HAIR_MASS, hx.center, new THREE.Quaternion(), hx.boxes, true)
              : mkBody(HAIR_MASS, mid, new THREE.Quaternion(),
                [boxFor(mid, aW, bW, R, R, len)], true);
            // not the finger's 0.9: Bullet's w *= (1-d)^dt bleeds a swing so fast the hair snaps instead of flowing
            body.setDamping(0.25, HAIR_DAMP);
            // Hair stops rather than bounces: the limb defaults (friction 0.85, restitution 0.03) stick-slip chatter on the scalp.
            body.setFriction(0.3);
            body.setRestitution(0.0);
            body.setRollingFriction(0.0);
            body.setCcdMotionThreshold(len * 0.5);
            body.setCcdSweptSphereRadius(R * 0.9);
            // The ROOT segment skips the head: it is born inside it, and a contact born penetrating resolves as
            // kinetic energy (the poof).
            this.world.addRigidBody(body, G_FINGER,
              j2 === 0 ? G_STATIC : (G_STATIC | headGroup));
            _bv1.setValue(0, -9.81 * HAIR_GRAV, 0);
            body.setGravity(_bv1);       // AFTER addRigidBody — the source's lesson
            // No additive slack: BUILD_WIDEN is a limb constant, and on hair it nearly doubles the root limit.
            const lim = HAIR_LIM * Math.pow((j2 + 1) / list.length, HAIR_ROOT);
            const mkF = (bdy) => {
              const tr = keep(new AMMO.btTransform());
              tr.setIdentity();
              const o = localOf(bdy, aW);
              _bv2.setValue(o.x, o.y, o.z); tr.setOrigin(_bv2);
              return tr;
            };
            const con = keep(new AMMO.btGeneric6DofSpringConstraint(
              parentBody, body, mkF(parentBody), mkF(body), true));
            _bv1.setValue(0, 0, 0);
            con.setLinearLowerLimit(_bv1); con.setLinearUpperLimit(_bv1);
            _bv1.setValue(-lim, -lim, -lim); con.setAngularLowerLimit(_bv1);
            _bv1.setValue(lim, lim, lim); con.setAngularUpperLimit(_bv1);
            for (let ax = 3; ax < 6; ax++) {
              con.enableSpring(ax, true);
              // Bullet's spring "damping" is a target-velocity GAIN (velFactor = fps * damping / iterations), not dissipation.
              con.setStiffness(ax, HAIR_TENS);
              con.setDamping(ax, HAIR_DAMP);
              // no stop-ERP override: hair limits stay at Bullet's default 0.2, as in the source, or a loose limit gets hit hard
            }
            con.setEquilibriumPoint();
            this.world.addConstraint(con, true);
            this._constraints.push(con);
            this._hairSegs.push({
              body, node: nd, parent: nd.parent,
              restWorldQ: nd.getWorldQuaternion(new THREE.Quaternion()),
              con, j: j2, n: list.length,   // retuneHair() re-derives the ramp
            });
            parentBody = body;
            built++;
          }
        }
        if (built) {
          // Claim the hair from three-vrm while this doll lives, or its springbones overwrite every bone we drive (avatar.js vrm.update).
          avatar.__simHair = true;
          console.log(`[ammodoll] bullet hair: ${chains.size} locks, ${built} segments`);
        }
      }
    }

    // ---- BULLET WINGS: hair's shape (kinematic anchor, local dressing) but not its code; every parameter differs.
    // Alive, avatar.js drives the wings (WING_IDLE); limp, these chains take the same bones; never two authors.
    this._wingSegs = [];
    this._wingAnchors = [];
    {
      // The chest, not the clavicle: this rig cut has no clavicle body (the arms hang off 'chest' too).
      const chestSeg = this.segs.get('chest|neck') ?? this.segs.get('spine|chest');
      const wingNodes = [];
      avatar.root?.traverse?.((o) => {
        if (/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(o.name ?? '')) wingNodes.push(o);
      });
      const wchains = new Map();
      for (const nd of wingNodes) {
        // The _<n> index IS the chain position (counting underscores collapses _1 and _2).
        const m = nd.name.match(/^([LR]_Wing_(?:Upper|Lower))(?:_(\d+))?$/);
        if (!wchains.has(m[1])) wchains.set(m[1], []);
        wchains.get(m[1]).push({ i: m[2] ? Number(m[2]) : 0, node: nd });
      }
      if (chestSeg && wchains.size) {
        // The AUTHORED pose from avatar.js's _findWings; the live pose would ratchet on every rebuild.
        if (!avatar.__wingRest) {
          const rest = new Map();
          for (const [, l0] of wchains) for (const it of l0) rest.set(it.node, it.node.quaternion.clone());
          avatar.__wingRest = rest;
        }
        for (const [nd0, q0] of avatar.__wingRest) {
          nd0.quaternion.copy(q0); nd0.updateMatrix();   // harmless when auto is on
        }
        avatar.root.updateMatrixWorld(true);
        const WT = WING_TUNING;
        const WING_LIM = WT.limit * DEG;
        const wingExt = boneMeshExtents(avatar, 'wing', (n) => /^[LR]_Wing_/.test(n));
        let built = 0;
        for (const [, list] of wchains) {
          list.sort((x2, y2) => x2.i - y2.i);
          const rootW = list[0].node.getWorldPosition(new THREE.Vector3());
          const aShape = keep(new AMMO.btBoxShape(new AMMO.btVector3(0.01, 0.01, 0.01)));
          _bt1.setIdentity();
          _bv1.setValue(rootW.x, rootW.y, rootW.z); _bt1.setOrigin(_bv1);
          const aMs = keep(new AMMO.btDefaultMotionState(_bt1));
          _bv1.setValue(0, 0, 0);
          const aCi = keep(new AMMO.btRigidBodyConstructionInfo(0, aMs, aShape, _bv1));
          const anchor = keep(new AMMO.btRigidBody(aCi));
          anchor.setCollisionFlags(anchor.getCollisionFlags() | CF_KINEMATIC);
          anchor.setActivationState(DISABLE_DEACTIVATION);
          this.world.addRigidBody(anchor, G_FINGER, 0);   // mask 0: touches nothing
          this._bodies.push(anchor);
          this._wingAnchors.push({
            anchor, head: chestSeg.body, local: localOf(chestSeg.body, rootW),
          });
          let parentBody = anchor;
          let prevLen = 0.2;
          for (let j2 = 0; j2 < list.length; j2++) {
            const nd = list[j2].node;
            const aW = nd.getWorldPosition(new THREE.Vector3());
            const childNd = list[j2 + 1]?.node;
            const bW = childNd ? childNd.getWorldPosition(new THREE.Vector3())
              : aW.clone().add(nd.getWorldDirection(new THREE.Vector3()).multiplyScalar(-prevLen));
            const len = Math.max(aW.distanceTo(bW), 0.03);
            prevLen = len;
            const mid = aW.clone().add(bW).multiplyScalar(0.5);
            // The box is the mesh (boneMeshExtents) when there is one; else a bone-length PLATE (headless), whose
            // width keeps a wing out of the ground plane.
            const ext = wingExt.get(nd.name);
            let center = mid, boxes;
            if (ext) {
              nd.updateWorldMatrix(true, false);
              center = ext.c.clone().applyMatrix4(nd.matrixWorld);
              boxes = [{
                // a membrane can be millimetres thick, and a zero-depth box has no inertia about two axes
                he: new THREE.Vector3(
                  Math.max(ext.he.x, 0.01), Math.max(ext.he.y, 0.01),
                  Math.max(ext.he.z, 0.01)),
                t: new THREE.Vector3(0, 0, 0),
                q: nd.getWorldQuaternion(new THREE.Quaternion()),
              }];
            } else {
              const halfSpan = len * 0.45, halfThick = Math.max(0.01, len * 0.05);
              boxes = [boxFor(mid, aW, bW, halfSpan, halfThick, 0.03)];
            }
            const body = mkBody(WT.mass, center, new THREE.Quaternion(), boxes, true);
            body.setDamping(0.35, WT.damping);
            body.setFriction(0.6);        // wings drag on the floor, not slide
            body.setRestitution(0.0);
            body.setRollingFriction(0.0);
            // Wings meet statics only: the root is born inside the torso, and a folded wing wraps the arm and leg.
            this.world.addRigidBody(body, G_FINGER, G_STATIC);
            _bv1.setValue(0, -9.81 * WT.gravity, 0);
            body.setGravity(_bv1);       // AFTER addRigidBody — the source's lesson
            const lim = WING_LIM * Math.pow((j2 + 1) / list.length, WT.rootExp);
            const mkF = (bdy) => {
              const tr = keep(new AMMO.btTransform());
              tr.setIdentity();
              const o = localOf(bdy, aW);
              _bv2.setValue(o.x, o.y, o.z); tr.setOrigin(_bv2);
              return tr;
            };
            const con = keep(new AMMO.btGeneric6DofSpringConstraint(
              parentBody, body, mkF(parentBody), mkF(body), true));
            _bv1.setValue(0, 0, 0);
            con.setLinearLowerLimit(_bv1); con.setLinearUpperLimit(_bv1);
            _bv1.setValue(-lim, -lim, -lim); con.setAngularLowerLimit(_bv1);
            _bv1.setValue(lim, lim, lim); con.setAngularUpperLimit(_bv1);
            for (let ax = 3; ax < 6; ax++) {
              con.enableSpring(ax, true);
              con.setStiffness(ax, WT.tension);
              con.setDamping(ax, WT.damping);
            }
            // equilibrium is the born pose, which the reset above makes the authored one
            con.setEquilibriumPoint();
            this.world.addConstraint(con, true);
            this._constraints.push(con);
            this._wingSegs.push({
              body, node: nd, parent: nd.parent,
              restWorldQ: nd.getWorldQuaternion(new THREE.Quaternion()),
              con, j: j2, n: list.length,
            });
            parentBody = body;
            built++;
          }
        }
        if (built) {
          // Wings are springbone chains too, so claim them, or three-vrm (which runs second) writes the same bones.
          avatar.__simHair = true;
          console.log(`[ammodoll] bullet wings: ${wchains.size} chains, ${built} segments`);
        }
      }
    }

    // Hair and wings are one kind to the step loop, joined once. `?? []`: _hairAnchors is unset on a hairless rig.
    this._dressAnchors = [...(this._hairAnchors ?? []), ...this._wingAnchors];
    this._dressSegs = [...(this._hairSegs ?? []), ...this._wingSegs];

    // ---- drive table: refDir and refQuat both from the live skeleton, or a driven bone renders at twice its offset ---
    this.drive = [];
    for (const seg of this.segs.values()) {
      const bn = node(seg.a);
      const cnPos = live[seg.b];
      if (!bn || !live[seg.a] || !cnPos) continue;
      const refDir = cnPos.clone().sub(live[seg.a]);
      if (refDir.lengthSq() < 1e-8) continue;
      this.drive.push({
        bone: seg.a, child: seg.b, node: bn, parent: bn.parent,
        restDir: refDir.normalize(),
        restQuat: bn.getWorldQuaternion(new THREE.Quaternion()),
        // ...and the BODY plus its born orientation, which make roll recoverable (see step). q0 is identity on a
        // fresh build; a seeded body is born mid-tumble, so don't compose it onto itself.
        body: seg.body,
        q0inv: quatOf2(seg.body, new THREE.Quaternion()).invert(),
      });
    }
    this.drivenBones = new Set(this.drive.map((d) => d.bone));
    this.totalMass = 0;
    for (const part of Object.keys(MASS_FRAC)) {
      const n = part === 'torso' || part === 'head' ? 1 : 2;
      this.totalMass += MASS_FRAC[part] * massScale * n;
    }

    // ---- inherited velocities: recover the SPIN, not just the drift --------
    {
      const samples = new Map();
      for (const s of this.segs.values()) {
        for (const name of [s.a, s.b]) {
          if (!seedV[name] || !live[name]) continue;
          if (!samples.has(s.body)) samples.set(s.body, []);
          const list = samples.get(s.body);
          if (list.some((x2) => x2.name === name)) continue;
          list.push({ name, p: live[name].clone(), v: seedV[name].clone() });
        }
      }
      for (const [body, list] of samples) {
        if (!list.length) continue;
        const t = body.getCenterOfMassTransform().getOrigin();
        const comV = new THREE.Vector3(t.x(), t.y(), t.z());
        let w = new THREE.Vector3();
        if (list.length >= 2) {
          let best = null, bestD = 0;
          for (let i = 0; i < list.length; i++) {
            for (let j2 = i + 1; j2 < list.length; j2++) {
              const d = list[i].p.distanceToSquared(list[j2].p);
              if (d > bestD) { bestD = d; best = [list[i], list[j2]]; }
            }
          }
          if (best && bestD > 1e-8) {
            const d = best[1].p.clone().sub(best[0].p);
            const dv = best[1].v.clone().sub(best[0].v);
            w = new THREE.Vector3().crossVectors(d, dv).divideScalar(bestD);
            const m = w.length();
            if (m > ANG_CEIL) w.multiplyScalar(ANG_CEIL / m);      // hostile input
          }
        }
        const s0 = list[0];
        const vc = s0.v.clone().sub(
          new THREE.Vector3().crossVectors(w, s0.p.clone().sub(comV)));
        if (Number.isFinite(vc.x) && Number.isFinite(vc.y) && Number.isFinite(vc.z)) {
          _bv1.setValue(vc.x, vc.y, vc.z); body.setLinearVelocity(_bv1);
        }
        if (Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)) {
          _bv1.setValue(w.x, w.y, w.z); body.setAngularVelocity(_bv1);
        }
      }
    }

    this.rootStartY = avatar.root.position.y;
    this._rootBaseY = avatar.root.position.y;

    if (lean) this._topple(lean);
    this._syncP();
    // Hips-to-root offset is a rig constant (restP.hips.y - root.y). Trust the measurement only within 5 cm of it:
    // seeded and dragged bodies don't start at rest.
    const restHipsY = this.restP?.hips?.y;
    const measured = (this.p.hips?.y ?? live.hips?.y ?? 0) - avatar.root.position.y;
    const constant = restHipsY != null ? restHipsY - avatar.root.position.y : measured;
    this.hipsOffset = Math.abs(measured - constant) > 0.05 ? constant : measured;
    this._measureHipsLocal(this.restP?.hips ?? null);   // sideways too (bodyengine.js)
  }

  // ---------------------------------------------------------------- instruments
  // (unused by the sim; the suite asserts anatomy on them, which finite/settled metrics cannot see)

  /** Collision volumes as the solver holds them, world space, `[{ p, q, he }]` per box; the debug overlay's
   *  counterpart to the verlet's caps/radius. */
  volumes() {
    const out = [];
    if (!AMMO) return out;
    for (const { body, boxes } of this._vol ?? []) {
      // one value-returning ammo call per statement — see quatOf2
      const t = body.getCenterOfMassTransform();
      const o = t.getOrigin();
      const bp = new THREE.Vector3(o.x(), o.y(), o.z());
      const r = t.getRotation();
      const bq = new THREE.Quaternion(r.x(), r.y(), r.z(), r.w());
      for (const bx of boxes) {
        out.push({
          p: bx.t.clone().applyQuaternion(bq).add(bp),
          q: bq.clone().multiply(bx.q),
          he: bx.he.clone(),
        });
      }
    }
    return out;
  }

  /** Re-apply JOINT_SPECS to the LIVE constraints, no rebuild. Frames keep their BUILT midpoint (subtracted here),
   *  so a much more asymmetric range sits nearer Bullet's wrap point: write tuned values into the table. */
  retune() {
    if (!AMMO) return 0;
    let n = 0;
    for (const J of this.jointMeta ?? []) {
      const S = JOINT_SPECS[J.spec];
      if (!S || !J.con) continue;
      let xlo, xhi;
      if (S.flex != null) {
        xlo = (J.positiveFlexes ? -S.ext : -S.flex) * DEG;
        xhi = (J.positiveFlexes ? S.flex : S.ext) * DEG;
      } else {
        xlo = S.x[0] * DEG; xhi = S.x[1] * DEG;
      }
      const lo = [xlo, -S.twist * DEG, S.z[0] * DEG];
      const hi = [xhi, S.twist * DEG, S.z[1] * DEG];
      _bv1.setValue(lo[0] - J.mid[0], lo[1] - J.mid[1], lo[2] - J.mid[2]);
      J.con.setAngularLowerLimit(_bv1);
      _bv1.setValue(hi[0] - J.mid[0], hi[1] - J.mid[1], hi[2] - J.mid[2]);
      J.con.setAngularUpperLimit(_bv1);
      J.lo = lo; J.hi = hi;
      n++;
    }
    // a sleeping body will not notice its joints changed under it
    for (const b of this._bodies) b.activate();
    return n;
  }

  /** Push WING_TUNING into the running wings, no rebuild, as retuneHair: a rebuild discards the fall being judged. */
  retuneWings() {
    if (!AMMO || !this._wingSegs?.length) return 0;
    const WT = WING_TUNING;
    for (const ws of this._wingSegs) {
      ws.body.setDamping(0.35, WT.damping);
      _bv1.setValue(0, -9.81 * WT.gravity, 0);
      ws.body.setGravity(_bv1);
      _bv1.setValue(0, 0, 0);
      ws.body.getCollisionShape().calculateLocalInertia(WT.mass, _bv1);
      ws.body.setMassProps(WT.mass, _bv1);
      ws.body.updateInertiaTensor();
      ws.body.activate();
      if (!ws.con) continue;
      const lim = WT.limit * DEG * Math.pow((ws.j + 1) / ws.n, WT.rootExp);
      _bv1.setValue(-lim, -lim, -lim); ws.con.setAngularLowerLimit(_bv1);
      _bv1.setValue(lim, lim, lim); ws.con.setAngularUpperLimit(_bv1);
      for (let ax = 3; ax < 6; ax++) {
        ws.con.setStiffness(ax, WT.tension);
        ws.con.setDamping(ax, WT.damping);
      }
    }
    return this._wingSegs.length;
  }

  /** Push HAIR_TUNING into the running hair, no rebuild. Mass changes recompute inertia from the shape. */
  retuneHair() {
    if (!AMMO || !this._hairSegs?.length) return 0;
    const HT = HAIR_TUNING;
    for (const hs of this._hairSegs) {
      hs.body.setDamping(0.25, HT.damping);
      _bv1.setValue(0, -9.81 * HT.gravity, 0);
      hs.body.setGravity(_bv1);
      _bv1.setValue(0, 0, 0);
      hs.body.getCollisionShape().calculateLocalInertia(HT.mass, _bv1);
      hs.body.setMassProps(HT.mass, _bv1);
      hs.body.updateInertiaTensor();
      hs.body.activate();
      if (!hs.con) continue;
      const lim = HT.limit * DEG * Math.pow((hs.j + 1) / hs.n, HT.rootExp);
      _bv1.setValue(-lim, -lim, -lim); hs.con.setAngularLowerLimit(_bv1);
      _bv1.setValue(lim, lim, lim); hs.con.setAngularUpperLimit(_bv1);
      for (let ax = 3; ax < 6; ax++) {
        hs.con.setStiffness(ax, HT.tension);
        hs.con.setDamping(ax, HT.damping);
      }
    }
    return this._hairSegs.length;
  }

  /** Live per-axis joint angles against their bounds, in the joint basis. */
  jointAngles() {
    const out = [];
    for (const J of this.jointMeta) {
      // one getRotation per statement — see quatOf2
      quatOf2(J.parentBody, _q);
      quatOf2(J.childBody, _qp);
      const rel = _q.invert().multiply(_qp);
      // measured in the constraint's centred frames, reported ANATOMICAL by adding the midpoint back (lo/hi: table values)
      const relF = J.basisA.clone().invert().multiply(rel).multiply(J.basisB);
      const eul = new THREE.Euler().setFromQuaternion(relF, 'XYZ');
      const ang = [eul.x + J.mid[0], eul.y + J.mid[1], eul.z + J.mid[2]];
      out.push({
        name: J.name, spec: J.spec, angles: ang, lo: J.lo, hi: J.hi,
        over: Math.max(...ang.map((a2, i) => Math.max(J.lo[i] - a2, a2 - J.hi[i], 0))),
      });
    }
    return out;
  }

  /** The flexion axes as BUILT (world, at rest) with signed ranges: the suite checks anatomy against them. */
  flexAxes() {
    return this.jointMeta.map((J) => ({
      name: J.name, spec: J.spec,
      axisX: J.axisX.clone(), axisY: J.axisY.clone(), axisZ: J.axisZ.clone(),
      lo: J.lo, hi: J.hi, born: J.born,
    }));
  }

  massSplit() {
    let torso = 0, total = 0;
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (seen.has(s.body)) continue;
      seen.add(s.body);
      const m = this._massOf.get(s.body) ?? 0;
      total += m;
      if (s.torso) torso += m;
    }
    return { torso, total, frac: total > 0 ? torso / total : 0 };
  }

  // ---------------------------------------------------------------- dynamics

  _topple(lean) {
    let lo = Infinity, hi = -Infinity;
    for (const body of this._cores) {
      const y = body.getCenterOfMassTransform().getOrigin().y();
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const span = (hi - lo) || 1;
    _v.copy(lean);
    const cap = 8;
    if (_v.lengthSq() > cap * cap) _v.setLength(cap);
    for (const body of this._cores) {
      const t = body.getCenterOfMassTransform().getOrigin();
      const w = (t.y() - lo) / span;
      const cur = body.getLinearVelocity();
      _bv1.setValue(cur.x() + _v.x * w, cur.y(), cur.z() + _v.z * w);
      body.setLinearVelocity(_bv1);
      body.activate();
    }
  }

  // impulse lives on BodyEngineBase: the cap, the topple and the clock restarts are shared.

  /** `firm` = a NAIL, else a HAND: a drag calls setPin every mousemove, and a near-rigid nail hauls limbs through
   *  their joint stops. */
  setPin(joint, target, firm = false) {
    if (this.done) return;
    if (!joint) {
      for (const j of [...this._pinCons.keys()]) this.setPin(j, null);
      return;
    }
    const seg = [...this.segs.values()].find((s) => s.a === joint || s.b === joint);
    if (!seg) return;
    if (!target) {
      const pin = this._pinCons.get(joint);
      if (pin) {
        this.world.removeConstraint(pin.con);
        AMMO.destroy(pin.con);
        const i = this._refs.indexOf(pin.con);
        if (i >= 0) this._refs.splice(i, 1);
        this._pinCons.delete(joint);
        this.pins.delete(joint);
      }
      // the lift ceiling is a LEASE, not a ratchet
      if (this._pinCons.size === 0) this.rootStartY = this._rootBaseY;
      return;
    }
    let pin = this._pinCons.get(joint);
    if (!pin) {
      // p2p with a hard impulse clamp: a distant target PULLS at bounded force, never teleports (the source's grab feel)
      const anchor = (seg.a === joint ? seg.localA : seg.localB);
      // seg.local* are rest-local = body-local (rest-aligned bodies)
      _bv1.setValue(anchor.x, anchor.y, anchor.z);
      const con = new AMMO.btPoint2PointConstraint(seg.body, _bv1);
      con.get_m_setting().set_m_impulseClamp(this.totalMass * (firm ? PIN_CLAMP_X : GRAB_CLAMP_X));
      con.get_m_setting().set_m_tau(firm ? PIN_TAU : GRAB_TAU);
      this.world.addConstraint(con, false);
      this._refs.push(con);
      pin = { con, body: seg.body };
      this._pinCons.set(joint, pin);
      this.pins.set(joint, new THREE.Vector3());
    }
    this.pins.get(joint).copy(target);
    _bv1.setValue(target.x, target.y, target.z);
    pin.con.setPivotB(_bv1);
    for (const body of this._bodies) body.activate();
  }

  /** Drag-release handover in rigmeasure.js's snapshotPacker format (the far side may be the verlet): joint names,
   *  positions, endpoint velocities (v + ω × r). */
  snapshot() {
    // {j:[],p:[],v:[]} would be TRUTHY on `seedVel?.j` — say nothing instead
    if (this._freed) return null;
    this._syncP();
    const pack = snapshotPacker();
    const seen = new Set();
    for (const s of this.segs.values()) {
      if (s.finger) continue;          // the wire carries the core skeleton
      const t = s.body.getCenterOfMassTransform().getOrigin();
      const lv = s.body.getLinearVelocity(), av = s.body.getAngularVelocity();
      for (const name of [s.a, s.b]) {
        if (seen.has(name) || !this.p[name]) continue;
        seen.add(name);
        const q2 = this.p[name];
        _a.set(q2.x - t.x(), q2.y - t.y(), q2.z - t.z());
        _b.set(av.x(), av.y(), av.z()).cross(_a).add(_v.set(lv.x(), lv.y(), lv.z()));
        pack.add(name, q2, _b);
      }
    }
    return pack.pack();
  }

  /** Apply the water's force to every core part in it (see step). True when any part is wet. */
  _water() {
    // a body's own water when it was given one (a headless agent: one process can host agents in several
    // worlds, so the module's single field may be another world's); else the page's
    const wf = this.waterSource ? this.waterSource() : waterField();
    if (!wf) return false;
    const t = wf.time();
    let wet = false;
    for (const body of this._cores) {
      const o = body.getCenterOfMassTransform().getOrigin();
      const x = o.x(), y = o.y(), z = o.z(), r = this._waterR.get(body) ?? 0.1;
      const w = wf.sample(x, z);
      const surface = wf.level + surfaceOffset(w, x, z, t);
      if (y - r >= surface) continue;
      const lv = body.getLinearVelocity();
      _wv[0] = lv.x(); _wv[1] = lv.y(); _wv[2] = lv.z();
      const m = this._massOf.get(body) ?? 1;
      const cur = waterCurrent(w);
      _wc[0] = cur[0]; _wc[1] = cur[1];
      _wc[2] = swellRise((tt) => surfaceOffset(w, x, z, tt), t, surface - y);   // the swell carries what floats in it
      const sub = partWaterForce(m, y, r, _wv, surface, _wc, _wf);
      if (sub <= 0) continue;
      wet = true;
      body.activate();   // a sleeping island ignores forces — and water never lets a body lie still
      _bv1.setValue(_wf[0], _wf[1], _wf[2]); body.applyCentralForce(_bv1);
      const av = body.getAngularVelocity(), k = -WATER_ANG_DRAG * sub * 0.4 * m * r * r;
      _bv1.setValue(av.x() * k, av.y() * k, av.z() * k); body.applyTorque(_bv1);
    }
    return wet;
  }

  _syncP() {
    for (const s of this.segs.values()) {
      const t = s.body.getCenterOfMassTransform();
      const o = t.getOrigin(), r = t.getRotation();
      _qp.set(r.x(), r.y(), r.z(), r.w());
      _a.copy(s.localA).applyQuaternion(_qp);
      (this.p[s.a] ??= new THREE.Vector3()).set(o.x() + _a.x, o.y() + _a.y, o.z() + _a.z);
      _a.copy(s.localB).applyQuaternion(_qp);
      (this.p[s.b] ??= new THREE.Vector3()).set(o.x() + _a.x, o.y() + _a.y, o.z() + _a.z);
    }
  }

  step(dt) {
    if (this.done) return null;
    // 0.05, not the source's 0.25: 8 substeps at 1/120 cover 0.067s, and the rest would be one huge step for the hair.
    dt = Math.min(0.05, Math.max(0, dt || 0));
    // Kinematic roots move BEFORE the step: Bullet derives their velocity as (new - old)/dt, and a stale offset whips the chains.
    for (const ha of this._dressAnchors ?? []) {
      const t0 = ha.head.getCenterOfMassTransform();
      const o0 = t0.getOrigin();
      _v.set(o0.x(), o0.y(), o0.z());
      const r0 = t0.getRotation();
      _q.set(r0.x(), r0.y(), r0.z(), r0.w());
      _b.copy(ha.local).applyQuaternion(_q).add(_v);
      _bt1.setIdentity();
      _bv1.setValue(_b.x, _b.y, _b.z); _bt1.setOrigin(_bv1);
      _bq1.setValue(_q.x, _q.y, _q.z, _q.w); _bt1.setRotation(_bq1);
      ha.anchor.getMotionState().setWorldTransform(_bt1);
      ha.anchor.setWorldTransform(_bt1);
    }
    // WATER (shared/buoyancy.js): each core part is buoyed by its submerged share and dragged toward the water's
    // motion. Bullet holds an applied force through every substep; frames are capped at 0.05 s above.
    this.floating = dt > 0 && this._water();
    if (dt > 0) this.world.stepSimulation(dt, MAX_SUBSTEPS, FIXED_DT);

    // angular ceiling: nothing anatomical spins at 20 rad/s, and residual solver energy hides there first
    for (const body of this._cores) {
      const w = body.getAngularVelocity();
      const m = Math.hypot(w.x(), w.y(), w.z());
      if (m > ANG_CEIL) {
        const k = ANG_CEIL / m;
        _bv1.setValue(w.x() * k, w.y() * k, w.z() * k);
        body.setAngularVelocity(_bv1);
      }
    }

    // settle is LINEAR AND ANGULAR over CORE bodies: 20 g finger springs twitch below anything the wire sees
    let maxSpeed = 0, maxSpin = 0;
    for (const body of this._cores) {
      const v = body.getLinearVelocity(), w = body.getAngularVelocity();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x(), v.y(), v.z()));
      maxSpin = Math.max(maxSpin, Math.hypot(w.x(), w.y(), w.z()));
    }
    this.maxV = maxSpeed;
    this.maxW = maxSpin;

    // quiet = linear AND angular; a FLOATING body never settles, or it would freeze over a trough
    this._settleTick(dt, !this.floating && this.maxV < SETTLE_V && this.maxW < SETTLE_W);
    if (this.floating) this.elapsed = 0;

    this._syncP();

    this._followRoot();   // the body lies where it fell — see bodyengine.js

    // bones, parents first (construction order). Never write POSITION: solver error must stretch a joint, not the mesh.
    const pose = {};
    for (const d of this.drive) {
      const bp = this.p[d.bone], cp = this.p[d.child];
      if (!bp || !cp) continue;
      // The BODY's rotation, not shortestArc of the bone's direction (a pure swing that drops roll). Bodies are
      // rest-aligned, so the body's rotation since build IS the bone's.
      quatOf2(d.body, _q).multiply(d.q0inv).multiply(d.restQuat);
      d.parent.getWorldQuaternion(_qp).invert();
      _qp.multiply(_q);
      d.node.quaternion.copy(_qp);
      pose[d.bone] = [+_qp.x.toFixed(4), +_qp.y.toFixed(4), +_qp.z.toFixed(4), +_qp.w.toFixed(4)];
    }
    this.pose = pose;
    this.avatar.setPose(pose);

    // hair rides raw nodes, local only: the body's rest→live rotation on the born orientation, then into parent-local
    for (const hs of this._dressSegs ?? []) {
      quatOf2(hs.body, _q).multiply(hs.restWorldQ);
      hs.parent.getWorldQuaternion(_qp).invert();
      hs.node.quaternion.copy(_qp.multiply(_q));
      // updateMatrix() IS THE WRITE: three-vrm sets matrixAutoUpdate = false on spring-bone joints, so a bare
      // quaternion write never reaches the renderer.
      hs.node.updateMatrix();
    }

    if (this.settledFor >= SETTLE_TIME || this.elapsed >= DEADLINE) {
      this.done = true;
      this.finalPose = pose;
      this.dispose();
      return null;
    }
    return pose;
  }

  /** Free every WASM object this instance created (Bullet objects don't GC). Safe twice; called at capture. */
  dispose() {
    if (this._freed) return;
    this._freed = true;
    // Hair is left where the sim ended, on purpose; rebuilds still start from __hairRest, so a crumple never becomes rest.
    this.done = true;
    // Hand the hair back ADOPTING its pose (never springBoneManager.reset(): that snaps to combed), so a doll disposed
    // mid-tumble doesn't freeze it; the comb returns on standing (avatar.js setLimp → _combHair).
    this.avatar?._releaseHair?.({ adopt: true });
    try {
      for (const c of this._constraints) this.world.removeConstraint(c);
      for (const [, pin] of this._pinCons) this.world.removeConstraint(pin.con);
      for (const b of this._bodies) this.world.removeRigidBody(b);
      for (const b of this._statics) this.world.removeRigidBody(b);
    } catch { /* half-built world */ }
    for (let i = this._refs.length - 1; i >= 0; i--) {
      try { AMMO.destroy(this._refs[i]); } catch { /* already gone */ }
    }
    this._refs.length = 0;
    this._constraints.length = 0;
    this._bodies.length = 0;
    this._cores.length = 0;
    this._statics.length = 0;
    this.segs.clear();
    this._pinCons.clear();
    this.pins.clear();
    this.world = null;
  }
}
