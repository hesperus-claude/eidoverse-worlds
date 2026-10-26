// controller — input to embodiment. Owns my body's state, my camera, and the
// keyboard/mouse/touch surface that drives both.
//
// The camera is the thing most people judge a 3D client by in the first ten
// seconds, so it gets: collision (no more seeing through hillsides), a
// shoulder offset (your own body stops occluding what you're aiming at), and
// a continuous zoom that passes through into first person.

import { THREE, camera, canvas } from './core.js';
import { CONFIG, angleDelta, bus } from './base.js';
import { heightAt } from './terrain.js';
import { resolveColliders, lastBlockedTop, lastContacts, findSeat, raySegment } from './colliders.js';
import { bumpTick } from './hiddenbump.js';
import { outOfMyView } from './myview.js';
import { colliderFor, deskEyeY, canMantle, mantleStep } from './bodyscale.js';   // this body's chosen size: capsule, eye, mantle
// ONE walker (shared/mover.js): the stride, its speeds and the body's size are the mover's, the same the agent steps
// with and the authority checks; this file keeps the keys, the camera and the collider pass. Water too: the mover
// drags a wading stride and swims past the chest (waterStance); what's here is only how the float LOOKS.
import { walkSpeed, stickSpeed, easeSpeed, stepWalk, waterStance, floatDepth, MOVER } from '../../shared/mover.js';
import { waterLevel, waterAt, waveTime } from './water.js';
import { surfaceOffset } from '../../shared/waves.js';
import { floatStep, footprintSurface } from '../../shared/buoyancy.js';
import { chat } from './chat.js';
import { isOverlayOpen, flashHint, html } from './ui.js';
import { selectClip, AIRBORNE_GRACE } from './locomotion_clip.js';
import { bodyModeOf } from '../../shared/bodymode.js';
// the 3D swim (under a water level, and in water volumes where a world has them): the mover's law (shared/mover.js stepSwim)
import { waterAt as volumeAt, waterTime } from './watervolumes.js';
import { swimStep, waveHeight } from '../../shared/water.js';
import { register as registerAction } from './actions.js';
import {
  resolveFirstPersonAnchor, FP_FORWARD, FP_EYE_LIFT, FP_GAZE_AHEAD, FP_GAZE_DROP,
} from './fp_view.js';

// ---------------------------------------------------------------- flight
// The SAME integrator an agent flies (shared/flight.js), so humans and agents share one physics.
// Off by default: F toggles it, only when the capability provider grants this body a rig.
import {
  makeConfig as flightConfig, initialState as flightState, step as flightStep,
  takeOff as flightTakeOff, bestGlide, bodyDown as flightDown,
} from '../../shared/flight.js';
import { pilotInput } from '../../shared/flightpilot.js';
import { worldFlightProvider, resolveFlight } from '../../shared/flightcap.js';
import { inspectBody } from '../../shared/flightbody.js';
import { applyOwnedWingFold } from '../../shared/wingpresence.js';

let flight = null, flightCfg = null, flightProv = null;
let lastFlightEnd = null;   // why the last flight ended -- 'F did nothing' has causes
let flightBones = null;

/** Called once the body is known. The grant is the server's `yourRights.fly`, never a client-made allow-self;
 *  a compatible body with no grant gets a refusal that names the fix. */
export function armFlight(boneNames, identity = 'me') {
  flightBones = boneNames ?? [];
  flightProv = worldFlightProvider({ rights: myRights, label: 'world-grant' });
  return resolveFlight(flightProv, { identity, avatar: { boneNames: flightBones } }).enabled;
}

// The world's grant comes through a hook main.js wires (an import would cycle via net.js). The default returns
// null, read as "not granted": a forgotten wiring grounds the body, never frees it.
/** Hand the wings back to the idle. Every exit from flight goes through here
 *  -- F, a landing, a ragdoll, a revoked capability -- because "clear it at
 *  each exit" is a rule with as many holes as it has exits. */
function releaseWings() {
  const me = meRef();
  if (me) me.wingEffort = 0;
}

let myRights = () => null;
export function setRightsHook(fn) { myRights = typeof fn === 'function' ? fn : (() => null); }
// ...and my body, for the same reason and by the same route (mybody imports
// this module, so the arrow cannot point back).
let meRef = () => null;
export function setMeHook(fn) { meRef = typeof fn === 'function' ? fn : (() => null); }

// Flight's ground is the floor walking stands on (resolveColliders), not raw heightAt. Probe with a scratch
// vector: resolveColliders mutates x/z and resets `blockedTop`, which the walk path reads the same frame.
const _gp = new THREE.Vector3();
const _float = { on: false, y: 0, vy: 0, at: 0 };   // the swimmer's buoyant column (shared/buoyancy.js)
function groundUnder(pos, cap = null) {
  _gp.set(pos.x, pos.y, pos.z);
  // with a capsule: probe as the move itself will (a small body steps up less than the default one)
  return cap ? resolveColliders(_gp, heightAt, cap.r, cap.tall, true) : resolveColliders(_gp, heightAt);
}
/** groundY(x, z) for the integrator: it has no y to offer, so probe from the
 *  flier's own altitude -- which is what decides whether a box is floor or
 *  wall, and the reason this is not a two-argument terrain lookup. */
function flightGround(x, z) {
  _gp.set(x, flight?.pos?.y ?? myState.pos.y, z);
  return resolveColliders(_gp, heightAt);
}

export const flying = () => !!flight;
// a shove gave something my walk's momentum (thingphysics.js, shared/shove.js keptOf): for a moment my speed is at most what
// I kept (a heavy crate stops me, a ball barely slows me)
let speedCap = null;
export function capSpeed(v, ms) { if (Number.isFinite(v) && ms > 0) speedCap = { v: Math.max(0, v), until: performance.now() + ms }; }

// The vigil posture (flight spec §1 fold_down, §2 FOLDED): controller state, since folding happens standing;
// takeOff refuses while folded.
let wingsFolded = false;
export const folded = () => wingsFolded;
export function setFolded(fold, me = meRef()) {
  wingsFolded = applyOwnedWingFold(myState, me, fold);
}

function toggleFold(me) {
  if (flight) return 'you are flying — land first';
  // Folding is body autonomy, not a flight grant. Starting the posture needs
  // authored wing chains; releasing a carried posture is always possible,
  // including after a swap into a body that has no wings to draw.
  const winged = inspectBody(flightBones ?? []).canAnimateWings;
  if (!wingsFolded && !winged) return null;
  setFolded(!wingsFolded, me);
  if (wingsFolded) return 'wings folded — the vigil posture costs the sky (G to unfold)';
  if (!winged) return 'folded-wing posture released — this body has no wings';
  const cap = flightProv && resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones ?? [] } });
  return cap?.enabled ? 'wings open' : 'wings open — propulsion is still not granted here';
}

