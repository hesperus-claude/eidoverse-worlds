// world — the authored plane's scene registries and world-scope builders.
//
// The log's MEANING lives in shared/protocol/fold.js (net.js folds it through replica.js; the realizers in realize/
// project it into the scene). What remains here is what every consumer shares: the entity/comp/mount registries,
// the world-build queue that gates arrival on ground, the world-scope application functions the realizers drive,
// and mount transforms. State is folded once and every load completion re-reads it (TEL0S_NOTES §11).

import { bodyOf } from '../../shared/components.js';
import { socketsUnder, resolveSeat } from '../../shared/sockbody.js';
import { THREE, scene, camera, renderer } from './core.js';
import { report, bus, CONFIG } from './base.js';
// net.js does NOT import this module (its own note: "live grants keep it fresh
// via world.js"), so this direction closes no cycle.
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
// seat correction for mounted occupants (upstream #101), called by the me-drive frame for every seated body
import { occupyCorrectionFor } from './occupants.js';
import { applySeatCorrection } from './seatcore.js';
import { isOwner } from '../../shared/protocol/roles.js';

/** id -> Object3D. `null` is a reservation held while the GLB downloads, so a
 *  duplicate spawn in the same tick can't create two bodies for one id. */
export const entities = new Map();
/** A thing's fold record (shared/protocol/replica.js), keys as the fold spells them (shared/protocol/names.js): the ONE
 *  record every reader uses, frozen in dev. Never keep it across an ingest: a write replaces it, so a kept ref goes stale. */
export const bagOf = (id) => replica.st?.entities?.[enc(String(id))]?.c ?? null;
/** Every placed thing's [id, record], ids as the page spells them (the world entity excluded). */
export function* bags() {
  const es = replica.st?.entities; if (!es) return;
  for (const k in es) if (k !== '@world') yield [dec(k) ?? k, es[k].c];
}
/** What a thing IS as realized and where from, for the panels: {kind, lib?} — the fold's word (shared/protocol/kind.js),
 *  the realizer keeps no second copy (entityMeta is gone, C7c). */
export const metaOf = (id) => { const c = bagOf(id); return c ? { kind: kindOf({ c }), ...(typeof c.model === 'string' ? { model: c.model } : {}) } : null; };
/** The tree's edges as this client's fold indexes them (shared/protocol/replica.js, kept at every ingest): the ids a
 *  carrier holds (id order), a thing's carrier, the ids above it nearest first — ids as the page spells them. One
 *  index for the realizer's carrier checks, the panels and the seats; no map is kept beside the fold (C12b). */
const out = (k) => dec(k) ?? k;
export const childrenOf = (id) => replica.childrenOf?.(enc(String(id))).map(out) ?? [];
export const parentIdOf = (id) => { const p = replica.parentOf?.(enc(String(id))); return p == null ? null : out(p); };
export const ancestorsOf = (id) => replica.ancestors?.(enc(String(id))).map(out) ?? [];
/** A host's sockets (PLAN-sockets-entities: a socket is a child entity {transform, parent: {to: host}, socket: {name,
 *  part?, body?, accepts?, radius?}}): [{id, name, sock}], from the fold's children index. The one reader every client
 *  surface shares (clickuse, localbody, seatbody, the Inspector, xrpointer, the scene panel). */
export const socketsOn = (host) => socketsUnder(String(host), childrenOf, bagOf);
/** A socket child as a seat reads it: {id (the socket), host, name, sock (its socket component)}, or null when `id` isn't
 *  a socket in the fold (yet, or any more), or is switched off. */
export function seatSocket(id) {
  const c = id == null ? null : bagOf(id);
  if (!c?.socket || typeof c.socket !== 'object') return null;
  // a socket switched off (or under something switched off) is closed to occupying, as the authority reads it (occupants.js: offChain):
  // whoever sits there lets go (localbody's per-frame check), and a frame naming it seats nobody (review 10-12 S3-3)
  if (c.disabled === true || ancestorsOf(id).some((a) => bagOf(a)?.disabled === true)) return null;
  return { id: String(id), host: parentIdOf(id), name: c.socket.name, sock: c.socket, station: c.station && typeof c.station === 'object' ? c.station : null };
}
// Avatar attachments: the map is mounts.js's (a leaf, so the lite client's net.js can read it); re-exported for the rest
import { avatarMounts } from './mounts.js';
export { avatarMounts };
/** A body's seat is presence, not logged: the owner's pose frame carries `seat: {to: <socket id>}` while seated, and a
 *  frame without it clears it. Old {to: <host>, slot} frames resolve via shared/sockbody.js resolveSeat. */
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
  const hit = resolveSeat(replica.st, { to: enc(String(seat.to)), slot: seat.slot });   // the old frame: the host's socket of that name
  return hit ? (dec(hit.to) ?? hit.to) : null;
}
/** What else a seat frame carries (shared/sockbody.js): the pose the occupant chose from the socket's menu and when
 *  (`pose`, `at`: a sync group follows the latest choice), and their input (`in`: throttle, steer, aimYaw, aimPitch)
 *  when the socket routes it. Read by occupybody.js for every occupant, mine and everyone else's, the same way. */
