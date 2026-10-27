// localbody — my body in the world's physics: ragdoll, seats, being dragged, pins, shoves (§14 6c).
// MY client owns MY body: everything that happens to it is applied HERE and rebroadcast through ordinary presence,
// so nobody else ever simulates me.
// logChat is injected by initLocalBody: importing chat.js would add an edge to the net→world knot (§14.2).

import { bodyOf } from '../../shared/components.js';
import { mayLeave, vacatedFromMine, vacatedAt, OCCUPY_REACH, ESCAPE_HOLD_S, ESCAPE_REPEAT_S } from '../../shared/sockbody.js';
import { driveOccupied, releaseOccupied } from './occupybody.js';
import { serverNow } from './remotes.js';
import { sendRequest, identities } from './net.js';
import { plain, called, typeable } from './plainwords.js';
import { usePromptHint } from './useprompt.js';
import { handsHint, physicsApi as _phys } from './thingphysics.js';
const myHoldsNow = () => _phys.mine().length > 0;
import { THREE } from './core.js';
import { CONFIG, bus } from './base.js';
import { mergePose } from '../../shared/humanoid.js';
import {
  myState, updateFollowCamera, setPosture, keys, setOccupyHook, setMountedHook, camYaw, camPitch, setCamYaw, xrIntent,
} from './controller.js';
import { camera } from './core.js';
import { avatarMounts, mountTransform, bags, bagOf, socketWorldPos, setBodySeat, entities, seatSocket, socketsOn, parentIdOf } from './world.js';
import { outOfMyView } from './myview.js';
import { sendAnim } from './net.js';
import { makeRagdoll } from './bodysim.js';
import { jointPositions } from './ragdoll.js';
import { initBodyDrag, beingDragged, revokeDragged } from './bodydrag.js';
import { toast, flashHint, setAmbientHint, html } from './ui.js';
import { pushable, bodyTable, onConsentChange } from './consent.js';
import { makeConsentSync } from './consentsync.js';
import { bodyActAsPuppet } from './consentinbox.js';
import { clearMyReach } from './reachnet.js';
import { getMe } from './mybody.js';

let logChat = () => {};

// the settled bones stay as a held pose, so a late joiner gets the result, not a replay of the flop
let ragdoll = null;
let downed = false;

export function isDowned() { return downed; }
export function activeRagdoll() { return ragdoll; }

// fall the way you faced, harder the faster you moved: dropped straight down, the knees kick back out of their stops
const _fall = new THREE.Vector3();
function toppleVelocity() {
  return _fall.set(Math.sin(myState.yaw), 0, Math.cos(myState.yaw))
    .multiplyScalar(0.9 + Math.min(1.2, (myState.speed ?? 0) * 0.35));
}

export function goLimp(lean = null) {
  const me = getMe();
  if (!me || downed) return;
  downed = true;
  // park the undriven bones and stop the clip BEFORE the sim: it reads both rest and live skeletons here
  me.setLimp(true);
  clearMyReach();   // descriptor AND arm (mirrors mcpl/agent.ts knockDown)
  ragdoll = makeRagdoll(me, lean ?? toppleVelocity(), me.restBonePositions());
  myState.clip = 'ragdoll';
  flashHint('limp — move to get up');
}
export function getUp() {
  if (!downed) return;
  const me = getMe();
  revokeDragged();                 // I take myself back from a dragger
  clearPins();                     // standing up tears every nail out
  downed = false; ragdoll?.dispose?.(); ragdoll = null;
  myState.pose = null; me?.clearPose();
  me?.setLimp(false);
  myState.clip = 'idle';
  myState.pos.copy(me.root.position);
  myState.pos.y = 0;
}
// ---------------------------------------------------------------- mounted
// seated, my body derives from the parent's live transform + socket (occupybody.js, as remotes do)
// getting off is the socket's to allow (shared/sockbody.js mayLeave) and emits no verb: the next frame carries no seat
const _seatP = new THREE.Vector3();
let leaving = null;            // {from, to, yaw, clip, t0, dur}: carried off the seat while a leave clip plays
export const seatLeaving = () => !!leaving;
/** shared/sockbody.js bodyOf, or null when not seated. */
export function occupiedBody() {
  const m = avatarMounts.get(CONFIG.name);
  return m ? bodyOf(seatSocket(m.to)?.station) : null;
}
// the escape: no seat can hold you. Get-up pressed again within ESCAPE_REPEAT_S of a refusal, or X held for
// ESCAPE_HOLD_S, always gets you up.
let escapeArmedAt = -Infinity, escapeHeld = 0, escapeTile = false;
bus.on('escape-hold', (on) => { escapeTile = !!on; });   // the stand tile held (actionbar.js) counts as X held
/** Off my seat, if the socket allows this kind ('move' | 'jump' | 'menu' | 'script' | 'escape'); true when off or leaving.
 *  `at`: the authority's `vacated.at` [x, y, z]; I stand there, so my body and its track start together. */
