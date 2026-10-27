// models — the first realizer (TEL0S_NOTES §11.4): entity lifecycle as a projection of state.st.
// Every load completion re-reads current state, so a place, remove or mount landing mid-load needs no pending list
// (state is the list; mounts re-check via mountsTouching). Writes the shared maps (world.js), emits 'entity', 'comp',
// 'mount'; loads go through the scheduler. A same-id spawn replaces wholesale (spec/PROTOCOL.md §3.1, fixture 04-overwrite).

import { THREE, scene, camera } from '../core.js';
import { applyScale, entScale } from '../../../shared/scale3.js';
import { isMineHidden, isolatedOut } from '../myview.js';
import { report, bus } from '../base.js';
import { loadGLB, retainGLB, releaseGLB, evictIdleProtos, lodRecipeReady, gpuPressure,
  lodNegotiable, negotiationReady } from '../assets.js';
import { makeModelQuality, chooseTier } from '../lod_policy.js';
import { colliders, fitCollider, removeCollider, reindexCollider, refitCollider } from '../colliders.js';
import { attachLamps, releaseOwner, registerCaster, requestLight, updateRequest, releaseLight } from '../lightrig.js';
import { makeLightGizmo } from '../lights.js';
// ../../../, not ../../: resolves to shared/ on disk (bun tests) and still clamps to /shared/ in the browser
import { lightOf, colliderOf } from '../../../shared/components.js';
import { entities, bagOf, childrenOf, avatarMounts, findPart, editHolds } from '../world.js';
import { compKeys } from '../../../shared/protocol/view.js';
import { encName } from '../../../shared/protocol/names.js';
import { state, onWorldChange } from '../state.js';
import { schedule, cancelOwner } from '../scheduler.js';
import { planReconcile, bandForDistance, mountsTouching, collisionOwnedElsewhere, kindOf, offIn, readMesh, meshKeyOf } from './models_field.js';
import { prepareMaterial } from '../materials.js';
import { tracked, reserve, regen, untrack, release } from './lifecycle.js';

import { recordComponents } from '../../../shared/protocol/view.js';
import { R_BASE, residencyRadiusFor } from '../../../shared/lod-distance.js';   // shared with the server's LOD budget
import { worldPose } from '../../../shared/hierarchy.js';

// PROTOCOL §9 amendment: the fold's q when the thing is more than turned, else its yaw; base carries q too, so motion
// composes on the real tilt instead of snapping a toppled thing upright
function orientObj(obj, ent) {
  if (Array.isArray(ent?.q) && ent.q.length === 4) obj.quaternion.set(ent.q[0], ent.q[1], ent.q[2], ent.q[3]);
  else obj.rotation.set(0, ent?.yaw ?? 0, 0);
}
const restOf = (obj, ent) => ({
  pos: obj.position.toArray(), yaw: ent?.yaw ?? obj.rotation.y,
  ...(Array.isArray(ent?.q) && ent.q.length === 4 ? { q: [...ent.q] } : {}),
});

const _v = new THREE.Vector3();

// ---- placeholders -----------------------------------------------------------
// a translucent box the size of the real thing (geom bbox) until the GLB lands: a real entity to the maps, invisible
// to camera collision, colliders and shadows

const libGeom = new Map();   // lib -> {bbox} — fed by the 'geom' message
/** A placed thing's model box in its own frame: the server's measure, or (a model added after you joined, which the
 *  join-time geom never covered) measured here from the loaded meshes. null while nothing has loaded. */
const _ib = new THREE.Matrix4(), _bx = new THREE.Box3(), _mb = new THREE.Box3();
export function boxOf(id) {
  const ent = state.st.entities?.[id]; const known = ent?.model ? libBox(ent.model) : null; if (known) return known;
  const obj = entities.get(id); if (!obj) return null;
  obj.updateWorldMatrix(true, true); _ib.copy(obj.matrixWorld).invert(); _bx.makeEmpty();
  const walk = (m) => {   // its own meshes only: an occupant (another entity mounted here) is a child in three, not part of it
    if (m !== obj && m.userData?.entityId != null && m.userData.entityId !== id) return;
    if (m.isMesh && m.geometry && !m.userData?.isGizmo) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _mb.copy(m.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(_ib, m.matrixWorld)); _bx.union(_mb); }
    for (const k of m.children) walk(k);
  };
  walk(obj);
  return _bx.isEmpty() ? null : [_bx.min.toArray(), _bx.max.toArray()];
}
/** A model's box in its own frame (before scale), as the server measured it: [[min], [max]], or null until known. */
export function libBox(lib) { const b = libGeom.get(lib)?.bbox; if (!b?.size) return null; const c = b.center ?? [0, b.size[1] / 2, 0]; return [[0, 1, 2].map((i) => c[i] - b.size[i] / 2), [0, 1, 2].map((i) => c[i] + b.size[i] / 2)]; }
let _phGeo = null;
let _phMat = null;

function makePlaceholder(id, ent, g) {
  _phGeo ??= new THREE.BoxGeometry(1, 1, 1);
  _phMat ??= new THREE.MeshBasicNodeMaterial({ color: 0x8a9099, transparent: true, opacity: 0.22, depthWrite: false });
  const grp = new THREE.Group();
  const mesh = new THREE.Mesh(_phGeo, _phMat);
  mesh.scale.set(Math.max(g.bbox.size?.[0] ?? 0.5, 0.05), Math.max(g.bbox.size?.[1] ?? 0.5, 0.05), Math.max(g.bbox.size?.[2] ?? 0.5, 0.05));
  mesh.position.set(...(g.bbox.center ?? [0, 0, 0]));
  mesh.castShadow = mesh.receiveShadow = false;
  // never swept into a weather wrap: that would recompile it mid-session for every placeholder
  mesh.userData.noWet = true;
  mesh.userData.noCloudShadow = true;
  grp.add(mesh);
  grp.userData.entityId = id;
  grp.userData.placeholder = true;
  grp.userData.noCamCollide = true;
  grp.position.set(...(ent.pos ?? [0, 0, 0]));
  orientObj(grp, ent);
  if (ent.scale) applyScale(grp, entScale(ent));
  grp.userData.base = restOf(grp, ent);
  return grp;
}

/** Idempotent: only a bare `null` reservation of known size upgrades. */
function maybePlaceholder(id) {
  if (entities.get(id) !== null) return;   // realized, placeholdered, or unknown
  const ent = state.st.entities[id];
  const g = ent?.model ? libGeom.get(ent.model) : null;
  if (!ent || !g?.bbox) return;
  const grp = makePlaceholder(id, ent, g);
  entities.set(id, grp);
  scene.add(grp);
  applyHidden(id);   // hidden survives the stand-in box (placeholder / demote)
  syncCompLight(id); // a lamp's light rides the stand-in until the model lands
  bus.emit('entity', { id, kind: 'placeholder' });
}

const isPlaceholder = (obj) => Boolean(obj?.userData?.placeholder);

