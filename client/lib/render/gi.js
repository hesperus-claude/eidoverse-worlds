// gi — the world's baked bounce light: an irradiance probe volume (three r186's LightProbeGrid: L2 SH probes in one 3D
// texture) over each gi-volume (componentspec). At run time it is Godot's LightmapGI probes or Bevy's irradiance volumes, not
// VoxelGI: no voxels, no live relighting; only that the client bakes it resembles VoxelGI. The world owns the look (the component and its strength), each viewer's ew-gi dial the cost
// (render/gipref.js). A grid is baked a probe a frame through the shared frame budget, from a PROXY of the room (its opaque
// unskinned meshes at their world matrices and the placed lights near it), never the live scene: baking the live client
// scene hung the page (render-lab 11-09, probes/gi-grid.js). Rebaked in place, debounced, once loads settle.
// No gi-volume or the dial off: three's grid code never loads and nothing is built.
import { THREE, TSL, scene, renderer, backendName } from '../core.js';
import { bus } from '../base.js';
import { state, onWorldChange } from '../state.js';
import { laneBusy } from './loadwork.js';
import { ask, spent } from './framebudget.js';
import { worldLights, glowScale } from './lightrig.js';
import { GI_LEVELS, giPref, setGiPref, onGiPref } from './gipref.js';
import { foldOfView } from '../../../shared/zone.js';
import { worldPose, offChain } from '../../../shared/protocol/simlayer.js';
export { GI_LEVELS, giPref, setGiPref };

const TIERS = { low: { cube: 8, cap: 250 }, high: { cube: 16, cap: 1000 } };

// ---- pure: what to bake ----
const fin = Number.isFinite, v3 = (x) => Array.isArray(x) && x.length === 3 && x.every(fin);
const clamp = (x, lo, hi, d) => (fin(x) ? Math.min(hi, Math.max(lo, x)) : d);   // the registry's ranges (componentspec gi-volume)

/** The volumes in a fold (shared/zone.js foldOfView): [{id, center, size, strength, spacing, bounces, blend}], world-axis-aligned. */
export function giVolumesOf(st) {
  const out = [];
  for (const id of Object.keys(st?.entities ?? {}).sort()) {
    const c = st.entities[id].c, g = c['gi-volume'];
    if (id === '@world' || !g || typeof g !== 'object' || c.zone?.shape !== 'box' || c.zone.global === true || !v3(c.zone.size) || offChain(st, id)) continue;
    const pose = worldPose(st, id); if (!pose) continue;
    const scale = v3(pose.scale) ? pose.scale.map(Math.abs) : [1, 1, 1];
    out.push({ id, center: [...pose.pos], size: c.zone.size.map((x, i) => Math.abs(x) * scale[i]),
      strength: clamp(g.strength, 0, 16, 1), spacing: clamp(g.spacing, 0.25, 8, 1.5), bounces: Math.round(clamp(g.bounces, 0, 2, 1)),
      blend: clamp(c.zone.blend, 0, 1e3, 0) });
  }
  return out;
}

/** One volume's grid at a dial level, or null (off, or nothing to light). Probes sit on the zone's faces and `spacing` apart;
 *  past the level's probe cap the spacing widens. falloff: one probe cell past the zone (its floor and walls are on its faces), plus its blend. */
export function planGrid(vol, level) {
  const tier = TIERS[level];
  if (!tier || !vol || !(vol.strength > 0)) return null;
  const countsAt = (s) => vol.size.map((e) => Math.max(2, Math.round(e / s) + 1));
  let s = vol.spacing, counts = countsAt(s);
  while (counts[0] * counts[1] * counts[2] > tier.cap) counts = countsAt(s *= 1.1);
  const cell = Math.max(...vol.size.map((e, i) => e / (counts[i] - 1)));
  return { id: vol.id, center: vol.center, size: vol.size, counts, cube: tier.cube, bounces: vol.bounces, intensity: vol.strength, falloff: cell + vol.blend };
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
const QUIET_MS = 1500;           // a rebake waits for the world to stop changing
function touch() { dirtyAt = performance.now(); }
const boxOf = (p, pad = 0) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...p.center), new THREE.Vector3(...p.size).addScalar(2 * pad));
const nearAny = (id) => { const pos = state.st.entities?.[id]?.pos; if (!v3(pos)) return true; const v = new THREE.Vector3(...pos); for (const { plan } of live.values()) if (boxOf(plan, 2).containsPoint(v)) return true; return false; };
// what can make or unmake a volume; anything else matters only while one is live
const SHAPES = new Set(['gi-volume', 'zone', 'disabled']);
onWorldChange((ev) => {
  if (ev?.type === 'reset') { for (const id of [...live.keys()]) drop(id); job = null; }
  if (!giTouches(ev, nearAny)) return;
  const { what, comp: name } = ev;
  if (live.size || job || ev.type !== 'change' || what === 'born' || what === 'gone' || what === 'parent' || SHAPES.has(name)) touch();
});
onGiPref(touch);
bus.on?.('lanes-idle', () => { if (live.size || job) touch(); });   // models finished loading: what the proxy sees changed

function drop(id) { const l = live.get(id); if (!l) return; scene.remove(l.grid); l.grid.dispose(); live.delete(id); }

