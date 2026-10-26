// colliders — the physical reading of placed geometry: each object gets an OBB (local AABB + yaw) fit from its own geometry.
// Boxy things block and their tops are walkable; tall small-footprint things (streetlights) collide as a slim centre
// pillar, so you walk under what they carry; room-sized things collide against their real triangles, so you can walk in.
// Layer-0 affordances come from the same data: a walkable surface is sittable and placeable-on, unauthored.

import { THREE } from './core.js';
import { MOVER } from '../../shared/mover.js';
import { bus } from './base.js';
import { MeshBVH, estimateMemoryInBytes } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gridAccumulator, decideSupportClass, validTopGrid, LIE_GRID } from './supportclass.js';

const UP = new THREE.Vector3(0, 1, 0);
export const colliders = new Map(); // entity id -> { obj, box, pillar, exact?, interior, cell }

// ---- exact (trimesh) colliders ----------------------------------------------
// Room-scale things (supportclass.js ROOM_MIN_*) collide against their triangles via a BVH, since a box seals the
// room: floor = downward raycast, walls = closest-point at HIP. `collide: "exact" | "box"` forces either way.
// Body size is the MOVER's (shared/mover.js MOVER.body); only the wall-probe height is this file's.
const HIP = 0.95;    // wall-probe height: floors stay > r away, walls don't

// every mesh opted out (glTF extras collision:false) = NOT solid; distinct from "no exact collider", which falls back to a box/pillar
const NON_SOLID = Object.freeze({ nonSolid: true });
function buildExact(obj) {
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const geoms = [];
  let meshes = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    meshes++;
    // glTF extras preserve non-solid panes, pool surfaces, and decorative parts.
    for(let parent=o;parent&&parent!==obj.parent;parent=parent.parent)
      if(parent.userData?.collision===false)return;
    const relative = new THREE.Matrix4().multiplyMatrices(inv,o.matrixWorld);
    const instance = new THREE.Matrix4(), transform = new THREE.Matrix4();
    for(let i=0;i<(o.isInstancedMesh?o.count:1);i++){
      transform.copy(relative);
      if(o.isInstancedMesh){o.getMatrixAt(i,instance);transform.multiply(instance);}
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(transform);
      const clean = new THREE.BufferGeometry();
      clean.setAttribute('position',g.getAttribute('position'));
      geoms.push(clean);
    }
  });
  if (!geoms.length) return meshes ? NON_SOLID : null;
  return { bvh: new MeshBVH(mergeGeometries(geoms, false)) };
}

// ---- per-lib shared derivations (§16.2.C) ------------------------------------
// Fits are root-local and scale-free, so pristine clones of a lib share geometry, BVH and lie (keyed by lib path).
// Only pristine fits (models.js passes `lib`) WRITE it; refit-time reads are safe. CPU heap only, refcounted by its wearers.
const libCache = new Map(); // lib -> { refs, lie?, exact?: {bvh, interior} }

/** CPU bytes and refcounts per cached lib. */
export const colliderCacheStats = () => {
  const libs = [];
  let bytes = 0;
  for (const [lib, c] of libCache) {
    let b = 0;
    if (c.exact) { try { b = estimateMemoryInBytes(c.exact.bvh); } catch { /* debug util, best-effort */ } }
    bytes += b;
    libs.push({ lib, refs: c.refs, exact: !!c.exact, lie: c.lie ?? null, bytes: b });
  }
  return { libs, bytes };
};

const _lbInv = new THREE.Matrix4();
const _lbRel = new THREE.Matrix4();
const _lbBox = new THREE.Box3();
/** The root-local bounding box at ANY current transform (inv(root) folds the pose out): every consumer treats
 *  `box` as root-local, and the promote tail fits after the spawn transform lands. */
function localBox(obj) {
  obj.updateMatrixWorld(true);
  _lbInv.copy(obj.matrixWorld).invert();
  const box = new THREE.Box3();
  obj.traverse((o) => {
    const g = o.geometry;
    if (!g) return;
    if (g.boundingBox === null) g.computeBoundingBox();
    if (!g.boundingBox || g.boundingBox.isEmpty()) return;
    _lbRel.multiplyMatrices(_lbInv,o.matrixWorld);
    const instance=new THREE.Matrix4(),transform=new THREE.Matrix4();
    for(let i=0;i<(o.isInstancedMesh?o.count:1);i++){
      transform.copy(_lbRel);
      if(o.isInstancedMesh){o.getMatrixAt(i,instance);transform.multiply(instance);}
      _lbBox.copy(g.boundingBox).applyMatrix4(transform);box.union(_lbBox);
    }
  });
  return box;
}