/** For an id whose load resolved some other way than realization. */
function clearReservation(id) {
  const cur = entities.get(id);
  if (cur === null || isPlaceholder(cur)) {
    if (cur) (cur.parent ?? scene).remove(cur);
    entities.delete(id);
    syncCompLight(id);   // the stand-in it rode is gone: park at the fold, or drop
  }
}

// ---- the scene-side mount index ---------------------------------------------
// the fold's edges live in the replica (world.js childrenOf); this is SCENE truth (userData.mountedTo) for the cargo
// step-out loops, since a `remove` folds the children's parent records away before retire() runs
const sceneChildren = new Map(); // parent id -> Set(child id)   (scene truth)
const sceneParentOf = new Map();

/** Mirror one userData.mountedTo write (`to` = parent id) or clear (null). */
function indexSceneMount(id, to) {
  const prev = sceneParentOf.get(id) ?? null;
  if (prev === to) return;
  if (prev) {
    const s = sceneChildren.get(prev);
    if (s) { s.delete(id); if (!s.size) sceneChildren.delete(prev); }
  }
  if (to) {
    let s = sceneChildren.get(to);
    if (!s) sceneChildren.set(to, s = new Set());
    s.add(id);
    sceneParentOf.set(id, to);
  } else sceneParentOf.delete(id);
}

// ---- creation ---------------------------------------------------------------

function createModel(id, ent) {
  const gen = reserve(id, { kind: 'model', model: ent.model });
  entities.set(id, null);   // reservation — the contract every consumer knows
  maybePlaceholder(id);     // …upgraded to a sized stand-in when geom is known
  syncCompLight(id);        // a lamp lights its folded spot before (and beyond) its load
  // STREAMING (§13.3 R1, §16.2.C): gate on POSITION, stand-in or not: a far entity loads nothing and the 500ms sweep
  // promotes it once inside R. Unknown sizes err LARGE (DIAG_DEFAULT); live spawns share this path.
  if (entDist(ent) > residencyRadius(ent)) return;
  scheduleLoad(id, ent, gen);
}

function scheduleLoad(id, ent, gen, tier = null) {
  const t0 = tracked.get(id);
  if (t0) t0.loading = true;   // the sweep must not re-promote a load in flight
  schedule({
    key: `entity:${id}`, owner: `entity:${id}`, lane: 'net',
    // re-read at dequeue, so walking toward a thing promotes its load
    priority: () => bandForDistance(camWorld().distanceTo(
      _v.set(...(state.st.entities[id]?.pos ?? [0, 0, 0])))),
    run: async (signal) => {
      // a first load picks its tier at DEQUEUE, once /version has answered (assets.js lodNegotiable), from the live
      // distance; a re-tier brings the sweep's choice
      await negotiationReady;
      if (signal.aborted) return;
      const want = tier ?? tierFor(ent, null);
      const obj = await loadGLB(ent.model, { tier: want });
      const cur = state.st.entities[id];
      const t = tracked.get(id);
      if (t?.gen === gen) t.loading = false;
      // the world may have moved on while the bytes flew (retired, replaced, re-spawned, demoted, generation reset)
      if (signal.aborted || t?.gen !== gen) return;
      if (!cur || kindOf(cur) !== 'model' || cur.model !== ent.model) {
        clearReservation(id);
        if (tracked.get(id)?.gen === gen) untrack(id);
        return;
      }
      // a TIER SWAP re-checks authority at application: a sit, a mount, a part motion or an edit hold may have landed
      // while the bytes flew. Then the clone isn't worn and the standing object keeps everything; the sweep retries.
      const standing = entities.get(id);
      if (standing && !isPlaceholder(standing) && standing.userData?.lib && !canRetier(id, cur)) {
        resStats.retiersRefused++;
        if (t) t.retierAt = Date.now();
        return;
      }
      realizeModel(id, cur, obj);
    },
  }).done.catch((e) => {
    const t = tracked.get(id);
    if (t?.gen === gen) t.loading = false;
    if (e?.name === 'AbortError') return;
    if (t) t.failedAt = Date.now();   // the sweep backs off, not machine-guns
    // a failed load keeps its reservation: the id stays addressable (a later remove folds cleanly), it never renders
    report(`realize spawn ${id}`, e);
  });
}

// the visible half of a promote is synchronous; the heavy tail (collider fit, lamp/caster scans, mount re-checks)
// drains ≤~4ms/frame via 'promote-tail' (main.js). A query before the collider lands misses the object (§16.2.C).
/** What a realized object holds that its replacement must not inherit: a tier swap and a demote release identically
 *  (the collider, caster and lamps let go via lifecycle.js release). */
function teardownRealized(id, obj, phase) {
  promoteTail.delete(id);   // a pending heavy tail dies — the replacement earns its own
  lampsOn.delete(id);
  indexSceneMount(id, null);
  releaseGLB(obj.userData?.glbKey ?? obj.userData?.lib);
  cancelOwner(`entity:${id}`);
  release(id, phase);
}

function realizeModel(id, cur, obj) {
  const stand = entities.get(id);
  if (stand && (isPlaceholder(stand) || stand.userData?.lib)) {
    // durable children may sit on placeholders: step them out BEFORE the stand's subtree goes and clear mountRel so the
    // tail's execMount re-attaches them; mountedTo stays so a racing retire() can still step them off
    const kids = sceneChildren.get(id);
    if (kids) for (const cid of [...kids]) {
      const cobj = entities.get(cid);
      if (cobj?.userData?.mountedTo === id && cobj.parent) {
        scene.attach(cobj);
        delete cobj.userData.mountRel;
      }
    }
    // the fresh clone starts unattached: the tail's mountsTouching pass re-executes the linkage
    if (stand.userData.mountedTo) indexSceneMount(id, null);
    // a real object REPLACED (tier swap) releases what it held; a placeholder held nothing
    if (!isPlaceholder(stand)) teardownRealized(id, stand, 'swap');
    (stand.parent ?? scene).remove(stand);   // the real thing takes the spot
  }
  retainGLB(obj.userData.glbKey ?? cur.model);   // the proto is worn — eviction must not undress it
  obj.userData.lib = cur.model;
  obj.userData.tier = obj.userData.tierServed ?? 'full';   // the server's word, not the request
  // tierAsked from loadGLB: a lod ask answered with the original wears 'full' but asked 'lod'; the sweep compares
  // against the ask, so it isn't re-asked every cooldown
  obj.userData.entityId = id;
  const sc = entScale(cur);
  obj.position.set(...(cur.pos ?? [0, 0, 0]));
  orientObj(obj, cur);
  if (sc) applyScale(obj, sc);
  obj.userData.base = restOf(obj, cur);
  entities.set(id, obj);
  scene.add(obj);
  applyHidden(id);   // a thing hidden before its model arrived stays hidden
  bus.emit('entity', { id, kind: 'spawn' });
  // comps that folded while the GLB was in flight announce now: emitters and panels attach off these events
  emitCompBag(id);
  promoteTail.set(id, obj);   // the boulders land within the next frames
}