// the proxy: the world's opaque, unskinned meshes near a volume at their world matrices, and every placed light near one
function buildProxy(plans) {
  const proxy = new THREE.Scene(); proxy.background = new THREE.Color(0, 0, 0);
  const boxes = plans.map((p) => boxOf(p, 1)), b = new THREE.Box3();
  for (const obj of objects().values()) {
    if (!obj?.parent) continue;
    obj.updateMatrixWorld(true);
    obj.traverseVisible((x) => {
      if (!(x.isMesh || x.isInstancedMesh) || x.isSkinnedMesh || !x.geometry || !x.material) return;
      if ((Array.isArray(x.material) ? x.material : [x.material]).every((m) => m.transparent)) return;
      if (!boxes.some((bx) => bx.intersectsBox(b.setFromObject(x, false)))) return;
      const m = x.isInstancedMesh ? new THREE.InstancedMesh(x.geometry, x.material, x.count) : new THREE.Mesh(x.geometry, x.material);
      if (x.isInstancedMesh) { m.instanceMatrix.copy(x.instanceMatrix); m.instanceMatrix.needsUpdate = true; }
      m.matrixAutoUpdate = false; m.matrix.copy(x.matrixWorld); m.matrixWorld.copy(x.matrixWorld); m.frustumCulled = false;
      proxy.add(m);
    });
  }
  for (const L of worldLights()) {   // the rig's requests, not its slots: the pool lights ~8 of a room's lamps at a time
    if (!boxes.some((bx) => bx.distanceToPoint(L.pos) <= L.range)) continue;
    const l = L.spot ? new THREE.SpotLight(L.color, L.intensity, L.range, L.spot.angle, L.spot.angle > 0 ? Math.min(1, Math.max(0, (L.spot.angle - (L.spot.inner ?? 0)) / L.spot.angle)) : 0, L.decay)
      : new THREE.PointLight(L.color, L.intensity, L.range, L.decay);
    l.castShadow = false; l.position.copy(L.pos);
    if (L.spot) { l.target.position.copy(L.pos).add(L.dir); proxy.add(l.target); }
    proxy.add(l);
  }
  proxy.updateMatrixWorld(true);
  return proxy;
}

async function startBake() {
  dirtyAt = 0; job = null; starting = true;
  try { await replan(); } catch (e) { giOff(`bake setup failed: ${e?.message ?? e}`); } finally { starting = false; }
}
// off for this page, and said where the capture rig looks (giDebug().off): what throws once throws every time
function giOff(why) {
  failed = `${why} (${backendName?.() ?? '?'})`;
  console.warn(`[gi] ${failed}; bounce light off on this page`);
  for (const id of [...live.keys()]) drop(id);
  job = null;
}
async function replan() {
  const plans = failed || giSupport(renderer) ? [] : plansOf(foldOfView(state.st), giPref());
  const keep = new Set(plans.map((p) => p.id));
  for (const id of [...live.keys()]) if (!keep.has(id)) drop(id);
  if (!plans.length) return;
  if (!LPG) {   // registered before the first bake: three's bake registers its own node only when the library has none for the class
    const Grid = (await import('three/addons/lighting/LightProbeGrid.js')).LightProbeGrid;
    const { LightProbeGridNode } = await import('three/addons/tsl/lighting/LightProbeGridNode.js');
    if (!LPG) { renderer.library.addLight(sharedGridNode(LightProbeGridNode, TSL.renderGroup), Grid); LPG = Grid; }
  }
  const queue = plans.map((plan) => {
    const key = JSON.stringify([plan.center, plan.size, plan.counts]);
    let l = live.get(plan.id);
    if (l && l.key !== key) { drop(plan.id); l = null; }   // a new grid recompiles every lit material once (its light id); a rebake in place doesn't
    if (!l) {
      const grid = new LPG(...plan.size, ...plan.counts); grid.position.set(...plan.center); grid.updateMatrixWorld(true);
      l = { grid, key, added: false }; live.set(plan.id, l);
    }
    l.plan = plan; l.grid.falloff = plan.falloff;
    return { l, steps: bakeSteps(plan.counts[0] * plan.counts[1] * plan.counts[2], plan.bounces), i: 0 };
  });
  job = { proxy: buildProxy(plans), queue };
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

/** The frame loop's step: start a debounced rebake once loads settle, bake one probe when the frame budget allows. */
export function updateGi() {
  if (globalThis.__gpuLost?.fired) return;   // a lost device draws nothing (gpulost.js)
  if (dirtyAt && !starting && performance.now() - dirtyAt > QUIET_MS && !laneBusy() && state.hydrated && renderer.initialized !== false) startBake();
  else if (job) stepBake();
  for (const { grid, plan } of live.values()) grid.intensity = plan.intensity * glowScale();   // its lamps dim by day as the rig's do
}
/** EW.gi: the dial, why GI is off here (null: it isn't), each grid, and the bake in progress (null when none). */
export const giDebug = () => ({ level: giPref(), off: failed ?? giSupport(renderer),
  grids: [...live.values()].map((l) => ({ id: l.plan.id, counts: l.plan.counts, cube: l.plan.cube, shown: l.added })),
  baking: job ? job.queue.map((q) => `${q.l.plan.id} ${q.i}/${q.steps.length}`) : null });