// ---- spatial hash -----------------------------------------------------------
// Bucketed by world-space cell; a query tests only the 3×3 neighbourhood around it.
const CELL = 8; // metres
const buckets = new Map();
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function bucketAdd(id, entry) {
  // an OBB can straddle cells — register in every cell its footprint touches
  const { obj } = entry; const { box } = frameOf(entry);   // a thing lying down is filed by its true footprint
  const s = obj.scale?.x || 1; // imports land wrong-sized and get resized in-world
  const r = Math.max(
    Math.abs(box.min.x), Math.abs(box.max.x),
    Math.abs(box.min.z), Math.abs(box.max.z),
  ) * s;
  entry.cells = [];
  const x0 = Math.floor((obj.position.x - r) / CELL), x1 = Math.floor((obj.position.x + r) / CELL);
  const z0 = Math.floor((obj.position.z - r) / CELL), z1 = Math.floor((obj.position.z + r) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = `${cx},${cz}`;
      if (!buckets.has(k)) buckets.set(k, new Set());
      buckets.get(k).add(id);
      entry.cells.push(k);
    }
  }
}
function bucketRemove(id, entry) {
  for (const k of entry?.cells ?? []) {
    const s = buckets.get(k);
    if (s) { s.delete(id); if (!s.size) buckets.delete(k); }
  }
}

const _fray = new THREE.Ray();
// does it contain its OWN floor (rays down from mid-height)? Feeds only the grass clearing mask, never walkability
function hasFloor(bvh, box, s) {
  const midY = (box.min.y + box.max.y) / 2;
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  let hits = 0, n = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      // inset to 20%..80%: wall-hugging samples would hit the walls, and every hollow box would read as floored
      _fray.origin.set(box.min.x + w * (0.2 + 0.2 * i), midY, box.min.z + d * (0.2 + 0.2 * j));
      _fray.direction.set(0, -1, 0);
      n++;
      const hit = bvh.raycastFirst(_fray, THREE.DoubleSide);
      if (!hit) continue;
      // horizontal-ish only: a wall under the ray is no floor (sign ignored: a deck's back-faces point down)
      const ny = hit.face?.normal?.y;
      if (ny == null || Math.abs(ny) > 0.5) hits++;
    }
  }
  return hits / n >= 0.35;
}

// ---- the uneven-top probe ---------------------------------------------------
// Top lie = bbox top minus the median cell top of a vertex grid (#11); the math is supportclass.js's, shared with headless.
// No BVH on purpose: the BVH is what decide() is pricing. Survey: tools/collider-survey.ts.
export function topLie(obj, box) {   // exported for the classifier-parity fixture (#94)
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  const acc = gridAccumulator(box.min.x, box.min.z, w, d);
  if (!acc) return 0;
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    rel.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(rel);
      acc.add(v.x, v.y, v.z);
    }
  });
  return acc.finish(box.max.y).lie;
}

/** `fresh`: a pristine-clone fit, the only kind that may WRITE the shared derivations. */
function decide(entry, s, fresh = false) {
  const { box, pref } = entry;
  // SIZE decides walkability (one exception below); no "hollow" probe: it can't tell a trunk from a pavilion's bell.
  // A per-object `collide` still wins.
  const w = (box.max.x - box.min.x) * s, d = (box.max.z - box.min.z) * s;
  const h = (box.max.y - box.min.y) * s;
  // shape gates come from supportclass.js; the numbers in the comments below are ITS constants
  const { roomScale } = decideSupportClass({ w, d, h });
  // The exception: floor-shaped things whose box top lies (blankets, rugs) collide exact (#11); thresholds
  // in supportclass.js. The lie probe is per lib and scale-free, and runs only when the shape gate asks.
  const { floorShaped } = decideSupportClass({ w, d, h });
  const shared = entry.cacheKey ? libCache.get(entry.cacheKey) : null;
  if (floorShaped && entry.lie == null) {
    if (shared && shared.lie != null) entry.lie = shared.lie;
    else {
      entry.lie = topLie(entry.obj, box);
      if (shared && fresh) shared.lie = entry.lie;
    }
  }
  const uneven = floorShaped
    && decideSupportClass({ w, d, h, lie: (entry.lie ?? 0) * s }).uneven;
  const exact = pref === 'exact' ? true : pref === 'box' ? false : (roomScale || uneven);
  if (exact && !entry.exact) {
    if (shared?.exact) entry.exact = shared.exact;
    else {
      const built = buildExact(entry.obj);
      if (built === NON_SOLID) { if (shared && fresh) shared.exact = built; }
      else if (built) {
        // hasFloor reads only the local bvh + box, so the verdict rides the shared product: computed once, not 16 rays per clone
        built.interior = hasFloor(built.bvh, box, s);
        if (shared && fresh) shared.exact = built;
      }
      entry.exact = built;
    }
  }
  entry.nonSolid = exact && entry.exact === NON_SOLID;   // every mesh opted out: nothing to stand on or bump
  if (!exact || entry.nonSolid) entry.exact = null;         // small/solid: use pillar/box, no trimesh
  entry.pillar = !entry.exact && (box.max.y - box.min.y) * s > 2.4;
  // Clearing is separate from collision: only things with a real floor suppress the meadow (no bald ring under a palm).
  entry.interior = entry.exact ? entry.exact.interior : false;
}