// ---- the promote tail (§16.2.C) ---------------------------------------------

/** id -> the realized object awaiting its heavy tail. Identity is the guard: the drain runs an item only while
 *  entities.get(id) is still this object (retire and demote also cancel eagerly). */
const promoteTail = new Map();

/** Per-lib collider derivations are shared only for a pristine clone: no occupant glued in, no part motion that may
 *  have bent a named node. Everything else builds per-entity (§16.2.C). */
function shareableLib(id, cur) {
  if (!cur?.model) return null;
  const kids = sceneChildren.get(id);
  if (kids) for (const cid of kids) {
    const cobj = entities.get(cid);
    if (cobj && cobj.parent && cobj.parent !== scene && !cobj.userData.socket) return null;   // a socket is a frame, not geometry
  }
  const bag = recordComponents(cur);
  if (bag) {
    if (bag.motion?.part) return null;
    for (const k in bag) if (k.startsWith('motion:')) return null;
  }
  return cur.model;
}

function runPromoteTail(id, obj) {
  const cur = state.st.entities[id];
  if (!cur) return;   // a remove raced the drain; retire already cleaned up
  // receiveShadow came from the factory at parse time; castShadow is the rig's live caster budget (§12.5)
  registerCaster(id, obj);
  // no fitted collider where collision is owned elsewhere (mounted cargo, a `structure` anchor: collisionOwnedElsewhere)
  // or on a LOD-tier placement (#156: collision stays off the reduced mesh; full fits it on approach)
  if (obj.userData.tier !== 'lod' && !collisionOwnedElsewhere(cur, obj.userData.mountedTo)) {
    // localFrame: the spawn transform is already applied, so the box is computed root-local and bucketed live
    fitCollider(id, obj, {
      // comp.collider {shape} when present, else the spawn's legacy collide (PROTOCOL §4; shared/components.js colliderOf)
      collide: colliderOf(cur), scale: cur.scale || 1,
      lib: shareableLib(id, cur), localFrame: true,
    });
    // the grass clearing mask repaints on entity events: an interior verdict is announced when it exists
    if (colliders.get(id)?.interior) bus.emit('entity', { id, kind: 'collider' });
  }
  // emissive surfaces become lamp REQUESTS (free until the rig assigns a slot). No shadows: a prop never claims the one
  // casting slot (a body lit from inside does). An authored Light component beats inferred lamps (no double-lighting).
  if (lampsOn.get(id)) releaseOwner(`entity:${id}`);   // a re-run tail on the same id: never two sets
  const infer = !lightOf(cur);
  if (infer) attachLamps(obj, `entity:${id}`);
  lampsOn.set(id, infer);
  // mounts that were waiting on this id — as child or carrier
  for (const mid of mountsTouching(state.st.entities, id, childrenOf)) execMount(mid);
}

/** Realized objects still owing their heavy tail: the governor's loading grace counts them (§16.2.D). */
export const promoteTailPending = () => promoteTail.size;
/** What the realizer holds a thing AS ({kind, lib?}): the parity probe's word against the fold's; null for a reservation. */
export const realizedAs = (id) => { const t = tracked.get(id); return t ? { kind: t.kind, ...(t.model ? { model: t.model } : {}) } : null; };

/** Drain within ~4 ms, at least one item per frame ('promote-tail', main.js). */
export function drainPromoteTail() {
  if (!promoteTail.size) return;
  const t0 = performance.now();
  for (const [id, obj] of promoteTail) {
    promoteTail.delete(id);
    if (entities.get(id) !== obj) continue;   // the guard: same realized object only
    try { runPromoteTail(id, obj); } catch (e) { report(`promote tail ${id}`, e); }
    if (performance.now() - t0 >= 4) break;
  }
}

/** An Empty (PROTOCOL §3.2): a bare Group, so every entities-map consumer treats it as an entity; no collider, lamps,
 *  caster slot or load. Announced as 'spawn' (what comp evaluators rebuild on); a light comp brings its gizmo. */
function createHost(id, ent, kind) {
  reserve(id, { kind });
  const g = new THREE.Group();
  g.userData.entityId = id;
  g.userData.empty = true;
  g.userData.noCamCollide = true;
  g.position.set(...(ent.pos ?? [0, 0, 0]));
  orientObj(g, ent);
  if (ent.scale) applyScale(g, entScale(ent));
  g.userData.base = restOf(g, ent);
  if (kind === 'socket') g.userData.socket = true;   // a socket: no marker (the seat gizmos draw it), no collider, no box
  else setEmptyMarker(g, editing);
  entities.set(id, g);
  scene.add(g);
  applyHidden(id);
  bus.emit('entity', { id, kind: 'spawn' });
  emitCompBag(id);
  // mounts waiting on this id, as child or carrier (an Empty has no tail: it exists at once)
  for (const mid of mountsTouching(state.st.entities, id, childrenOf)) execMount(mid);
}

const createEmpty = (id, ent) => createHost(id, ent, 'empty');
/** A light component landing on, or leaving, a standing host changes what the fold calls it — the same Group serves, so
 *  only the word changes (the realized object is the one a planReconcile would otherwise rebuild). A mesh is drawn
 *  (createMesh below), so a mesh component arriving or leaving is a rebuild, never a relabel. */
function relabelHost(id) {
  const t = tracked.get(id), ent = state.st.entities[id];
  if (!t || !ent || t.kind === 'model' || t.kind === 'mesh') return;
  const kind = kindOf(ent);
  if (kind === 'model' || kind === 'mesh' || kind === t.kind) return;
  t.kind = kind;
}
/** A mesh thing (componentspec `mesh`): one THREE.Mesh with a single material named 'surface', base-centred like a
 *  measured model (boxOfM), with a model's tail (collider, caster slot). A shape or size change rebuilds in place. */