/** Why flight is doing that, in words, for a person with no devtools open (__flightDebug is the console twin). */
export function flightReport() {
  const v = flightProv
    ? resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } })
    : { enabled: false, reason: 'flight not armed for this body' };
  const L = [];
  L.push(`rig: ${flightBones?.length ?? 0} bones, ` +
         (v.enabled ? `granted (${v.profile.wingCount} wing bones)` : `DENIED — ${v.reason}`));
  if (flight) {
    L.push(`state: ${flight.phase} · t=${flight.t.toFixed(1)}s · ` +
           `y=${flight.pos.y.toFixed(2)} (ground ${flightGround(flight.pos.x, flight.pos.z).toFixed(2)})`);
    L.push(`speed: ${flight.airspeed.toFixed(1)} m/s air · vy=${flight.vel.y.toFixed(2)} · ` +
           `wings ${flight.wings} · stamina ${Math.round(flight.stamina)}`);
    // The freeze that started this: a phase that integrates nothing while
    // still holding the body. If it is ever seen again, it names itself.
    if (flight.phase === 'GROUND') L.push('!! GROUND while held — this is the freeze bug; press F');
  } else {
    L.push('state: not flying' + (lastFlightEnd
      ? ` · last flight ended ${lastFlightEnd.phase} at t=${lastFlightEnd.t}s, ` +
        `y=${lastFlightEnd.y} over ground ${lastFlightEnd.ground}`
      : ' · no flight this session'));
  }
  return L.join('\n');
}
// A probe, because "F did nothing" has three possible causes and they need
// telling apart: no provider, a rig the provider refuses, or a toggle that
// ran and then the movement loop overwrote it.
if (typeof globalThis !== 'undefined') {
  globalThis.__flightDebug = () => ({
    armed: !!flightProv, bones: flightBones?.length ?? 0,
    flying: !!flight, phase: flight?.phase ?? null,
    y: flight?.pos?.y ?? myState.pos.y,
    vy: flight?.vel?.y ?? null,
    launchNow: flight?.launchNow ?? null,
    groundHere: (() => { try { return heightAt(myState.pos.x, myState.pos.z); } catch { return null; } })(),
    lastEnd: lastFlightEnd,
    verdict: flightProv
      ? resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } })
      : 'no provider',
  });
}

function toggleFlight() {
  // releasing the wings is part of every landing, or a stuck effort of 1 keeps them beating
  if (flight) { flight = null; releaseWings(); return 'landed'; }
  if (!flightProv) return 'flight not armed for this body';
  // The spec's precondition, enforced where the human meets it. takeOff would
  // refuse anyway -- this says so before spending the resolve, and names the
  // key that undoes it.
  if (wingsFolded) return 'wings are folded — press G to unfold first';
  const r = resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } });
  if (!r.enabled) return `no: ${r.reason}`;
  flightCfg ??= flightConfig();
  // Arm it in a local, publish once: a GROUND state left in `flight` is truthy and freezes the body.
  let next;
  try {
    next = flightState({
      phase: 'GROUND',
      pos: { x: myState.pos.x, y: myState.pos.y, z: myState.pos.z },
      // the world's yaw convention is atan2(dx,dz); the integrator's is
      // atan2(dz,dx). Convert, both ways, at this boundary only.
      yaw: Math.PI / 2 - myState.yaw,
    }, flightCfg);
    // the resolved ground, not myState.pos.y (metres off mid-jump), since takeOff builds launch height from it
    next = flightTakeOff(flightCfg, next, { groundY: groundUnder(myState.pos) });
  } catch (e) {
    return `flight failed to start: ${e?.message ?? e}`;
  }
  // a refusal is not a take-off: takeOff returns the given phase with a `takeoff.refused` event, never throws
  if (next.phase !== 'PILOT') {
    const why = next.events?.find(ev => ev.kind === 'takeoff.refused')?.reason ?? next.phase;
    return `cannot take off: ${why}`;
  }
  flight = next;
  return 'flying — W/S pitch, A/D bank, Shift spoil, Space flap, F to land';
}

export const myState = {
  pos: new THREE.Vector3(0, 0, 0),
  yaw: 0,
  pitch: 0,          // head pitch, mirrored from the camera
  speed: 0,
  clip: 'idle',
  anim: null,        // an anim played once: rides one pose packet, cleared after it has been sent
  pose: undefined,   // held custom bone override (null clears); presence only
  wingsFolded: false, // semantic body posture; each rig renders its own fold
  bodyMode: 'stand',  // what the body is doing as a whole (shared/bodymode.js): published as presence bodyMode
  q: undefined,        // full-body orientation while swimming (docs/UNDERWATER-PRESENCE.md); undefined = upright, by yaw
  locomotion: undefined, // {mode, medium, body} while swimming: presence, descriptive only
  seat: null,        // { id, chair } while seated on something
};

export const keys = new Set();
// XR intent — a thumbstick is a keyboard that reports fractions (parity law:
// every gesture must be sayable). xr.js fills this per-frame while presenting;
// the same wish/gravity/mantle/seat code below does every bit of the moving.
export const xrIntent = { fwd: 0, strafe: 0, yawDelta: 0, jump: false, active: false, pitchDown: 0 };   // pitchDown: the head's, radians (+ looking down)
// While an XR session presents, the headset owns the camera (via the rig in
// xr.js) — the desktop follow-cam must not fight it. Probe pattern as usual.
let xrPresenting = () => false;
export function setXrProbe(fn) { xrPresenting = fn; }
let posture = null;              // 'sit' | 'lie' | null
let vy = 0, grounded = true, mantle = null, airborneFor = 0, jumped = false, wantMove = false;

// camera
export let camYaw = 0, camPitch = 0.32, camDist = 4.2;
const _lastFinitePos = new THREE.Vector3();
let dragging = false, dragBtn = 0, dragMode = 'orbit';
// EDIT CAMERA: in edit mode the orbit's centre may leave the body (pan, frame) and the camera may pull far back.
// The offset is from the BODY, so walking carries the view along; leaving edit mode drops it.
export const editPan = new THREE.Vector3();
const EDIT_DIST = 80, PLAY_DIST = 16;
// THE WORLD'S EDGE (R, 10-10 23:00: she ran 44 m out in a world bounded at ±20; the authority refuses every move outside
// its bounds, so its track of her body stopped at the edge and every put and throw after was '25 m from you'). The body
// stops at @world.bounds as at a wall, less its capsule, and says so once in the status bar.
let boundsSrc = () => null, edgeSaidAt = 0;
export function setBoundsHook(fn) { boundsSrc = typeof fn === 'function' ? fn : () => null; }
export function worldBounds() { const B = boundsSrc(); const ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return B && ok(B.min) && ok(B.max) ? B : null; }
export function clampToBounds(x, z, pad = 0.25) { const B = worldBounds(); if (!B) return [x, z];
  return [Math.min(B.max[0] - pad, Math.max(B.min[0] + pad, x)), Math.min(B.max[2] - pad, Math.max(B.min[2] + pad, z))]; }
function keepInBounds() { const [x, z] = clampToBounds(myState.pos.x, myState.pos.z);
  if (x === myState.pos.x && z === myState.pos.z) return; myState.pos.x = x; myState.pos.z = z;
  const now = performance.now(); if (now - edgeSaidAt > 4000) { edgeSaidAt = now; flashHint("that's the edge of this world", 2500); } }
let autoWalk = null; const _autoV = new THREE.Vector3();
/** Walk my body toward (x, z) as if the keys were held, until `until()` is true (or I'm there). Resolves 'arrived',
 *  'cancelled' (a move key, edit mode), 'blocked' (no progress for 0.9 s) or 'timeout'. One walk at a time. */
export function walkTo(x, z, { until = null, ms = 12000 } = {}) {
  endAutoWalk('cancelled'); [x, z] = clampToBounds(x, z);
  return new Promise((done) => { const now = performance.now(); autoWalk = { x, z, until, ms, t0: now, best: Infinity, bestAt: now, done, run: Math.hypot(x - myState.pos.x, z - myState.pos.z) > 3.5 }; });
}
function endAutoWalk(why) { const a = autoWalk; if (!a) return; autoWalk = null; a.done(why); }
export const isAutoWalking = () => !!autoWalk;
// Free camera, edit mode only: WASD flies a WORLD point; the body stays put and walls don't push the eye.
// Leaving edit mode (B) returns the view to the body but keeps the spot; the Body/Free switch is the full reset.
const freeCam = { on: false, focus: new THREE.Vector3(), dist: 6, yaw: 0, pitch: 0.32, saved: false };
export const isFreeCam = () => freeCam.on && editingNow();
export const freeCamState = () => ({ on: freeCam.on, focus: freeCam.focus.toArray(), dist: freeCam.dist });
export function setFreeCam(on) {
  on = !!on && editingNow();
  if (on === freeCam.on) return on;
  if (on) { freeCam.focus.set(myState.pos.x, myState.pos.y + deskEyeY(), myState.pos.z).add(editPan); editPan.set(0, 0, 0); }
  else { editPan.set(0, 0, 0); camDist = Math.min(camDist, PLAY_DIST); freeCam.saved = false; }
  freeCam.on = on;
  bus.emit('edit-freecam', on);
  return on;
}
const _panR = new THREE.Vector3(), _panU = new THREE.Vector3(), _flyF = new THREE.Vector3();
export const mouse = new THREE.Vector2();
export let firstPerson = false;
export let photoMode = false;