/** `lib`: share per-lib derivations; ONLY for a pristine clone (models.js's promote tail). `localFrame`: box in the
 *  root-local frame at any transform, required when fitting after the spawn transform landed. */
export function fitCollider(id, obj, { collide, scale = 1, lib = null, localFrame = false } = {}) {
  const box = localFrame ? localBox(obj) : new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  removeCollider(id);   // a re-fit REPLACES: drop the old entry's bucket cells + lib ref
  // camGhost hoisted from userData (the flag lives on roots) so the camera query never touches the object graph
  const entry = { obj, box, pref: collide, pillar: false, exact: null, cells: [],
    camGhost: !!obj.userData?.noCamCollide, cacheKey: lib };   // the libCache key (the model's path), not a record field
  if (lib) {
    const c = libCache.get(lib) ?? { refs: 0 };
    c.refs++;
    libCache.set(lib, c);
  }
  decide(entry, scale, Boolean(lib));
  if (entry.nonSolid) {   // decorative throughout: register nothing (and give back the lib ref taken above)
    if (lib) { const c = libCache.get(lib); if (c && --c.refs <= 0) libCache.delete(lib); }
    return;
  }
  colliders.set(id, entry);
  bucketAdd(id, entry);
}

/** Support from DATA (/geom bboxes and floor decks) for a model headless couldn't decode (#17). Not decide()
 *  (its probes need triangles): always a box; room-scale floors come as thin slabs, never a sealing block.
 *  `min`/`max` are entity-LOCAL, like fitCollider's box. */
export function fitSupportBox(id, min, max, { position, yaw = 0, scale = 1 } = {}) {
  const box = new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2]),
  );
  if (box.isEmpty()) return;
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: { y: yaw },
    scale: new THREE.Vector3(scale, scale, scale),
  };
  const entry = { obj, box, pref: 'box', exact: null, interior: false, cells: [] };
  // as decide(): tall small-footprint things collide as a slim centre pillar, not their canopy extents
  entry.pillar = (box.max.y - box.min.y) * scale > 2.4;
  colliders.set(id, entry);
  bucketAdd(id, entry);
}

/** Heightfield support from a served topGrid (#84), for floor-shaped assets whose box top lies: the same grid
 *  decide() uses to detect the lie IS the floor here. Support only, model-local. Returns false for anything
 *  validTopGrid refuses; the caller then abstains, never falls back to the box top. */
export function fitSupportGrid(id, topGrid, { position, yaw = 0, scale = 1 } = {}) {
  if (!validTopGrid(topGrid)) return false;
  if (![position].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
      || !Number.isFinite(yaw) || !Number.isFinite(scale) || !(scale > 0)) return false;
  const [minX, minZ] = topGrid.minXZ, [w, d] = topGrid.sizeXZ;
  let lo = Infinity, hi = -Infinity;
  for (const c of topGrid.cells) if (c !== null) { if (c < lo) lo = c; if (c > hi) hi = c; }
  const box = new THREE.Box3(
    new THREE.Vector3(minX, lo, minZ),
    new THREE.Vector3(minX + w, hi, minZ + d),
  );
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: { y: yaw },
    scale: new THREE.Vector3(scale, scale, scale),
  };
  const entry = { obj, box, pref: 'box', exact: null, interior: false, pillar: false, cells: [],
    grid: { n: topGrid.n, minX, minZ, w, d, tops: topGrid.cells } };
  colliders.set(id, entry);
  bucketAdd(id, entry);   // radial footprint: the world bounds follow yaw and scale
  return true;
}

// ---- declared structure boxes -----------------------------------------------
// Buildings declare their boxes (shared/structure.js plans, realize/structure.js calls this), so decide() never runs.
// Deliberately no pillar rule (a 2.8m wall is no post) and no `interior` (physobj and ragdolls SKIP interior
// entries, so bodies would fall through); the grass mask gets its own `mask` entry.
const structureIds = new Map(); // owner entity id -> synthetic collider ids