function meshGeometry({ shape, size: [x, y, z] }) {
  const r = x / 2;
  switch (shape) {
    case 'sphere': return new THREE.SphereGeometry(r, 32, 16).translate(0, r, 0);
    case 'cylinder': return new THREE.CylinderGeometry(r, r, y, 32).translate(0, y / 2, 0);
    case 'capsule': return new THREE.CapsuleGeometry(r, Math.max(0, y - 2 * r), 8, 16).translate(0, y / 2, 0);
    case 'plane': return new THREE.PlaneGeometry(x, z).rotateX(-Math.PI / 2);
    default: return new THREE.BoxGeometry(x, y, z).translate(0, y / 2, 0);
  }
}
function meshMaterial(shape) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.8, metalness: 0, ...(shape === 'plane' ? { side: THREE.DoubleSide } : {}) });
  mat.name = 'surface';
  return mat;
}
function createMesh(id, ent) {
  const m = readMesh(ent?.mesh);
  reserve(id, { kind: 'mesh', mesh: meshKeyOf(ent) });
  const obj = new THREE.Mesh(meshGeometry(m), meshMaterial(m.shape));
  obj.castShadow = true; obj.receiveShadow = true;
  obj.userData.entityId = id;
  obj.userData.meshShape = m.shape; obj.userData.meshSize = m.size;
  prepareMaterial(obj.material, obj);
  obj.position.set(...(ent.pos ?? [0, 0, 0]));
  orientObj(obj, ent);
  if (ent.scale) applyScale(obj, entScale(ent));
  obj.userData.base = restOf(obj, ent);
  entities.set(id, obj);
  scene.add(obj);
  applyHidden(id);
  fitCollider(id, obj, { collide: colliderOf(ent), scale: ent.scale || 1, localFrame: true });
  registerCaster(id, obj);
  bus.emit('entity', { id, kind: 'spawn' });
  emitCompBag(id);
  for (const mid of mountsTouching(state.st.entities, id, childrenOf)) execMount(mid);
}
function rebuildMesh(id) {
  const ent = state.st.entities[id]; const obj = entities.get(id); const t = tracked.get(id);
  const m = readMesh(ent?.mesh); if (!obj || !t || t.kind !== 'mesh' || !m) return;
  const key = meshKeyOf(ent); if (key === t.mesh) return;
  obj.geometry.dispose(); obj.geometry = meshGeometry(m); obj.userData.meshSize = m.size;
  if (obj.userData.meshShape !== m.shape) { obj.userData.meshShape = m.shape; for (const mat of [obj.material, ...(obj.userData.__matClones ?? [])]) if (mat) mat.side = m.shape === 'plane' ? THREE.DoubleSide : THREE.FrontSide; }
  t.mesh = key;
  if (!collisionOwnedElsewhere(ent, obj.userData.mountedTo)) fitCollider(id, obj, { collide: colliderOf(ent), scale: ent.scale || 1, localFrame: true });
  bus.emit('entity', { id, kind: 'place' });
}

/** The Inspector's live preview of a mesh card scrub: the geometry as the field reads now, before release. The fold's
 *  echo (rebuildMesh, keyed) settles it. */
export function previewMesh(id, m) {
  const obj = entities.get(id); const t = tracked.get(id); if (!obj || t?.kind !== 'mesh') return false;
  const r = readMesh(m); if (!r) return false;
  obj.geometry.dispose(); obj.geometry = meshGeometry(r); obj.userData.meshSize = r.size; t.mesh = null;   // null: the next fold word (or a pose-revert) rebuilds and refits
  return true;
}
/** A light is an Empty that casts (syncCompLight hangs the cast and the gizmo on it); a mesh is its own drawn thing — each
 *  tracked under its own kind so the planner's identity rule and the residency sweep read the same word the fold does. */
// A socket (PLAN-sockets-entities) is an Empty that is only ever a frame: attached to its host (or into the host's moving
// part, at rest: execMount), so an occupant's seat and the cargo on it ride whatever carries the socket through the scene graph.
const CREATE = { light: (id, ent) => createHost(id, ent, 'light'), mesh: createMesh, empty: createEmpty, model: createModel, socket: (id, ent) => createHost(id, ent, 'socket') };

// an Empty wears a pickable wireframe marker in EDIT MODE only: attached, not merely hidden, since the raycaster
// ignores `visible`. One shared geometry and material.
let editing = false;
let _emGeo = null;
let _emMat = null;
function setEmptyMarker(g, on) {
  const cur = g.children.find((c) => c.userData?.emptyMarker);
  if (on && !cur) {
    _emGeo ??= new THREE.OctahedronGeometry(0.18);
    _emMat ??= new THREE.MeshBasicNodeMaterial({ color: 0x66ccff, wireframe: true, transparent: true, opacity: 0.9, depthTest: false });
    const m = new THREE.Mesh(_emGeo, _emMat);
    m.userData = { emptyMarker: true, perfscopeIgnore: true, noCamCollide: true, noWet: true, noCloudShadow: true };
    m.castShadow = m.receiveShadow = false;
    m.renderOrder = 999;
    g.add(m);
  } else if (!on && cur) g.remove(cur);
}

// ---- light components (PROTOCOL §4) ------------------------------------------
// comp.light on a non-light entity: a rig request whose `obj` IS the realized object (a child gizmo would join its
// collider and scans), parked at the folded position while unrealized; an Empty carries the gizmo as a child.
// Keyed by id and released here, never by releaseOwner(`entity:<id>`), which demote and tier swaps call on purpose.
const compLights = new Map();   // id -> { key, gizmo? }

function dropCompLight(id) {
  const cl = compLights.get(id);
  if (!cl) return;
  releaseLight(cl.key);
  if (cl.gizmo) { cl.gizmo.parent?.remove(cl.gizmo); cl.gizmo.geometry?.dispose?.(); cl.gizmo.material?.dispose?.(); }
  compLights.delete(id);
}

// id -> are its inferred lamps (owner `entity:<id>`) standing? Set once the promote tail decides; a Light component
// added to or removed from a standing model flips them. Cleared with the realized object.
const lampsOn = new Map();
function syncInferredLamps(id) {
  if (!lampsOn.has(id)) return;   // the tail has not landed: it will decide
  const obj = entities.get(id);
  if (!obj) return;
  const ent = state.st.entities[id];
  const want = !!ent && !lightOf(ent);
  if (want && !lampsOn.get(id)) attachLamps(obj, `entity:${id}`);
  else if (!want && lampsOn.get(id)) releaseOwner(`entity:${id}`);
  lampsOn.set(id, want);
}

/** Make the realized light match the fold: create, update, move to the current object, or release. Idempotent. */
function syncCompLight(id) {
  syncInferredLamps(id);
  const ent = state.st.entities[id];
  const L = ent ? lightOf(ent) : null;
  if (!L || offIn(state.st.entities, id)) { dropCompLight(id); return; }   // a switched-off thing casts nothing (I34)
  const host = entities.get(id) ?? null;
  const spec = {
    color: L.color, intensity: L.intensity, range: L.range, decay: L.decay, keep: L.important, dayAware: L.daytime !== 'full',   // the rig's `keep` tier is light.important
    spot: L.kind === 'spot' ? { angle: L.angle, inner: L.inner } : null,
    obj: host, pos: host ? null : [...(ent.pos ?? [0, 0, 0])],
  };
  let cl = compLights.get(id);
  if (!cl) {
    cl = { key: `complight:${id}` };
    compLights.set(id, cl);
    requestLight(cl.key, { ...spec, authored: true, owner: null });
  } else updateRequest(cl.key, spec);
  const wantGizmo = !!host?.userData?.empty;
  if (wantGizmo && cl.gizmo?.parent !== host) {
    if (!cl.gizmo) cl.gizmo = makeLightGizmo(L.color);
    host.add(cl.gizmo);
  } else if (!wantGizmo && cl.gizmo) {
    cl.gizmo.parent?.remove(cl.gizmo); cl.gizmo.geometry?.dispose?.(); cl.gizmo.material?.dispose?.();
    delete cl.gizmo;
  }
  cl.gizmo?.material?.color?.set?.(L.color);
}