export function dismountMe(kind = 'menu', at = null) {
  const m = avatarMounts.get(CONFIG.name);
  if (!m) return false;
  const body = occupiedBody();
  if (kind === 'menu' && !mayLeave(body, kind) && body?.leaveBy === 'script' && performance.now() - escapeArmedAt < ESCAPE_REPEAT_S * 1000) kind = 'escape';
  if (!mayLeave(body, kind)) {
    if (body?.leaveBy === 'script' && kind === 'menu') escapeArmedAt = performance.now();
    flashHint(body?.leaveBy === 'script' ? html`this seat lets you go when the world does — <kbd>X</kbd> again (or hold it) to get up anyway` : body?.leaveBy === 'jump' ? html`<kbd>Space</kbd> or <kbd>X</kbd> to get off` : html`<kbd>X</kbd> to get off`);
    return false;
  }
  escapeArmedAt = -Infinity; escapeHeld = 0;
  const me = getMe();
  const sw = mountTransform(CONFIG.name, _seatP, { av: me });
  const yaw = sw?.yaw ?? myState.yaw;
  const off = sw ? _seatP.clone() : myState.pos.clone();
  let exitYaw = yaw;
  // the socket's own exit, where it names one (off a horse to the side, out of a car door)
  const ex = body?.exit;
  const host = seatSocket(m.to)?.host;
  if (ex && host != null && entities.get(host)) {
    const obj = entities.get(host); obj.updateWorldMatrix(true, false);
    off.set(ex[0], ex[1], ex[2]).applyMatrix4(obj.matrixWorld);
    if (ex.length === 4) { const f = new THREE.Vector3(Math.sin(ex[3]), 0, Math.cos(ex[3])).transformDirection(obj.matrixWorld); exitYaw = Math.atan2(f.x, f.z); }
  } else { off.x += Math.sin(yaw) * 0.7; off.z += Math.cos(yaw) * 0.7; }
  if (at) off.set(at[0], at[1], at[2]);
  sitTicket++;                           // an earlier sit's answer is stale now
  setBodySeat(CONFIG.name, null);        // my next frame carries no seat
  const from = me ? me.root.position.clone() : off.clone();
  const leaveClip = me ? body?.leave ?? null : null;
  releaseOccupied(me);
  if (leaveClip && me) {
    // the leave clip's time is locked to the carry
    const a = me.ensureClip(leaveClip);
    leaving = { from, to: new THREE.Vector3(off.x, off.y, off.z), yaw: exitYaw, clip: leaveClip, t0: performance.now(), dur: a ? a.getClip().duration : 1.2 };
    myState.clip = leaveClip;
  } else {
    me?.root.rotation.set(0, exitYaw, 0);  // a rocket seat may have had me on my back
    myState.pos.set(off.x, off.y, off.z); myState.yaw = exitYaw;   // at the release height: a seat upstairs stands me upstairs
    setPosture('stand');
  }
  return true;
}
function stepLeaving(dt) {
  const me = getMe();
  const u = Math.min(1, (performance.now() - leaving.t0) / 1000 / leaving.dur);
  const k = u * u * (3 - 2 * u);
  myState.pos.copy(leaving.from).lerp(leaving.to, k);
  myState.yaw = leaving.yaw; myState.speed = 0; myState.clip = leaving.clip;
  myState.q = undefined; myState.locomotion = undefined;
  if (me) {
    me.root.position.copy(myState.pos);
    me.locomotion = null;
    me.root.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), leaving.yaw), Math.min(1, 10 * dt));
    me.setSeatBlend([[leaving.clip, 1]], u);
    updateFollowCamera(dt, me);
  }
  if (u >= 1) {
    me?.setSeatBlend(null); me?.root.rotation.set(0, leaving.yaw, 0);
    myState.pos.copy(leaving.to); myState.clip = 'idle'; leaving = null;   // its height kept, never reset to 0
    setPosture('stand');
  }
}

