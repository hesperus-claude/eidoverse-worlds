// gi — the world's baked bounce light: an irradiance probe volume (three r186's LightProbeGrid: L2 SH probes in one 3D
// texture) over each gi-volume (componentspec). At run time it is Godot's LightmapGI probes or Bevy's irradiance volumes, not
// VoxelGI: no voxels, no live relighting; only that the client bakes it resembles VoxelGI. The world owns the look (the component and its energy), each viewer's ew-gi dial the cost
// (render/gipref.js). A grid is baked a probe a frame through the shared frame budget, from a PROXY of the room (its opaque
// unskinned meshes at their world matrices and the placed lights near it), never the live scene: baking the live client
// scene hung the page (render-lab 11-09, probes/gi-grid.js). Baked once the room's static content has settled (the realizers'
// queue drained to P.FAR, the lanes idle, 1.5 s quiet), and rebaked only when what the bake sees changes (its signature):
// Godot never rebakes by itself, and bakes only geometry flagged static, so what moves and editor gizmos stay out.
// No gi-volume or the dial off (its default): three's grid code never loads and nothing is built. No bake step runs while an
// immersive session presents (nobody has run the bake in a headset); what is owed waits for the session to end.
import { THREE, TSL, scene, camera, renderer, backendName } from '../core.js';
import { bus } from '../base.js';
import { state, onWorldChange } from '../state.js';
import { laneBusy } from './loadwork.js';
import { pending, P } from './scheduler.js';
import { ask, spent } from './framebudget.js';
import { worldLights, glowScale } from './lightrig.js';
import { GI_LEVELS, giPref, setGiPref, onGiPref } from './gipref.js';
import { foldOfView } from '../../../shared/zone.js';
import { worldPose, offChain } from '../../../shared/protocol/simlayer.js';
export { GI_LEVELS, giPref, setGiPref };

const TIERS = { low: { cube: 8, cap: 250 }, high: { cube: 16, cap: 1000 } };
// What one world's content may make a visitor's browser build (a world is untrusted content; cold read of 11-27):
//   grids: live grids a world, the volumes nearest the view. Bevy without binding arrays (WebGPU, WebGL 2) takes "only the
//     closest irradiance volume to the view". A grid is a Light: one 3D texture sampled seven times in every lit fragment
//     shader, where 16 sampled textures a stage is the ceiling and a lamp-lit room already binds 14, and an id in every lit
//     pipeline's key, so a grid joining or leaving recompiles every lit material.
//   lights: the bake's lights, the strongest at the volume. Each is a real three light in every proxy material's shader;
//     16 is the most the rig ever lights at once (lightrig's slot ceiling).
//   meshes: the proxy's meshes, the largest. A bake step renders the whole proxy into six cube faces.
export const GI_BOUNDS = Object.freeze({ grids: 1, lights: 16, meshes: 256 });

// ---- pure: what to bake ----
const fin = Number.isFinite, v3 = (x) => Array.isArray(x) && x.length === 3 && x.every(fin);
const clamp = (x, lo, hi, d) => (fin(x) ? Math.min(hi, Math.max(lo, x)) : d);   // the registry's ranges (componentspec gi-volume)

/** The volumes in a fold (shared/zone.js foldOfView): [{id, center, size, energy, spacing, bounces, blend}], world-axis-aligned. */
export function giVolumesOf(st) {
  const out = [];
  for (const id of Object.keys(st?.entities ?? {}).sort()) {
    const c = st.entities[id].c, g = c['gi-volume'];
    if (id === '@world' || !g || typeof g !== 'object' || c.zone?.shape !== 'box' || c.zone.global === true || !v3(c.zone.size) || offChain(st, id)) continue;
    const pose = worldPose(st, id); if (!pose) continue;
    const scale = v3(pose.scale) ? pose.scale.map(Math.abs) : [1, 1, 1];
    out.push({ id, center: [...pose.pos], size: c.zone.size.map((x, i) => Math.abs(x) * scale[i]),
      energy: clamp(g.energy, 0, 16, 1), spacing: clamp(g.spacing, 0.25, 8, 1.5), bounces: Math.round(clamp(g.bounces, 0, 2, 1)),
      blend: clamp(c.zone.blend, 0, 1e3, 0) });
  }
  return out;
}