const MOVE_KEYS = {
  fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
};
const held = (list) => list.some((k) => keys.has(k));

// A hook the build module sets while a ghost or a drag owns the pointer, so
// the controller doesn't also spin the camera.
let pointerClaimed = () => false;
export function setPointerClaim(fn) { pointerClaimed = fn; }

// ---------------------------------------------------------------- keyboard

const typing = () => document.activeElement?.tagName === 'INPUT'
  || document.activeElement?.tagName === 'TEXTAREA';

addEventListener('keydown', (e) => {
  if (typing() || isOverlayOpen()) return;
  if (e.key === 'Enter') { chat.open(); e.preventDefault(); return; }
  if (e.code === 'Space') e.preventDefault();      // space scrolls the page otherwise
  // keys: toolKeys — a chord (Ctrl+D duplicates, Ctrl+Z undoes) never walks the body; Ctrl itself is held (dive: I97)
  if (!(e.ctrlKey || e.metaKey) || e.code === 'ControlLeft' || e.code === 'ControlRight') keys.add(e.code);
  bus.emit('key', e);
});
addEventListener('keyup', (e) => keys.delete(e.code));
// A held key with the window unfocused stays "down" forever — clear on blur.
addEventListener('blur', () => keys.clear());

bus.on('key', (e) => {
  // Autorepeat is not a second press: every binding here toggles. Guarded here, not on the emit, because
  // build.js's nudge keys want the repeat.
  if (e.repeat) return;
  // the body's toggles yield while editing: X/F/G are the editor's there
  // (remove / find / move tool) and a chorded Z is undo, never 'lie'
  if (editingNow?.()) return;
  if (e.ctrlKey || e.metaKey) return;
  BODY_KEYS.find((k) => k.code === e.code)?.run();
});

// The body's keys, as data: the handler above dispatches from this table and the
// lantern lists it (actions.js), so a key and its row cannot drift apart.
const BODY_KEYS = [
  { code: 'KeyX', key: 'X', id: 'sit', title: 'sit / stand', icon: 'armchair', keywords: ['seat', 'chair', 'posture'], run: () => toggleSit() },
  { code: 'KeyF', key: 'F', id: 'fly', title: 'fly', keywords: ['flight', 'wings', 'land'], run: () => { const m = toggleFlight(); if (m) flashHint?.(m); } },
  { code: 'KeyZ', key: 'Z', id: 'lie', title: 'lie down', icon: 'bed', keywords: ['posture', 'rest', 'sleep'], run: () => { posture = posture === 'lie' ? null : 'lie'; myState.seat = null; } },
  { code: 'KeyG', key: 'G', id: 'fold', title: 'fold wings', keywords: ['wings', 'unfold'], run: () => { const m = toggleFold(meRef()); if (m) flashHint?.(m); } },
];
for (const { code, ...a } of BODY_KEYS) registerAction({ ...a, id: `body:${a.id}`, group: 'body' });

// Declared seats live in main.js; its hook gets first claim on X (and a mounted body's X means "get up").
// Returns true when it consumed the press.
let occupyHook = () => false;
export function setOccupyHook(fn) { occupyHook = fn; }

function toggleSit() {
  if (occupyHook()) return;
  if (posture === 'sit') { posture = null; myState.seat = null; return; }
  // Layer-0: if there's a real seat pan within reach, sit ON it. The geometry
  // is the affordance — a scanned stool is sittable the moment it arrives.
  const seat = findSeat(myState.pos, undefined, (e) => !!outOfMyView(e.obj));   // a surface I hid is no seat offer
  if (seat) {
    myState.pos.set(seat.x, seat.y, seat.z);
    myState.yaw = seat.yaw;
    myState.seat = { id: seat.id, chair: true };
    grounded = true; vy = 0;
    flashHint(html`seated — <kbd>X</kbd> to stand`);
  } else {
    myState.seat = null;
  }
  posture = 'sit';
}

// ---------------------------------------------------------------- mouse
// Everything here is gated on the event being on the canvas, so UI drags and scrolls never move the camera.

canvas.addEventListener('mousedown', (e) => {
  if (pointerClaimed()) return;
  // Outside edit mode either button looks. In edit mode a left-drag belongs to the object under it, so the camera
  // has an editor's controls:
  //   Alt+left  orbit (over anything)      middle, or Alt+middle  pan      Alt+right  dolly      right  orbit
  //   left on bare space  orbit (build.js says so: 'edit-bare-press')       wheel  dolly      F  frame the selection
  if (editingNow()) {
    if (e.button === 1) { e.preventDefault(); dragging = true; dragMode = 'pan'; }
    else if (e.altKey) { e.preventDefault(); dragging = true; dragMode = e.button === 2 ? 'dolly' : 'orbit'; }
    else if (e.button === 2) { dragging = true; dragMode = 'orbit'; }
    if (dragging) dragBtn = e.button;
    return;
  }
  if (e.button === 2 || e.button === 0) { dragging = true; dragBtn = e.button; dragMode = 'orbit'; }
});
bus.on('edit-bare-press', () => { dragging = true; dragBtn = 0; dragMode = 'orbit'; });   // a left press on nothing, in edit mode
addEventListener('keyup', (e) => { if (e.key === 'Alt' && editingNow()) e.preventDefault(); });   // a bare Alt release would focus the browser's menu bar mid-edit
canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });   // no autoscroll / paste on a middle press
// set by build.js so the controller doesn't have to import it (build imports us)
let editingNow = () => false;
export function setEditingProbe(fn) { editingNow = fn; }
addEventListener('mouseup', () => { dragging = false; });
// ---- mouselook --------------------------------------------------------------
// The canvas captures the pointer; drag-orbit stays as the fallback and the edit-mode behaviour.
let locked = false, lockHinted = false;
export const isMouselook = () => locked;

// Mouselook: bare M toggles the lock; Esc always frees it (browsers never grant a lock from Esc, hence M).
// Clicking the world does not lock, on purpose. While locked, `mouse` pins to (0,0) so picking reads screen centre.

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    mouse.set(0, 0);
    if (!lockHinted) { flashHint(html`mouselook — <kbd>M</kbd> toggles · <kbd>Esc</kbd> frees the cursor`); lockHinted = true; }
  }
});
bus.on('edit-mode', (on) => { if (on && locked) document.exitPointerLock(); });
bus.on('edit-mode', (on) => {
  if (!on) {
    if (freeCam.on) { Object.assign(freeCam, { dist: camDist, yaw: camYaw, pitch: camPitch, saved: true }); bus.emit('edit-freecam', false); }   // B: back in my body, the spot kept
    editPan.set(0, 0, 0); camDist = Math.min(camDist, PLAY_DIST); camPitch = THREE.MathUtils.clamp(camPitch, -0.9, 1.2);
  } else if (freeCam.on && freeCam.saved) { camDist = freeCam.dist; camYaw = freeCam.yaw; camPitch = freeCam.pitch; freeCam.saved = false; bus.emit('edit-freecam', true); }   // B again: where I left the camera
});
/** Frame a point (F on a selection): the orbit centres on it, far enough back to see `radius` of it. Edit mode only. */
export function frameOn(point, radius = 1) {
  if (!editingNow()) return false;
  if (freeCam.on) freeCam.focus.copy(point); else
  editPan.set(point.x - myState.pos.x, point.y - (myState.pos.y + deskEyeY()), point.z - myState.pos.z);
  camDist = THREE.MathUtils.clamp(radius * 2.6 + 1, 1.5, EDIT_DIST);
  return true;
}

addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat) return;
  // bare M only: modified presses belong to the browser and the OS
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (editingNow() || isOverlayOpen() || chat.isOpen) return;
  if (locked) document.exitPointerLock();
  else relock();
});

// Chrome wants requestPointerLock from a focused target and an Esc unlock leaves the canvas unfocused:
// focus first, then ask, and say so if the browser refuses.
function relock() {
  if (document.pointerLockElement === canvas) return;
  try { canvas.focus?.({ preventScroll: true }); } catch { /* not focusable, fine */ }
  const p = canvas.requestPointerLock();
  p?.catch?.(() => flashHint(html`press <kbd>M</kbd> again to look`));
}

addEventListener('mousemove', (e) => {
  if (dragging && dragMode === 'pan') {
    // along the view's own right and up, a screen's worth per screen at this distance
    camera.matrixWorld.extractBasis(_panR, _panU, _dir);
    const k = Math.max(camDist, 1) * 0.0016;
    (freeCam.on ? freeCam.focus : editPan).addScaledVector(_panR, -e.movementX * k).addScaledVector(_panU, e.movementY * k);
  } else if (dragging && dragMode === 'dolly') {
    camDist = THREE.MathUtils.clamp(camDist * Math.exp((e.movementY - e.movementX) * 0.006), 0.8, EDIT_DIST);
  } else if (locked || dragging) {
    camYaw -= e.movementX * 0.005;
    camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.004, editingNow() ? -1.45 : -0.9, editingNow() ? 1.45 : 1.2);
  }
  if (!locked) mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag orbit
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // in edit mode the wheel is proportional (a step far out covers more ground) and reaches further
  camDist = editingNow() ? THREE.MathUtils.clamp(camDist * Math.exp(e.deltaY * 0.0012), 0.8, EDIT_DIST) : THREE.MathUtils.clamp(camDist + e.deltaY * 0.004, 0.0, PLAY_DIST);
  const wasFP = firstPerson;
  // Hysteresis: enter FP under 0.4m, don't leave until past 0.7m. A single
  // threshold flickers 1P/3P at the boundary — nauseating, and loudest for
  // exactly the motion-sensitive people a hangout world shelters.
  firstPerson = wasFP ? camDist < 0.7 : camDist < 0.4;
  if (firstPerson !== wasFP) flashHint(firstPerson ? 'first person' : 'third person');
}, { passive: false });

// ---------------------------------------------------------------- touch
// A left thumbstick plus look-drag on the rest of the screen: the minimum that makes a body usable on a phone.

const touchState = { moveX: 0, moveZ: 0, lookId: null, lastX: 0, lastY: 0 };
export function enableTouch() {
  document.body.classList.add('touch');
  const stick = document.getElementById('stick');
  const nub = stick.querySelector('.nub');
  let stickId = null, cx = 0, cy = 0;
  const R = 46;
  stick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    stick.setPointerCapture(e.pointerId);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    touchState.moveX = dx / R; touchState.moveZ = dy / R;
  });
  const end = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null; touchState.moveX = touchState.moveZ = 0;
    nub.style.transform = '';
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || touchState.lookId !== null) return;
    touchState.lookId = e.pointerId;
    touchState.lastX = e.clientX; touchState.lastY = e.clientY;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touchState.lookId) return;
    camYaw -= (e.clientX - touchState.lastX) * 0.006;
    camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - touchState.lastY) * 0.005, -0.9, 1.2);
    touchState.lastX = e.clientX; touchState.lastY = e.clientY;
  });
  const lookEnd = (e) => { if (e.pointerId === touchState.lookId) touchState.lookId = null; };
  canvas.addEventListener('pointerup', lookEnd);
  canvas.addEventListener('pointercancel', lookEnd);

  // Jump only: chat is on the rail. The chat import stays (Enter opens chat; chat.isOpen gates movement).
  const btns = document.getElementById('touchbtns');
  for (const [label, code] of [['⤒', 'Space'], ['⤓', 'KeyC']]) {
    const b = document.createElement('button');
    b.className = 'panel';
    b.textContent = label;
    b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); keys.add(code); });
    b.addEventListener('pointercancel', () => keys.delete(code));
    b.addEventListener('lostpointercapture', () => keys.delete(code));
    b.addEventListener('pointerup', () => keys.delete(code));
    btns.appendChild(b);
  }
}
if (matchMedia('(pointer: coarse)').matches) enableTouch();

// ---------------------------------------------------------------- movement

const _dir = new THREE.Vector3();
const _wp = new THREE.Vector3();   // a probe point for the mover's floorAt in water
const _eye = new THREE.Vector3();
const _facing = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

let swimVelocity = [0, 0, 0];
const _swimProbe = new THREE.Vector3(), _swimOld = new THREE.Vector3();
const _swimQ = new THREE.Quaternion(), _swimTilt = new THREE.Quaternion();
/** Keep a swimming body inside the world: @world.bounds as walking keeps them (clampToBounds), and the stage's 78 m
 *  island where the world has none (as walking does). (Upstream's authored `environment.bounds` box is a #248 water-volume
 *  world's, deferred with those components.) */