function seatExtras(m, seat) {
  const fin = Number.isFinite;
  if (typeof seat.pose === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(seat.pose)) { m.pose = seat.pose; m.at = fin(seat.at) ? seat.at : 0; } else { delete m.pose; delete m.at; }
  const i = seat.in;
  if (i && typeof i === 'object') { m.in = {}; for (const k of ['throttle', 'steer', 'aimYaw', 'aimPitch']) if (fin(i[k])) m.in[k] = i[k]; } else delete m.in;
}


export const liveEntities = () => [...entities.values()].filter(Boolean);

/** ids someone is actively editing — the residency sweep must never demote
 *  them (review S4: id-based, because promote/demote SWAPS the object a
 *  userData flag would ride). build.js and panel editors add/remove. */
export const editHolds = new Set();

// heavy world construction (terrain, grass) runs on its own ordered chain so log replay doesn't wait behind it;
// safe because spawns carry their logged y and the terrain step re-seats ground objects when it lands
let worldBuild = Promise.resolve();
let buildDepth = 0;
let gatingDepth = 0;
// Terrain gates arrival — you cannot stand in a world with no ground. Grass
// does not: it is decoration, it costs seconds of main-thread geometry
// generation, and it can grow around someone who is already walking.
const GATING = new Set(['terrain']);
function enqueueWorldBuild(what, fn) {
  buildDepth++;
  if (GATING.has(what)) gatingDepth++;
  bus.emit('build-queue', { depth: buildDepth, what });
  worldBuild = worldBuild
    .then(() => {
      loadTrack(`build:${what}`, `growing ${what}`);
      // a work record too — terrain/grass builds were the biggest UNNAMED
      // frame gaps in the first Safari beacon (2.4s "(unattributed)")
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
// The sky's arrival gate rides its own counter, NOT the worldBuild chain:
// grass parks that chain on whenBooted(), so a sky queued behind it would
// hold the curtain against itself (see applySkyFolded).
let skyGate = 0;
export const buildsPending = () => gatingDepth + skyGate;
export const anyBuildsPending = () => buildDepth + skyGate;

// Guards so a re-join (avatar switch, reconnect) that replays the log doesn't
// regenerate an identical world.
let lastTerrainArgs = null;
let stageFloor = true;   // no terrain built: the stage floor stands (with the world's water, if any)
let lastGrassArgs = null;

// ---- world-scope state application ------------------------------------------
// Driven by the environment/social realizers (realize/environment.js, realize/social.js).

/** Build (or rebuild) the terrain from its authored bag. Dedupes by args so
 *  a re-join replaying the same world does not regenerate identical ground. */
export function applyTerrainState(args) {
  // no terrain: the stage floor returns, with the world's water on it when it has some (environment.js groundArgs
  // {stageFloor, water}; house review I8) and without the old ground's water when it doesn't
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
    // a heightmap's grid is fetched BEFORE the build, so the ground arrives shaped and heightAt agrees with the mesh;
    // no grid, no build: the standing ground stays until the grid lands (the readiness the sim waits on, shapeReady)
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
    // the layer textures ride the engine's colorNode, unreachable from
    // material properties — carry them so terrain disposal can free them
    // (review S5)
    if (t) t.layerTextures = layers.map((l) => l.map);
    // the factory dresses the ground BEFORE its compile: wetness + cloud
    // shade + receiveShadow (real terrain never received before — only the
    // stage floor did, and that hides when this lands)
    if (t?.mesh) prepareObject(t.mesh, { kind: 'terrain' });
    // compile the ground's pipelines BEFORE it enters the scene, uncapped (TEL0S_NOTES §16.2): an uncompiled
    // ground codegens inside the first render(), which is worse than a longer splash
    if (t?.mesh) {
      // P_GATE: arrival waits on THIS item — the first 8b gate measured a
      // rain world booting in 16s because the cloud-march compiles queued
      // ahead of the ground the curtain was actually waiting for
      await warm('compile terrain', () => renderer.compileAsync(t.mesh, camera, scene).catch(() => {}), { p: P_GATE });
    }
    setTerrain(t);
    // the water reads the ground it fills (its per-vertex depth), so it is built on THIS terrain
    try { applyWater(args, heightAt); } catch (e) { report('water', e); }
    // re-seat only ground-level entities — anything with a meaningful y
    // (seated on furniture, elevated) keeps its logged height
    for (const [id, obj] of entities) {
      if (obj && !obj.userData.mountedTo && Math.abs(obj.position.y) < 0.02) {   // a parented thing's y is in its parent's frame
        obj.position.y = heightAt(obj.position.x, obj.position.z);
        if (obj.userData.base) obj.userData.base.pos[1] = obj.position.y;
        reindexCollider(id);
      }
    }
  });
}

// A heightmap terrain whose grid did not come: ask again as the fetch backoff allows (shared/terrainshape.js
// gridRetryIn), and build THIS bag once — unless a newer terrain has arrived meanwhile.
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
/** Whether the world's terrain is waiting on its heightmap's grid (the ground shown is the last one built). */
export const terrainPending = () => terrainRetry !== null && lastTerrainArgs !== null && !shapeReady(shapeParams(JSON.parse(lastTerrainArgs)));

/** The authored terrain bag this client last built from — what EW.terrain(patch) edits. */
export function currentTerrainArgs() { return lastTerrainArgs ? JSON.parse(lastTerrainArgs) : null; }

// Edits sent but not yet echoed: two quick patches must compose (the second builds on the first), not both
// build on the last echo and the second erase the first. A sent bag stands as the base until the world
// echoes something, or PENDING_MS passes with no echo (the edit was refused).
let pendingTerrain = null;   // { args, at }
const PENDING_MS = 5000;
/** The bag a new terrain edit should build on: the newest sent-but-unechoed edit, else the built one. */
export function terrainEditBase() {
  if (pendingTerrain && Date.now() - pendingTerrain.at < PENDING_MS) return structuredClone(pendingTerrain.args);
  return currentTerrainArgs();
}
/** Record a terrain bag as sent, so the next edit composes with it. Returns the bag. */
export function noteTerrainSent(args) { pendingTerrain = { args, at: Date.now() }; return args; }

/** Placed features and heightmaps (shared/terrainshape.js) over the noise mesh, the same law agents and the sim stand
 *  on: vertices re-heighted and heightAt swapped, so what you see is what you stand on. */
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

// Def hot-reload (§24): on `defs-updated`, re-hydrate the registry and regrow the meadow from the SAME authored args;
// world state is untouched. The dedupe key is cleared so applyGrassState treats the regrow as new work.
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

/** Grow (or mow) the grass field. Same dedupe-by-args contract. */
export function applyGrassState(args) {
  if (!args) return;
  const key = JSON.stringify(args);
  if (lastGrassArgs === key) return;
  lastGrassArgs = key;
  if (args.clear) { clearGrass(); return; }   // an empty field: mow it
  enqueueWorldBuild('grass', async () => {
    // yields the main thread to arrival; resolves instantly once booted
    await whenBooted();
    // vegetation brush (createFlora) — makeGrass's replacement upstream.
    // Legacy makeGrass bags persisted in old world logs are mapped
    // inside buildFloraField; the log itself is never rewritten.
    const field = await buildFloraField(args, { scene, heightFn: heightAt });
    // factory pass before the precompile (field.mesh is the whole stroke
    // group): wet sheen on the meadow, sweep markers, no shadow receipt
    // (grass never received, and its fragment cost is the client's biggest)
    if (field?.mesh) prepareObject(field.mesh, { kind: 'grass' });
    // warm EVERY render object off the render path: warmField (flora.js) defeats culling, so tiles culled against
    // the boot camera don't compile synchronously inside render() on first look
    if (field?.mesh) await warmField(field, renderer, camera, scene);
    setGrass(field);
  });
}

/** Apply an already-FOLDED sky bag (state.st.sky or foldSkyEntry output).
 *  `ts` anchors live transition timing; a snapshot passes the bag's own. */
// During initial hydration, arrival gates on the sky's pipeline warm (TEL0S_NOTES §16.2), capped so a degraded sky
// can't brick arrival. Registered synchronously in the hydration realizer pass, before checkReady can see an empty
// queue; a mid-session sky verb gates nothing.
let skyGated = false;
// 25 s: the gate covers the first bake's cloud-graph compile (~9 s on a cold GPU cache); it resolves early via
// whenBakeReady, so the cap binds only pathological cases.
const SKY_GATE_MAX_MS = 25000;
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
        // visible in __loadLog: the gate line names the giving-up, and the
        // still-running warm keeps its own conductor records
        work.phase('lifted-at-cap');
        setTimeout(() => work.end(), 2);
      } else work.end();
    });
  }
  return p;
}