/** Register a building's boxes (grid-LOCAL metres), one entry each so the spatial hash still prunes. */
export function fitStructureBoxes(ownerId, boxes, { position, yaw = 0, scale = 1 } = {}) {
  removeStructureBoxes(ownerId);
  if (!Array.isArray(boxes) || !boxes.length) return 0;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return 0;
  if (!Number.isFinite(yaw) || !Number.isFinite(scale) || !(scale > 0)) return 0;
  const obj = {
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: { y: yaw },
    scale: new THREE.Vector3(scale, scale, scale),
  };
  const ids = [];
  let lo = null, hi = null;
  for (const b of boxes) {
    if (![b?.x0, b?.y0, b?.z0, b?.x1, b?.y1, b?.z1].every(Number.isFinite)) continue;
    const box = new THREE.Box3(
      new THREE.Vector3(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.min(b.z0, b.z1)),
      new THREE.Vector3(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1), Math.max(b.z0, b.z1)),
    );
    if (box.isEmpty()) continue;
    const id = `${ownerId}#s${ids.length}`;
    // `structOwner`: whose wall it hit, without parsing the synthetic key
    const kind = b.kind ?? 'wall';
    const entry = { obj, box, pref: 'box', exact: null, interior: false, pillar: false,
      // floors hold you up; they never push you sideways (see resolveColliders)
      support: kind === 'floor', cells: [], structOwner: ownerId, structKind: kind };
    colliders.set(id, entry);
    bucketAdd(id, entry);
    ids.push(id);
    lo = lo ? lo.min(box.min) : box.min.clone();
    hi = hi ? hi.max(box.max) : box.max.clone();
  }
  // The grass mask: one non-colliding rect entry (flora paints a rect), so an L-shaped building over-clears a little.
  if (lo && hi) {
    const id = `${ownerId}#mask`;
    const entry = { obj, box: new THREE.Box3(lo, hi), pref: 'box', exact: null,
      interior: true, mask: true, pillar: false, cells: [], structOwner: ownerId };
    colliders.set(id, entry);
    bucketAdd(id, entry);
    ids.push(id);
  }
  structureIds.set(ownerId, ids);
  return ids.length;
}

/** Idempotent: the realizer calls it on retire and again at the head of every re-fit. */
export function removeStructureBoxes(ownerId) {
  const ids = structureIds.get(ownerId);
  if (!ids) return;
  for (const id of ids) removeCollider(id);
  structureIds.delete(ownerId);
}

/** For the realizer's ownership check and the debug overlay's per-building colour. */
export const structureBoxIds = (ownerId) => structureIds.get(ownerId) ?? [];

/** After an in-world rescale: re-decides exact-vs-box at the NEW size (a scaled-up dollhouse becomes walkable-inside), re-buckets. */
export function refitCollider(id) {
  const e = colliders.get(id);
  if (!e) return;
  bucketRemove(id, e);
  decide(e, e.obj.scale?.x || 1);
  if (!suspended.has(id)) bucketAdd(id, e);
}
// the realizer's word that a realized object is going (realize/lifecycle.js): its collider goes with it
bus.on('realized', ({ id }) => removeCollider(id));
export function removeCollider(id) {
  suspended.delete(id);
  const e = colliders.get(id);
  if (e) {
    bucketRemove(id, e);
    if (e.cacheKey) {
      const c = libCache.get(e.cacheKey);
      // zero refs: nothing resident wears this lib's derivations; drop CPU geometry + BVH for GC (demote/delete land here)
      if (c && --c.refs <= 0) libCache.delete(e.cacheKey);
    }
  }
  colliders.delete(id);
}
/** A thing in a hand or in the air (thingphysics.js) isn't where its collider was: take it out of the walking world's grid
 *  while it is (on = true), and put it back where it is now (on = false). The entry itself is kept. */
const suspended = new Set();
export function suspendCollider(id, on) {
  const e = colliders.get(id);
  if (on) { if (!e || suspended.has(id)) return; bucketRemove(id, e); e.cells = []; suspended.add(id); return; }
  if (!suspended.delete(id) || !e) return;
  bucketAdd(id, e);
}
export const isSuspended = (id) => suspended.has(id);
export function reindexCollider(id) {
  const e = colliders.get(id);
  if (!e || suspended.has(id)) return;
  bucketRemove(id, e);
  bucketAdd(id, e);
}