/** comp.collider changed on a standing collider (one not yet landed needs nothing: the tail reads it fresh). */
function applyColliderPref(id) {
  const e = colliders.get(id);
  if (!e) return;
  e.pref = colliderOf(state.st.entities[id]);
  refitCollider(id);
}

// ---- refresh ----------------------------------------------------------------

function refreshModel(id, ent) {
  const obj = entities.get(id);
  if (!obj) return;   // loading: completion reads state
  // a MOUNTED child's transform is parent-relative and the mount owns it: don't re-apply it on reconnect
  if (!obj.userData.mountedTo) {
    if (ent.pos) obj.position.set(...ent.pos);
    if (ent.q || ent.yaw != null) orientObj(obj, ent);
    obj.userData.base = restOf(obj, ent);
  }
  if (ent.scale != null) applyScale(obj, entScale(ent));
  if (!isPlaceholder(obj) && obj.userData.tier !== 'lod') refitCollider(id);   // placeholders and lod tiers own no collider
  bus.emit('entity', { id, kind: 'place' });
}

// ---- retirement -------------------------------------------------------------

function retire(id) {
  dropCompLight(id);
  lampsOn.delete(id);
  cancelOwner(`entity:${id}`);
  promoteTail.delete(id);         // a pending heavy tail dies with the id
  const obj = entities.get(id);
  if (obj && !isPlaceholder(obj) && obj.userData?.lib) releaseGLB(obj.userData.glbKey ?? obj.userData.lib);
  if (obj?.userData?.meshShape) { obj.geometry?.dispose?.(); for (const mat of new Set([obj.material, ...(obj.userData.__matOrig ?? []), ...(obj.userData.__matClones ?? [])])) mat?.dispose?.(); }
  const rode = obj?.userData?.mountedTo;
  // a carrier that leaves the fold with only a stand-in: its cargo steps off that, the same way (one that is only being
  // rebuilt keeps it: the rebuild re-mounts them)
  const holder = obj ?? (state.st.entities[id] ? null : standIns.get(id));
  if (holder) {
    // cargo steps off before the carrier vanishes, at the FOLD's stamped pose so every client agrees; O(children)
    const kids = sceneChildren.get(id);
    if (kids) for (const cid of [...kids]) {
      const cobj = entities.get(cid);
      indexSceneMount(cid, null);
      if (cobj?.userData?.mountedTo !== id) continue;
      scene.attach(cobj);
      delete cobj.userData.mountedTo;
      delete cobj.userData.mountRel;
      const cst = state.st.entities[cid];
      if (cst?.pos) cobj.position.set(...cst.pos);
      if (cst?.q || cst?.yaw != null) orientObj(cobj, cst);
      applyScale(cobj, entScale(cst) ?? 1);   // the fold's scale, not the one attach() baked in
      cobj.userData.base = restOf(cobj, cst);
      // an Empty owns no collider (its only mesh may be a light gizmo)
      if (!cobj.userData.empty) fitCollider(cid, cobj, { collide: colliderOf(cst), scale: cobj.scale?.x || 1 });
    }
    (holder.parent ?? scene).remove(holder);
    if (holder !== obj) standIns.delete(id);
  }
  if (rode) pruneStandIn(rode);
  indexSceneMount(id, null);      // if the retired thing itself rode a carrier
  release(id, 'retire');          // the collider, the caster and the lamps let go
  entities.delete(id);
  untrack(id);
  bus.emit('entity', { id, kind: 'remove' });
}

// ---- components -------------------------------------------------------------

function emitCompBag(id) {
  syncCompLight(id);   // every path that re-announces the bag re-derives the light
  const bag = bagOf(id);
  if (bag) for (const type of compKeys(bag)) bus.emit('comp', { id, type, data: bag[type] });
}

/** comp {type:'hidden', data:true} = not drawn, still there (the collider, the mounts, the log all stand). */
function applyHidden(id) {
  const obj = entities.get(id);
  if (obj) obj.visible = bagOf(id)?.hidden !== true && !isMineHidden(id) && !isolatedOut(id);   // hidden for everyone, or just in my view (myview.js: the eye, isolate)
  else if (standIns.has(id)) placeStandIn(id);   // its waiting children go and come with it
}
bus.on('myview', ({ id }) => applyHidden(id));

function onComp(id, type) {
  // switched off or back on: the thing and everything under it go (deepest first) or come back (the top first)
  if (type === 'disabled') { reconcileSubtree(id); bus.emit('disabled-changed', { id }); return; }
  const data = bagOf(id)?.[encName(type)] ?? null;   // the diff names components as the view spells them
  if (type === 'motion' && data == null) restAtBase(id);
  if (type === 'hidden') applyHidden(id);
  if (type === 'light') syncCompLight(id);
  if (type === 'light') relabelHost(id);
  // a mesh's own geometry follows its component in place; a mesh arriving on (or leaving) a host is a rebuild
  if (type === 'mesh') { if (kindOf(state.st.entities[id]) === 'mesh' && tracked.get(id)?.kind === 'mesh') rebuildMesh(id); else reconcileId(id); }
  if (type === 'collider') applyColliderPref(id);
  // a socket that starts (or stops) riding a part re-attaches: into the part's node at rest, or back onto its host
  if (type === 'socket') execMount(id);
  bus.emit('comp', { id, type, data });
}

/** Motion ended: rest at the logged base pose (an away-from-base stop's `place` rewrites base first). */
function restAtBase(id) {
  const obj = entities.get(id);
  const base = obj?.userData?.base;
  if (!obj || !base) return;
  obj.position.set(...base.pos);
  orientObj(obj, base);
  reindexCollider(id);
}

// ---- mounting ---------------------------------------------------------------

/** If either end isn't realized, do nothing: the spawn completion calls back via mountsTouching. `mountRel` guards
 *  re-execution: re-attaching a part socket mid-motion would re-bake the phase into the offset. */
