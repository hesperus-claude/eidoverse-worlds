// bodydrag — grabbing a limp body and dragging it: a TAKEOVER, like a seat, with a sim attached.
//   * The DRAGGER sims its copy of the target's rig, grabbed joint pinned to the cursor ray, and streams pose + root
//     to the OWNER (targeted `bodydrag`, presence, never logged), who REBROADCASTS it: one source of truth.
//   * Consent is the owner's, always: the grab is a request, a movement key revokes, and 1.2 s of dragger silence
//     auto-resumes; a crashed dragger never leaves a body possessed.
//   * On release the owner settles from where it was left. Agents only accept and rebroadcast, so they drag too.
//   See docs/research/ragdoll-sync.md.

import { THREE, camera, canvas, scene } from './core.js';
import { bus } from './base.js';
import { remotes, draggedLocal } from './remotes.js';
import { JOINTS } from './ragdoll.js';
import { makeRagdoll } from './bodysim.js';
import { sendBodyDrag } from './net.js';
import { flashHint, toast } from './ui.js';
import { isEditing } from './build.js';

const GRAB_RANGE = 5;        // how far a body may be from ME to grab (m)
const STREAM_MS = 66;        // sim → owner cadence, matches presence
const SILENCE_MS = 1200;     // owner resumes itself after this much quiet

let hooks = null;            // main.js: my own body's state and effects
export function initBodyDrag(h) { hooks = h; }

// ---------------------------------------------------------------- dragger

let drag = null;             // { id, rd, joint, depth, sentAt }
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _pt = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function grabbables() {
  const out = [];
  for (const r of remotes.values()) {
    if (r.avatar && r.lastClip === 'ragdoll') out.push(r);
  }
  return out;
}

// Pick against JOINT positions: a SkinnedMesh raycast tests the bind pose, and a grabbable body is lying elsewhere.
const PICK_R = 0.3;           // how close the ray must pass to a joint (m)