/** Where a thing VISIBLY is: its collider box's world centre, since a GLB's origin can sit metres off the mesh
 *  (§24t-4). Null when the id has no collider. */
const _ecV = new THREE.Vector3();
export function entityWorldCenter(id, out = new THREE.Vector3()) {
  const c = colliders.get(id);
  const obj = c?.obj;
  if (!c?.box || !obj) return null;
  const sc = obj.scale ?? _ecV.set(1, 1, 1); const F = frameOf(c);
  out.copy(F.box.min).add(F.box.max).multiplyScalar(0.5)
    .multiply(_ecV.set(sc.x || 1, sc.y || 1, sc.z || 1))
    .applyAxisAngle(UP, F.yaw)
    .add(obj.position);
  return out;
}

// ---- scope: whose world a query is about -----------------------------------
// An agent process holds several worlds' colliders (`entry.scope`, set by mcpl/physics.ts); while a scope is
// active, queries see only that world's entries and unscoped ones. A browser never sets one.
let activeScope = null;
export function setColliderScope(s) { activeScope = s ?? null; }
export const colliderScope = () => activeScope;
const inScope = (e) => activeScope === null || e.scope == null || e.scope === activeScope;

function* near(x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const s = buckets.get(`${cx + i},${cz + j}`);
      if (!s) continue;
      for (const id of s) {
        const e = colliders.get(id);
        if (e && inScope(e)) yield e;
      }
    }
  }
}

/** Variable-radius neighbourhood, [id, entry] pairs (§14.2 6a), deduped across cells.
 *  ⚠️ NOT REENTRANT: the dedupe Set is shared, so never start a second iteration inside one; collect first. */
const _seen = new Set();
export function* nearColliders(x, z, r = CELL) {
  const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
  const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
  _seen.clear();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const s = buckets.get(`${cx},${cz}`);
      if (!s) continue;
      for (const id of s) {
        if (_seen.has(id)) continue;
        _seen.add(id);
        const e = colliders.get(id);
        if (e && inScope(e)) yield [id, e];
      }
    }
  }
}

// ---- camera segment query (§14.2 6a — hot-path offender #1) -----------------
// How far back the camera may sit, from the grid: a slab test per entry's OBB in the cells the ≤6m segment
// overlaps; exact entries raycast their BVH (doorways) and pillars test the post (canopies don't yank it).

const _rsO = new THREE.Vector3();
const _rsD = new THREE.Vector3();
const _rsRay = new THREE.Ray();
const _rsPost = new THREE.Box3();
const _rsSeen = new Set();

function slabT(o, d, box, far) {
  let t0 = 0, t1 = far;
  for (const ax of ['x', 'y', 'z']) {
    const dv = d[ax];
    if (Math.abs(dv) < 1e-9) {
      if (o[ax] < box.min[ax] || o[ax] > box.max[ax]) return null;
      continue;
    }
    let a = (box.min[ax] - o[ax]) / dv;
    let b = (box.max[ax] - o[ax]) / dv;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  return t0;   // 0 when the origin starts inside — a solid box is solid
}

/** Nearest blocking distance along origin+dir, within `far`; null = clear.
 *  camGhost entries (gizmos, placeholders) never block. */
export function raySegment(origin, dir, far, ignoreId = null) {
  let bestT = Infinity;
  const ex = origin.x + dir.x * far, ez = origin.z + dir.z * far;
  const x0 = Math.floor(Math.min(origin.x, ex) / CELL) - 1;
  const x1 = Math.floor(Math.max(origin.x, ex) / CELL) + 1;
  const z0 = Math.floor(Math.min(origin.z, ez) / CELL) - 1;
  const z1 = Math.floor(Math.max(origin.z, ez) / CELL) + 1;
  _rsSeen.clear();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const set = buckets.get(`${cx},${cz}`);
      if (!set) continue;
      for (const id of set) {
        if (id === ignoreId || _rsSeen.has(id)) continue;
        _rsSeen.add(id);
        const e = colliders.get(id);
        if (!e || e.camGhost || e.mask || !e.box || !inScope(e)) continue;
        const o = e.obj;
        const s = o.scale?.x || 1;
        const F = frameOf(e); const yaw = F.yaw;
        _rsO.copy(origin).sub(o.position);
        _rsD.copy(dir);
        if (yaw) { _rsO.applyAxisAngle(UP, -yaw); _rsD.applyAxisAngle(UP, -yaw); }
        _rsO.divideScalar(s);
        const lfar = Math.min(far, bestT) / s;
        if (F.exact?.bvh) {
          _rsRay.origin.copy(_rsO);
          _rsRay.direction.copy(_rsD);
          const hit = F.exact.bvh.raycastFirst(_rsRay, THREE.DoubleSide);
          if (hit && hit.distance <= lfar) bestT = hit.distance * s;
          continue;
        }
        let box = F.box;
        if (F.pillar) {
          const mx = (F.box.min.x + F.box.max.x) / 2, mz = (F.box.min.z + F.box.max.z) / 2;
          _rsPost.min.set(mx - 0.25, F.box.min.y, mz - 0.25);
          _rsPost.max.set(mx + 0.25, F.box.max.y, mz + 0.25);
          box = _rsPost;
        }
        const t = slabT(_rsO, _rsD, box, lfar);
        if (t !== null) bestT = t * s;
      }
    }
  }
  return bestT === Infinity ? null : bestT;
}

