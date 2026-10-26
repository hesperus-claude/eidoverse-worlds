// bodyengine — the shared spine of every body-physics engine.
//
// THE ENGINE CONTRACT:
//
//   constructor(avatar, lean, rest, seedVel)
//   step(dt)            → sparse local-quat pose (drives the avatar directly),
//                         or null once captured
//   impulse(v)          — a shove landing mid-tumble (wire path: puppet {lean}
//                         and the force verb)
//   setPin(joint, target, firm) / setPin(joint, null) / setPin(null)
//   snapshot()          → {j,p,v} handover (rigmeasure.js owns the format)
//   .pins .pinned .done .finalPose .p .maxV
//   dispose()           — engines with off-heap state free it here
//
// Only what engines MUST agree on lives here (clocks, bookkeeping), never solving.
// Each engine supplies _topple(lean) and its own settle THRESHOLDS; the clock law is shared.

import { THREE } from './core.js';

const _iv = new THREE.Vector3();

/** Capped at the trust boundary (main.js) AND here: the sim protects its own stability. m/s. */
const IMPULSE_CAP = 8;

export class BodyEngineBase {
  constructor(avatar) {
    this.avatar = avatar;
    this.done = false;
    this.pose = null;
    this.finalPose = null;
    this.settledFor = 0;
    this.elapsed = 0;
    this.maxV = Infinity;
    this.p = {};                 // joint -> world pos (debug + parity surface)
  }

  /** `pins` may be created lazily (verlet) or at build (bullet): both read the same here. */
  get pinned() { return (this.pins?.size ?? 0) > 0; }

  /** Restarts the settle deadline too: a late shove must not capture a body mid-air. @param v THREE.Vector3, m/s */
  impulse(v) {
    if (this.done) return;
    _iv.copy(v);
    if (_iv.lengthSq() > IMPULSE_CAP * IMPULSE_CAP) _iv.setLength(IMPULSE_CAP);
    this._topple(_iv);
    this.settledFor = 0;
    this.elapsed = 0;
  }

  /** The settle CLOCK law: a held body neither settles nor deadlines; quiet time is in SECONDS; `cancel` clears it. */
  _settleTick(dt, quiet, cancel = !quiet) {
    this.elapsed += dt;
    if (this.pinned) { this.settledFor = 0; this.elapsed = 0; return; }
    if (quiet) this.settledFor += dt;
    else if (cancel) this.settledFor = 0;
  }

  /** In the root's frame, from rest; non-zero on rigs authored forward of the origin (§24t-8). */
  _measureHipsLocal(restHipsWorld) {
    const root = this.avatar.root;
    if (!restHipsWorld || !root) { this.hipsLocalX = 0; this.hipsLocalZ = 0; return; }
    const dx = restHipsWorld.x - root.position.x, dz = restHipsWorld.z - root.position.z;
    const yaw = root.rotation?.y ?? 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // world → root-local (inverse yaw)
    this.hipsLocalX = dx * c - dz * s;
    this.hipsLocalZ = dx * s + dz * c;
  }

  /** Falling, the root only descends (guards overshoot pops); pinned or floating, it follows the hips up. */
  _followRoot() {
    const hips = this.p.hips;
    if (!hips) return;
    const root = this.avatar.root.position;
    const yaw = this.avatar.root.rotation?.y ?? 0;
    const lx = this.hipsLocalX ?? 0, lz = this.hipsLocalZ ?? 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // root-local → world (yaw), then the root goes where the hips minus that is
    root.x = hips.x - (lx * c + lz * s);
    root.z = hips.z - (-lx * s + lz * c);
    const y = hips.y - this.hipsOffset;
    // a carried body may be lifted, and a FLOATING one rides up a wave: the root follows it up too
    if ((this.pinned || this.floating) && y > this.rootStartY) this.rootStartY = y;
    root.y = Math.min(this.rootStartY, y);
  }
}