function execMount(id) {
  const ent = state.st.entities[id];
  if (!ent) return;
  if (!ent.parent) {
    const obj = entities.get(id);
    if (obj?.userData?.mountedTo) execDismount(id, ent);
    return;
  }
  const rel = ent.parent;
  const child = entities.get(id);
  if (!child) return;
  const parent = entities.get(rel.to) || standInFor(rel.to);
  if (!parent) return;
  // a socket on a part goes INTO the part's node at its rest pose, so the scene graph carries it (and its occupants)
  // through the motion; the part node is part of the linkage identity
  const part = typeof ent?.socket?.part === 'string' ? ent.socket.part : null;
  const partNode = part && !parent.userData.standIn ? findPart(parent, part) : null;
  const relKey = JSON.stringify([rel, part, !!partNode, !!parent.userData.standIn]);
  if (child.userData.mountRel === relKey) return;   // already exactly this
  // a loop (an old log): parenting under its own descendant recurses forever every frame, so leave it standing
  for (let p = parent; p; p = p.parent) if (p === child) return;
  parent.add(child);   // transform becomes parent-relative
  child.position.set(...(rel.offset ?? [0, 0, 0]));
  applyScale(child, entScale(ent) ?? 1);   // its own: attach() and a step-out bake the carrier's in
  if (Array.isArray(rel.q) && rel.q.length === 4) child.quaternion.set(rel.q[0], rel.q[1], rel.q[2], rel.q[3]);
  else child.rotation.set(0, rel.yaw ?? 0, 0);
  if (partNode) attachAtRest(parent, partNode, child);
  // its rest is this local pose (in the part's node when it rides one): motion.js and openable.js compose onto it (I37)
  child.userData.base = { pos: child.position.toArray(), yaw: child.rotation.y, q: child.quaternion.toArray() };
  child.userData.mountedTo = rel.to;
  child.userData.mountRel = relKey;
  indexSceneMount(id, rel.to);
  // the parent's collider is what the pair collides as while attached
  removeCollider(id);
  bus.emit('mount', { id, to: rel.to });
  if (!parent.userData.standIn) pruneStandIn(rel.to);
}

/** Move `child` (posed in `host`'s frame) into `node`, a moving part somewhere under `host`, so that with the part at
 *  REST it stands exactly where it stood: its local pose in the node is (the node's rest pose in the host's frame)⁻¹ ∘
 *  its pose in the host's. A node's rest is motion.js's `mbase` once it has animated it (the pose it started from), else
 *  where it stands now (a part that has never moved is at rest). */
const _arM = new THREE.Matrix4(), _arL = new THREE.Matrix4(), _arV = new THREE.Vector3(), _arQ = new THREE.Quaternion();
function attachAtRest(host, node, child) {
  const chain = [];
  for (let n = node; n && n !== host; n = n.parent) chain.push(n);
  if (!chain.length || chain[chain.length - 1].parent !== host) return;   // not under it: stays on the host
  _arM.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i], b = n.userData.mbase;
    _arM.multiply(_arL.compose(b ? _arV.fromArray(b.pos) : n.position, b ? _arQ.fromArray(b.quat) : n.quaternion, n.scale));
  }
  child.updateMatrix();
  _arL.copy(_arM).invert().multiply(child.matrix);
  node.add(child);
  _arL.decompose(child.position, child.quaternion, child.scale);
}

// ---- stand-ins ----------------------------------------------------------------
// an unrealized carrier (far, loading, failed) still carries: children mount into a bare Group at its folded pose, so
// their transforms stay carrier-local; the real carrier re-mounts them. One per carrier, never in `entities`.
const standIns = new Map();   // carrier id -> Group

function standInFor(cid) {
  if (!state.st.entities[cid]) return null;   // a dangling parent: the child stands as a root, as it always did
  let g = standIns.get(cid);
  if (!g) {
    g = new THREE.Group();
    g.userData = { standIn: cid, noCamCollide: true, perfscopeIgnore: true, skyExempt: true };   // skyExempt: a sky build in flight must not adopt it (sky.js claimSkyAdditions)
    standIns.set(cid, g);
    scene.add(g);
    placeStandIn(cid);
  }
  return g;
}
function placeStandIn(cid) {
  const g = standIns.get(cid); if (!g) return;
  const w = worldPose(state.st.entities, cid); if (!w) return;
  g.position.set(...w.pos); g.quaternion.set(...w.q); applyScale(g, w.scale ?? 1);
  g.visible = bagOf(cid)?.hidden !== true && !isMineHidden(cid) && !isolatedOut(cid);
}
function pruneStandIn(cid) {
  const g = standIns.get(cid);
  if (g && !g.children.length) { g.parent?.remove(g); standIns.delete(cid); }
}
/** `id` moved or was re-parented in the fold: the stand-ins at or under it re-stand (their world pose composes its). */
function restandWaiting(id, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  placeStandIn(id);
  for (const cid of childrenOf(id)) restandWaiting(cid, seen);
}

function execDismount(id, ent) {
  const obj = entities.get(id);
  if (obj && obj.userData.mountedTo) {
    const was = obj.userData.mountedTo;
    scene.attach(obj);   // keeps the world transform it had
    delete obj.userData.mountedTo;
    delete obj.userData.mountRel;
    indexSceneMount(id, null);
    // plane-transition stamp wins over wherever the mount left it
    if (ent?.pos) obj.position.set(...ent.pos);
    if (ent?.q || ent?.yaw != null) orientObj(obj, ent);
    // …and the fold's scale: attach() baked the carrier's in, which a joiner (building from ent.scale) never sees
    applyScale(obj, entScale(ent) ?? 1);
    obj.userData.base = restOf(obj, ent);
    if (!obj.userData.empty) fitCollider(id, obj, { collide: colliderOf(ent), scale: obj.scale?.x || 1 });
    pruneStandIn(was);
  }
  bus.emit('mount', { id, to: null });
}

// ---- residency (§13.3 R1) ---------------------------------------------------
// demotion coarsens the projection, never the state: a far entity swaps back to a placeholder, freeing scene, collider,
// lamps and caster slot; promotion reruns the load. VRAM falls only when the shared proto evicts.

// ---- the geometry tier (#156 client contract) ------------------------------
// chosen before the fetch (lod_policy.js); the recipe comes from the running sequencer's /version (none: no lod ask).
// A lod placement is visual only: no collider or support surface until it upgrades to full on approach.
let lodRecipe = null;
lodRecipeReady.then((r) => { lodRecipe = r; }).catch(() => {});
export const modelQuality = makeModelQuality(globalThis.localStorage);
function tierFor(ent, current = null) {
  // the recipe counts only where a lod ask can cross the wire (assets.js lodNegotiable); elsewhere nothing is asked
  return chooseTier({ dist: entDist(ent), radius: residencyRadius(ent), quality: modelQuality.quality,
    recipe: lodNegotiable(ent?.model) ? lodRecipe : null, pressure: gpuPressure(), shed: modelQuality.shed, current, scale: ent?.scale ?? 1 });
}
/** The models⚙ row's behaviour (skypanel.js binds it): set the resident's dial and say whether a reduced tier can be
 *  asked from this browser at all (variants are KTX2). Out of the DOM so tools/lod-client-test.ts gates it. */
export function dialModelQuality(v) {
  const q = modelQuality.setQuality(v);
  return lodNegotiable('eidoverse/assets/models/any.glb')
    ? `models: ${q} (yours only)`
    : `models: ${q} (yours only) — reduced tiers cannot be asked from this browser; everything stays full detail`;
}
/** Same predicate as demotion: a tier swap is a demote-and-promote with the placeholder frame skipped. */
const canRetier = (id, ent) => canDemote(id, ent);

const R_HYST = 20;     // the band that keeps a walk along the edge quiet
const DIAG_DEFAULT = 12; // m, assumed bbox diagonal before geom lands: err LARGE, so a big thing loads at join (§16.2.C)
const resStats = { demotes: 0, promotes: 0, retiers: 0, retiersRefused: 0 };