// ---- resolution -------------------------------------------------------------

let blockedTop = null;
export const lastBlockedTop = () => blockedTop;
const touched = new Set();
/** The collider entries the last resolveColliders call pushed against or stood on (read right after the call). */
export const lastContacts = () => touched;

const _local = new THREE.Vector3();
const _push = new THREE.Vector3();
const _exits = [
  { d: 0, x: 1, z: 0 }, { d: 0, x: -1, z: 0 },
  { d: 0, x: 0, z: 1 }, { d: 0, x: 0, z: -1 },
];

/** Push `pos` out of anything solid and return the ground height under it. Mutates pos.x/z, never pos.y; `r` is
 *  a HORIZONTAL radius. `tall` (height above pos.y) decides what fits underneath and scales step-up and wall probe. */
const _ray = new THREE.Ray();
const _hip = new THREE.Vector3();
const _cp = {};

// `climbs`: may this body mantle (sets lastBlockedTop)? The walking avatar passes true, so a smaller chosen size
// (bodyscale.js colliderFor) keeps its mantle; a ragdoll joint never climbs.
// ---- a thing's frame for the yaw-only readers below ----------------------------
// Readers are root-local, yaw only: exact while upright. A tumbled thing's rotation.y is unreadable (XYZ Euler flips
// past 90°), so it gets its true horizontal yaw and its box in that frame, and loses exact collision.
const UPRIGHT = Math.cos(10 * Math.PI / 180);
const _fm = new THREE.Matrix4(), _fy = new THREE.Matrix4();
export function frameOf(e) {
  const o = e.obj, r = o.rotation, f = (e._f ??= { yaw: 0, box: e.box, exact: e.exact, pillar: e.pillar, grid: e.grid, qx: NaN, qy: NaN, qz: NaN, qw: NaN });
  if (!r || (!r.x && !r.z) || !o.quaternion) { f.yaw = r?.y ?? 0; f.box = e.box; f.exact = e.exact; f.pillar = e.pillar; f.grid = e.grid; f.qx = NaN; return f; }
  const q = o.quaternion;
  // keyed on everything a refit (decide) may change in place: the box, its exactness, its pillar and grid readings
  if (q.x === f.qx && q.y === f.qy && q.z === f.qz && q.w === f.qw && f.src === e.box && f.ex === e.exact && f.pi === e.pillar && f.gr === e.grid) return f;
  const te = _fm.makeRotationFromQuaternion(q).elements;   // column k (a local axis in the world) = te[4k..4k+2]
  const ups = [te[1], te[5], te[9]].map(Math.abs); const k = ups.indexOf(Math.max(...ups)); const j = k === 0 ? 1 : 0;
  f.yaw = Math.atan2(-te[4 * j + 2], te[4 * j]);
  const standing = k === 1 && te[5] > UPRIGHT;
  // lying, it is its box: no trimesh, no slim post (a fallen tree is a log), no heightfield (measured upright)
  if (standing) { f.box = e.box; f.exact = e.exact; f.pillar = e.pillar; f.grid = e.grid; }
  else { f.box = e.box.clone().applyMatrix4(_fy.makeRotationY(-f.yaw).multiply(_fm)); f.exact = null; f.pillar = false; f.grid = null; }
  f.qx = q.x; f.qy = q.y; f.qz = q.z; f.qw = q.w; f.src = e.box; f.ex = e.exact; f.pi = e.pillar; f.gr = e.grid;
  return f;
}