const MOVE = { fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };
const held = (l) => l.some((k) => keys.has(k));
const _camUp = new THREE.Vector3(), _camQ = new THREE.Quaternion(), _camO = new THREE.Vector3(), _camD = new THREE.Vector3();
let lastSeat = null;
export function updateMountedMe(dt) {
  if (leaving) { stepLeaving(dt); return; }
  const me = getMe();
  const m = avatarMounts.get(CONFIG.name);
  if (!m || !me) return;
  const body = occupiedBody();
  if (!body) {   // the socket went away under me: that is how a script lets go
    dismountMe('script');
    return;
  }
  // routed input is published as signals on my seat frame (net.js), never as physics here
  const seatYaw = lastSeat?.yaw ?? myState.yaw;
  const inp = {};
  if (body.input.move !== 'none') {
    inp.throttle = Math.max(-1, Math.min(1, (held(MOVE.fwd) ? 1 : 0) - (held(MOVE.back) ? 1 : 0) + (xrIntent.active ? xrIntent.fwd : 0)));
    inp.steer = Math.max(-1, Math.min(1, (held(MOVE.right) ? 1 : 0) - (held(MOVE.left) ? 1 : 0) + (xrIntent.active ? xrIntent.strafe : 0)));
  }
  if (body.input.look !== 'locked') {   // the camera looks back along camYaw
    inp.aimYaw = Math.atan2(Math.sin(camYaw + Math.PI - seatYaw), Math.cos(camYaw + Math.PI - seatYaw));
    inp.aimPitch = Math.max(-1.5, Math.min(1.5, -(camPitch - 0.32)));
  }
  m.in = inp;
  me.pitch = 0;   // the seat turns the head (setSeatLook)
  const r = driveOccupied(me, CONFIG.name, { dt, nowMs: serverNow(), local: true });
  if (!r) { updateFollowCamera(dt, me); return; }   // parent still downloading
  lastSeat = r;
  myState.pos.copy(r.pos);
  myState.yaw = r.yaw;
  myState.speed = 0;
  myState.clip = r.clip;
  me.root.position.copy(r.pos);
  me.root.quaternion.copy(r.q);   // the socket's whole rotation
  if (body.input.look === 'locked') setCamYaw(r.yaw + Math.PI);
  // updateMe (the camera's owner) is skipped while seated: drive it here or it freezes (#75)
  updateFollowCamera(dt, me);
  // look.up 'socket' rolls with the thing; 'world' keeps the horizon level
  if (body.look.up === 'socket') {
    _camQ.fromArray(r.sw.socketQ); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(_camQ);
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.x, f.z)).invert().premultiply(_camQ);   // the socket's rotation without its heading
    const pivot = me.headWorldPosition(new THREE.Vector3()) ?? r.pos;
    camera.getWorldDirection(_camD);
    _camO.copy(camera.position).sub(pivot).applyQuaternion(tilt);
    camera.position.copy(pivot).add(_camO);
    camera.up.copy(_camUp.set(0, 1, 0).applyQuaternion(tilt));
    camera.lookAt(_camO.copy(camera.position).add(_camD.applyQuaternion(tilt)));
  } else camera.up.set(0, 1, 0);
  // movement keys leave only when the seat doesn't take them
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => keys.has(k)) && body.input.move === 'none') { if (mayLeave(body, 'move')) { camera.up.set(0, 1, 0); dismountMe('move'); } }
  else if (keys.has('Space') || (xrIntent.active && xrIntent.jump)) { if (mayLeave(body, 'jump')) { camera.up.set(0, 1, 0); dismountMe('jump'); } }
  if ((keys.has('KeyX') || escapeTile) && !mayLeave(body, 'menu')) { escapeHeld += dt; if (escapeHeld >= ESCAPE_HOLD_S) { camera.up.set(0, 1, 0); dismountMe('escape'); } }
  else escapeHeld = 0;
}