function pickBody(ndc) {
  _ray.setFromCamera(ndc, camera);
  let best = null;            // frontmost body along the ray
  for (const r of grabbables()) {
    const h = r.avatar.vrm.humanoid;
    for (const j of JOINTS) {
      const node = h?.getNormalizedBoneNode?.(j);
      if (!node) continue;
      node.getWorldPosition(_tmp);
      const offRay = _ray.ray.distanceToPoint(_tmp);
      if (offRay > PICK_R) continue;
      const along = _tmp.sub(_ray.ray.origin).dot(_ray.ray.direction);
      if (along <= 0) continue;
      // frontmost body wins; within a body, the joint the cursor is ON wins
      if (!best || along < best.along - 0.4 || (r === best.r && offRay < best.offRay)) {
        best = { r, joint: j, along, offRay };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- pins
// P while dragging nails the held joint; the OWNER enforces it, and a movement key pulls every nail

const markers = new Map();          // "bodyId:joint" -> mesh
let _markerGeo = null, _markerMat = null;
function syncMarkers(wanted) {
  if (!_markerGeo) {
    _markerGeo = new THREE.SphereGeometry(0.055, 12, 10);
    _markerMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
  }
  for (const [key, at] of wanted) {
    let m = markers.get(key);
    if (!m) {
      m = new THREE.Mesh(_markerGeo, _markerMat);
      m.renderOrder = 2;
      m.userData.isBody = true;      // the sky's scene-diff must not claim a nail
      markers.set(key, m);
      scene.add(m);
    }
    m.position.set(at[0], at[1], at[2]);
  }
  for (const [key, m] of markers) if (!wanted.has(key)) { scene.remove(m); markers.delete(key); }
}

function pickMarker() {
  let best = null;
  for (const [key, m] of markers) {
    const d = _ray.ray.distanceToPoint(m.position);
    if (d < 0.13 && (!best || d < best.d)) best = { key, d };
  }
  return best;
}

function pinCurrent() {
  if (!drag) return;
  const r = remotes.get(drag.id);
  // where the joint IS, not the cursor: keeps the nail on the limb if the two ever disagree
  const t = drag.rd.p?.[drag.joint] ?? drag.rd.pins?.get(drag.joint);
  if (!t) return;
  sendBodyDrag(drag.id, {
    end: true,
    pinAt: { joint: drag.joint, at: [t.x, t.y, t.z] },
    ...(drag.rd.pose ? { pose: drag.rd.pose } : {}),
    // a nail is a handover too: the owner continues this sim rather than guess it from the bones
    sim: drag.rd.snapshot(),
    ...(r?.avatar ? {
      p: r.avatar.root.position.toArray(),
      yaw: r.avatar.root.rotation.y,
    } : {}),
  });
  drag.rd.setPin(null);
  drag.rd.dispose?.();
  draggedLocal.delete(drag.id);
  flashHint(`${drag.joint} nailed in place — click the pin to pull it`);
  drag = null;
}

addEventListener('keydown', (e) => {
  // photo mode owns P everywhere else; while a body is in your hand, the nail wins
  if (e.code === 'KeyP' && drag) { e.stopImmediatePropagation(); pinCurrent(); }
}, true);

function beginGrab(e) {
  if (e.button !== 0 || isEditing() || drag || !hooks) return;
  _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  // a pin marker outranks the body behind it: clicking a nail pulls it
  const mk = pickMarker();
  if (mk) {
    const [id, joint] = mk.key.split(':');
    if (id === 'me') hooks.removePin(joint);
    else sendBodyDrag(id, { unpin: { joint } });
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  const hit = pickBody(_ndc);
  if (!hit) return;
  const { r: hitR, joint } = hit;
  // an arm's-length act: the BODY must be near me, however far the camera sits
  const me = hooks.myPos();
  if (me && hitR.avatar.root.position.distanceTo(me) > GRAB_RANGE) {
    flashHint(`${hitR.id} is too far away to grab`);
    return;
  }

  hitR.avatar.root.updateMatrixWorld(true);
  const rd = makeRagdoll(hitR.avatar, null, hitR.avatar.restBonePositions());
  // keep the joint-to-ray offset (up to PICK_R): snapping would jump the limb
  const jn = hitR.avatar.vrm.humanoid?.getNormalizedBoneNode?.(joint);
  const off = new THREE.Vector3();
  if (jn) {
    off.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, hit.along);
    off.subVectors(jn.getWorldPosition(_tmp), off);
  }
  drag = { id: hitR.id, rd, joint, depth: hit.along, off, sentAt: 0 };
  draggedLocal.add(hitR.id);
  sendBodyDrag(hitR.id, { grab: { joint } });
  flashHint(`dragging ${hitR.id} by the ${joint} — release to drop · P to nail it here`);
  // the grab owns this press: neither the camera orbit nor build may see it
  e.stopImmediatePropagation();
  e.preventDefault();
}

function endGrab() {
  if (!drag) return;
  const r = remotes.get(drag.id);
  drag.rd.setPin(null);
  sendBodyDrag(drag.id, {
    end: true,
    ...(drag.rd.pose ? { pose: drag.rd.pose } : {}),
    // the handover: every joint's place and speed, so the owner CONTINUES this sim
    sim: drag.rd.snapshot(),
    ...(r?.avatar ? {
      p: r.avatar.root.position.toArray(),
      yaw: r.avatar.root.rotation.y,
    } : {}),
  });
  drag.rd.dispose?.();
  draggedLocal.delete(drag.id);
  drag = null;
}

/** The dragged person left (#95): release quietly BEFORE the avatar is disposed, or the VRM is double-disposed ('participant-teardown' comes first). */
bus.on('participant-teardown', (id) => {
  if (drag?.id === id) {
    drag.rd.setPin(null);
    drag.rd.dispose?.();
    drag = null;
  }
  draggedLocal.delete(id);
});

// capture phase: this listener decides FIRST whether the press is a grab
canvas.addEventListener('mousedown', beginGrab, true);
addEventListener('mouseup', endGrab);
addEventListener('mousemove', (e) => {
  if (drag) _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});
// depth on the wheel: reel the body toward you or push it away
canvas.addEventListener('wheel', (e) => {
  if (drag) { drag.depth = THREE.MathUtils.clamp(drag.depth - e.deltaY * 0.01, 1, 30); e.stopImmediatePropagation(); }
}, true);

// ---------------------------------------------------------------- dragged

let draggedBy = null;        // who currently drives MY body
let lastSampleAt = 0;

/** main.js consults it. */
export function beingDragged() { return draggedBy != null; }

/** Movement key or getUp. */
export function revokeDragged() {
  if (!draggedBy) return;
  sendBodyDrag(draggedBy, { end: true });
  draggedBy = null;
}

bus.on('bodydrag', (msg) => {
  if (!hooks) return;
  const { by } = msg;
  if (msg.grab != null) {
    console.debug('[bodydrag] grab from', by,
      { pushable: hooks.pushable(), downed: hooks.isDowned(), draggedBy });
    // consent was the authority's (server/messages.ts bodydrag: a grab is refused there unless displace allows it)
    if (!hooks.isDowned()) { sendBodyDrag(by, { end: true }); return; }     // only limp bodies drag
    if (draggedBy && draggedBy !== by) { sendBodyDrag(by, { end: true }); return; }  // first grab wins
    draggedBy = by;
    lastSampleAt = performance.now();
    hooks.beginDragged(by);
    // grabbing a nailed joint takes it back; the OTHER nails stay mine and the takeover sim must know them
    if (msg.grab.joint) hooks.removePin?.(String(msg.grab.joint));
    const pins = hooks.getPins?.() ?? [];
    if (pins.length) sendBodyDrag(by, { pins });
    return;
  }
  if (msg.unpin != null) {
    // someone pulls one of my nails — the authority already held it to the same consent as a grab
    hooks.removePin?.(String(msg.unpin.joint ?? ''));
    return;
  }
  if (Array.isArray(msg.pins)) {
    // the owner's other nails, sent on accept: my takeover sim keeps enforcing them
    if (drag && drag.id === by) {
      for (const p of msg.pins) {
        if (p?.j && Array.isArray(p.at) && p.at.length === 3) {
          drag.rd.setPin(String(p.j), _tmp.set(p.at[0], p.at[1], p.at[2]), true);  // a NAIL, held firm
        }
      }
    }
    return;
  }
  if (msg.end != null) {
    // my dragger let go: resume myself; a nail it carries is MY sim's to enforce from here
    if (draggedBy === by) {
      draggedBy = null;
      if (msg.pinAt?.joint && Array.isArray(msg.pinAt.at)) hooks.addPin?.(String(msg.pinAt.joint), msg.pinAt.at);
      hooks.endDragged(msg);
    }
    else if (drag && drag.id === by) {
      // I was the dragger and the OWNER revoked (broke free, or refused)
      drag.rd.setPin(null);
      drag.rd.dispose?.();
      draggedLocal.delete(drag.id);
      drag = null;
      flashHint(`${by} broke free`);
    }
    return;
  }
  if (draggedBy === by && msg.pose) {
    lastSampleAt = performance.now();
    hooks.applyDragged(msg);
  }
});

// ---------------------------------------------------------------- tick

/** The takeover sim (not main.js's Ragdoll), for the debug panel. */
export function dragSim() { return drag?.rd ?? null; }

export function dragState() {
  return { dragging: drag ? { id: drag.id, joint: drag.joint, depth: +drag.depth.toFixed(2) } : null, draggedBy };
}

export function updateBodyDrag(dt, now = performance.now()) {
  // dragger: advance the takeover sim, pin to the cursor ray, stream
  if (drag) {
    const r = remotes.get(drag.id);
    if (!r?.avatar) { endGrab(); return; }       // they left mid-drag
    // Self-heal: an owner streaming any non-ragdoll clip took themselves back, revoke or no; their stream outranks our sim.
    const newest = r.buf[r.buf.length - 1];
    if (newest?.clip && newest.clip !== 'ragdoll') {
      drag.rd.setPin(null);
      drag.rd.dispose?.();
      draggedLocal.delete(drag.id);
      flashHint(`${drag.id} broke free`);
      drag = null;
      return;
    }
    _ray.setFromCamera(_ndc, camera);
    _pt.copy(_ray.ray.direction).multiplyScalar(drag.depth).add(_ray.ray.origin).add(drag.off);
    drag.rd.setPin(drag.joint, _pt);
    drag.rd.step(dt);                            // drives the remote avatar directly
    if (now - drag.sentAt >= STREAM_MS && drag.rd.pose) {
      drag.sentAt = now;
      sendBodyDrag(drag.id, {
        pose: drag.rd.pose,
        p: r.avatar.root.position.toArray(),
        yaw: r.avatar.root.rotation.y,
      });
    }
  }
  // dragged: a silent dragger loses the body — nobody stays possessed
  if (draggedBy && now - lastSampleAt > SILENCE_MS) {
    draggedBy = null;
    hooks?.endDragged({});
  }

  // nails, drawn where presence says; mine from my own state
  const wanted = new Map();
  for (const r of remotes.values()) {
    const pins = r.buf?.[r.buf.length - 1]?.pins;
    if (Array.isArray(pins)) {
      for (const p of pins) {
        if (p?.j && Array.isArray(p.at) && p.at.length === 3) wanted.set(`${r.id}:${p.j}`, p.at);
      }
    }
  }
  for (const p of hooks?.getPins?.() ?? []) wanted.set(`me:${p.j}`, p.at);
  syncMarkers(wanted);
}