export function constrainMovement(pos) {
  const [x, z] = clampToBounds(pos.x, pos.z); pos.x = x; pos.z = z;
  if (!worldBounds()) { const r = Math.hypot(pos.x, pos.z); if (r > 78) { pos.x *= 78 / r; pos.z *= 78 / r; } }
}
// Diving in the water level (water.js): the same 3D swim as authored volumes (Space up, C / Ctrl down), surface at
// the wave above; surfacing hands the body back to the float (shared/buoyancy.js).
let levelDiving = false;
const levelDiveKeys = () => keys.has('KeyC') || keys.has('ControlLeft') || keys.has('ControlRight');
function levelDiveWater(me) {
  const wl = flight ? null : waterLevel();
  const w = wl == null ? null : waterAt(myState.pos.x, myState.pos.z);
  if (!w) { levelDiving = false; return null; }
  const stature = deskEyeY(me?.userScale) / deskEyeY(1);
  if (!levelDiving) {
    // only from a swim (deep enough to float: MOVER.swim.deep of the float depth), and only when asked: C / Ctrl, or a
    // headset heading down
    const wantDive = levelDiveKeys() || (xrIntent.active && xrIntent.fwd * Math.sin(xrIntent.pitchDown) > .3);
    if (!wantDive || !(w.depth > MOVER.swim.deep * floatDepth(MOVER.body.height * stature))) return null;
    // only from IN the water (review #254): falling over a lake with C held must not start a swim in mid-air —
    // the body is at least half under its float line (afloat, its feet ride floatDepth under the surface)
    const top = wl + surfaceOffset(w, myState.pos.x, myState.pos.z, waveTime());
    if (!(myState.pos.y < top - 0.5 * floatDepth(MOVER.body.height * stature))) return null;
    levelDiving = true; swimVelocity = [0, -0.6, 0];
  }
  return { level: true, top: wl + surfaceOffset(w, myState.pos.x, myState.pos.z, waveTime()), waves: [],
    speed: MOVER.swim.speed * MOVER.swim.dive * (me?.userScale ?? 1) };
}
export const isLevelDiving = () => levelDiving;   // probes and tests
function updateSwimming(dt, me, fwd, strafe) {
  _swimProbe.copy(myState.pos); _swimProbe.y += .7;
  const water = volumeAt(_swimProbe) ?? levelDiveWater(me);
  if (!water || myState.seat) { swimVelocity=[0,0,0];levelDiving=false;return false; }
  _swimProbe.copy(myState.pos);
  const floor = resolveColliders(_swimProbe,heightAt);
  // a headset swims where it looks: A/X (its jump) rises, and looking down while pushing forward dives —
  // no invented buttons (the desktop's C/Ctrl have no VR twin by design)
  const xr=xrIntent.active;
  const rise=keys.has('Space')||(xr&&xrIntent.jump), dive=keys.has('KeyC')||keys.has('ControlLeft')||keys.has('ControlRight');
  // Wading is still walking. At a deep shoreline gravity hands over to swim.
  const stature=deskEyeY(me?.userScale)/deskEyeY(1);   // this body's size: float depth, handover and head sweep follow it
  if(floor >= waveHeight(water,myState.pos.x,myState.pos.z,waterTime())-floatDepth(MOVER.body.height*stature) && !rise) { levelDiving=false; return false; }
  if(flight){flight=null;releaseWings();}
  if(!myState.locomotion)flashHint('swimming — WASD move, Space rise, C / Ctrl dive, Shift faster');
  mantle=null;posture=null;grounded=false;vy=0;airborneFor=0;
  _dir.set(strafe,0,-fwd).applyAxisAngle(UP,camYaw);
  _dir.y = Number(rise)-Number(dive)-fwd*Math.sin(xr?xrIntent.pitchDown:camPitch-.32);
  // a headset heading down (looking down, pushing forward) is diving: it releases the surface latch, which
  // otherwise snaps a swimmer with no dive button straight back up (its direction stays where it looks)
  const headsetDive=xr&&!rise&&fwd*Math.sin(xrIntent.pitchDown)>.3;   // an explicit rise (A/X) wins
  const input={direction:_dir.toArray(),rise,dive:dive||headsetDive,fast:keys.has('ShiftLeft')||keys.has('ShiftRight'),stature};
  let mode='swim';const steps=Math.max(1,Math.ceil(dt/(1/60)));
  for(let i=0;i<steps;i++){
    _swimOld.copy(myState.pos);
    const next=swimStep(myState.pos.toArray(),swimVelocity,input,water,dt/steps,waterTime());
    myState.pos.fromArray(next.pos);swimVelocity=next.velocity;mode=next.mode;
    // Sweep torso and head before resolving support; this also stops upward
    // swimming through a habitat ceiling, which walking's floor probe cannot.
    _dir.copy(myState.pos).sub(_swimOld);const distance=_dir.length();
    if(distance>.00001){_dir.divideScalar(distance);
      for(const h of [.3*stature,1.1*stature]){
        _swimProbe.copy(_swimOld);_swimProbe.y+=h;
        const hit=raySegment(_swimProbe,_dir,distance+.3);
        if(hit!==null){myState.pos.copy(_swimOld).addScaledVector(_dir,Math.max(0,hit-.3));swimVelocity=[0,0,0];break;}
      }
    }
    const bottom=resolveColliders(myState.pos,heightAt);
    if(myState.pos.y<bottom){myState.pos.y=bottom;swimVelocity[1]=Math.max(0,swimVelocity[1]);}
    constrainMovement(myState.pos);
  }
  // back at the level's surface and not diving: the float (updateMe) takes the body from here
  if(water.level&&mode==='surface'&&!input.dive){levelDiving=false;}
  const horizontal=Math.hypot(swimVelocity[0],swimVelocity[2]);
  if(horizontal>.05)myState.yaw+=angleDelta(myState.yaw,Math.atan2(swimVelocity[0],swimVelocity[2]))*Math.min(1,dt*8);
  myState.speed=Math.hypot(...swimVelocity);myState.clip='idle';
  myState.locomotion={mode,medium:'water',body:'diver'};me.locomotion=myState.locomotion;
  _swimQ.setFromAxisAngle(UP,myState.yaw);
  _swimTilt.setFromAxisAngle(new THREE.Vector3(1,0,0),mode==='surface'?0:Math.min(1.1,horizontal*.4));
  _swimQ.multiply(_swimTilt);myState.q=_swimQ.toArray();
  me.root.position.copy(myState.pos);me.root.quaternion.copy(_swimQ);me.setClip('idle',0);
  myState.pitch=THREE.MathUtils.clamp(camPitch-.32,-.45,.55);me.pitch=firstPerson?0:myState.pitch;
  updateFollowCamera(dt,me);return true;
}

