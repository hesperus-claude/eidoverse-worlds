// world — the scene registries, the arrival-gating world-build queue, world-scope builders and mount transforms.
// The log's MEANING lives in shared/protocol/fold.js; state is folded once and every load completion re-reads it (TEL0S_NOTES §11).

import { bodyOf } from '../../shared/components.js';
import { socketsUnder, resolveSeat } from '../../shared/sockbody.js';
import { THREE, scene, camera, renderer } from './core.js';
import { report, bus, CONFIG } from './base.js';
// net.js does NOT import this module, so this direction closes no cycle
import { net, replica } from './net.js';
import { enc, dec } from '../../shared/protocol/names.js';
import { kindOf } from '../../shared/protocol/kind.js';
import { loadEidoModule, noiseTexture, loadTrack, loadDone, libLabels } from './assets.js';
import { prepareObject } from './materials.js';
import { beginWork } from './loadwork.js';
import { reindexCollider } from './colliders.js';
import { setTerrain, setGrass, clearGrass, heightAt } from './terrain.js';
import { shapeParams, shapedHeightAt, requestGrid, setGridFetcher, gridRetryIn, shapeReady } from '../../shared/terrainshape.js';
import { materialLayerSpecs } from '../../shared/terrainlayers.js';
setGridFetcher(async (ref) => { const r = await fetch(`/library/${ref}`); if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
import { applyWater } from './water.js';
import { buildFloraField, warmField, loadFloraModule } from './flora.js';
import { applySky, whenSkyWarm } from './sky.js';
import { whenBooted, bootDone } from './boot.js';
import { warm, P_GATE } from './warmqueue.js';
// seat-height correction (upstream #101)
import { occupyCorrectionFor } from './occupants.js';
import { applySeatCorrection } from './seatcore.js';
import { isOwner } from '../../shared/protocol/roles.js';

/** id -> Object3D. `null` reserves the id while the GLB downloads, so a same-tick duplicate spawn can't make two bodies. */
export const entities = new Map();
/** The ONE fold record every reader uses, keys as the fold spells them; frozen in dev.
 *  Never keep it across an ingest: a write replaces it, so a kept ref goes stale. */
export const bagOf = (id) => replica.st?.entities?.[enc(String(id))]?.c ?? null;
/** ids as the page spells them; @world excluded. */
export function* bags() {
  const es = replica.st?.entities; if (!es) return;
  for (const k in es) if (k !== '@world') yield [dec(k) ?? k, es[k].c];
}
/** {kind, model?} for the panels, the fold's word (shared/protocol/kind.js); the realizer keeps no second copy (C7c). */
export const metaOf = (id) => { const c = bagOf(id); return c ? { kind: kindOf({ c }), ...(typeof c.model === 'string' ? { model: c.model } : {}) } : null; };
/** The tree's edges from the fold's own index (replica.js), ids as the page spells them; never keep a map beside it (C12b).
 *  childrenOf in id order; ancestorsOf nearest first. */
const out = (k) => dec(k) ?? k;
export const childrenOf = (id) => replica.childrenOf?.(enc(String(id))).map(out) ?? [];
export const parentIdOf = (id) => { const p = replica.parentOf?.(enc(String(id))); return p == null ? null : out(p); };
export const ancestorsOf = (id) => replica.ancestors?.(enc(String(id))).map(out) ?? [];
/** [{id, name, sock}]: a socket is a child entity {transform, parent: {to: host}, socket: {name, part?, body?, accepts?, radius?}}.
 *  The one reader every client surface shares. */
export const socketsOn = (host) => socketsUnder(String(host), childrenOf, bagOf);
/** {id, host, name, sock, station}, or null when `id` isn't a socket in the fold (yet, or any more), or is switched off. */
export function seatSocket(id) {
  const c = id == null ? null : bagOf(id);
  if (!c?.socket || typeof c.socket !== 'object') return null;
  // switched off (or under something off) is closed to occupying, as the authority reads it (occupants.js offChain):
  // whoever sits there lets go, and a frame naming it seats nobody
  if (c.disabled === true || ancestorsOf(id).some((a) => bagOf(a)?.disabled === true)) return null;
  return { id: String(id), host: parentIdOf(id), name: c.socket.name, sock: c.socket, station: c.station && typeof c.station === 'object' ? c.station : null };
}
// the map is mounts.js's (a leaf, so the lite client's net.js can read it)
import { avatarMounts } from './mounts.js';
export { avatarMounts };
/** A seat is presence, not logged: a pose frame without `seat: {to: <socket id>}` clears it. Old {to: host, slot} frames resolve via resolveSeat. */
export function setBodySeat(id, seat) {
  const cur = avatarMounts.get(id);
  const to = seat?.to ? seatSocketId(seat) : null;
  if (!to) { if (cur) { avatarMounts.delete(id); bus.emit('mount', { id, to: null }); } return; }
  if (cur?.to === to) { seatExtras(cur, seat); return; }
  const m = { to };
  seatExtras(m, seat);
  avatarMounts.set(id, m);
  bus.emit('mount', { id, to });
}
function seatSocketId(seat) {
  if (seatSocket(seat.to)) return String(seat.to);
  if (typeof seat.slot !== 'string' || !replica.st) return null;
  const hit = resolveSeat(replica.st, { to: enc(String(seat.to)), slot: seat.slot });
  return hit ? (dec(hit.to) ?? hit.to) : null;
}
/** `pose` + `at` (a sync group follows the latest choice) and `in` (routed input); occupybody.js reads every occupant the same way. */
function seatExtras(m, seat) {
  const fin = Number.isFinite;
  if (typeof seat.pose === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(seat.pose)) { m.pose = seat.pose; m.at = fin(seat.at) ? seat.at : 0; } else { delete m.pose; delete m.at; }
  const i = seat.in;
  if (i && typeof i === 'object') { m.in = {}; for (const k of ['throttle', 'steer', 'aimYaw', 'aimPitch']) if (fin(i[k])) m.in[k] = i[k]; } else delete m.in;
}


export const liveEntities = () => [...entities.values()].filter(Boolean);

/** ids being edited: the residency sweep must never demote them. By id, because promote/demote SWAPS the object. */
export const editHolds = new Set();

// its own chain so log replay doesn't wait; safe because spawns carry their logged y and terrain re-seats ground objects
let worldBuild = Promise.resolve();
let buildDepth = 0;
let gatingDepth = 0;
// Terrain gates arrival; grass does not: it costs seconds and can grow around someone already walking.
const GATING = new Set(['terrain']);
function enqueueWorldBuild(what, fn) {
  buildDepth++;
  if (GATING.has(what)) gatingDepth++;
  bus.emit('build-queue', { depth: buildDepth, what });
  worldBuild = worldBuild
    .then(() => {
      loadTrack(`build:${what}`, `growing ${what}`);
      // named, or the frame gap is unattributed
      const work = beginWork(`build ${what}`);
      return Promise.resolve(fn()).finally(() => work.end());
    })
    .catch((e) => report(`world build (${what})`, e))
    .finally(() => {
      loadDone(`build:${what}`);
      buildDepth--;
      if (GATING.has(what)) gatingDepth--;
      bus.emit('build-queue', { depth: buildDepth, what });
    });
}
// NOT the worldBuild chain: grass parks it on whenBooted(), so a sky queued behind would hold the curtain against itself
let skyGate = 0;
export const buildsPending = () => gatingDepth + skyGate;
export const anyBuildsPending = () => buildDepth + skyGate;

// so a re-join that replays the log doesn't regenerate an identical world
let lastTerrainArgs = null;
let stageFloor = true;   // no terrain built: the stage floor stands (with the world's water, if any)
let lastGrassArgs = null;

// ---- world-scope state application (driven by realize/environment.js, realize/social.js) ----

/** Dedupes by args. */
export function applyTerrainState(args) {
  // no terrain: the stage floor returns, with the world's water if any (environment.js groundArgs), never the old ground's
  if (!args || args.stageFloor === true) {
    const key = args ? JSON.stringify(args) : null;
    if (lastTerrainArgs !== key) { lastTerrainArgs = key; if (!stageFloor) { stageFloor = true; setTerrain(null); }
      try { applyWater(args, heightAt); } catch (e) { report('water', e); } }
    return;
  }
  stageFloor = false;
  const key = JSON.stringify(args);
  if (pendingTerrain && JSON.stringify(pendingTerrain.args) === key) pendingTerrain = null;   // our edit, echoed
  if (lastTerrainArgs === key) return;
  lastTerrainArgs = key;
  enqueueWorldBuild('terrain', async () => {
    await loadEidoModule('terrain.js');
    // grid BEFORE the build, so heightAt agrees with the mesh; no grid, no build (the standing ground stays: shapeReady)
    const shape = shapeParams(args);
    if (shape?.heightmap && !(await requestGrid(shape.heightmap.grid))) {
      if (lastTerrainArgs !== key) return;
      report(`heightmap ${shape.heightmap.grid} has not loaded — keeping the ground already here, retrying`, new Error('grid unavailable'));
      retryTerrainWhenGridLands(args, key, shape.heightmap.grid);
      return;
    }
    if (lastTerrainArgs !== key) return;   // a newer terrain arrived while the grid was in flight
    const layers = materialLayerSpecs(args.layers).map((l) => ({
      map: noiseTexture(l.color ?? '#4a5d33'), repeat: l.repeat ?? 16,
    }));
    const t = globalThis.makeTerrain({ ...args, layers });
    if (t && shape) reshapeTerrain(t, args);
    // the textures ride colorNode, unreachable from the material: carried so disposal can free them
    if (t) t.layerTextures = layers.map((l) => l.map);
    // dressed BEFORE its compile: wetness, cloud shade, receiveShadow
    if (t?.mesh) prepareObject(t.mesh, { kind: 'terrain' });
    // compiled BEFORE it enters the scene, uncapped (TEL0S_NOTES §16.2): else it codegens inside the first render()
    if (t?.mesh) {
      // P_GATE: arrival waits on THIS item, or cloud compiles queue ahead of the ground
      await warm('compile terrain', () => renderer.compileAsync(t.mesh, camera, scene).catch(() => {}), { p: P_GATE });
    }
    setTerrain(t);
    // the water reads this ground's per-vertex depth
    try { applyWater(args, heightAt); } catch (e) { report('water', e); }
    // re-seat only ground-level entities; anything elevated keeps its logged height
    for (const [id, obj] of entities) {
      if (obj && !obj.userData.mountedTo && Math.abs(obj.position.y) < 0.02) {   // a parented thing's y is in its parent's frame
        obj.position.y = heightAt(obj.position.x, obj.position.z);
        if (obj.userData.base) obj.userData.base.pos[1] = obj.position.y;
        reindexCollider(id);
      }
    }
  });
}

// retry at the fetch backoff (gridRetryIn); build THIS bag once, unless a newer terrain arrived meanwhile
let terrainRetry = null;
function retryTerrainWhenGridLands(args, key, ref) {
  clearTimeout(terrainRetry);
  terrainRetry = setTimeout(async () => {
    if (lastTerrainArgs !== key) return;
    if (!(await requestGrid(ref))) { if (lastTerrainArgs === key) retryTerrainWhenGridLands(args, key, ref); return; }
    if (lastTerrainArgs !== key) return;
    lastTerrainArgs = null;   // let the same bag through the dedupe, this once
    applyTerrainState(args);
  }, Math.max(250, gridRetryIn(ref)));
}
/** Waiting on its heightmap's grid (the ground shown is the last one built). */
export const terrainPending = () => terrainRetry !== null && lastTerrainArgs !== null && !shapeReady(shapeParams(JSON.parse(lastTerrainArgs)));

/** What EW.terrain(patch) edits. */
export function currentTerrainArgs() { return lastTerrainArgs ? JSON.parse(lastTerrainArgs) : null; }

// sent, not yet echoed: two quick patches must compose, not the second erase the first. Stands until an echo or PENDING_MS (refused).
let pendingTerrain = null;   // { args, at }
const PENDING_MS = 5000;
export function terrainEditBase() {
  if (pendingTerrain && Date.now() - pendingTerrain.at < PENDING_MS) return structuredClone(pendingTerrain.args);
  return currentTerrainArgs();
}
export function noteTerrainSent(args) { pendingTerrain = { args, at: Date.now() }; return args; }

/** The same law agents and the sim stand on (shared/terrainshape.js): what you see is what you stand on. */
function reshapeTerrain(t, args) {
  const hf = shapedHeightAt(t.heightAt, args);
  const pos = t.mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, hf(pos.getX(i), pos.getZ(i)));
  pos.needsUpdate = true;
  t.mesh.geometry.computeVertexNormals();
  t.mesh.geometry.computeBoundingBox();
  t.mesh.geometry.computeBoundingSphere();
  t.heightAt = hf;
}

// Def hot-reload (§24): regrow the meadow from the SAME args; world state untouched
bus.on('defs-updated', async () => {
  try {
    const mod = await loadFloraModule();
    await mod.refreshFloraDefs?.();
    if (!lastGrassArgs) return;
    const args = JSON.parse(lastGrassArgs);
    lastGrassArgs = null;
    applyGrassState(args);
  } catch (e) {
    console.warn('[defs] hot reload failed — old defs stand:', e);
  }
});

/** Dedupes by args. */
export function applyGrassState(args) {
  if (!args) return;
  const key = JSON.stringify(args);
  if (lastGrassArgs === key) return;
  lastGrassArgs = key;
  if (args.clear) { clearGrass(); return; }   // an empty field: mow it
  enqueueWorldBuild('grass', async () => {
    await whenBooted();   // yields to arrival
    // legacy makeGrass bags are mapped inside buildFloraField; the log is never rewritten
    const field = await buildFloraField(args, { scene, heightFn: heightAt });
    // before the precompile; no shadow receipt: grass's fragment cost is the client's biggest
    if (field?.mesh) prepareObject(field.mesh, { kind: 'grass' });
    // warmField defeats culling, or tiles culled against the boot camera compile inside render() on first look
    if (field?.mesh) await warmField(field, renderer, camera, scene);
    setGrass(field);
  });
}

// Hydration's arrival gates on the sky's warm (TEL0S_NOTES §16.2), capped so a degraded sky can't brick arrival.
// Registered synchronously, before checkReady can see an empty queue; a mid-session sky verb gates nothing.
let skyGated = false;
// covers a cold first bake (~9 s); it resolves early, so the cap binds only pathological cases
const SKY_GATE_MAX_MS = 25000;
/** An already-FOLDED sky bag. `ts` anchors live transition timing; a snapshot passes the bag's own. */
export function applySkyFolded(bag, ts) {
  if (!bag) return Promise.resolve();
  const p = Promise.resolve(applySky(bag, ts ?? bag.ts)).catch((e) => report('sky', e));
  if (!skyGated && !bootDone()) {
    skyGated = true;
    skyGate = 1;
    loadTrack('build:sky', 'warming the sky');
    bus.emit('build-queue', { depth: buildDepth, what: 'sky' });
    const work = beginWork('sky gate');
    work.phase('warm');
    Promise.race([
      whenSkyWarm(),
      new Promise((r) => setTimeout(() => r('timeout'), SKY_GATE_MAX_MS)),
    ]).then((how) => {
      skyGate = 0;
      loadDone('build:sky');
      bus.emit('build-queue', { depth: buildDepth, what: 'sky' });
      if (how === 'timeout') {
        // the still-running warm keeps its own records
        work.phase('lifted-at-cap');
        setTimeout(() => work.end(), 2);
      } else work.end();
    });
  }
  return p;
}

/** An upload joins this world's palette, for everyone, live and on replay. */
export function applyAssetState(args) {
  if (!args?.path) return;
  libLabels.set(args.path, args.name ?? 'upload');
  bus.emit('asset', { name: args.name ?? 'upload', path: args.path });
}

/** A UI mirror: enforcement is the server's, narration livechat.js's. */
export function applyGrantState(id, rec) {
  // taken away: back to @world default-role
  if (!rec) { worldRoles.delete(id); bus.emit('roles', { id, role: null }); return; }
  worldRoles.set(id, { role: rec.role ?? 'inhabitant', gen: rec.can?.generate === true, fly: rec.can?.fly === true || Boolean(rec.fly) });
  bus.emit('roles', { id, ...worldRoles.get(id) });
  // what I MAY DO is the server's `your-rights`, not this
}

// No deferred shadow-in drain: castShadow is in no pipeline cache key (lightrig.js §12.5).

// @world roles:<id>, mirrored only so the client can SAY what someone is
const worldRoles = new Map();
export const roleOf = (id) => worldRoles.get(id) ?? null;
export const worldHasOwner = () => [...worldRoles.values()].some(isOwner);

// ---- named parts ------------------------------------------------------------

/** root -> Map(partName -> {obj|null, at}). Misses retry once a second: a model may not have loaded yet. */
const _partCache = new WeakMap();
export function findPart(root, name) {
  let map = _partCache.get(root);
  if (!map) { map = new Map(); _partCache.set(root, map); }
  const hit = map.get(name);
  if (hit && (hit.obj || Date.now() - hit.at < 1000)) return hit.obj;
  let found = null;
  root.traverse((c) => { if (!found && c !== root && c.name === name) found = c; });
  map.set(name, { obj: found, at: Date.now() });
  return found;
}

// ---- mounting ---------------------------------------------------------------

/** For reach checks: ignores a part's motion on purpose, so "how far is the seat" doesn't oscillate. Fills out, or null. */
export function socketWorldPos(id, out) {
  const s = seatSocket(id);
  const host = s?.host != null ? entities.get(s.host) : null;
  if (!host) return null;
  host.updateWorldMatrix(true, false);
  const p = bagOf(id)?.transform?.pos;
  return out.set(...(Array.isArray(p) && p.length === 3 ? p : [0, 0, 0])).applyMatrix4(host.matrixWorld);
}

// read through the socket object's matrixWorld, so an occupant RIDES the swing: derived, not streamed
const _mtQ = new THREE.Quaternion();
const _mtF = new THREE.Vector3();
const _mtV = new THREE.Vector3();
const _mtR = new THREE.Quaternion(), _mtS = new THREE.Quaternion(), _UP = new THREE.Vector3(0, 1, 0);
/** Fills outPos with the occupant's ROOT, placed so the ANCHOR body point (shared/sockbody.js) lands on the socket;
 *  'surface' sockets take #101's seat-height correction. Returns {q, socketPos, socketQ, body, sock, upright, yaw, pose, to, host, slot, seatState, seatReason} or null. */
const _mtP = new THREE.Vector3(), _mtW = new THREE.Quaternion();
export function mountTransform(occupantId, outPos, occ, poseOffset = null) {
  const m = avatarMounts.get(occupantId);
  if (!m) return null;
  const s = seatSocket(m.to);
  const sObj = s ? entities.get(s.id) : null;
  if (!sObj) return null;
  const sock = s.sock;
  const body = bodyOf(s.station);
  sObj.updateWorldMatrix(true, false);
  _mtF.setFromMatrixPosition(sObj.matrixWorld);
  // whole world rotation (a rocket seat lies on its back), part and host included
  const socketQw = sObj.getWorldQuaternion(_mtW);
  // the occupant's own heading, if set, replaces the socket's own turn
  if (Number.isFinite(m.yaw)) { const lq = bagOf(s.id)?.transform?.q; _mtR.copy(socketQw).multiply(_mtS.fromArray(Array.isArray(lq) && lq.length === 4 ? lq : [0, 0, 0, 1]).invert()).multiply(_mtQ.setFromAxisAngle(_UP, m.yaw)); }
  else _mtR.copy(socketQw);
  const upright = _mtV.set(0, 1, 0).applyQuaternion(_mtR).y > 0.966;   // within 15°
  const socketPos = _mtF.toArray();
  let state = 'approximate', reason = null;
  if (body && body.anchor !== 'surface') {
    if (poseOffset) _mtF.add(_mtP.fromArray(poseOffset).applyQuaternion(socketQw));
    if (body.anchor === 'root') state = 'anchored';
    else {
      occ?.av?.setAnchorWant?.(body.anchor);
      const off = occ?.av?.anchorOffset?.();
      if (off) { _mtF.sub(_mtP.fromArray(off).multiply(occ.av.root.scale).applyQuaternion(_mtR)); state = 'anchored'; }
      else reason = occ?.av ? `measuring the ${body.anchor}` : 'body loading';
    }
  } else {
    // the seat-height correction (#101) is a world-up subtraction: it only holds while the socket stands upright
    const seat = upright ? occupyCorrectionFor(occ, s.station) : { applied: false, reason: 'the socket is tilted (the seat profile assumes upright)' };
    if (seat.applied) { const c = applySeatCorrection([_mtF.x, _mtF.y, _mtF.z], seat.contactY, seat.scale); if (c) _mtF.set(c[0], c[1], c[2]); state = 'profiled'; }
    else reason = seat.reason;
  }
  outPos.copy(_mtF);
  _mtF.set(0, 0, 1).applyQuaternion(_mtR);
  return { q: _mtR.toArray(), socketPos, socketQ: socketQw.toArray(), body, sock, upright, yaw: Math.atan2(_mtF.x, _mtF.z), pose: body?.clip ?? 'sitchair', to: s.id, host: s.host, slot: s.name ?? null,
    seatState: state, seatReason: reason };
}

// sky.js owns the args; injected to keep the module graph one-directional
let currentSkyArgs = () => ({});
export function setSkyArgsSource(fn) { currentSkyArgs = fn; }