/** One volume's grid at a dial level, or null (off, or nothing to light). Probes sit on the zone's faces and `spacing` apart;
 *  past the level's probe cap the spacing widens. falloff: one probe cell past the zone (its floor and walls are on its faces), plus its blend. */
export function planGrid(vol, level) {
  const tier = TIERS[level];
  if (!tier || !vol || !(vol.energy > 0)) return null;
  const countsAt = (s) => vol.size.map((e) => Math.max(2, Math.round(e / s) + 1));
  let s = vol.spacing, counts = countsAt(s);
  while (counts[0] * counts[1] * counts[2] > tier.cap) counts = countsAt(s *= 1.1);
  const cell = Math.max(...vol.size.map((e, i) => e / (counts[i] - 1)));
  return { id: vol.id, center: vol.center, size: vol.size, counts, cube: tier.cube, bounces: vol.bounces, intensity: vol.energy, falloff: cell + vol.blend };
}
export const plansOf = (st, level) => giVolumesOf(st).map((v) => planGrid(v, level)).filter(Boolean);

/** The ranged bake (LightProbeGrid.bake's start/count/pass), one probe a step: pass 0 over every probe, then each bounce. */
export function bakeSteps(total, bounces) {
  const out = [];
  for (let pass = 0; pass <= bounces; pass++) for (let start = 0; start < total; start++) out.push({ start, count: 1, pass });
  return out;
}

/** Does a world change ask for a rebake? `near(id)`: is that thing by a volume (a pose far from every one doesn't). */
const READS = new Set(['gi-volume', 'zone', 'light', 'model', 'mesh', 'material', 'disabled', 'hidden']);
export function giTouches(ev, near = () => true) {
  if (ev?.type === 'hydrated' || ev?.type === 'reset') return true;
  if (ev?.type !== 'change') return false;
  const { what, comp: name } = ev;   // the event names a component (state.js), not a bag
  if (what === 'comp') return READS.has(name);
  return near(ev.id);   // born, gone, pose, parent
}

/** Can three's grid bake here? null, or why not. Its bake is node-based (a WebGPURenderer, either backend); on WebGL 2 the
 *  cube captures and the SH batch are float render targets. */
export function giSupport(r) {
  if (r?.isWebGPURenderer !== true) return "three's LightProbeGrid bakes with a WebGPURenderer only";
  if (r.backend?.isWebGLBackend && !r.backend.extensions?.has?.('EXT_color_buffer_float')) return 'WebGL 2 without EXT_color_buffer_float: the bake renders into float targets';
  return null;
}

// ---- the grid's light node ----
// three r186's LightProbeGridNode keeps the grid's box, resolution, intensity and falloff as plain uniform()s, which land in
// the per-OBJECT uniform group, and three refreshes that group for a material with no nodes of its own (every glTF model's
// plain MeshStandardMaterial) only when the object, its material or its geometry changes (NodeMaterialObserver.needsRefresh).
// updateGi dims the grid by day every frame: a model first drawn by day kept the day's 0.0012 at night, one first drawn at
// night kept 1 by day (render-lab 11-23: 23 of 25 model meshes; night frame luma 40.86 after a day preview, 45.55 without).
// The render group is where three keeps a light's own values (AnalyticLightNode's colour): refreshed every render.
const GRID_UNIFORMS = ['_min', '_max', '_resolution', '_intensity', '_falloff'];
/** three's grid light node (Base) with its uniforms in `group`. */
export function sharedGridNode(Base, group) {
  return class extends Base { constructor(light) { super(light); for (const k of GRID_UNIFORMS) this[k] = this[k].setGroup(group); } };
}