export function updateMe(dt, me) {
  if (!me) return;
  if (photoMode) { updatePhotoCamera(dt); bumpTick(null, dt); return; }   // no body moving: a mark already up still fades

  let fwd = Number(held(MOVE_KEYS.fwd)) - Number(held(MOVE_KEYS.back));
  let strafe = Number(held(MOVE_KEYS.right)) - Number(held(MOVE_KEYS.left));
  if (touchState.moveX || touchState.moveZ) { strafe = touchState.moveX; fwd = -touchState.moveZ; }
  if (xrIntent.active) {
    fwd = xrIntent.fwd; strafe = xrIntent.strafe;
    if (xrIntent.yawDelta) { camYaw += xrIntent.yawDelta; xrIntent.yawDelta = 0; }
  }

  // a NaN that got into the accumulators in VR (a stick axis on wake, 09-05 23:13) survives the
  // session end and blacks out the desktop view: the orbit camera reads camYaw. Every compare
  // with NaN is false, so nothing below would ever clear it.
  if (!Number.isFinite(myState.speed)) myState.speed = 0;
  if (!Number.isFinite(camYaw)) camYaw = 0;
  if (!(Number.isFinite(myState.pos.x) && Number.isFinite(myState.pos.y) && Number.isFinite(myState.pos.z))) myState.pos.copy(_lastFinitePos); else _lastFinitePos.copy(myState.pos);
  // Auto-walk to something out of reach, with the same inputs keys give, so downstream it is ordinary walking.
  // Any real input ends it; so does arriving, getting nowhere, or running out of time.
  if (autoWalk) {
    const a = autoWalk, dx = a.x - myState.pos.x, dz = a.z - myState.pos.z, d = Math.hypot(dx, dz), now = performance.now();
    if (Math.abs(fwd) > 0.08 || Math.abs(strafe) > 0.08 || editingNow()) endAutoWalk('cancelled');
    else if (a.until?.() || d < 0.12) endAutoWalk('arrived');
    else if (now - a.t0 > a.ms) endAutoWalk('timeout');
    else { if (d < a.best - 0.05) { a.best = d; a.bestAt = now; }
      if (now - a.bestAt > 900) endAutoWalk('blocked');
      else { _autoV.set(dx / d, 0, dz / d).applyAxisAngle(UP, -camYaw); strafe = _autoV.x; fwd = -_autoV.z; } }
  }
  if (isFreeCam()) {
    // WASD flies the camera's centre: forward is where the camera looks (so W climbs when you look up), the speed grows
    // with the distance you've pulled back, Shift is three times faster
    if (Math.abs(fwd) > 0.08 || Math.abs(strafe) > 0.08) {
      camera.matrixWorld.extractBasis(_panR, _panU, _flyF);
      const sp = Math.max(camDist, 3) * 1.1 * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1) * dt;
      freeCam.focus.addScaledVector(_flyF, -fwd * sp).addScaledVector(_panR, strafe * sp);
    }
    fwd = 0; strafe = 0;   // the body stays where it stood
  }
  if (updateSwimming(dt, me, fwd, strafe)) return;
  myState.q = undefined;
  myState.locomotion = undefined;
  me.locomotion = null;
  me.root.rotation.set(0, myState.yaw, 0);
  const moving = Math.abs(fwd) > 0.08 || Math.abs(strafe) > 0.08;
  wantMove = moving;   // INTENT, for the clip choice below: the walk→idle blend starts on key release, not 0.34 s later when the coast ends
  // walking brings the edit camera home (R, 10-10: "when you use 'f' to frame, can you make it so that using WASD
  // automatically resets the camera back to your character?"): the pan eases out and a far pull-back comes in
  if (moving && editingNow() && (editPan.lengthSq() > 0 || camDist > PLAY_DIST)) {
    const k = Math.exp(-dt / 0.12);
    editPan.multiplyScalar(k); if (editPan.lengthSq() < 1e-4) editPan.set(0, 0, 0);
    if (camDist > PLAY_DIST) camDist = Math.max(PLAY_DIST, PLAY_DIST + (camDist - PLAY_DIST) * k - 0.01);
  }
  const running = keys.has('ShiftLeft') || keys.has('ShiftRight') || !!autoWalk?.run;   // a long auto-walk runs
  // A slow walk for precise positioning — placing a chair exactly where you
  // want it at 1.55 m/s is a fight.
  const creeping = keys.has('AltLeft') || keys.has('AltRight');
  const mag = Math.min(1, Math.hypot(fwd, strafe));
  // VR stick: half deflection walks, full sprints (mover.stickSpeed); desktop keeps shift/alt. The mover scales
  // stride with chosen size. `fast` = Shift or stick past half: on land the run, in water MOVER.swim.run.
  const fast = xrIntent.active ? mag > 0.5 : running;
  const full = walkSpeed({ run: fast, creep: creeping, scale: me.userScale });   // the mover's speed for these keys
  const target = moving ? (xrIntent.active ? stickSpeed(mag, me.userScale) : full * mag) : 0;
  myState.speed = easeSpeed(myState.speed, target, dt);
  if (speedCap && performance.now() < speedCap.until) myState.speed = Math.min(myState.speed, speedCap.v); else speedCap = null;
  // WATER (upstream #242): one level for the world (water.js), none while flying. The mover reads it (env.waterAt) and
  // its stance decides the pace — wading drags, past the chest the body swims; the float below is presentation.
  // Measured against this body's own stature (a taller body wades deeper), from what the body would stand on.
  const wl = flight ? null : waterLevel();
  const wadeH = wl == null ? 0 : me.bodyHeight?.() ?? colliderFor(me.userScale).tall;

  // first person: the body faces where I look, standing still too (R, 10-10). Others see which way I'm looking, and what I
  // throw or set down "ahead" goes where my eyes are. Not on a seat, not while the edit camera is off on its own.
  if (firstPerson && !moving && !myState.seat && !isFreeCam()) { myState.yaw += angleDelta(myState.yaw, camYaw + Math.PI) * Math.min(1, 12 * dt); myState.yaw = Math.atan2(Math.sin(myState.yaw), Math.cos(myState.yaw)); }
  if (moving) {
    _dir.set(strafe, 0, -fwd).normalize().applyAxisAngle(UP, camYaw);
    const targetYaw = Math.atan2(_dir.x, _dir.z);
    myState.yaw += angleDelta(myState.yaw, targetYaw) * Math.min(1, 12 * dt); myState.yaw = Math.atan2(Math.sin(myState.yaw), Math.cos(myState.yaw));   // the accumulator wraps too (the owner's recorder: root 7.62 = 1.34 + 2π after setCamYaw already wrapped)
    // the stride is the mover's, so metres per frame match an agent's tick and the authority's track. The floor is
    // the collider pass below; in water the mover also needs it (stance), probed as the move will be.
    const wcap = wl == null ? null : colliderFor(me.userScale);
    const groundHere = wl == null ? Infinity : groundUnder(myState.pos, wcap);
    const stride = stepWalk({ pos: [myState.pos.x, myState.pos.y, myState.pos.z], dir: [_dir.x, _dir.z], dt, run: fast, creep: creeping, scale: me.userScale, gain: myState.speed / full, height: wadeH || undefined },
      // the mover's floor (and so its ledge rule) only where the stride touches water: on dry ground the collider pass
      // owns y as before, so a pond somewhere never changes how a hill walks (review 10-15 #2)
      wl == null ? {} : { floorAt: (x, z, y) => { const g = groundUnder(_wp.set(x, y, z), wcap); return g < wl || groundHere < wl ? g : NaN; }, waterAt: () => wl });
    myState.pos.x = stride.pos[0]; myState.pos.z = stride.pos[2];
    keepInBounds();
    if (!worldBounds()) {   // the stage's 78 m island, where the world authored no bounds of its own (as swimming: I32)
      const R = 78, r = Math.hypot(myState.pos.x, myState.pos.z);
      if (r > R) { myState.pos.x *= R / r; myState.pos.z *= R / r; }
    }
  }

  // ---- vertical
  const cap = colliderFor(me.userScale);   // the walking capsule grows and shrinks with the body; it still climbs
  const ground = resolveColliders(myState.pos, heightAt, cap.r, cap.tall, true);
  // what the feet rest on: the ground, or — past the chest in water — the floating depth (so falling or
  // jumping into deep water lands you swimming at the surface, by the same gravity as anywhere else)
  const wst = wl != null ? waterStance(wl, ground, wadeH) : null;
  const support = wst ? wst.y : ground;
  const swimming = !!wst?.swimming;
  const blockedTop = lastBlockedTop();
  bumpTick(lastContacts(), dt);   // a thing I hid stays solid: bumping it shows its outline (hiddenbump.js)
  // FLIGHT OWNS THE BODY while it lasts -- position, heading and clip -- the
  // same way a mantle or a ragdoll does. Walking resumes the moment she lands.
  if (flight) {
    // A grounded flight does not own a body (stepGround integrates nothing); second lock after the toggle's.
    if (flight.phase === 'GROUND') {
      flashHint?.('flight did not start — released');
      flight = null; grounded = true; vy = 0;
    }
  }
  // The grant is re-resolved every frame, so a revocation grounds a body already up: handed to the leaf
  // (a visible descent), never dropped, which would teleport it to the ground.
  if (flight && flight.phase !== 'RAGDOLL') {
    const still = resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } });
    if (!still.enabled) {
      flashHint?.(`flight withdrawn — ${still.reason}`, 6000);
      flight = flightDown(flight, { eventId: 'capability-revoked' });
    }
  }
  if (flight) {
    const input = pilotInput(keys, flight, dt);
    flight = flightStep(flightCfg, flight, dt, { groundY: flightGround, input });
    // the world's bounds hold in the air too (house review I13): the flight state itself is clamped, or the next step
    // carries on from outside them
    const [fx, fz] = clampToBounds(flight.pos.x, flight.pos.z);
    if (fx !== flight.pos.x || fz !== flight.pos.z) flight = { ...flight, pos: { ...flight.pos, x: fx, z: fz } };
    myState.pos.set(flight.pos.x, flight.pos.y, flight.pos.z);
    myState.yaw = Math.PI / 2 - flight.yaw;          // back to world convention
    myState.speed = Math.hypot(flight.vel.x, flight.vel.z);
    myState.clip = flight.wings === 'LIMP' ? 'ragdoll'
      : (input.flap ? 'fly' : 'soar');
    myState.bodyMode = flight.wings === 'LIMP' ? 'fall' : 'fly';   // the mover's flight state, reported (shared/bodymode.js)
    // Wing effort follows flight state, not a timer: the launch envelope (normalised to the config's launchBoost)
    // or full power while flap (Space) is held.
    const boost = flightCfg.pilot?.launchBoost ?? 9.0;
    const fromLaunch = Math.min(1, (flight.launchNow ?? 0) / (boost * 0.55));
    me.wingEffort = input.flap ? 1 : fromLaunch;
    if (flight.phase === 'LANDED' || flight.phase === 'GROUND' || flight.phase === 'RAGDOLL') {
      const endedAt = +flight.t.toFixed(2);
      lastFlightEnd = { phase: flight.phase, y: +flight.pos.y.toFixed(2),
                        ground: +flightGround(flight.pos.x, flight.pos.z).toFixed(2),
                        t: endedAt };
      // a landing before the launch finishes spooling is a bug: report it with its numbers
      if (endedAt < 1.5) {
        flashHint?.(`flight ended after ${endedAt}s — landed at y=${lastFlightEnd.y}, ` +
                    `ground ${lastFlightEnd.ground}`, 6000);
      }
      flight = null; grounded = true; vy = 0;
      myState.clip = 'idle'; myState.speed = 0;
      me.wingEffort = 0;              // back to the resting flap, eased in _flap
      releaseWings();                 // ...and for any body the loop is not holding
    }
    // Draw the body here: the clip/root/camera lines at updateMe's tail are past the `return` below
    // (stepRagdoll and updateMountedMe do the same).
    me.setClip(myState.clip, myState.speed);
    me.root.position.copy(myState.pos);
    me.root.rotation.y = myState.yaw;
    me.pitch = firstPerson ? 0 : THREE.MathUtils.clamp(camPitch - 0.32, -0.45, 0.55);
    updateFollowCamera(dt, me);
    return;                                           // nothing else drives her
  }
  // not flying means no wing effort, asserted every frame to cover exits releaseWings() doesn't know about
  if (me.wingEffort) me.wingEffort = 0;
  if (mantle) {
    mantle.t += dt / 0.55;
    const k = Math.min(1, mantle.t), e = k * k * (3 - 2 * k);
    myState.pos.lerpVectors(mantle.from, mantle.to, e);
    if (k >= 1) { mantle = null; grounded = true; vy = 0; }
  } else {
    if (grounded && !swimming && (keys.has('Space') || (xrIntent.active && xrIntent.jump))) {   // nothing to push off from, swimming
      posture = null; myState.seat = null;
      const reach = blockedTop !== null ? blockedTop - myState.pos.y : 0;
      if (blockedTop !== null && canMantle(reach, me.userScale)) {
        _facing.set(Math.sin(myState.yaw), 0, Math.cos(myState.yaw));
        const to = myState.pos.clone().addScaledVector(_facing, mantleStep(me.userScale));
        to.y = blockedTop;
        mantle = { from: myState.pos.clone(), to, t: 0 };
        grounded = false;
      } else { vy = 5.6; grounded = false; jumped = true; }   // a DELIBERATE jump: the clip may start this frame, no airborne grace
    }
    if (!mantle) {
      // reaching the water starts the float (a body off a high bank falls first, then dunks); a frame this code
      // didn't run means something else moved the body, so the old float is stale
      const nowMs = performance.now();
      const afloat = _float.on && nowMs - _float.at <= 250;
      if (swimming && (afloat || myState.pos.y <= support + 0.3)) {
        // Floating (shared/buoyancy.js): a buoyant column on shared/waves.js's swell, picking up the body's motion.
        // Ahead of the falling branch, so a crest lifting the swimmer is not mistaken for a fall.
        if (!afloat) { _float.on = true; _float.y = myState.pos.y; _float.vy = vy; }
        _float.at = nowMs;
        const t = waveTime();
        const surf = footprintSurface((x, z) => wl + surfaceOffset(waterAt(x, z), x, z, t), myState.pos.x, myState.pos.z);
        floatStep(_float, surf, wadeH, dt, ground);
        myState.pos.y = _float.y; vy = 0; grounded = true;
      } else if (!grounded || myState.pos.y > support + 0.02) {
        grounded = false;
        vy -= 16 * dt;
        myState.pos.y += vy * dt;
        // into deep water the fall goes on below the floating depth (the float takes it next frame, still
        // moving down); the bed is the only floor there
        const floor = swimming ? ground : support;
        if (myState.pos.y <= floor) { myState.pos.y = floor; vy = 0; grounded = true; }
      } else { myState.pos.y = support; vy = 0; grounded = true; }
      if (!swimming) _float.on = false;
    }
  }
  airborneFor = grounded || mantle ? 0 : airborneFor + dt;
  if (grounded || mantle) jumped = false;
  if (myState.speed >= 0.05) {
    posture = null; myState.seat = null; // standing up is just walking away
    // ...and so is escaping a held pose (puppet, restored, or ragdoll-settled).
    // Without this, a pose applied from OUTSIDE this session had no exit —
    // the get-up path only exists in the session that fell.
    if (myState.pose) myState.pose = null;
  }

  // The policy itself lives in locomotion_clip.js so it can be driven directly
  // (#196 review B2: this path selects the clip AND its blend, and nothing bound
  // it). Flight picks its own clip and returns before this line.
  if (swimming) { posture = null; myState.seat = null; }   // you cannot sit down in deep water
  const sel = selectClip({ mantle, jumped, airborneFor, wantMove, speed: myState.speed, scale: me.userScale, posture, seat: myState.seat });
  // swimming is its own pair of clips — a stroke while moving, treading water while still. They are
  // procedural (avatar.js _swimLayer), so every client draws them from this name alone.
  myState.clip = swimming && grounded ? (wantMove || myState.speed > 0.15 ? 'swim' : 'tread') : sel.clip;
  // the body-mode this body publishes (shared/bodymode.js; R 10-17: was the posture, read off the clip): the mover's own
  // states (swimming, in the air past the step grace) over what was chosen (posture; a seat is sitting)
  myState.bodyMode = bodyModeOf({ swimming: swimming && grounded, falling: !grounded && !mantle && airborneFor > AIRBORNE_GRACE, chosen: posture ?? (myState.seat ? 'sit' : 'stand') });

  me.setClip(myState.clip, myState.speed, sel.opts);
  me.root.position.copy(myState.pos);
  me.root.rotation.y = myState.yaw;
  // your head follows your camera — you could always look up, your body never
  // showed it
  myState.pitch = THREE.MathUtils.clamp(camPitch - 0.32, -0.45, 0.55);
  me.pitch = firstPerson ? 0 : myState.pitch;

  updateFollowCamera(dt, me);
}