export function resolveColliders(pos, terrainAt, r = MOVER.body.radius, tall = MOVER.body.height, climbs = tall >= MOVER.body.height) {
  blockedTop = null; touched.clear();
  let ground = terrainAt(pos.x, pos.z);
  // Shared by the avatar and 3cm ragdoll joints, so vertical numbers scale with `tall` and are never constants.
  // a climbing body's step is the mover's, in proportion to its size; a ragdoll joint does not climb stairs
  const step = climbs ? MOVER.body.step * (tall / MOVER.body.height) : Math.min(MOVER.body.step, tall * 0.3);
  const probeY = Math.min(HIP, tall * 0.5);  // mid-body, not "hip"
  const spanY = Math.max(r, tall * 0.26);    // how far up/down a wall hit counts
  for (const e0 of near(pos.x, pos.z)) {
    const { obj, mask, support } = e0; const { yaw, box, exact, pillar, grid } = frameOf(e0);
    if (mask) continue;   // a grass-mask footprint is not a solid (see fitStructureBoxes)
    if (support) {
      // A declared floor is support, never an obstacle: the generic path's 8cm top tolerance would turn a 10cm
      // foundation slab into a wall and eject the body from its own building.
      const ss = obj.scale?.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(ss);
      if (_local.x > box.min.x && _local.x < box.max.x
          && _local.z > box.min.z && _local.z < box.max.z) {
        const topY = obj.position.y + box.max.y * ss;
        if (topY <= pos.y + step && topY > ground) { ground = topY; touched.add(e0); }
      }
      continue;
    }
    if (grid) {
      // Heightfield support (#84): the containing cell's max-y, piecewise-constant; an empty cell offers NOTHING
      // (interpolating would bridge air into floors).
      const gs = obj.scale?.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(gs);
      const gx = Math.floor(((_local.x - grid.minX) / grid.w) * grid.n);
      const gz = Math.floor(((_local.z - grid.minZ) / grid.d) * grid.n);
      if (gx >= 0 && gx < grid.n && gz >= 0 && gz < grid.n) {
        const top = grid.tops[gz * grid.n + gx];
        if (top !== null) {
          const gy = obj.position.y + top * gs;
          if (gy <= pos.y + step && gy > ground) { ground = gy; touched.add(e0); }
        }
      }
      continue; // support only — never box-test a grid entry (no false walls)
    }
    if (exact) {
      // work in entity-local space (yaw-only rotation, uniform scale)
      const s = obj.scale.x || 1;
      _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(s);
      const localY = (pos.y - obj.position.y) / s;
      // floor: nearest surface below the feet (+step allowance) IS the ground
      _ray.origin.set(_local.x, localY + step / s, _local.z);
      _ray.direction.set(0, -1, 0);
      const hit = exact.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit) {
        const gy = obj.position.y + hit.point.y * s;
        if (gy <= pos.y + step && gy > ground) { ground = gy; touched.add(e0); }
      }
      // walls: closest triangle to a mid-body probe pushes the capsule out
      _hip.set(_local.x, localY + probeY / s, _local.z);
      const res = exact.bvh.closestPointToPoint(_hip, _cp);
      if (res) {
        const dx = (_hip.x - res.point.x) * s, dz = (_hip.z - res.point.z) * s;
        const dy = Math.abs(_hip.y - res.point.y) * s;
        const dh = Math.hypot(dx, dz);
        if (dh < r && dy < spanY && dh > 1e-6) {
          _push.set(dx / dh, 0, dz / dh).applyAxisAngle(UP, yaw)
            .multiplyScalar(r - dh);
          pos.x += _push.x; pos.z += _push.z; touched.add(e0);
        }
      }
      continue; // never box-test an exact entity — that would seal interiors
    }
    const bs = obj.scale?.x || 1;
    _local.set(pos.x - obj.position.x, 0, pos.z - obj.position.z)
      .applyAxisAngle(UP, -yaw).divideScalar(bs);
    const br = r / bs;
    let minX = box.min.x, maxX = box.max.x, minZ = box.min.z, maxZ = box.max.z;
    if (pillar) {
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      minX = cx - 0.25; maxX = cx + 0.25; minZ = cz - 0.25; maxZ = cz + 0.25;
    }
    if (_local.x < minX - br || _local.x > maxX + br || _local.z < minZ - br || _local.z > maxZ + br) continue;
    const topY = obj.position.y + box.max.y * bs;
    // Are we UNDER it? Without box.min.y every box is an infinite column down to the floor.
    const bottomY = obj.position.y + box.min.y * bs;
    if (pos.y + tall <= bottomY) continue;
    if (pos.y >= topY - 0.08) {
      // at/above the top: the box is floor, not wall
      if (_local.x > minX && _local.x < maxX && _local.z > minZ && _local.z < maxZ) {
        ground = Math.max(ground, topY); touched.add(e0);
      }
      continue;
    }
    // inside the radius-expanded footprint, below the top: push out the nearest face
    _exits[0].d = (maxX + br) - _local.x;
    _exits[1].d = _local.x - (minX - br);
    _exits[2].d = (maxZ + br) - _local.z;
    _exits[3].d = _local.z - (minZ - br);
    let best = _exits[0];
    for (let i = 1; i < 4; i++) if (_exits[i].d < best.d) best = _exits[i];
    // Grazing an overhang's underside declines the sideways push, only if there IS a down (a crate on the floor still
    // pushes) and the overlap is a graze, not "I don't fit". Not "shortest exit is down": for big slabs it always is.
    if (bottomY > ground + 0.05
        && (pos.y + tall) - bottomY <= Math.max(0.05, tall * 0.08)) continue;
    _push.set(best.x, 0, best.z).applyAxisAngle(UP, yaw).multiplyScalar(best.d * bs);
    pos.x += _push.x; pos.z += _push.z; touched.add(e0);
    // pillars aren't mantleable, nor is anything to a non-climber (a ragdoll wrist must not set the mantle probe)
    if (!pillar && climbs) blockedTop = topY;
  }
  return ground;
}