/** An upload became part of this world's vocabulary: the palette grows for
 *  everyone, live (broadcast) and forever (replay/snapshot for joiners). */
export function applyAssetState(args) {
  if (!args?.path) return;
  libLabels.set(args.path, args.name ?? 'upload');
  bus.emit('asset', { name: args.name ?? 'upload', path: args.path });
}

/** Mirror one role record so the UI can say what you are here, live.
 *  Enforcement is the server's; narration is the LIVE driver's business
 *  (legacy case or livechat.js), not this mirror's. */
export function applyGrantState(id, rec) {
  // a role taken away: back to the world's default (the authority reads @world default-role)
  if (!rec) { worldRoles.delete(id); bus.emit('roles', { id, role: null }); return; }
  worldRoles.set(id, { role: rec.role ?? 'inhabitant', gen: rec.can?.generate === true, fly: rec.can?.fly === true || Boolean(rec.fly) });
  bus.emit('roles', { id, ...worldRoles.get(id) });
  // (What I MAY DO is the server's answer, `your-rights`, re-sent whenever a role changes; this mirror is the HUD's.)
}

// No deferred shadow-in drain: castShadow is in no pipeline cache key, so the light rig budgets casters live
// (lightrig.js §12.5).

// Per-world roles (@world roles:<id>), mirrored from the view. A mirror for UI honesty — the authority enforces; this only
// lets the client SAY what someone is.
const worldRoles = new Map();
export const roleOf = (id) => worldRoles.get(id) ?? null;
export const worldHasOwner = () => [...worldRoles.values()].some(isOwner);

