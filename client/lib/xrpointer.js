// xrpointer — the VR laser's POLICY as plain functions a test can run without a headset (tools/xrpointer-test.mjs);
// xr.js owns the per-hand loop and the scene.
//   1. WHEN THE BEAM IS DRAWN: always / never / contextual (on a panel or nameplate, or grip/trigger held). Never hides
//      the beam only; pointing, clicking, scroll and hover still work.
//   2. HOW THE RAY FOLLOWS THE HAND: a frame-rate-independent low-pass (alpha = 1 − exp(−dt/τ)) in rig space, so
//      tremor is filtered but walking and turning never lag the beam.
//   3. HOW IT HOLDS A TARGET: sticky with hysteresis; while held the ray is bent to the last point on the target.
import * as THREE from 'three';

// ---- 1. the setting -------------------------------------------------------------------------------------------
export const POINTER_VIS_MODES = ['always', 'never', 'contextual'];
export const POINTER_VIS_DEFAULT = 'contextual';
export const pointerVisibilityMode = (v) => (POINTER_VIS_MODES.includes(v) ? v : POINTER_VIS_DEFAULT);   // an unknown stored value reads as the default
/** Is the beam drawn this frame? `target`: the ray rests on a panel or a nameplate. `grip`/`trig`: held. */
export function pointerVisible(mode, { target = false, grip = false, trig = false } = {}) {
  const m = pointerVisibilityMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return true;
  return !!(target || grip || trig);
}
/** The surface dot has its own setting; pointer 'never' hides only the beam. `target`: what the contextual beam
 *  shows for (panel, nameplate, interactable); `surface`: anything under the laser, a plain wall too. */
export function dotVisible(mode, { target = false, surface = false } = {}) {
  const m = pointerVisibilityMode(mode);
  if (m === 'never') return false;
  if (m === 'always') return !!(target || surface);
  return !!target;
}
/** Does a PLAIN entity count for the beam's length? Only with a button held or the beam always drawn: an idle hand
 *  must not reach out to every wall it hangs toward. An INTERACTABLE entity is a target regardless. */
export const looksAtWorld = (mode, { grip = false, trig = false } = {}) => pointerVisibilityMode(mode) === 'always' || !!(grip || trig);
/** Sockets (world.js socketsOn) or reactions. Trigger-select for editing is an editor's act, so a plain wall isn't a
 *  target. `comp`: the entity's component bag (world.js comps). */
export const interactable = (comp, sockets = 0) => !!comp && (sockets > 0 || (!!comp.reactions && typeof comp.reactions === 'object' && Object.keys(comp.reactions).length > 0));

// ---- 2. smoothing ---------------------------------------------------------------------------------------------
// τ is the time to close ~63% of a gap. 30 ms roughly halves 8–12 Hz tremor; a sweep trails by ω·τ (≈5° at 3 rad/s).
// It is the one dial: raise to steady the beam, lower if aiming feels late.
export const POINTER_TAU = 0.03;          // s
// a step this large in ONE frame is not tremor: tracking re-acquired, a recentre, a teleport. Snap rather than swoop.
export const POINTER_SNAP_RAD = 0.6;      // rad
export const POINTER_SNAP_M = 0.5;        // m
export const smoothAlpha = (dt, tau = POINTER_TAU) => (!(dt > 0) ? 0 : !(tau > 0) ? 1 : 1 - Math.exp(-dt / tau));
/** One frame: `out` ({position, quaternion}) moves toward `to`. `st` is the caller's per-hand state ({init}).
 *  Returns 'snap' or the alpha used. */
export function smoothPose(out, to, dt, st, tau = POINTER_TAU) {
  if (!st.init || out.position.distanceTo(to.position) > POINTER_SNAP_M || out.quaternion.angleTo(to.quaternion) > POINTER_SNAP_RAD) {
    out.position.copy(to.position); out.quaternion.copy(to.quaternion); st.init = true;
    return 'snap';
  }
  const a = smoothAlpha(dt, tau);
  out.position.lerp(to.position, a); out.quaternion.slerp(to.quaternion, a);
  return a;
}

// ---- 3. stickiness ----------------------------------------------------------------------------------------------
// GET ON: a panel control needs the ray on it; a nameplate gets PLATE_GETON_RAD of angular slack (platecard.platePick).
// STAY ON: a held target keeps the ray until STICK_STAY_RAD off its last on-target point. YIELD: a neighbour takes over
// only past STICK_YIELD_RAD, so tremor on a seam between two buttons doesn't flicker.
export const PLATE_GETON_RAD = 0.01;      // ≈0.57°
export const STICK_STAY_RAD = 0.025;      // ≈1.4° — 2 cm at arm's length (0.8 m), 7.5 cm at 3 m
export const STICK_YIELD_RAD = 0.008;     // ≈0.46°
/** The held target for the next frame. `held` / `raw`: {key, …} or null (raw = what the unbent ray is on now);
 *  `angle`: radians between the unbent ray and the held target's last point (NaN when there is none, or the held
 *  target has gone). → { held, bend }: bend = draw and pick toward held's point instead of along the ray. */
export function stickStep(held, raw, angle) {
  if (raw && held && raw.key === held.key) return { held: raw, bend: false };   // on it: its point follows the ray
  if (held && Number.isFinite(angle) && angle <= (raw ? STICK_YIELD_RAD : STICK_STAY_RAD)) return { held, bend: true };
  return { held: raw ?? null, bend: false };
}

const _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1), _fwd = new THREE.Vector3(0, 0, -1);
/** Angle (rad) between the ray (origin, unit dir) and the direction to `point`. */
export const angleTo = (origin, dir, point) => { _d.subVectors(point, origin); return _d.lengthSq() < 1e-12 ? 0 : dir.angleTo(_d); };
/** A ray matrix from `origin` looking at `point` (−Z forward, the controllers' convention). Writes `out`. */
export function rayMatrixTo(out, origin, point) {
  _d.subVectors(point, origin).normalize();
  _q.setFromUnitVectors(_fwd, _d);
  return out.compose(origin, _q, _one);
}