// ---- Layer-0 affordances ----------------------------------------------------

/** Nearest sittable surface: a horizontal top at chair-ish height within `range` (DESIGN.md's `seatOn`: the geometry IS
  *  the affordance, nothing authored). Returns {y, x, z, yaw, id} or null. */
export function findSeat(pos, range = 1.2, skip = null) {   // skip(entry): a surface the caller won't offer
  let best = null;
  // grid-bounded (§14.2 6a): a chair within `range` has its cells inside the query disc; this runs on every X press
  for (const [id, e0] of nearColliders(pos.x, pos.z, range)) {
    const { obj, mask } = e0; const { yaw, box, exact, pillar, grid } = frameOf(e0);
    if (mask || skip?.(e0)) continue;
    if (pillar || exact) continue; // interiors aren't chairs; furniture inside them is
    if (grid) continue; // a heightfield's box top is the lie we exist to avoid — no phantom seat offers (#11)
    const sc = obj.scale?.x || 1;
    const topY = obj.position.y + box.max.y * sc;
    const rise = topY - pos.y;
    if (rise < 0.25 || rise > 0.85) continue;            // not seat height
    // centre of the top face, in world space
    _local.set((box.min.x + box.max.x) / 2 * sc, 0, (box.min.z + box.max.z) / 2 * sc)
      .applyAxisAngle(UP, yaw);
    const cx = obj.position.x + _local.x, cz = obj.position.z + _local.z;
    const d = Math.hypot(cx - pos.x, cz - pos.z);
    if (d > range) continue;
    if (!best || d < best.d) best = { d, id, x: cx, z: cz, y: topY, yaw: yaw };
  }
  return best;
}

/** Highest surface directly under a point: what a dropped object lands on (ON the table, not at y=0 beside it). */
export function surfaceUnder(x, z, terrainAt, maxY = Infinity, skipId = null) {
  let y = terrainAt(x, z);
  let onto = null;
  // a surface UNDER the point has its footprint over it, so the point's own cell holds every candidate (§14.2 6a)
  for (const [id, e0] of nearColliders(x, z, 0.5)) {
    const { obj, mask } = e0; const { yaw, box, exact, pillar } = frameOf(e0);
    if (pillar || mask || id === skipId) continue;
    if (exact) {
      // dropped things land on the actual surface (stair tread, mezzanine)
      const s = obj.scale.x || 1;
      _local.set(x - obj.position.x, 0, z - obj.position.z)
        .applyAxisAngle(UP, -yaw).divideScalar(s);
      const fromY = (Math.min(maxY, obj.position.y + box.max.y * s) - obj.position.y) / s;
      _ray.origin.set(_local.x, fromY + 0.01, _local.z);
      _ray.direction.set(0, -1, 0);
      const hit = exact.bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (hit) {
        const topY = obj.position.y + hit.point.y * s;
        if (topY > y && topY <= maxY) { y = topY; onto = id; }
      }
      continue;
    }
    const sc2 = obj.scale?.x || 1;
    _local.set(x - obj.position.x, 0, z - obj.position.z).applyAxisAngle(UP, -yaw).divideScalar(sc2);
    if (_local.x < box.min.x || _local.x > box.max.x || _local.z < box.min.z || _local.z > box.max.z) continue;
    const topY = obj.position.y + box.max.y * sc2;
    if (topY > y && topY <= maxY) { y = topY; onto = id; }
  }
  return { y, onto };
}

export function clearColliders() {
  colliders.clear();
  buckets.clear();
  libCache.clear();
}