// ---- named parts ------------------------------------------------------------

/** root Object3D -> Map(partName -> {obj|null, at}). Misses retry once a second: models load async, so a part may not
 *  exist yet. Shared by motion.js and mounting. */
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

/** World-space position of a socket (a socket child's id), for reach checks and hints: its host's transform composed
 *  with the socket's own (local to the host). Ignores a part's motion on purpose: "how far is the seat" should not
 *  oscillate with the swing. Fills out; returns null when either half is missing. */
export function socketWorldPos(id, out) {
  const s = seatSocket(id);
  const host = s?.host != null ? entities.get(s.host) : null;
  if (!host) return null;
  host.updateWorldMatrix(true, false);
  const p = bagOf(id)?.transform?.pos;
  return out.set(...(Array.isArray(p) && p.length === 3 ? p : [0, 0, 0])).applyMatrix4(host.matrixWorld);
}

// A seated body's world transform, live: the socket's realized object read through its matrixWorld (host's current
// transform, then any moving part, then the socket's pose), so an occupant RIDES the swing: derived, not streamed.
const _mtQ = new THREE.Quaternion();
const _mtF = new THREE.Vector3();
const _mtV = new THREE.Vector3();
const _mtR = new THREE.Quaternion(), _mtS = new THREE.Quaternion(), _UP = new THREE.Vector3(0, 1, 0);
/** Fill outPos with the occupant's ROOT position on its seat; returns {q (the root's whole rotation), socketPos, socketQ,
 *  body, sock, upright, yaw, pose, to (the socket), host, slot (its name), seatState, seatReason} or null when not
 *  mounted. The root is placed so the socket's ANCHOR body point (shared/sockbody.js) lands on it; 'surface' sockets take #101. */
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
  // the socket's whole world rotation (a rocket seat lies on its back), part displacement and host included
  const socketQw = sObj.getWorldQuaternion(_mtW);
  // the occupant's: the socket's, or, where the occupant set its own heading, the socket's frame without its own turn (the
  // host's, a part's displacement included) then that heading
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
    // the seat-height correction (#101) is a world-up subtraction, so it only holds while the socket stands upright
    const seat = upright ? occupyCorrectionFor(occ, s.station) : { applied: false, reason: 'the socket is tilted (the seat profile assumes upright)' };
    if (seat.applied) { const c = applySeatCorrection([_mtF.x, _mtF.y, _mtF.z], seat.contactY, seat.scale); if (c) _mtF.set(c[0], c[1], c[2]); state = 'profiled'; }
    else reason = seat.reason;
  }
  outPos.copy(_mtF);
  _mtF.set(0, 0, 1).applyQuaternion(_mtR);
  return { q: _mtR.toArray(), socketPos, socketQ: socketQw.toArray(), body, sock, upright, yaw: Math.atan2(_mtF.x, _mtF.z), pose: body?.clip ?? 'sitchair', to: s.id, host: s.host, slot: s.name ?? null,
    seatState: state, seatReason: reason };
}

// sky.js owns the current args; world.js only needs them to merge a weather
// verb on top. Imported lazily to keep the module graph one-directional.
let currentSkyArgs = () => ({});
export function setSkyArgsSource(fn) { currentSkyArgs = fn; }