/** By the SOCKET's world point, not the entity origin; every slot competes. `arg` narrows by case-insensitive id
 *  prefix. Occupied seats and my own don't count. */
const _sitV = new THREE.Vector3();
// a plain X offers only seats within climbing reach (ground distance alone lifted a body to a seat 3 m up); /sit
// <name> reaches any. One source with the authority's check: shared/sockbody.js OCCUPY_REACH.
const SEAT_RISE = { up: OCCUPY_REACH.up, down: OCCUPY_REACH.down };
function nearestSeat(arg, reach) {
  const want = arg ? String(arg).toLowerCase() : null;
  const mine = avatarMounts.get(CONFIG.name);
  const taken = new Set([...avatarMounts].filter(([id]) => id !== CONFIG.name).map(([, o]) => o.to));
  let best = null, bestD = reach;
  // a seat is a socket with a body block; its host is what you name and see
  for (const [sid, c] of bags()) {
    if (!c?.socket || typeof c.socket !== 'object' || c.disabled === true) continue;
    const body = bodyOf(c.station);
    if (!body) continue;   // an attachment point, not a seat
    const id = parentIdOf(sid);
    if (id == null) continue;
    if (want && !id.toLowerCase().startsWith(want) && !sid.toLowerCase().startsWith(want)) continue;
    if (!want && entities.get(id) && outOfMyView(entities.get(id))) continue;   // a hidden seat isn't offered; naming it still sits
    if (mine && mine.to === sid) continue;
    if (taken.has(sid)) continue;
    const p = socketWorldPos(sid, _sitV);
    if (!p) continue;
    const d = Math.hypot(p.x - myState.pos.x, p.z - myState.pos.z);
    if (!want && (p.y - myState.pos.y > SEAT_RISE.up || myState.pos.y - p.y > SEAT_RISE.down)) continue;
    if (d < bestD) { bestD = d; best = { id, sock: sid, slot: c.socket.name, d, body }; }
  }
  return best;
}

/** With a seat only further out, say so rather than ground-sit silently. The authority is asked first (`use`, not
 *  logged); already seated, I may move straight to a socket that allows fromSeat. */
let sitTicket = 0;   // getting up or asking again makes every earlier answer stale
export function trySitOn(arg, slot = null) {
  const mine = avatarMounts.get(CONFIG.name);
  const best = nearestSeat(arg, arg ? Infinity : OCCUPY_REACH.r);
  if (best && slot && best.slot !== slot) { const o = socketsOn(best.id).find((x) => x.name === slot); const b = bodyOf(o?.station); if (b) Object.assign(best, { sock: o.id, slot, body: b }); }
  if (!best) {
    const far = arg ? null : nearestSeat(null, 30);
    if (far) logChat('*', `nearest seat is on ${called(far.id)} (${far.slot}), ${far.d.toFixed(0)}m away — get closer, or /sit ${typeable(far.id)}`);
    return false;
  }
  if (mine && !best.body.fromSeat) { logChat('*', `get up first — ${called(best.id)} (${best.slot}) doesn't take you straight from another seat`); return true; }
  const ticket = ++sitTicket;
  const take = () => {
    // a late answer must never put me back on a seat I already left
    if (ticket !== sitTicket || avatarMounts.get(CONFIG.name) !== mine) return;
    if (mine) releaseOccupied(getMe());
    setBodySeat(CONFIG.name, { to: best.sock });   // my frames carry the socket's id
    const lb = best.body.leaveBy;
    logChat('*', `you ${best.body.action} on ${called(best.id)} (${best.slot}) — ${lb === 'script' ? 'it lets you go when the world does (hold X to get up anyway)' : lb === 'menu' ? 'X to get up' : lb === 'jump' ? 'Space or X to get up' : 'X or move to get off'}`);
  };
  sendRequest('use', { id: best.sock, action: best.body.action }).then((r) => {
    if (r?.ok) take(); else logChat('*', plain(`${best.body.action} on ${best.id}`, r));
  });
  return true;
}

