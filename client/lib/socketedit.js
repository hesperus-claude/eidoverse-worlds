// socketedit — the seat-anchor authoring grammar: gold gizmos, click select, drag, Q/E face, Del, one undoable entry per commit.
// build.js stays the gesture ROUTER (two canvas listeners would re-fight contested clicks); this calls back only at gesture time (eval-safe cycle).

import * as OP from '../../shared/protocol/requests.js';
import { sendOps } from './editwrites.js';
import { THREE, camera } from './core.js';
import { bus } from './base.js';
import { modelName } from './assets.js';
import { entities, metaOf, bags, bagOf, parentIdOf, findPart } from './world.js';
import { state } from './state.js';
import { socketMapIn } from '../../shared/sockbody.js';
import { motionNode } from '../../shared/protocol/names.js';
import { mouse } from './controller.js';
import { flashHint, html } from './ui.js';
import { engage, release } from './keyhints.js';
import { setEditMode, isEditing, deselect,
  setInspectorHtml, hideInspector } from './build.js';
import { registerHandler } from './inspect.js';
import { socketQ } from '../../shared/components.js';
import { qMul, qFromYaw, qNorm } from '../../shared/rot.js';

const raycaster = new THREE.Raycaster();

const seatGizmos = new Map();   // "id\x00slot" -> gizmo (child of entity root)
let seatSel = null;             // { id, slot } — the anchor under edit
let seatDrag = null;            // { armed, startX, startY, pending } drag state
let seatArm = null;             // entity id waiting for a placement click

export const socketArmed = () => seatArm !== null;
export const socketSelected = () => seatSel !== null;

function makeSeatGizmo() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xf5c96b, depthTest: false, transparent: true, opacity: 0.9 });
  const seat = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), mat);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 6), mat);
  nose.position.set(0, 0, 0.16);
  nose.rotation.x = Math.PI / 2;              // the arrow is the sit-facing
  g.add(seat, nose);
  // picking is ray-to-point: these meshes must not catch the placement/selection rays around them
  g.traverse((o) => { o.raycast = () => {}; o.renderOrder = 9; o.userData.noCamCollide = true; });
  return g;
}

/** Parented to the entity ROOT at the anchor's rest spot, like socketWorldPos: reach never oscillates with a part's motion. */
export function refreshSocketGizmos() {
  for (const [k, g] of seatGizmos) { g.parent?.remove(g); seatGizmos.delete(k); }
  if (!isEditing()) return;
  // a seat is a socket child: every host that has one, read as its old map (socketMapIn)
  const hosts = new Set();
  for (const [sid, c] of bags()) if (c?.socket && typeof c.socket === 'object') { const h = parentIdOf(sid); if (h != null) hosts.add(h); }
  for (const id of hosts) {
    const root = entities.get(id);
    if (!root) continue;
    for (const [slot, sock] of Object.entries(socketsOf(id))) {
      const g = makeSeatGizmo();
      g.position.set(...(sock.pos ?? [0, 0.5, 0]));
      g.quaternion.fromArray(socketQ(sock));
      root.add(g);
      seatGizmos.set(`${id}\x00${slot}`, g);
    }
  }
  if (seatSel && !seatGizmos.has(`${seatSel.id}\x00${seatSel.slot}`)) deselectSocket();
  else refreshSeatHighlight();
}
bus.on('comp', ({ type }) => { if (type === 'socket' && isEditing()) refreshSocketGizmos(); });
bus.on('entity', () => { if (isEditing()) refreshSocketGizmos(); });

function refreshSeatHighlight() {
  for (const [k, g] of seatGizmos) {
    const on = seatSel && k === `${seatSel.id}\x00${seatSel.slot}`;
    g.scale.setScalar(on ? 1.6 : 1);
    g.traverse((o) => o.material?.color.setHex(on ? 0x8fe8c8 : 0xf5c96b));
  }
}

/** Ray-to-point: a 7 cm marker on a busy mesh is unhittable by triangle raycast. */
const _spV = new THREE.Vector3();
function pickSeat(ray) {
  let best = null, bestD = Infinity;
  for (const [k, g] of seatGizmos) {
    g.getWorldPosition(_spV);
    const tol = Math.min(0.3, 0.06 + camera.position.distanceTo(_spV) * 0.015);
    const d = ray.distanceToPoint(_spV);
    if (d < tol && d < bestD) { bestD = d; best = k; }
  }
  if (!best) return null;
  const [id, slot] = best.split('\x00');
  return { id, slot };
}