// ---------------------------------------------------------------- camera

// Clips whose head sits where the fixed standing-height guess puts it. Any
// other clip — sit/sitchair/lie, whatever pose a socket declares — moves the
// head somewhere a constant offset from the root can't know.
const STANDING_CLIPS = new Set(['idle', 'walk', 'run', 'jump', 'climb']);
const _headWp = new THREE.Vector3();

export function updateFollowCamera(dt, me) {
  if (xrPresenting()) return;   // the rig carries the camera; the body stays visible (own head hidden by layers)
  const headY = deskEyeY(me?.userScale);   // 1.45 m for a 100% body; the chosen size lifts or lowers the eye
  const focus = _eye.set(myState.pos.x, myState.pos.y + headY, myState.pos.z);
  const free = isFreeCam();
  if (free) focus.copy(freeCam.focus); else
  if (editingNow() && !firstPerson) focus.add(editPan);   // the edit camera's centre (pan, frame)

  if (firstPerson) {
    // Posed or not standing: anchor on the LIVE head bone (#75; the mixer runs while hidden). Standing keeps the
    // fixed height, or the walk cycle's head bob reaches the eye.
    if (me && (myState.pose || !STANDING_CLIPS.has(myState.clip))) {
      const hp = me.headWorldPosition(_headWp);
      if (hp) focus.set(hp.x, hp.y + FP_EYE_LIFT, hp.z);
    }
    // Eye slightly forward of the head joint so the face doesn't clip the near
    // plane, aimed along the orbit angles (which are now the LOOK angles).
    _facing.set(Math.sin(camYaw), 0, Math.cos(camYaw));
    camera.position.copy(focus).addScaledVector(_facing, 0.16);
    _dir.set(
      -Math.sin(camYaw) * Math.cos(camPitch - 0.32),
      -Math.sin(camPitch - 0.32),
      -Math.cos(camYaw) * Math.cos(camPitch - 0.32),
    ).normalize();
    camera.lookAt(
      camera.position.x + _dir.x, camera.position.y + _dir.y, camera.position.z + _dir.z);
    if (me) { me.vrm.scene.visible = false; me.firstPersonView = true; }   // not the inside of your own head, nor your own name over it
    return;
  }
  if (me) { me.vrm.scene.visible = true; me.firstPersonView = false; }

  // desired eye, with a shoulder offset so the body doesn't sit dead-centre
  // over whatever you're aiming at
  const dirX = Math.sin(camYaw) * Math.cos(camPitch);
  const dirY = Math.sin(camPitch);
  const dirZ = Math.cos(camYaw) * Math.cos(camPitch);
  const shoulder = _shoulder.set(Math.cos(camYaw), 0, -Math.sin(camYaw))
    .multiplyScalar(THREE.MathUtils.clamp(camDist * 0.16, 0, 0.62));
  const want = _camWant.set(dirX, dirY, dirZ).multiplyScalar(camDist).add(focus).add(shoulder);

  // ---- collision: pull the eye in so it never ends up inside the world; one grid segment query (§14.2 6a)
  const farD = focus.distanceTo(want);
  _cdir.copy(want).sub(focus).normalize();
  // the free camera is an editor's: it passes through. So does the body camera once its centre has left the body (F, a
  // pan): the centre is then INSIDE the framed thing, and the wall rule pulled the eye in to its middle (R, 10-10: F in
  // Body mode put the camera inside the barrel)
  const off = free || (editingNow() && editPan.lengthSq() > 1e-6);
  const hitT = off ? null : raySegment(focus, _cdir, farD);
  const allowed = hitT !== null ? Math.min(farD, hitT - 0.22) : farD;
  if (allowed < farD) {
    want.copy(focus).addScaledVector(_cdir, Math.max(0.35, allowed));
  }
  // never let the eye go under the floor
  if (!off) want.y = Math.max(want.y, heightAt(want.x, want.z) + 0.35);

  camera.position.lerp(want, 1 - Math.exp(-(allowed < farD ? 26 : 14) * dt));
  camera.lookAt(focus.x + shoulder.x * 0.5, focus.y - 0.1, focus.z + shoulder.z * 0.5);
}
const _shoulder = new THREE.Vector3();
const _camWant = new THREE.Vector3();   // _want is photo mode's, below
const _cdir = new THREE.Vector3();