// ---- the live grids ----
let objects = () => new Map();
export function setGiObjects(fn) { objects = fn; }
const live = new Map();          // volume id -> { grid, plan, key, added }
let dirtyAt = 0, job = null, waited = 0, starting = false, LPG = null, failed = null;
let baked = null;               // the signature of the static set the grids hold (or are baking)
let refused = [], candidates = [], proxyStats = null, viewCheckAt = 0;   // volumes past GI_BOUNDS.grids; every volume, when some are; the last proxy's counts
const QUIET_MS = 1500;           // a rebake waits for the world to stop changing
function touch() { dirtyAt = performance.now(); }
const boxOf = (p, pad = 0) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...p.center), new THREE.Vector3(...p.size).addScalar(2 * pad));
const nearAny = (id) => { const pos = state.st.entities?.[id]?.pos; if (!v3(pos)) return true; const v = new THREE.Vector3(...pos); for (const { plan } of live.values()) if (boxOf(plan, 2).containsPoint(v)) return true; return false; };
// what can make or unmake a volume; anything else matters only while one is live
const SHAPES = new Set(['gi-volume', 'zone', 'disabled']);
onWorldChange((ev) => {
  if (ev?.type === 'reset') { for (const id of [...live.keys()]) drop(id); job = null; baked = null; clearProxy(); refused = []; candidates = []; proxyStats = null; }
  if (ev?.type === 'change' && (ev.what === 'pose' || ev.what === 'born') && moves(ev.id)) return;   // no part of the bake: a carried cup's poses neither rebake nor hold an owed rebake back
  if (!giTouches(ev, nearAny)) return;
  const { what, comp: name } = ev;
  if (live.size || job || ev.type !== 'change' || what === 'born' || what === 'gone' || what === 'parent' || SHAPES.has(name)) touch();
});
onGiPref(touch);
bus.on?.('lanes-idle', () => { if (live.size || job) touch(); });   // models finished loading: what the proxy sees changed

/** A grid's box from its plan (three's LightProbeGrid: position, width/height/depth, and the box its node reads). */
function place(grid, { center, size }) {
  grid.width = size[0]; grid.height = size[1]; grid.depth = size[2];
  grid.position.set(...center); grid.updateMatrixWorld(true); grid.updateBoundingBox?.();
}
function drop(id) { const l = live.get(id); if (!l) return; scene.remove(l.grid); l.grid.dispose(); live.delete(id); }

// What moves is no part of a static bake (Godot's gi_mode: Static bakes, Dynamic is only lit). Main has no per-thing flag, so
// the components that move a thing decide: carryable (grabbable), simulated or animated (physics dynamic | kinematic), a
// motion (any slot), an openable; the thing itself or anything it hangs under. An openable that names a part, and a motion slot
// that names a node (motion:<slot> {node}), move only that node: the rest of the thing stays in the bake.
const isMotion = (k) => k === 'motion' || k.startsWith('motion:');
const MOVES = (c) => !!c && ((c.grabbable !== undefined && c.grabbable?.enabled !== false) || (c.openable !== undefined && typeof c.openable?.part !== 'string')
  || c.physics?.kind === 'dynamic' || c.physics?.kind === 'kinematic' || Object.keys(c).some((k) => isMotion(k) && typeof c[k]?.node !== 'string'));
/** The names of a thing's nodes that move while it stands still (openable.part, each motion slot's node). */
const movingParts = (c) => [...(typeof c?.openable?.part === 'string' ? [c.openable.part] : []), ...Object.keys(c ?? {}).filter((k) => isMotion(k) && typeof c[k]?.node === 'string').map((k) => c[k].node)];
/** A part by name under `root`: its first descendant so named (world.js findPart's rule). */
function partNode(root, name) { let hit = null; root.traverse((c) => { if (!hit && c !== root && c.name === name) hit = c; }); return hit; }
/** Visit `o` and what hangs under it, visible only (Object3D.traverseVisible), never entering a node `cut` says to leave. */
function walk(o, cut, visit) { if (!o.visible) return; visit(o); for (const c of o.children) if (!cut(c)) walk(c, cut, visit); }
function moves(id) { const es = state.st.entities ?? {}; for (let k = id, n = 0; k && n < 33; k = es[k]?.parent?.to, n++) if (MOVES(es[k])) return true; return false; }

/** What a bake would see: the opaque, unskinned, static meshes near a volume (never an editor gizmo: a light's bulb) and the
 *  placed lights near one (the rig's requests, not its slots: the pool lights ~8 of a room's lamps at a time), each list cut
 *  to its GI_BOUNDS: the largest meshes (a room's walls and floor carry its bounce), the strongest lights at the volume. */