export function selectSocket(pick) {
  deselect();                              // a seat and a thing never co-hold the keys
  seatSel = pick;
  refreshSeatHighlight();
  engage('seatTurn');
  const meta = metaOf(pick.id) ?? {};
  const label = meta.model != null ? modelName(meta.model) : pick.id;
  setInspectorHtml(
    html`<span><b>${pick.slot}</b> anchor on <b>${label.slice(0, 24)}</b></span><span style="color:var(--dim)">drag move · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> remove · <kbd>Esc</kbd> done</span>`);   // one html``: markup + markup would concatenate to a plain (text) string
}
export function deselectSocket() {
  if (seatSel) release();
  seatSel = null; seatDrag = null;
  refreshSeatHighlight();
  hideInspector();
}

/** Leaving edit mode. */
export function resetSockets() {
  seatArm = null;
  deselectSocket();
}

/** Socket children as a map (shared/sockbody.js socketMapIn); writes are translated back into children at the door. */
function socketsOf(id) { return socketMapIn(state.st.entities, id) ?? {}; }

/** Always the whole merged map: comp data replaces wholesale, so a partial write eats every OTHER anchor. */
export function commitSockets(id, next, describe) {
  sendOps([Object.keys(next).length ? OP.set(id, 'sockets', next) : OP.unset(id, 'sockets')], { what: describe });
}

const _saM = new THREE.Matrix4();
const _saM2 = new THREE.Matrix4();
const _saQ = new THREE.Quaternion();
const _saV = new THREE.Vector3();
function worldYawOf(root) {
  root.getWorldQuaternion(_saQ);
  _saV.set(0, 0, 1).applyQuaternion(_saQ);
  return Math.atan2(_saV.x, _saV.z);
}

/** The `part` that makes an anchor RIDE. Only motion-named parts: arbitrary mesh nodes would freeze junk into the log. */
function partUnderHit(id, hitObj) {
  const bag = bagOf(id) ?? {};
  const names = new Set();
  for (const key in bag) {
    const n = (key === 'motion' || key.startsWith('motion:')) ? motionNode(key, bag[key]) : null;
    if (n) names.add(n);
  }
  if (!names.size) return null;
  for (let o = hitObj; o && !o.userData.entityId; o = o.parent) if (names.has(o.name)) return o.name;
  return null;
}

/** A click MID-SWING must not bake the phase into the anchor: undo the part's displacement (inverse of mountTransform). */
function unrideHitPoint(root, partName, wp) {
  const part = partName ? findPart(root, partName) : null;
  const b = part?.userData?.mbase;
  if (!part || !part.parent || !b) return wp;
  part.updateWorldMatrix(true, false);
  _saM.compose(_saV.set(...b.pos), _saQ.fromArray(b.quat), part.scale)
    .premultiply(part.parent.matrixWorld);                  // part-at-rest → world
  return wp.applyMatrix4(_saM2.copy(part.matrixWorld).invert()).applyMatrix4(_saM);
}

const round3 = (n) => +n.toFixed(3);
function seatFromHit(id, root, hit) {
  const part = partUnderHit(id, hit.object);
  const wp = unrideHitPoint(root, part, hit.point.clone());
  root.updateWorldMatrix(true, false);
  const mp = wp.applyMatrix4(_saM2.copy(root.matrixWorld).invert());   // world → model frame
  return { pos: [round3(mp.x), round3(mp.y), round3(mp.z)], part };
}

export function armSocketPlacement(id) {
  if (!id || !entities.get(id)) return;
  setEditMode(true, { quiet: true });
  seatArm = id;
  flashHint(html`click the spot where the occupant goes — the arrow will face you · <kbd>Esc</kbd> cancels`, 8000);
}

export function cancelSocketArm() {
  if (!seatArm) return false;
  seatArm = null;
  flashHint('seat placement cancelled');
  return true;
}

function placeSeatAt(e) {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const id = seatArm;
  const root = entities.get(id);
  if (!root) { seatArm = null; return; }
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) { flashHint(html`that missed the thing — click ON it, or <kbd>Esc</kbd>`); return; }
  seatArm = null;
  const { pos, part } = seatFromHit(id, root, hit);
  // face the declarer: you look at the seat from where an occupant's knees would point
  const yaw = +(Math.atan2(camera.position.x - hit.point.x, camera.position.z - hit.point.z) - worldYawOf(root)).toFixed(3);
  const sockets = socketsOf(id);
  let slot = 'seat', n = 2;
  while (sockets[slot]) slot = `seat${n++}`;
  sockets[slot] = { pos, ...(yaw ? { q: qFromYaw(yaw).map((v) => +v.toFixed(6)) } : {}), ...(part ? { part } : {}), body: {} };   // body: a person attaches here
  commitSockets(id, sockets, 'seat anchor');
  selectSocket({ id, slot });      // the comp echo builds the gizmo already selected
  flashHint(html`<b>${slot}</b> declared${part ? ' (rides ' + part + ')' : ''} — drag refines · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> removes`);
}