// camera free in edit mode: the body holds a working pose so people nearby see I've stepped out; it doesn't restore a
// prior pose
const WORKING_POSE = { leftUpperArm: [0.0772, -0.5863, -0.1053, 0.7995], rightUpperArm: [0.0772, 0.5863, 0.1053, 0.7995], leftLowerArm: [0, -0.3007, 0, 0.9537], rightLowerArm: [0, 0.3007, 0, 0.9537],
  leftHand: [0, 0, 0.6428, 0.766], rightHand: [0, 0, -0.6428, 0.766], head: [0.0872, 0, 0, 0.9962] };
let working = false;
bus.on('edit-freecam', (on) => {
  const me = getMe(); if (!me) return;
  if (on && !working) { working = true; me.setPose(WORKING_POSE); myState.pose = WORKING_POSE; }
  else if (!on && working) { working = false; if (myState.pose === WORKING_POSE) { myState.pose = null; me.clearPose(); } }
});

// a seat in reach says so in the hint bar (~2×/s): an undiscoverable affordance doesn't exist
let _hintAcc = 0;
// builder mode's keys differ (build.js: X deletes): play offers there would advertise a delete key as a seat
let _building = false;
bus.on('edit-mode', (on) => { _building = !!on; _hintAcc = 1; });
export function updateSeatHint(dt) {
  _hintAcc += dt;
  if (_hintAcc < 0.45) return;
  _hintAcc = 0;
  if (CONFIG.renderer || CONFIG.spectate) return;
  if (_building) { setAmbientHint(null); return; }
  let hint = null;
  if (avatarMounts.has(CONFIG.name)) { const b = occupiedBody();
    hint = !b || b.leaveBy === 'any' ? (b?.input.move !== 'none' && b ? html`<kbd>X</kbd> get up · <kbd>WASD</kbd> drive` : html`<kbd>X</kbd> get up · <kbd>WASD</kbd> hop off`)
      : b.leaveBy === 'script' ? html`this seat lets you go when the world does · hold <kbd>X</kbd> to get up anyway` : b.leaveBy === 'jump' ? html`<kbd>Space</kbd> or <kbd>X</kbd> get up` : html`<kbd>X</kbd> get up`; }
  else if (!downed && nearestSeat(null, OCCUPY_REACH.r)) hint = html`<kbd>X</kbd> — sit`;
  // what I hold and how to let go comes first (never a secret), else what's in reach
  if (!downed) { const hh = handsHint(); if (hh && (myHoldsNow() || !hint)) hint = hh; }
  if (!hint && !downed) hint = usePromptHint();   // E (useprompt.js)
  setAmbientHint(hint);
}

export function stepRagdoll(dt) {
  const me = getMe();
  if (ragdoll) {
    const pose = ragdoll.step(dt);
    if (pose) myState.pose = pose;
    myState.pos.copy(me.root.position);
    if (ragdoll.done) { myState.pose = ragdoll.finalPose; ragdoll = null; }
  }
  // updateMe is skipped while limp: drive the camera here or it freezes on the fall
  if (me) updateFollowCamera(dt, me);
}

// ---------------------------------------------------------------- dragged
// someone else's sim drives my limp body (bodydrag.js); my client still applies the stream and rebroadcasts it

function beginDraggedMode(by) {
  const me = getMe();
  if (!me) return;
  ragdoll?.dispose?.(); ragdoll = null;
  downed = true;
  me.setLimp(true);
  myState.clip = 'ragdoll';
  flashHint(`${by} grabs you — move to break free`);
}