function residencyRadius(ent) {
  const s = ent?.model ? libGeom.get(ent.model)?.bbox?.size : null;
  const diag = s ? Math.hypot(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0) : DIAG_DEFAULT;
  return residencyRadiusFor(diag);
}
// min(camera, avatar): in photo-mode flight, demoting the body's floor would drop it through the world
let residencyFocus = null;
export function setResidencyFocus(fn) { residencyFocus = fn; }
const _f = new THREE.Vector3();
// WORLD position: in XR the camera is a child of the rig, so camera.position is a head offset near the origin (all
// would read "close"); desktop has no parent, the same number
const _cw = new THREE.Vector3();
const camWorld = () => camera.getWorldPosition(_cw);
/** Test seam (tools/camera-world-probe): the residency/LOD distance for a folded entity. */
export const residencyDistance = (ent) => entDist(ent);
/** A parented thing's pos is in its parent's frame, so its carriers' transforms are composed onto it. */
const _rq = new THREE.Quaternion(), _rs = new THREE.Vector3(), _rup = new THREE.Vector3(0, 1, 0);
function foldWorldPos(ent, out) {
  out.set(...(ent?.pos ?? [0, 0, 0]));
  const seen = new Set();
  for (let e = ent; e?.parent?.to && !seen.has(e); ) {
    seen.add(e);
    const p = state.st.entities[e.parent.to]; if (!p) break;
    const s3 = Array.isArray(p.scale3) && p.scale3.length === 3 ? p.scale3 : null, s = typeof p.scale === 'number' ? p.scale : 1;
    out.multiply(s3 ? _rs.set(s3[0], s3[1], s3[2]) : _rs.setScalar(s));
    if (Array.isArray(p.q) && p.q.length === 4) _rq.set(p.q[0], p.q[1], p.q[2], p.q[3]); else _rq.setFromAxisAngle(_rup, p.yaw ?? 0);
    out.applyQuaternion(_rq).add(_rs.set(...(p.pos ?? [0, 0, 0])));
    e = p;
  }
  return out;
}
function entDist(ent) {
  foldWorldPos(ent, _v);
  let d = camWorld().distanceTo(_v);
  const p = residencyFocus?.();
  if (p) d = Math.min(d, _f.set(p.x, p.y, p.z).distanceTo(_v));
  return d;
}

/** Refuses what a demote can't cleanly undo; cheap fold-truth predicates. */
function canDemote(id, ent) {
  if (!ent || kindOf(ent) !== 'model' || ent.parent) return false;   // only a model has a stand-in (a mesh has no bytes to shed); mounted children ride carriers
  const obj = entities.get(id);
  if (!obj || isPlaceholder(obj) || editHolds.has(id)) return false;
  if (!libGeom.get(ent.model)?.bbox) return false;    // nothing honest to stand in
  // a carrier with cargo refuses (stepping cargo off is a removal); its own sockets don't count unless one rides a part
  // or carries something
  const kids = childrenOf(id);
  for (const k of kids) { const sk = state.st.entities[k]?.socket; if (!sk || typeof sk.part === 'string' || childrenOf(k).length) return false; }
  // an occupied seat refuses, wherever WE are standing
  // the scan stays: avatarMounts is occupant-keyed and bounded by bodies present, not entities
  for (const rel of avatarMounts.values()) if (rel.to === id || kids.includes(rel.to)) return false;
  const bag = recordComponents(state.st.entities[id]);
  if (bag) {
    // part motions and sockets need named nodes a placeholder lacks; whole-entity motion is fine (userData.base)
    if (bag.motion?.part) return false;
    for (const k in bag) if (k.startsWith('motion:')) return false;
  }
  return true;   // flights rest in seconds and punts are near-range: distance excludes them
}

function demote(id) {
  const ent = state.st.entities[id];
  const obj = entities.get(id);
  // its sockets (canDemote let only bare ones through) step off onto the scene and re-attach to the stand-in below
  const socks = [...(sceneChildren.get(id) ?? [])].filter((k) => entities.get(k)?.userData?.socket);
  for (const k of socks) { const so = entities.get(k); scene.attach(so); delete so.userData.mountRel; }
  teardownRealized(id, obj, 'demote');   // a demoted stand-in must not inherit the real model's collider/lamps
  (obj.parent ?? scene).remove(obj);
  const grp = makePlaceholder(id, ent, libGeom.get(ent.model));
  entities.set(id, grp);
  scene.add(grp);
  applyHidden(id);   // hidden survives the stand-in box (placeholder / demote)
  syncCompLight(id); // the lamp's light follows it onto the stand-in
  resStats.demotes++;
  for (const k of socks) execMount(k);
  bus.emit('entity', { id, kind: 'demote' });   // emitters retire their handle
}

let lastEvict = 0;
/** One residency beat (2 Hz); exported so tools/lod-client-test.ts can beat it deterministically. */
export function residencySweep() {
  // the VRAM tier (R2): every ~5 s, over budget, zero-ref protos dispose
  const now = Date.now();
  if (now - lastEvict > 5000) {
    lastEvict = now;
    evictIdleProtos().catch(() => {});
  }
  for (const [id, t] of tracked) {
    if (t.kind !== 'model') continue;
    const ent = state.st.entities[id];
    if (!ent) continue;
    const obj = entities.get(id);
    const R = residencyRadius(ent);
    const d = entDist(ent);
    if (obj && !isPlaceholder(obj) && d > R + R_HYST) {
      if (canDemote(id, ent)) demote(id);
    // inside the radius a realized placement may want the other tier; hysteresis lives in the policy, the cooldown
    // stops stacking swaps, and the new tier replaces in place (no placeholder frame)
    } else if (obj && !isPlaceholder(obj) && !t.loading && obj.userData.lib) {
      const asked = obj.userData.tierAsked ?? obj.userData.tier ?? 'full';
      const want = tierFor(ent, asked);
      if (want !== asked && now - (t.retierAt ?? 0) > 5000 && canRetier(id, ent)) {
        t.retierAt = now;
        resStats.retiers++;
        scheduleLoad(id, ent, regen(id), want);
      }
    // both stand-in shapes (placeholders and null reservations) promote by distance. Invariant: within its radius an
    // entity eventually loads; beyond it, it never fetches a byte (§16.2.C)
    } else if ((obj === null || isPlaceholder(obj)) && d < R && !t.loading
      && (!t.failedAt || now - t.failedAt > 30000)) {
      resStats.promotes++;
      scheduleLoad(id, ent, regen(id));   // stale in-flight completions no-op
    }
  }
}