/** Called FIRST by the core's mousedown, or the mesh under a small gizmo wins every contested click. */
export function socketMouseDown(e) {
  if (seatArm) { placeSeatAt(e); return true; }
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const sp = pickSeat(raycaster.ray);
  if (!sp) return false;
  selectSocket(sp);
  seatDrag = { armed: false, startX: e.clientX, startY: e.clientY };
  return true;
}

/** True whenever a seat is selected: a selected seat consumes the whole editing key set. */
export function socketKeyDown(e) {
  if (!seatSel) return false;
  if (e.code === 'KeyQ') turnSeat(e.shiftKey ? 0.02 : Math.PI / 12);   // keys: seatTurn
  if (e.code === 'KeyE') turnSeat(e.shiftKey ? -0.02 : -Math.PI / 12);   // keys: seatTurn
  if (e.code === 'Delete' || e.code === 'Backspace') removeSeat();
  return true;
}

/** Per frame from updateBuild: the anchor slides on ITS OWN entity's surfaces, so it can't fall off the thing. */
export function updateSocketDrag() {
  if (!seatDrag?.armed || !seatSel) return;
  raycaster.setFromCamera(mouse, camera);
  const root = entities.get(seatSel.id);
  if (!root) return;
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) return;
  const next = seatFromHit(seatSel.id, root, hit);
  seatDrag.pending = next;
  const g = seatGizmos.get(`${seatSel.id}\x00${seatSel.slot}`);
  if (g) g.position.set(...next.pos);
}

function commitSeatDrag() {
  if (!seatDrag?.pending || !seatSel) return;
  const sockets = socketsOf(seatSel.id);
  const cur = sockets[seatSel.slot] ?? {};
  sockets[seatSel.slot] = { ...cur, pos: seatDrag.pending.pos,
    ...(seatDrag.pending.part ? { part: seatDrag.pending.part } : {}) };
  if (!seatDrag.pending.part) delete sockets[seatSel.slot].part;
  commitSockets(seatSel.id, sockets, 'seat move');
}

function turnSeat(d) {
  if (!seatSel) return;
  const sockets = socketsOf(seatSel.id);
  const cur = sockets[seatSel.slot];
  if (!cur) return;
  // turn about the socket's OWN up (a tilted socket turns in its tilt)
  const { yaw: _y, ...rest } = cur;
  sockets[seatSel.slot] = { ...rest, q: qNorm(qMul(socketQ(cur), qFromYaw(d))).map((v) => +v.toFixed(6)) };
  commitSockets(seatSel.id, sockets, 'seat facing');
}

function removeSeat() {
  if (!seatSel) return;
  const sockets = socketsOf(seatSel.id);
  delete sockets[seatSel.slot];
  commitSockets(seatSel.id, sockets, 'seat removal');
  deselectSocket();
}

// the seat drag's own arm/commit listeners: they touch only seat state, so order against the core's doesn't matter
const DRAG_SLOP = 4;
addEventListener('mousemove', (e) => {
  if (seatDrag && !seatDrag.armed
      && Math.hypot(e.clientX - seatDrag.startX, e.clientY - seatDrag.startY) > DRAG_SLOP) {
    seatDrag.armed = true;
  }
});
addEventListener('mouseup', () => {
  if (seatDrag?.armed) commitSeatDrag();
  seatDrag = null;
});


// ---- the inspector's sockets GESTURES + preview --------------------------------
// fields live in shared/editschema.js; this adds placement, row-click select, and live gizmo drag before the commit
registerHandler('comp', (id, _obj, k, _v, opts) => { if (k !== 'add:seat' || opts?.live) return false; armSocketPlacement(id); return true; });
registerHandler('sockets', (id, obj, k, value, opts) => {
  if (k === 'add') { armSocketPlacement(id); return true; }
  if (k === 'slots') { if (entities.get(id)) selectSocket({ id, slot: value }); return true; }
  if (k === 'del') { if (seatSel?.id === id && seatSel.slot === value) deselectSocket(); return false; }
  if (!opts?.live) return false;
  const [slot, what, idx] = k.split('|');
  const g = seatGizmos.get(`${id}\x00${slot}`);
  if (!g) return true;
  if (what === 'pos') { const p = g.position.toArray(); p[+idx] = +value; g.position.set(...p); }
  else if (what === 'rot') { g.rotation.reorder('YXZ'); g.rotation[['x', 'y', 'z'][+idx]] = +value; }   // the inspector's heading/pitch/roll (Euler YXZ)
  return true;
});