function applyDraggedSample({ pose, p, yaw }) {
  const me = getMe();
  if (!me) return;
  if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) {
    me.root.position.set(p[0], p[1], p[2]);
    myState.pos.set(p[0], p[1], p[2]);
  }
  if (Number.isFinite(yaw)) { yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw)); me.root.rotation.y = yaw; myState.yaw = yaw; }
  if (pose && typeof pose === 'object') { me.setPose(pose); myState.pose = pose; }
  me.root.updateMatrixWorld(true);
  noteDraggedMotion();
  myState.clip = 'ragdoll';
  myState.speed = 0;
}

// velocity is only the difference between arriving frames: sampled so release keeps it
let dragSnap = null, dragVel = null;
function noteDraggedMotion() {
  const me = getMe();
  if (!me) return;
  const now = performance.now();
  const pos = jointPositions(me);
  if (dragSnap && now > dragSnap.t) {
    const dt = Math.min(0.5, (now - dragSnap.t) / 1000);
    dragVel ??= new Map();
    for (const [j, p] of pos) {
      const was = dragSnap.pos.get(j);
      if (was) dragVel.set(j, (dragVel.get(j) ?? new THREE.Vector3()).copy(p).sub(was).divideScalar(dt));
    }
  }
  dragSnap = { t: now, pos: new Map([...pos].map(([j, p]) => [j, p.clone()])) };
}

function endDraggedMode(msg) {
  const me = getMe();
  if (!me || !downed) return;
  // land on their final frame, then settle under MY OWN sim (dropped from a height, the body falls)
  if (msg?.pose || msg?.p) applyDraggedSample(msg);
  me.root.updateMatrixWorld(true);
  // the hand's own sim state outranks anything we sampled from its stream
  ragdoll = makeRagdoll(me, null, me.restBonePositions(), msg?.sim ?? dragVel);
  dragSnap = null; dragVel = null;
  applyMyPins();
  myState.clip = 'ragdoll';
}

// ---------------------------------------------------------------- pins
// pins (bodydrag.js): enforced by my sim, streamed in my presence; my movement key tears them out
// session-scoped on purpose: pins are presence, not history
const myPins = new Map();            // joint -> [x, y, z]
const _pinV = new THREE.Vector3();
const MAX_PINS = 8;

function syncPins() {
  myState.pins = myPins.size ? [...myPins].map(([j, at]) => ({ j, at })) : null;
}
function applyMyPins() {
  if (!ragdoll) return;
  // firm=true, as the dragger's sim, or physics depends on whose machine simulates
  for (const [j, at] of myPins) ragdoll.setPin(j, _pinV.set(at[0], at[1], at[2]), true);
}
function addPin(j, at) {
  if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) return;
  if (myPins.size >= MAX_PINS && !myPins.has(j)) return;
  myPins.set(j, at.map(Number));
  applyMyPins();
  syncPins();
}
function removePin(j) {
  if (!myPins.delete(j)) return;
  ragdoll?.setPin(j, null);
  syncPins();
  // freed of a nail while lying with no sim: wake mine so the body sags from what remains
  const me = getMe();
  if (downed && !ragdoll && me && !beingDragged()) {
    me.root.updateMatrixWorld(true);
    ragdoll = makeRagdoll(me, null, me.restBonePositions());
    applyMyPins();
    myState.clip = 'ragdoll';
  }
}
function clearPins() {
  if (!myPins.size) return;
  myPins.clear();
  ragdoll?.setPin(null);
  syncPins();
}

// ---------------------------------------------------------------- shove

// m/s, on any shove over the wire: nobody launches a body across the map whatever a message says
const MAX_PUSH = 6;
const _shove = new THREE.Vector3();