const _sz = new THREE.Vector3();
function staticSet(plans) {
  const boxes = plans.map((p) => boxOf(p, 1)), b = new THREE.Box3(), found = [];
  // A thing's object holds its children's objects (models.js execMount), so each thing is walked from its own root and the walk
  // never enters another thing's (each its own), a mover's, or a moving part; a thing hanging under a mover or a moving part is out.
  const es = state.st.entities ?? {}, roots = new Set(), out = new Set();
  for (const [id, obj] of objects()) { if (!obj) continue; roots.add(obj); if (moves(id)) out.add(obj); else for (const name of movingParts(es[id])) { const n = partNode(obj, name); if (n) out.add(n); } }
  const under = (o) => { for (let p = o.parent; p; p = p.parent) if (out.has(p)) return true; return false; };
  for (const [, obj] of objects()) {
    if (!obj?.parent || out.has(obj) || under(obj)) continue;
    obj.updateMatrixWorld(true);
    walk(obj, (x) => roots.has(x) || out.has(x), (x) => {
      if (!(x.isMesh || x.isInstancedMesh) || x.isSkinnedMesh || !x.geometry || !x.material || x.userData?.isGizmo) return;
      if ((Array.isArray(x.material) ? x.material : [x.material]).every((m) => m.transparent)) return;
      if (!boxes.some((bx) => bx.intersectsBox(b.setFromObject(x, false)))) return;
      found.push({ x, size: b.getSize(_sz).lengthSq() });
    });
  }
  const meshes = top(found, GI_BOUNDS.meshes, (f) => f.size).map((f) => f.x);
  const near = worldLights().filter((L) => boxes.some((bx) => bx.distanceToPoint(L.pos) <= L.range)), tight = plans.map((p) => boxOf(p));
  const lights = top(near, GI_BOUNDS.lights, (L) => (fin(L.intensity) ? L.intensity : 0) / (1 + Math.min(...tight.map((bx) => bx.distanceToPoint(L.pos))) ** 2));
  return { meshes, lights, cut: { meshes: found.length - meshes.length, lights: near.length - lights.length } };
}
/** The `n` of `xs` that score highest (ties: the earlier), in their own order. */
function top(xs, n, score) {
  if (xs.length <= n) return xs;
  const keep = new Set(xs.map((x, i) => [score(x), i]).sort((a, c) => c[0] - a[0] || a[1] - c[1]).slice(0, n).map(([, i]) => i));
  return xs.filter((_, i) => keep.has(i));
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;
/** The static set's signature: the plans, each mesh's geometry, materials and world matrix (an instanced one's count and
 *  instance version), each light as it stands. Equal signatures bake the same grid, so nothing rebakes. */
function signatureOf(plans, { meshes, lights }) {
  return JSON.stringify([plans.map((p) => [p.id, p.center, p.size, p.counts, p.cube, p.bounces, p.intensity, p.falloff]),
    meshes.map((x) => [x.geometry.uuid, (Array.isArray(x.material) ? x.material : [x.material]).map((m) => m.uuid), x.matrixWorld.elements.map(r4),
      x.isInstancedMesh ? [x.count, x.instanceMatrix.version] : 0]),
    lights.map((L) => [L.key, L.pos.toArray().map(r4), L.color, L.intensity, L.range, L.decay, L.spot?.angle ?? null, L.spot?.inner ?? null, L.dir ? L.dir.toArray().map(r4) : null])]);
}

// The proxy lives across bakes, and so do its lights and mesh copies: three keys every lit pipeline by its lights' ids
// (LightsNode.customCacheKey), so fresh lights in a fresh proxy rebuilt every proxy material on the next bake's first step
// (the lab's 13-35 s stall, by reading; not measured here). A rebake moves what changed and keeps the rest.
const proxy = { scene: null, meshes: new Map(), lights: new Map() };   // source mesh -> copy; light key -> three light
function clearProxy() { proxy.scene = null; proxy.meshes.clear(); proxy.lights.clear(); }
function buildProxy({ meshes, lights }) {
  if (!proxy.scene) { proxy.scene = new THREE.Scene(); proxy.scene.background = new THREE.Color(0, 0, 0); }
  const sc = proxy.scene, want = new Set(meshes), keys = new Set(lights.map((L) => L.key));
  for (const [src, m] of proxy.meshes) if (!want.has(src)) { sc.remove(m); proxy.meshes.delete(src); }
  for (const x of meshes) {
    let m = proxy.meshes.get(x);
    if (!m || m.geometry !== x.geometry || m.material !== x.material || !!m.isInstancedMesh !== !!x.isInstancedMesh || (x.isInstancedMesh && m.count !== x.count)) {
      if (m) sc.remove(m);
      m = x.isInstancedMesh ? new THREE.InstancedMesh(x.geometry, x.material, x.count) : new THREE.Mesh(x.geometry, x.material);
      m.matrixAutoUpdate = false; m.frustumCulled = false; proxy.meshes.set(x, m); sc.add(m);
    }
    if (x.isInstancedMesh) { m.instanceMatrix.copy(x.instanceMatrix); m.instanceMatrix.needsUpdate = true; }
    m.matrix.copy(x.matrixWorld); m.matrixWorld.copy(x.matrixWorld);
  }
  for (const [k, l] of proxy.lights) if (!keys.has(k)) { sc.remove(l); if (l.target) sc.remove(l.target); proxy.lights.delete(k); }
  for (const L of lights) {
    let l = proxy.lights.get(L.key);
    if (!l || !!l.isSpotLight !== !!L.spot) {
      if (l) { sc.remove(l); if (l.target) sc.remove(l.target); }
      l = L.spot ? new THREE.SpotLight() : new THREE.PointLight();
      l.castShadow = false; proxy.lights.set(L.key, l); sc.add(l); if (L.spot) sc.add(l.target);
    }
    l.color.set(L.color); l.intensity = L.intensity; l.distance = L.range; l.decay = L.decay; l.position.copy(L.pos);
    if (L.spot) { l.angle = L.spot.angle; l.penumbra = L.spot.angle > 0 ? Math.min(1, Math.max(0, (L.spot.angle - (L.spot.inner ?? 0)) / L.spot.angle)) : 0; l.target.position.copy(L.pos).add(L.dir); }
  }
  sc.updateMatrixWorld(true);
  return sc;
}

async function startBake() {
  dirtyAt = 0; starting = true;   // a running bake runs on unless what it sees has changed (replan)
  try { await replan(); } catch (e) { giOff(`bake setup failed: ${e?.message ?? e}`); } finally { starting = false; }
}
// off for this page, and said where the capture rig looks (giDebug().off): what throws once throws every time
function giOff(why) {
  failed = `${why} (${backendName?.() ?? '?'})`;
  console.warn(`[gi] ${failed}; bounce light off on this page`);
  for (const id of [...live.keys()]) drop(id);
  job = null; baked = null; clearProxy(); refused = []; candidates = []; proxyStats = null;
}
/** The `n` volumes nearest the view: the one it stands in (the smallest, where boxes nest), else the nearest box. A volume
 *  with a live grid holds its ground for a metre, so a doorway does not flip-flop between two rooms. */
const _eye = new THREE.Vector3();
function nearestView(plans, n) {
  camera.getWorldPosition(_eye);
  return plans.map((p, i) => { const d = boxOf(p).distanceToPoint(_eye); return { p, i, d: live.has(p.id) ? Math.max(0, d - 1) : d, v: p.size[0] * p.size[1] * p.size[2] }; })
    .sort((a, c) => a.d - c.d || a.v - c.v || a.i - c.i).slice(0, n).sort((a, c) => a.i - c.i).map((r) => r.p);
}
async function replan() {
  const all = failed || giSupport(renderer) ? [] : plansOf(foldOfView(state.st), giPref());
  const plans = all.length > GI_BOUNDS.grids ? nearestView(all, GI_BOUNDS.grids) : all;
  const keep = new Set(plans.map((p) => p.id)), n = GI_BOUNDS.grids;
  candidates = all.length > n ? all : [];
  refused = all.filter((p) => !keep.has(p.id)).map((p) => ({ id: p.id, why: `${n === 1 ? 'one grid' : `${n} grids`} a world, the nearest the view: ${plans.map((q) => q.id).join(', ')}` }));
  for (const id of [...live.keys()]) if (!keep.has(id)) drop(id);
  if (!plans.length) { job = null; baked = null; clearProxy(); proxyStats = null; return; }
  if (!LPG) {   // registered before the first bake: three's bake registers its own node only when the library has none for the class
    const Grid = (await import('three/addons/lighting/LightProbeGrid.js')).LightProbeGrid;
    const { LightProbeGridNode } = await import('three/addons/tsl/lighting/LightProbeGridNode.js');
    if (!LPG) { renderer.library.addLight(sharedGridNode(LightProbeGridNode, TSL.renderGroup), Grid); LPG = Grid; }
  }
  const set = staticSet(plans), sig = signatureOf(plans, set);
  proxyStats = { meshes: set.meshes.length, lights: set.lights.length, cut: set.cut };
  if (sig === baked && plans.every((p) => live.has(p.id))) return;   // the same room, baked or baking: nothing to do
  baked = sig; job = null;
  const queue = plans.map((plan) => {
    const key = JSON.stringify(plan.counts);   // the atlas's size: only new probe counts need a new grid
    let l = live.get(plan.id);
    if (l && l.key !== key) { drop(plan.id); l = null; }   // a new grid recompiles every lit material once (its light id); a rebake in place doesn't
    if (!l) { l = { grid: new LPG(...plan.size, ...plan.counts), key, added: false }; live.set(plan.id, l); }
    place(l.grid, plan);   // moved or resized with the same counts: the same grid, in place (it shows its old bake there until the rebake lands)
    l.plan = plan; l.grid.falloff = plan.falloff;
    return { l, steps: bakeSteps(plan.counts[0] * plan.counts[1] * plan.counts[2], plan.bounces), i: 0 };
  });
  job = { proxy: buildProxy(set), queue };
}

function stepBake() {
  const cur = job.queue[0];
  if (!cur || live.get(cur.l.plan.id) !== cur.l) { job.queue.shift(); if (!job.queue.length) job = null; return; }
  const g = ask('gi', { gpu: true, waited }); if (!g) { waited++; return; } waited = 0;
  const t0 = performance.now(), s = cur.steps[cur.i++], far = Math.hypot(...cur.l.plan.size) + 20;
  cur.l.grid.intensity = cur.l.plan.intensity;   // three's bounce pass reads it (_updateBounceGrid): a bake holds the room, not the hour; updateGi dims it again below, before the frame draws
  try { cur.l.grid.bake(renderer, job.proxy, { cubemapSize: cur.l.plan.cube, near: 0.05, far, ...s }); }
  catch (e) { giOff(`bake failed: ${e?.message ?? e}`); return; }
  finally { spent('gi', performance.now() - t0, null, g); }
  if (!cur.l.added && s.pass === 0 && s.start === cur.steps.length / (cur.l.plan.bounces + 1) - 1) { scene.add(cur.l.grid); cur.l.added = true; }   // shown once every probe holds direct light
  if (cur.i >= cur.steps.length) { if (!cur.l.added) { scene.add(cur.l.grid); cur.l.added = true; } job.queue.shift(); if (!job.queue.length) job = null; }
}

/** The frame loop's step: start a debounced (re)bake once the room's static content settles (main.js's ready gate reads the same
 *  queue: pending(P.FAR)), bake one probe when the frame budget allows. */
export function updateGi() {
  if (globalThis.__gpuLost?.fired) return;   // a lost device draws nothing (gpulost.js)
  const t = performance.now();   // the view walked nearer another volume than the live one: replan (a quiet world only)
  if (candidates.length && !dirtyAt && !starting && t - viewCheckAt > 500) { viewCheckAt = t; if (nearestView(candidates, GI_BOUNDS.grids).some((p) => !live.has(p.id))) touch(); }
  const xr = renderer.xr?.isPresenting === true;
  if (xr) { /* hold: a grid already baked still draws */ }
  else if (dirtyAt && !starting && t - dirtyAt > QUIET_MS && !laneBusy() && pending(P.FAR) === 0 && state.hydrated && renderer.initialized !== false) startBake();
  else if (job) stepBake();
  for (const { grid, plan } of live.values()) grid.intensity = plan.intensity * glowScale();   // its lamps dim by day as the rig's do
}
/** EW.gi: the dial, why GI is off here (null: it isn't), each grid, the volumes refused a grid (GI_BOUNDS.grids) and why, what
 *  the last proxy held and what its bounds cut, and the bake in progress (null when none). */
export const giDebug = () => ({ level: giPref(), off: failed ?? giSupport(renderer),
  grids: [...live.values()].map((l) => ({ id: l.plan.id, counts: l.plan.counts, cube: l.plan.cube, shown: l.added })),
  refused: refused.map((r) => ({ ...r })), proxy: proxyStats && { ...proxyStats, cut: { ...proxyStats.cut } },
  baking: job ? job.queue.map((q) => `${q.l.plan.id} ${q.i}/${q.steps.length}`) : null });