// (The camera's collision-target DI hook died with the mesh raycast — the
// grid's raySegment answers from collider entries, no entity list needed.)

// ---- photo mode -------------------------------------------------------------
// Screenshot key, UI hide and free camera: the human-facing version of the agents' retina path.

// Exponential-half-life damping: frame-rate independent, and no overshoot after a long frame (unlike a spring).
const MOVE_TAU = 0.22;   // dolly weight: pushes off, glides to a stop
const LOOK_TAU = 0.09;   // pans settle instead of snapping; short enough to not feel laggy
const FOV_TAU = 0.16;    // the lens breathes
// Alt = fine adjust: a slower dolly and heavier look damping; the mouse still commands the same angle.
const LOOK_TAU_FINE = 0.5;
const FINE_MPS = 2.5;    // absolute, not a fraction — "creep at 2.5 m/s"
const damp = (cur, target, tau, dt) => target + (cur - target) * Math.exp(-dt / tau);
/** Same, over the shortest arc — so a pan across ±π doesn't unwind the long way. */
function dampAngle(cur, target, tau, dt) {
  let d = (target - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-dt / tau));
}

const photo = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, fov: 55, speed: 6,
};
const _f = new THREE.Vector3(), _right = new THREE.Vector3(), _want = new THREE.Vector3();
export function togglePhotoMode() {
  photoMode = !photoMode;
  if (photoMode) {
    photo.pos.copy(camera.position);
    photo.yaw = camYaw; photo.pitch = camPitch;
    photo.vel.set(0, 0, 0);          // enter at rest — no inherited drift
    photo.fov = camera.fov;
    flashHint(html`photo mode — <kbd>WASD</kbd>+<kbd>QE</kbd> fly · <kbd>[</kbd><kbd>]</kbd> lens · <kbd>F1</kbd> hide UI · <kbd>F2</kbd> save · <kbd>P</kbd> exit`, 6000);
  } else {
    camera.fov = 55; camera.updateProjectionMatrix();
    document.body.classList.remove('photo');
  }
  return photoMode;
}
function updatePhotoCamera(dt) {
  if (dragging) { /* handled by the shared mousemove */ }
  // The mouse sets a target the camera chases; fly keys steer by the damped look, so movement never fights the settle.
  const fine = keys.has('AltLeft');
  const lookTau = fine ? LOOK_TAU_FINE : LOOK_TAU;
  photo.yaw = dampAngle(photo.yaw, camYaw, lookTau, dt);
  photo.pitch = damp(photo.pitch, camPitch, lookTau, dt);
  _f.set(-Math.sin(photo.yaw) * Math.cos(photo.pitch), -Math.sin(photo.pitch),
    -Math.cos(photo.yaw) * Math.cos(photo.pitch));
  _right.crossVectors(_f, UP).normalize();

  const boost = (keys.has('ShiftLeft') ? 3.5 : 1) * (fine ? FINE_MPS / photo.speed : 1);
  _want.set(0, 0, 0);
  if (held(MOVE_KEYS.fwd)) _want.add(_f);
  if (held(MOVE_KEYS.back)) _want.sub(_f);
  if (held(MOVE_KEYS.right)) _want.add(_right);
  if (held(MOVE_KEYS.left)) _want.sub(_right);
  if (keys.has('KeyE')) _want.y += 1;
  if (keys.has('KeyQ')) _want.y -= 1;
  // diagonals used to travel ~1.4× faster than the cardinals
  if (_want.lengthSq() > 1) _want.normalize();
  _want.multiplyScalar(photo.speed * boost);

  // Velocity chases the intent, so a keypress accelerates and a release coasts.
  const k = 1 - Math.exp(-dt / MOVE_TAU);
  photo.vel.addScaledVector(_want.sub(photo.vel), k);
  photo.pos.addScaledVector(photo.vel, dt);

  if (keys.has('BracketLeft')) photo.fov = Math.max(12, photo.fov - 30 * dt);
  if (keys.has('BracketRight')) photo.fov = Math.min(95, photo.fov + 30 * dt);
  const fov = damp(camera.fov, photo.fov, FOV_TAU, dt);
  if (Math.abs(fov - camera.fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }

  camera.position.copy(photo.pos);
  camera.lookAt(_f.add(photo.pos));   // _f is spent here — recomputed next frame
}

/** Spectator/retina camera: first person from a followed body's live head bone (as the snap `first` view, #75),
 *  with that body hidden. */
const _specHead = new THREE.Vector3();
const _specBox = new THREE.Box3();
export function updateSpectator(dt, remote) {
  if (!remote?.avatar) return;
  const root = remote.avatar.root;
  const head = remote.avatar.headWorldPosition(_specHead);
  const box = head ? null : remote.avatar.visualBounds(_specBox);
  let anchor;
  try {
    anchor = resolveFirstPersonAnchor({
      head: head ? [head.x, head.y, head.z] : null,
      bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
      name: remote.id,
    });
  } catch {
    return;   // rig offers no anchor (still materializing) — hold the frame
  }
  root.visible = false;
  _facing.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
  const eye = new THREE.Vector3(...anchor.eye).addScaledVector(_facing, FP_FORWARD);
  camera.position.lerp(eye, 1 - Math.exp(-20 * dt));
  camera.lookAt(eye.clone().addScaledVector(_facing, FP_GAZE_AHEAD).add(new THREE.Vector3(0, -FP_GAZE_DROP, 0)));
}

export function setCamYaw(v) { camYaw = Math.atan2(Math.sin(v), Math.cos(v)); }   // wrapped: the body's yaw must never carry a full turn (XR pop, 09-05)
export function setPosture(p) { posture = p; }
// the action bar's posture tiles (actionbar.js): sit runs the same seat search as X, stand leaves seat and posture.
// A declared-seat MOUNT (sockets, localbody.js) is neither posture nor myState.seat — the seat hook dismounts on X —
// so the tiles ask first: sitting on a swing, 'sit' is a no-op and 'stand' is the dismount
let mountedHook = () => false;
export function setMountedHook(fn) { if (typeof fn === 'function') mountedHook = fn; }
export function sitHere() { if (mountedHook()) return; if (posture !== 'sit') toggleSit(); }
export function standUp() {
  if (mountedHook()) { occupyHook(); return; }
  if (posture === 'sit' || posture === 'lie') { posture = null; myState.seat = null; }
}
export const getPosture = () => posture;