/** Every external force lands here: standing → a sim with this lean; mid-tumble → an impulse; down → a fresh sim. */
function applyShove(lean, by) {
  const me = getMe();
  if (!me) return;
  if (avatarMounts.has(CONFIG.name)) return;      // a seat holds you through a knock
  if (beingDragged()) return;                     // a held body answers to the hand
  if (lean && lean.lengthSq() > MAX_PUSH * MAX_PUSH) lean.setLength(MAX_PUSH);
  if (downed) {
    if (ragdoll) ragdoll.impulse(lean ?? toppleVelocity());
    else {
      // still limp: the new sim starts from the lying pose, limited by the neutral rest
      ragdoll = makeRagdoll(me, lean ?? toppleVelocity(), me.restBonePositions());
      applyMyPins();               // a nailed body swings
      myState.clip = 'ragdoll';
    }
  } else {
    goLimp(lean);
  }
  if (by) flashHint(`${by} knocked you over`);
}

// ---------------------------------------------------------------- wiring

export function initLocalBody({ logChat: logChatFn }) {
  logChat = logChatFn;

  // the whole consent table, every cell, on every arrival and change (consentsync.js); a refusal toasts and retries
  const consentSync = makeConsentSync({ table: bodyTable, send: sendRequest, toast, on: (ev, fn) => bus.on(ev, fn), enabled: () => !(CONFIG.renderer || CONFIG.spectate) });
  onConsentChange(consentSync.sync);

  // X: mounted → get up; a seat in reach → occupy it; else the controller's own layers (seat pans, ground sit)
  setMountedHook(() => avatarMounts.has(CONFIG.name));
  // sitting is consent, standing up the exit: an edit that moves my seat vacates me
  // (shared/protocol/authority/occupants.js vacatesFor)
  bus.on('body-inbox', (msg) => {
    // only from the seat I'm on now: a late message never stands me up from a seat taken since
    const u = Array.isArray(msg?.messages) ? msg.messages.find((m) => m?.type === 'vacated') : null;
    if (u && vacatedFromMine(u, avatarMounts.get(CONFIG.name)) && dismountMe('script', vacatedAt(u))) toast(`${typeof u.by === 'string' ? u.by : 'someone'} moved what you were occupying, so you stood up`, 'info', 5000);
    // an act I said yes to, delivered by the authority, applies as a puppet
    for (const m of Array.isArray(msg?.messages) ? msg.messages : []) {
      const p = bodyActAsPuppet(m); if (!p) continue;
      const by = typeof m.from === 'string' ? ([...identities].find(([, a]) => a === m.from)?.[0] ?? m.from) : 'someone';
      applyPuppet({ by, ...p });
    }
  });
  setOccupyHook(() => {
    if (avatarMounts.has(CONFIG.name)) { dismountMe('menu'); return true; }
    if (downed) return false;
    return trySitOn(null);
  });

  initBodyDrag({
    pushable: () => pushable(),
    isDowned: () => downed,
    myPos: () => myState.pos,
    beginDragged: beginDraggedMode,
    applyDragged: applyDraggedSample,
    endDragged: endDraggedMode,
    getPins: () => [...myPins].map(([j, at]) => ({ j, at })),
    addPin,
    removePin,
  });

  bus.on('puppet', applyPuppet);
}

function applyPuppet({ by, pose, merge, anim, ragdoll: rag }) {
  // the requester never simulates me: I do, and stream. The authority already decided (server/messages.ts bodyRefusal).
  if (rag) {
    // rag is true (undirected, old clients) or {lean:[x,y,z]} m/s
    const l = Array.isArray(rag?.lean) && rag.lean.length === 3 && rag.lean.every(Number.isFinite)
      ? _shove.set(rag.lean[0], rag.lean[1], rag.lean[2]) : null;
    applyShove(l, by);
    return;
  }
  // merge: only the bones they sent (null releases one); otherwise their pose replaces mine whole, and an EMPTY one is a release.
  if (pose) {
    myState.pose = merge ? mergePose(myState.pose, pose) : (Object.keys(pose).length ? pose : null);
    flashHint(myState.pose ? `${by} posed you` : `${by} released your pose`);
  }
  if (anim) {
    const data = { ...anim, replace: anim.replace !== false }; // legacy puppets replace
    if (data.replace) myState.pose = null;          // a replacing animation ends the held pose too
    getMe()?.playAnimation(data); sendAnim(data);
  }
}