export const residencyDebug = () => {
  let real = 0, standins = 0, loading = 0, waiting = 0;
  for (const [id, t] of tracked) {
    if (t.kind !== 'model') continue;
    const obj = entities.get(id);
    // a bare reservation is "loading" only while a job is in flight; far ones are "waiting"
    if (obj === null) (t.loading ? loading++ : waiting++);
    else if (isPlaceholder(obj)) standins++;
    else if (obj) real++;
  }
  let lod = 0, lodAsked = 0;   // served vs asked: the gap is the server's honest fall-throughs
  for (const obj of entities.values()) {
    if (obj?.userData?.tier === 'lod') lod++;
    if (obj?.userData?.tierAsked === 'lod') lodAsked++;
  }
  return { real, standins, loading, waiting, lod, lodAsked, quality: modelQuality.quality, recipe: lodRecipe, ...resStats, rBase: R_BASE, rHyst: R_HYST };
};

// ---- reconcile + dispatch ---------------------------------------------------

/** A thing and everything under it, after it was switched off or on (or moved under / out from under something off): off
 *  goes deepest first, on comes top first, by real depth, with the parent index rebuilt so each load re-seats its occupants. */
function reconcileSubtree(id) {
  const E = state.st.entities; const depth = (k) => { let n = 0; for (let p = E[k]?.parent?.to; p && n < 33; p = E[p]?.parent?.to) n++; return n; };
  const under = Object.keys(E).filter((k) => { for (let p = E[k]?.parent?.to, n = 0; p && n < 33; p = E[p]?.parent?.to, n++) if (p === id) return true; return false; });
  const order = [id, ...under].sort((a, b) => depth(a) - depth(b)); const off = offIn(E, id); if (off) order.reverse();
  for (const k of order) reconcileId(k);
  if (!off) for (const k of order) execMount(k);   // (a no-op until both ends are realized; the load's own callback finishes it)
}
/** Create, retire, rebuild, or refresh: the fold's current word is final. */
function reconcileId(id) {
  const ent = state.st.entities[id];
  const t = tracked.get(id);
  if (!ent || offIn(state.st.entities, id)) { if (t || entities.has(id)) retire(id); return; }
  const kind = kindOf(ent);
  if (!t) { CREATE[kind](id, ent); return; }
  if (t.kind !== kind || (kind === 'model' && t.model !== ent.model)) {
    retire(id);
    CREATE[kind](id, ent);
    return;
  }
  if (kind === 'mesh') rebuildMesh(id);
  refreshModel(id, ent);
  if (kind !== 'model') { emitCompBag(id); execMount(id); }
}

/** Hydration and reconnect; reconcile ∘ reconcile = reconcile (§11.4). */
export function reconcileModels() {
  const view = new Map([...tracked].map(([id, t]) => [id, { kind: t.kind, model: t.model, mesh: t.mesh }]));
  const { create, retire: dead } = planReconcile(state.st.entities, view);
  for (const id of dead) retire(id);
  const created = new Set(create.map((c) => c.id));
  for (const { id, ent } of create) CREATE[kindOf(ent)](id, ent);
  // survivors refresh in place — a reconnect may have moved anything
  for (const [id, t] of tracked) {
    if (created.has(id) || !state.st.entities[id]) continue;
    const ent = state.st.entities[id];
    refreshModel(id, ent);
    emitCompBag(id);
    execMount(id);
  }
}

/** One thing changed (state.js: said in the protocol's terms). The fold has already written state. */
function onChange({ id, what, comp }) {
  try {
    const ent = state.st.entities[id];
    switch (what) {
      case 'born':
      case 'gone':
        reconcileId(id);
        // a re-born thing keeps no stale bag: the light follows the new one
        if (what === 'born') syncCompLight(id);
        break;
      case 'pose':
        if (ent) refreshModel(id, ent);
        syncCompLight(id);   // a parked light (model still loading) moves with the fold
        if (standIns.size) restandWaiting(id);
        break;
      case 'parent':
        // moved under (or out from under) a switched-off thing: it goes or comes with its new parent
        if (offIn(state.st.entities, id) !== !(entities.has(id) || tracked.has(id))) { reconcileSubtree(id); break; }
        if (ent?.parent) execMount(id);
        else if (entities.has(id) || tracked.has(id)) execDismount(id, ent);
        if (standIns.size) restandWaiting(id);
        break;
      case 'comp':
        onComp(id, comp);
        break;
    }
  } catch (e) { report(`realize ${what} ${id}`, e); }
}

/** Wire the realizer to state. Called once from main.js. */
export function initModelsRealizer() {
  // geom lands a beat after the snapshot: upgrade every bare reservation the moment sizes are known
  bus.on('lib-geom', (geom) => {
    for (const [lib, g] of Object.entries(geom ?? {})) libGeom.set(lib, g);
    for (const id of tracked.keys()) maybePlaceholder(id);
  });
  // thingphysics: a launched body leaves its carrier (scene.attach keeps where it is); its rest's parent record re-mounts it
  bus.on('flight-detach', ({ id }) => {
    const obj = entities.get(id); if (!obj || !obj.parent || obj.parent.isScene) return;
    scene.attach(obj); delete obj.userData.mountedTo; delete obj.userData.mountRel; indexSceneMount(id, null);
  });
  bus.on('edit-mode', (on) => {
    editing = !!on;
    for (const [id, t] of tracked) if (t.kind !== 'model' && t.kind !== 'socket' && entities.get(id)) setEmptyMarker(entities.get(id), editing);
  });
  // a gesture the authority refused, or one cancelled with Esc (worlds, editwrites.js): the preview snaps back to the fold.
  // A mounted child's pose is its mount's (parent-relative), which execMount skips when the linkage is unchanged.
  bus.on('pose-revert', ({ id }) => {
    const ent = state.st.entities[id]; const obj = entities.get(id);
    if (!ent || !obj) return;
    // a refused or cancelled mesh scrub previewed a geometry the fold never took: back to the fold's, collider too
    if (tracked.get(id)?.kind === 'mesh') { tracked.get(id).mesh = null; rebuildMesh(id); }
    if (obj.userData.mountedTo && ent.parent) {
      if (typeof ent?.socket?.part === 'string') { delete obj.userData.mountRel; execMount(id); bus.emit('entity', { id, kind: 'place' }); return; }   // in a part, at rest
      obj.position.set(...(ent.parent.offset ?? [0, 0, 0]));
      if (Array.isArray(ent.parent.q) && ent.parent.q.length === 4) obj.quaternion.set(...ent.parent.q);
      if (ent.scale != null) applyScale(obj, entScale(ent));
      bus.emit('entity', { id, kind: 'place' });
      return;
    }
    refreshModel(id, ent);
  });
  // fold positions in, demote/promote out; 500 ms is ~3 m at a run
  setInterval(residencySweep, 500);
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') {
      reconcileModels();
    } else if (ev.type === 'reset') {
      // a real teardown: a populated scene with empty tracking re-creates every id ON TOP of its orphan on rehydrate
      for (const id of [...tracked.keys()]) retire(id);
      sceneChildren.clear();
      sceneParentOf.clear();
      for (const g of standIns.values()) g.parent?.remove(g);
      standIns.clear();
    } else if (ev.type === 'change') onChange(ev);
  });
  return true;
}
