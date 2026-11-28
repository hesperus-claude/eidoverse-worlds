// gi-volume's client side without a GPU (client/lib/render/gi.js): the volumes it reads, the grid each viewer's dial
// plans, the ranged bake's steps, what makes it rebake, what it builds (nothing, for a world without a gi-volume or a
// viewer with the dial off), and where it says why it is off. The bake's picture is the lead's live check (render-lab).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/gi-test.mjs
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
import fs from 'node:fs';
import { stubResolve } from '../harness/stub.ts';
import { suite } from '../gate/suite.ts';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
let gridModuleLoads = 0;   // how often anything asked for three's LightProbeGrid code
plugin({ name: 'gi-stubs', setup(build) {
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/gi-core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/gi-base-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+(render\/)?loadwork\.js$/, () => ({ path: here('../stubs/loadwork-stub.mjs') }));
  stubResolve(build, /^three\/addons\/(lighting|tsl\/lighting)\/LightProbeGrid(Node)?\.js$/, () => { gridModuleLoads++; return { path: here('../stubs/lightprobegrid-stub.mjs') }; });
} });
const read = (p) => fs.readFileSync(`${HERE}/../../${p}`, 'utf8');

const S = suite('gi');
const check = (name, ok, note) => S.check(name, ok, note);
let G = null;
try { G = await import('../../client/lib/render/gi.js'); } catch (e) { check('G0 client/lib/render/gi.js imports', false, String(e?.message ?? e)); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const prod = (c) => c[0] * c[1] * c[2];

if (G) {
  // the fold shape (shared/zone.js foldOfView): a 6 × 3 × 9 m room whose host hangs 10 m along x from a parent
  const room = (gi, zone = { shape: 'box', size: [6, 3, 9] }, extra = {}) => ({ entities: {
    hall: { c: { transform: { pos: [10, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, ...extra.hall } },
    room: { c: { transform: { pos: [0, 1.5, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, parent: { to: 'hall' }, zone, 'gi-volume': gi, ...extra.room } } } });

  const v = G.giVolumesOf(room({ energy: 2 }));
  check('G1 a thing with a box zone and gi-volume is one volume: its world centre, the zone\'s size, the fields read (absent: energy 1, spacing 1.5, bounces 1)',
    v.length === 1 && v[0].id === 'room' && same(v[0].center, [10, 1.5, 0]) && same(v[0].size, [6, 3, 9]) && v[0].energy === 2 && v[0].spacing === 1.5 && v[0].bounces === 1, v);
  check('G1 …no zone, a sphere zone, a global zone or a switched-off host: no volume',
    G.giVolumesOf(room({}, null)).length === 0 && G.giVolumesOf(room({}, { shape: 'sphere', radius: 2 })).length === 0
    && G.giVolumesOf(room({}, { shape: 'box', size: [6, 3, 9], global: true })).length === 0 && G.giVolumesOf(room({}, undefined, { hall: { disabled: true } })).length === 0,
    [G.giVolumesOf(room({}, null)), G.giVolumesOf(room({}, undefined, { hall: { disabled: true } }))]);
  check('G1 …and a box zone with no gi-volume is no volume either', G.giVolumesOf(room(undefined)).length === 0, G.giVolumesOf(room(undefined)));

  const lo = G.planGrid(v[0], 'low'), hi = G.planGrid(v[0], 'high');
  check('G2 the grid fills the zone: probes on its faces, spacing apart (6 × 3 × 9 m at 1.5 m: 5 × 3 × 7), centred on it',
    lo && same(lo.counts, [5, 3, 7]) && same(lo.size, [6, 3, 9]) && same(lo.center, [10, 1.5, 0]) && lo.bounces === 1 && lo.intensity === 2, lo);
  check('G3 the dial sets the cost: low bakes 8² cube faces, high 16²', lo?.cube === 8 && hi?.cube === 16 && same(hi?.counts, lo?.counts), [lo, hi]);
  const big = G.giVolumesOf(room({ spacing: 0.5 }, { shape: 'box', size: [30, 6, 30] }))[0];
  const bl = G.planGrid(big, 'low'), bh = G.planGrid(big, 'high');
  check('G4 the viewer\'s probe cap widens the owner\'s spacing (low ≤ 250, high ≤ 1000), never under 2 a side, high finer than low',
    bl && bh && prod(bl.counts) <= 250 && prod(bh.counts) <= 1000 && prod(bh.counts) > prod(bl.counts) && [...bl.counts, ...bh.counts].every((n) => n >= 2), [bl?.counts, bh?.counts]);
  check('G5 dial off: no grid', G.planGrid(v[0], 'off') === null && G.plansOf(room({}), 'off').length === 0, [G.planGrid(v[0], 'off')]);
  check('G5 …energy 0: no grid either (nothing to light)', G.planGrid(G.giVolumesOf(room({ energy: 0 }))[0], 'high') === null, '');
  const wild = G.giVolumesOf(room({ spacing: 0.01, bounces: 9, energy: 99 }))[0];
  check('G6 the old spelling `strength` is no field (renamed energy while trial, no alias): it reads as absent', G.giVolumesOf(room({ strength: 3 }))[0]?.energy === 1, G.giVolumesOf(room({ strength: 3 }))[0]);
  check('G6 a value past the registry\'s range reads at its bound (spacing ≥ 0.25 m, bounces ≤ 2, energy ≤ 16)', wild?.spacing === 0.25 && wild?.bounces === 2 && wild?.energy === 16, wild);
  // three fades a grid from its outermost probes; a room's floor, walls and ceiling ARE its zone's faces (or just past them):
  // a hard edge there dropped the bounce off every surface it was for (render-lab 11-09: luma off 45.4, low 45.9; fade 0: 57)
  const cell = Math.max(...lo.size.map((e, i) => e / (lo.counts[i] - 1)));
  check('G6 …the edge fades over one probe cell past the zone (a surface on or just past its faces keeps its bounce), plus the zone\'s blend (Unity Volume blend)',
    lo.falloff >= cell && lo.falloff <= cell + 1e-9 && Math.abs(G.planGrid(G.giVolumesOf(room({}, { shape: 'box', size: [6, 3, 9], blend: 2 }))[0], 'low')?.falloff - (cell + 2)) < 1e-9, [lo?.falloff, cell]);

  const st = G.bakeSteps(105, 1);
  check('G7 the bake is ranged, one probe a step: every probe direct (pass 0), then every probe again per bounce (pass 1), each pass from 0',
    st.length === 210 && st.every((s) => s.count === 1) && same(st[0], { start: 0, count: 1, pass: 0 }) && same(st[104], { start: 104, count: 1, pass: 0 }) && same(st[105], { start: 0, count: 1, pass: 1 }) && same(st[209], { start: 104, count: 1, pass: 1 }), [st.length, st[0], st[105]]);
  check('G7 …no bounces: one pass', G.bakeSteps(8, 0).length === 8 && G.bakeSteps(8, 0).every((s) => s.pass === 0), G.bakeSteps(8, 0).length);

  check('G8 the dial: off | low | high, low by default, stored in ew-gi; a bad value is ignored',
    same(G.GI_LEVELS, ['off', 'low', 'high']) && G.giPref() === 'low' && (G.setGiPref('high'), G.giPref() === 'high' && localStorage.getItem('ew-gi') === 'high') && (G.setGiPref('ultra'), G.giPref() === 'high') && (G.setGiPref('off'), G.giPref() === 'off'), G.giPref());
  localStorage.setItem('ew-gi', 'banana');
  check('G8 …a stored value that is no level reads as low', G.giPref() === 'low', G.giPref());

  check('G9 a rebake follows the world: a reset, the volume, its zone, a light, a model, a switch-off',
    G.giTouches({ type: 'reset' }) && G.giTouches({ type: 'hydrated' }) && ['gi-volume', 'zone', 'light', 'model', 'mesh', 'disabled', 'hidden'].every((comp) => G.giTouches({ type: 'change', what: 'comp', comp, id: 'x' })), '');
  check('G9 …and a thing born, gone or moved; not a sound or a script', G.giTouches({ type: 'change', what: 'born', id: 'cup' }) && G.giTouches({ type: 'change', what: 'pose', id: 'cup' }) && G.giTouches({ type: 'change', what: 'gone', id: 'cup' })
    && !G.giTouches({ type: 'change', what: 'comp', comp: 'sound', id: 'cup' }) && !G.giTouches({ type: 'world', key: 'chat' }), '');
  check('G9 …a thing that moves far from every volume doesn\'t (near: false)', !G.giTouches({ type: 'change', what: 'pose', id: 'ball' }, () => false) && G.giTouches({ type: 'change', what: 'comp', comp: 'light', id: 'ball' }, () => false), '');

  check('G9 support: three\'s grid bakes with a WebGPURenderer (either backend); on WebGL 2 it needs float colour targets; otherwise a reason, never a throw',
    typeof G.giSupport?.({ isWebGPURenderer: false }) === 'string' && G.giSupport({ isWebGPURenderer: true, backend: { isWebGPUBackend: true } }) === null
    && /EXT_color_buffer_float/.test(G.giSupport({ isWebGPURenderer: true, backend: { isWebGLBackend: true, extensions: { has: () => false } } }) ?? '')
    && G.giSupport({ isWebGPURenderer: true, backend: { isWebGLBackend: true, extensions: { has: (n) => n === 'EXT_color_buffer_float' } } }) === null && typeof G.giSupport(null) === 'string',
    [G.giSupport?.({ isWebGPURenderer: false }), G.giSupport?.({ isWebGPURenderer: true, backend: { isWebGLBackend: true, extensions: { has: () => false } } })]);
}

// ---- the frame loop, against three's grid stand-in (test/stubs/lightprobegrid-stub.mjs) ----
const core = await import('../stubs/gi-core-stub.mjs'), St = await import('../../client/lib/state.js'), FB = await import('../../client/lib/render/framebudget.js'), LP = await import('../stubs/lightprobegrid-stub.mjs');
const LR = await import('../../client/lib/render/lightrig.js');
{ // G11: what a bake lights the room with
  LR.requestLight('complight:lamp', { authored: true, pos: [1, 2, 3], intensity: 40, range: 8, decay: 2, dayAware: true, color: 0xffaa00 });
  LR.requestLight('complight:noon', { authored: true, pos: [0, 2, 0], intensity: 10, range: 6, decay: 2, dayAware: false });
  LR.requestLight('complight:spot', { authored: true, pos: [0, 3, 0], q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], intensity: 20, range: 9, decay: 2, spot: { angle: 0.5, inner: 0.25 } });
  LR.requestLight('lamp:body:0', { pos: [0, 1, 0], intensity: 9, dayAware: true });   // an inferred lamp: a body, not the room
  const wl = typeof LR.worldLights === 'function' ? LR.worldLights() : [];
  const by = (k) => wl.find((l) => l.key === k);
  check('G11 the proxy\'s lights are every placed light the rig was asked for, slotted or not (lightrig worldLights): the authored requests, not inferred lamps',
    same(wl.map((l) => l.key).sort(), ['complight:lamp', 'complight:noon', 'complight:spot']) && same(by('complight:lamp')?.pos?.toArray?.(), [1, 2, 3]) && by('complight:lamp')?.intensity === 40 && by('complight:lamp')?.range === 8 && by('complight:lamp')?.decay === 2,
    wl.map((l) => [l.key, l.pos?.toArray?.(), l.intensity]));
  const sd = by('complight:spot')?.dir;
  check('G11 …a spot with its cone and the way it shines (its host\'s -Z; a parked one by its folded q)', by('complight:spot')?.spot?.angle === 0.5 && !!sd && Math.abs(sd.x) < 1e-6 && Math.abs(sd.y - 1) < 1e-6 && Math.abs(sd.z) < 1e-6 && by('complight:lamp')?.dir == null,
    [by('complight:spot')?.spot, sd?.toArray?.()]);
  check('G11 …and whether each dims by day (light.daytime)', by('complight:lamp')?.dayAware === true && by('complight:noon')?.dayAware === false, wl.map((l) => [l.key, l.dayAware]));
  for (const k of ['complight:lamp', 'complight:noon', 'complight:spot', 'lamp:body:0']) LR.releaseLight(k);
}

const added = [], removed = [];
const inScene = new Set();   // what the live scene holds now (the rows below count grids in it)
core.scene.add = (o) => { added.push(o); inScene.add(o); };
core.scene.remove = (o) => { removed.push(o); inScene.delete(o); };
let objectReads = 0;
const roomMeshes = new Map();
{ const world = new core.THREE.Scene(), g = new core.THREE.Group(); world.add(g); const box = new core.THREE.Mesh(new core.THREE.BoxGeometry(3, 3, 3), new core.THREE.MeshStandardMaterial()); box.position.set(0, 1.5, 0); g.add(box); roomMeshes.set('walls', g); }
G?.setGiObjects?.(() => { objectReads++; return roomMeshes; });
core.renderer.isWebGPURenderer = true;
core.renderer.backend = { isWebGPUBackend: true };
const regs = [];   // what gi.js registers with three's node library (G12), and how many bake steps had run by then
core.renderer.library = { addLight: (nodeClass, lightClass) => regs.push({ nodeClass, lightClass, bakesBefore: LP.bakes.length }) };
let now = 1e6; performance.now = () => now;
let perFrame = null;   // a row's own work each frame, before the bake's step (another lane's ask, a look at the scene)
const run = async (frames) => { for (let i = 0; i < frames; i++) { now += 20; FB.tick(now); perFrame?.(); G.updateGi(); await new Promise((r) => setImmediate(r)); } };
const giRoom = (gi, things = {}) => ({ entities: { walls: { pos: [0, 0, 0] }, room: { pos: [0, 1.5, 0], zone: { shape: 'box', size: [3, 3, 3] }, ...(gi ? { 'gi-volume': gi } : {}) }, ...things } });   // things: more entities beside the room
const quiet = () => ({ made: LP.made.length, bakes: LP.bakes.length, loads: gridModuleLoads, objectReads, added: added.length, dbg: G.giDebug?.() });

if (G) {
  // (1) the world/viewer split's first property: nothing asked, nothing built and nothing paid (main's picture exactly)
  G.setGiPref('low');
  St.hydrate(giRoom(null, { lamp: { pos: [0, 2, 0], light: { intensity: 20 } } }));
  await run(200);
  const q0 = quiet();
  check('G14 a world with no gi-volume builds nothing: three\'s grid code never loads, no grid is made or baked, no proxy reads the room, nothing joins the scene',
    q0.loads === 0 && q0.made === 0 && q0.bakes === 0 && q0.objectReads === 0 && q0.added === 0 && same(q0.dbg?.grids, []) && q0.dbg?.baking === null, q0);
  St.reset(); G.setGiPref('off');
  St.hydrate(giRoom({ bounces: 1 }));
  await run(200);
  const q1 = quiet();
  check('G14 …nor a viewer with the dial off, in a world that asks for one', q1.loads === 0 && q1.made === 0 && q1.bakes === 0 && q1.objectReads === 0 && q1.added === 0 && same(q1.dbg?.grids, []) && q1.dbg?.baking === null && q1.dbg?.level === 'off', q1);
  // the positive control: the same room with the dial at low builds and bakes one grid, then shows it
  G.setGiPref('low');
  await run(250);
  const q2 = quiet(), grid = LP.made[0];
  check('G14 …turned to low, the same room builds one grid (3 × 3 × 3 probes) and bakes it, direct then one bounce, a probe a frame, then shows it',
    q2.made === 1 && q2.bakes === 54 && same(LP.bakes.map((b) => b.pass), [...Array(27).fill(0), ...Array(27).fill(1)]) && LP.bakes.every((b) => b.count === 1 && b.cubemapSize === 8) && added.includes(grid)
    && same(q2.dbg?.grids?.map((x) => [x.id, x.counts, x.shown]), [['room', [3, 3, 3], true]]) && q2.dbg?.baking === null, { ...q2, passes: LP.bakes.map((b) => b.pass).join('') });
  check('G14 …baked from a proxy, never the live scene: the room\'s meshes copied at their world matrices', LP.bakes.length > 0 && LP.bakes.every((b) => b.scene !== core.scene && b.scene?.isScene)
    && LP.bakes[0].scene.children.some((m) => m.isMesh && m.geometry === roomMeshes.get('walls').children[0].geometry), LP.bakes[0]?.scene?.children?.length);
  G.setGiPref('off');
  await run(120);
  check('G14 …and turned off again, the grid leaves the scene and is freed', removed.includes(grid) && grid?.disposed === true && same(G.giDebug().grids, []), [removed.length, grid?.disposed, G.giDebug().grids]);
  G.setGiPref('low');

  // fix A (render-lab 11-23): three r186's LightProbeGridNode keeps the grid's box, resolution, intensity and falloff in the
  // PER-OBJECT uniform group, and three refreshes that group for a material with no nodes of its own (every glTF model's plain
  // MeshStandardMaterial) only when the object, its material or its geometry changes (NodeMaterialObserver.needsRefresh). gi.js
  // dims the grid by day every frame, so a model first drawn by day kept the day's 0.0012 at night (23 of 25 model meshes;
  // night frame luma 40.86 after a day preview, 45.55 without). The render group is three's own place for a light's values.
  const groupsOf = (n) => Object.fromEntries(LP.GRID_UNIFORMS.map((k) => [k, n?.[k]?.group]));
  const Node = G.sharedGridNode?.(LP.LightProbeGridNode, 'the group given'), n = Node ? new Node({ isLightProbeGrid: true }) : null;
  check('G12 the grid\'s light node is three\'s, with every uniform three keeps per object (the box, the resolution, the intensity, the falloff) moved to the group it is given',
    !!n && n instanceof LP.LightProbeGridNode && LP.GRID_UNIFORMS.every((k) => n[k].group === 'the group given'), groupsOf(n));
  const r = regs[0], madeNode = r ? new r.nodeClass({ isLightProbeGrid: true }) : null;
  check('G12 …and gi.js registers it for three\'s LightProbeGrid with the RENDER group, once, before the first bake step (three\'s bake registers its own only when none is)',
    regs.length === 1 && r.lightClass === LP.LightProbeGrid && r.bakesBefore === 0 && LP.GRID_UNIFORMS.every((k) => madeNode[k].group === core.TSL.renderGroup),
    [regs.length, r?.bakesBefore, groupsOf(madeNode)]);
  const b0 = LP.bakes.length;
  await run(250);
  check('G12 …a rebake registers nothing more', regs.length === 1 && LP.bakes.length > b0, [regs.length, LP.bakes.length - b0]);

  // fix B (render-lab 11-23): three's bounce pass lights the proxy with a copy of the grid AT THE GRID'S OWN INTENSITY
  // (LightProbeGrid._updateBounceGrid), and updateGi dims the grid by day. A bake that ran by day (any rebake does: a lamp
  // moved, a model landed) had no second bounce and kept that at night (both passes at 0.00116; atlas L0 mean 0.298 where a
  // night bake gives 0.319). What a bake holds is the room, not the hour.
  St.reset(); LR.setDayness(0.966); LP.bakes.length = 0;
  LR.requestLight('complight:bulb', { authored: true, pos: [0, 2, 0], intensity: 10, range: 5, decay: 2, dayAware: true });   // G16's lamp, inside the room
  St.hydrate(giRoom({ bounces: 1, energy: 2 }));
  await run(250);
  const day = LR.glowScale(), shown = LP.bakes[0]?.grid?.intensity;
  check('G13 a bake step runs with the grid at its volume\'s energy, whatever the hour (the bounce pass reads it)', day < 0.01 && LP.bakes.length === 54 && LP.bakes.every((x) => x.intensity === 2), [day, LP.bakes.length, [...new Set(LP.bakes.map((x) => x.intensity))]]);
  check('G13 …and the frame still shows the grid dimmed by day', Math.abs(shown - 2 * day) < 1e-12, [shown, 2 * day]);
  LR.setDayness(null);
  // G16 pins TODAY'S behaviour (the plan critique of 11-25, a second suspect for the loose per-patch fit, r = 0.43): the
  // bake's lights cast no shadows and its proxy meshes cast none, so lamp light reaches every probe through furniture during
  // the bake itself, not only at lookup. Turning bake shadows on must move this row on purpose.
  const pl = LP.bakes[0]?.scene?.children?.filter((o) => o.isLight) ?? [], pm = LP.bakes[0]?.scene?.children?.filter((o) => o.isMesh) ?? [];
  check('G16 today the bake lights the proxy with every placed light in range, none casting a shadow, and no proxy mesh casts one (light leaks through furniture in the bake)',
    pl.length === 1 && pl[0].isPointLight && pl[0].intensity === 10 && pl.every((l) => l.castShadow === false) && pm.length > 0 && pm.every((m) => m.castShadow === false),
    [pl.map((l) => [l.type, l.intensity, l.castShadow]), pm.map((m) => m.castShadow)]);
  LR.releaseLight('complight:bulb');

  // ---- the rebake storm (render-lab 11-23: "6-9 rebakes per load, one per lanes-idle, each new proxy's first step stalling
  // the main thread 13-35 s"). A world loads, its models land one by one, the lanes drain after each: one bake, started
  // once the room's static content has settled (the scheduler's queue at P.FAR drained: what main.js's ready gate reads),
  // and a rebake only when what the bake sees changes. Godot never rebakes by itself (VoxelGI/LightmapGI bake on request).
  const Sch = await import('../../client/lib/render/scheduler.js'), BUS = await import('../stubs/gi-base-stub.mjs');
  const jobsOf = () => LP.bakes.filter((b) => b.pass === 0 && b.start === 0).length;   // each bake job starts at probe 0, pass 0
  const meshAt = (x, z, extra) => { const w = new core.THREE.Scene(), g = new core.THREE.Group(); w.add(g); const m = new core.THREE.Mesh(new core.THREE.BoxGeometry(0.5, 0.5, 0.5), new core.THREE.MeshStandardMaterial()); m.position.set(x, 0.5, z); g.add(m); if (extra) extra(g); return g; };
  const beat = async () => { BUS.bus.emit('lanes-idle'); await run(100); };   // the lanes drain, then 2 s pass
  St.reset(); await run(10);
  LR.requestLight('complight:lamp1', { authored: true, pos: [0, 2.5, 0], intensity: 20, range: 6, decay: 2 });
  for (const k of [...roomMeshes.keys()]) if (k !== 'walls') roomMeshes.delete(k);
  LP.bakes.length = 0;
  const landed = [];
  for (let i = 0; i < 4; i++) Sch.schedule({ key: `model:m${i}`, lane: 'net', priority: Sch.P.NEAR, run: () => new Promise((r) => landed.push(r)) });
  St.hydrate(giRoom({ bounces: 1 }, { cup: { pos: [0.5, 1, 0.5], grabbable: {} } }));
  await run(100);
  for (let i = 0; i < 4; i++) { roomMeshes.set(`m${i}`, meshAt(-1 + i * 0.6, 0.3)); landed[i]?.(); await run(2); await beat(); }
  await run(300);
  const afterLoad = { jobs: jobsOf(), steps: LP.bakes.length, meshes: LP.bakes.at(-1)?.children?.filter((o) => o.isMesh).length };
  check('R1 a load whose four models land one by one, the lanes draining after each, bakes ONCE, after the last has landed, and finishes (54 steps, every model in the proxy)',
    afterLoad.jobs === 1 && afterLoad.steps === 54 && afterLoad.meshes === 5 && G.giDebug().baking === null, afterLoad);
  for (let i = 0; i < 3; i++) await beat();
  await run(300);
  check('R1 …more lanes-idle beats with nothing changed bake nothing more', jobsOf() === 1 && LP.bakes.length === 54, [jobsOf(), LP.bakes.length]);
  roomMeshes.set('m4', meshAt(1, -1)); await beat(); await run(300);
  check('R1 …a model that lands later rebakes once, with it in the proxy', jobsOf() === 2 && LP.bakes.length === 108 && LP.bakes.at(-1).children.filter((o) => o.isMesh).length === 6, [jobsOf(), LP.bakes.length]);
  { const j0 = jobsOf(), n0 = LP.bakes.length;   // the owner asks for finer probes: a bake of ~250 probes, ~10 s at a probe a frame
    const finer = structuredClone(St.state.st); finer.entities.room['gi-volume'] = { bounces: 1, spacing: 0.5 }; St.applyView(finer);
    await run(100);                                                                  // 1.5 s quiet, then the bake is under way
    const mid = LP.bakes.length - n0; BUS.bus.emit('lanes-idle'); await run(800);   // a wake with nothing new, mid-bake
    const c = G.giDebug().grids[0]?.counts ?? [0, 0, 0], n = c[0] * c[1] * c[2];
    const steps = LP.bakes.slice(n0).map((b) => `${b.pass}:${b.start}`), want = [0, 1].flatMap((ps) => [...Array(n).keys()].map((i) => `${ps}:${i}`));
    check('R1 …and a wake in the middle of a bake, with nothing new, lets it finish: one job, every step in order, no restart', n > 27 && mid > 0 && mid < 2 * n && jobsOf() === j0 + 1 && JSON.stringify(steps) === JSON.stringify(want) && G.giDebug().baking === null, [n, mid, jobsOf() - j0, steps.length]); }
  const p1 = LP.bakes[0].children, p2 = LP.bakes.at(-1).children, ids = (ch) => ch.filter((o) => o.isLight).map((l) => l.id);   // what each bake's proxy held at its step
  check('R2 a rebake lights its proxy with the SAME light objects as the last one (three keys every lit pipeline by light id: new lights rebuild every proxy material, the first-step stall)',
    ids(p1).length === 1 && JSON.stringify(ids(p1)) === JSON.stringify(ids(p2)), [ids(p1), ids(p2)]);
  const shared = p2.filter((o) => o.isMesh && p1.includes(o)).length;
  check('R2 …and keeps the mesh copies of what did not change', shared === 5, shared);
  const cupMesh = meshAt(0.5, 0.5); roomMeshes.set('cup', cupMesh);
  const gz = (() => { const w = new core.THREE.Scene(), g = new core.THREE.Group(); w.add(g); const b = new core.THREE.Mesh(new core.THREE.SphereGeometry(0.13), new core.THREE.MeshBasicMaterial()); b.userData.isGizmo = true; b.position.set(0, 2, 0); g.add(b); return g; })();   // an Empty's bulb, nothing else
  roomMeshes.set('bulb', gz);
  const before = LP.bakes.length; await beat(); await run(300);
  const p3 = LP.bakes.at(-1).children, srcOf = (m) => m.geometry;
  check('R3 the bake leaves out editor gizmos (a light\'s bulb) and things that move (grabbable, dynamic or kinematic physics, motion, openable): Godot bakes only gi_mode static',
    !p3.some((m) => m.isMesh && (srcOf(m) === gz.children[0].geometry || srcOf(m) === cupMesh.children[0].geometry)), [LP.bakes.length - before, p3.length]);
  check('R3 …so a bulb appearing and a grabbable cup landing do not rebake', LP.bakes.length === before, LP.bakes.length - before);
  const moved = structuredClone(St.state.st); moved.entities.cup.pos = [0.2, 1, 0.2];
  St.applyView(moved); await beat(); await run(300);
  check('R3 …nor does carrying the cup about', LP.bakes.length === before, LP.bakes.length - before);
  LR.releaseLight('complight:lamp1');
  for (const k of [...roomMeshes.keys()]) if (k !== 'walls') roomMeshes.delete(k);
}
check('G10 Video settings carry the GI row through the dial\'s own module (videopanel.js reads render/gipref.js, not the bake)', /from '\.\.\/render\/gipref\.js'/.test(read('client/lib/ui/videopanel.js')) && /giPref\(\)/.test(read('client/lib/ui/videopanel.js')) && /setGiPref\(/.test(read('client/lib/ui/videopanel.js')), '');
check('G10 …the frame loop steps it, hands it the world\'s objects, and EW.gi reads giDebug (main.js)', /registerSystem\('gi', updateGi\)/.test(read('client/main.js')) && /setGiObjects\(\(\) => entities\)/.test(read('client/main.js')) && /\bgi: giDebug\b/.test(read('client/main.js')), '');

// the frame-loop rows below share these: a fresh world, a mesh, an edit of the view, what the last bake step's proxy held
const BUS = await import('../stubs/gi-base-stub.mjs'), LW = await import('../stubs/loadwork-stub.mjs'), T = core.THREE;
const jobsOf = () => LP.bakes.filter((b) => b.pass === 0 && b.start === 0).length;   // each bake job starts at probe 0, pass 0
const box = (x, y, z, size = 0.5, mat) => { const w = new T.Scene(), g = new T.Group(); w.add(g); const m = new T.Mesh(new T.BoxGeometry(size, size, size), mat ?? new T.MeshStandardMaterial()); m.position.set(x, y, z); g.add(m); return g; };
const fresh = async () => { St.reset(); await run(5); LP.bakes.length = 0; LP.made.length = 0; added.length = 0; removed.length = 0; for (const k of [...roomMeshes.keys()]) if (k !== 'walls') roomMeshes.delete(k); };
const proxyMeshes = () => (LP.bakes.at(-1)?.children ?? []).filter((o) => o.isMesh).map((m) => m.geometry);   // what the last bake step's proxy held
const edit = (fn) => { const nx = structuredClone(St.state.st); fn(nx.entities); St.applyView(nx); };

if (G) {
  // ---- pins: what holds today, written so the mutants the rows above let live go red (the cold read of 11-27: its rows
  // X3 X4 X11 X12 X16, and two more for the debounce and the frame budget)

  await fresh(); LW.lanes.busy = true;
  St.hydrate(giRoom({ bounces: 0 })); await run(300);
  const held = LP.bakes.length; LW.lanes.busy = false; await run(300);
  check('P1 no bake starts while the load lanes are busy, and it starts once they drain', held === 0 && LP.bakes.length === 27, [held, LP.bakes.length]);

  await fresh(); let early = 0;
  perFrame = () => { if (LP.bakes.length < 27 && LP.made.some((g) => inScene.has(g))) early++; };
  St.hydrate(giRoom({ bounces: 1 })); await run(300); perFrame = null;
  check('P2 a grid joins the scene only once every probe holds direct light (never while pass 0 is part done), and once',
    early === 0 && added.filter((o) => o.isLightProbeGrid).length === 1 && LP.bakes.length === 54, [early, added.length, LP.bakes.length]);

  await fresh();
  LR.requestLight('complight:pin', { authored: true, pos: [0, 2.5, 0], intensity: 20, range: 6, decay: 2 });
  roomMeshes.set('m0', box(-1, 0.5, 0.3));
  St.hydrate(giRoom({ bounces: 0 }, { lamp: { pos: [0, 2.5, 0], light: { intensity: 20 } }, m0: { pos: [-1, 0, 0.3] } })); await run(300);
  const j0 = jobsOf();
  LR.requestLight('complight:pin', { authored: true, pos: [0, 2.5, 0], intensity: 40, range: 6, decay: 2 });
  edit((es) => { es.lamp.light = { intensity: 40 }; }); await run(300);
  const j1 = jobsOf();
  check('P3 a lamp turned up rebakes once (the signature holds each light as it stands)', j0 === 1 && j1 === 2, [j0, j1]);
  roomMeshes.get('m0').children[0].position.set(1, 0.5, -0.3);
  edit((es) => { es.m0.pos = [1, 0, -0.3]; }); await run(300);
  check('P4 a static thing moved across the room rebakes once (its world matrix is in the signature; its pose is near the volume)', jobsOf() === j1 + 1, [j1, jobsOf()]);
  const glass = box(0.5, 0.5, 0.5, 0.5, new T.MeshStandardMaterial({ transparent: true, opacity: 0.3 })), skin = box(-0.5, 0.5, -0.5);
  skin.children[0].isSkinnedMesh = true;
  roomMeshes.set('glass', glass); roomMeshes.set('skin', skin);
  edit((es) => { es.glass = { pos: [0.5, 0, 0.5] }; es.skin = { pos: [-0.5, 0, -0.5] }; }); await run(300);
  const last = proxyMeshes();
  check('P5 a transparent mesh and a skinned one are no part of the proxy', !last.includes(glass.children[0].geometry) && !last.includes(skin.children[0].geometry) && last.length === 2, last.length);
  LR.releaseLight('complight:pin');

  await fresh();
  St.hydrate(giRoom({ bounces: 0 })); await run(60);
  const quietEarly = LP.bakes.length; await run(60);
  check('P6 a bake waits for 1.5 s of quiet: no step in the first 1.2 s after the world arrives, under way by 2.4 s', quietEarly === 0 && LP.bakes.length > 0, [quietEarly, LP.bakes.length]);

  await fresh();
  St.hydrate(giRoom({ bounces: 2 })); await run(100);
  const b0 = LP.bakes.length;
  perFrame = () => { FB.ask('hog', { gpu: true }); };   // another lane takes each frame's gpu unit before the bake asks
  await run(40); perFrame = null;
  const hogged = LP.bakes.length - b0; await run(200);
  check('P7 a bake step goes through the shared frame budget: while another lane holds each frame\'s gpu unit no step runs, and the bake finishes after',
    b0 > 0 && b0 < 81 && hogged === 0 && LP.bakes.length === 81, [b0, hogged, LP.bakes.length]);
}

if (G) {
  // ---- bounds (cold read 11-27, A1 A3 A4): a world is untrusted content, and what its gi-volumes ask for is built in
  // every visitor's browser. One live grid a world, the volume nearest the view (Bevy, without binding arrays: "only the
  // closest irradiance volume to the view"); a grid is a Light, one 3D texture sampled seven times in every lit fragment
  // shader (16 sampled textures a stage) and an id in every lit pipeline's key. The proxy: its strongest lights, its largest meshes.
  const gridsIn = () => [...inScene].filter((o) => o.isLightProbeGrid);
  const look = (x, y, z) => { core.camera.position.set(x, y, z); core.camera.updateMatrixWorld(true); };
  await fresh();
  const rooms = { entities: { walls: { pos: [0, 0, 0] } } };
  for (const [i, x] of [0, 10, 20].entries()) rooms.entities[`v${i}`] = { pos: [x, 1.5, 0], zone: { shape: 'box', size: [3, 3, 3] }, 'gi-volume': { bounces: 0 } };
  look(10.5, 1.6, 0);
  St.hydrate(rooms); await run(300);
  const d1 = G.giDebug();
  check('B1 three gi-volumes in a world: one grid is built, baked and shown, the one the view stands in; giDebug lists the other two as refused, saying why',
    LP.made.length === 1 && gridsIn().length === 1 && LP.bakes.length === 27 && same(d1.grids.map((g) => g.id), ['v1']) && same(d1.refused?.map((r) => r.id), ['v0', 'v2']) && d1.refused.every((r) => /one grid/.test(r.why)),
    { made: LP.made.length, inScene: gridsIn().length, steps: LP.bakes.length, grids: d1.grids, refused: d1.refused });
  look(20.2, 1.6, 0.4); await run(300);
  const d2 = G.giDebug();
  check('B1 …the view walks into another room: its grid is baked and shown in the first one\'s place, and the first leaves the scene and is freed',
    same(d2.grids.map((g) => g.id), ['v2']) && gridsIn().length === 1 && gridsIn()[0] === LP.made.at(-1) && LP.made.length === 2 && LP.made[0].disposed === true && same(d2.refused?.map((r) => r.id), ['v0', 'v1']),
    { grids: d2.grids, inScene: gridsIn().length, made: LP.made.length, refused: d2.refused });
  look(21, 1.6, 0); await run(300);
  check('B1 …and moving about inside it builds nothing more', LP.made.length === 2 && G.giDebug().baking === null, LP.made.length);
  await fresh(); look(0, 1.6, 0);
  const forty = { entities: { walls: { pos: [0, 0, 0] } } };
  for (let i = 0; i < 40; i++) forty.entities[`v${String(i).padStart(2, '0')}`] = { pos: [0, 1.5, 0], zone: { shape: 'box', size: [3, 3, 3] }, 'gi-volume': { bounces: 0 } };
  St.hydrate(forty); await run(600);
  check('B1 …forty volumes in one world: one grid built and in the scene, one grid\'s 27 steps baked, 39 refused',
    LP.made.length === 1 && gridsIn().length === 1 && LP.bakes.length === 27 && G.giDebug().refused?.length === 39, { made: LP.made.length, inScene: gridsIn().length, steps: LP.bakes.length, refused: G.giDebug().refused?.length });

  await fresh();
  for (let i = 0; i < 200; i++) LR.requestLight(`complight:h${String(i).padStart(3, '0')}`, { authored: true, pos: [(i % 10) * 0.1 - 0.5, 2, 0], intensity: 1 + i, range: 6, decay: 2 });
  LR.requestLight('complight:far', { authored: true, pos: [0, 2, 7], intensity: 500, range: 9, decay: 2 });   // in range of the room, 5.5 m past its wall
  St.hydrate(giRoom({ bounces: 0 })); await run(300);
  const lit = (LP.bakes.at(-1)?.children ?? []).filter((o) => o.isLight).map((l) => l.intensity).sort((a, b) => a - b);
  check('B2 two hundred lamps in a room light the proxy with the 16 strongest at the volume (each is a real three light in every proxy material\'s shader): a bright lamp far past the wall is weaker there than the room\'s own',
    lit.length === 16 && lit[0] === 185 && lit[15] === 200 && G.giDebug().proxy?.cut?.lights === 185, { lit, proxy: G.giDebug().proxy });
  for (let i = 0; i < 200; i++) LR.releaseLight(`complight:h${String(i).padStart(3, '0')}`);
  LR.releaseLight('complight:far');

  await fresh();
  for (let i = 0; i < 600; i++) roomMeshes.set(`c${i}`, box(-1.2 + (i % 25) * 0.1, 0.1 + Math.floor(i / 25) * 0.1, 1, 0.05));
  St.hydrate(giRoom({ bounces: 0 })); await run(300);
  const pm = proxyMeshes();
  check('B3 six hundred static meshes in a room: the proxy holds the 256 largest (each bake step draws the proxy into six cube faces), the walls among them',
    pm.length === 256 && pm.includes(roomMeshes.get('walls').children[0].geometry) && G.giDebug().proxy?.cut?.meshes === 345, { meshes: pm.length, proxy: G.giDebug().proxy });
  for (const k of [...roomMeshes.keys()]) if (k !== 'walls') roomMeshes.delete(k);
}

if (G) {
  // (2) where GI can't run it is off, and says why where the lead's capture rig looks (giDebug)
  St.reset(); const before = quiet();
  core.renderer.backend = { isWebGLBackend: true, extensions: { has: () => false } };
  St.hydrate(giRoom({ bounces: 1 }));
  await run(200);
  const q3 = quiet();
  check('G15 on a backend that can\'t bake it (WebGL 2 without float targets) no grid is built, and giDebug says why',
    q3.made === before.made && q3.bakes === before.bakes && same(q3.dbg?.grids, []) && q3.dbg?.baking === null && /EXT_color_buffer_float/.test(q3.dbg?.off ?? ''), q3.dbg);
  core.renderer.backend = { isWebGPUBackend: true };
  St.reset(); LP.failNext.n = 1;
  St.hydrate(giRoom({ bounces: 1 }));
  await run(200);
  const q4 = quiet();
  await run(300);
  const q5 = quiet();
  check('G15 …a bake step that throws turns GI off for the page with the error in giDebug, instead of rebaking forever',
    /stub bake failure/.test(q4.dbg?.off ?? '') && same(q4.dbg?.grids, []) && q4.dbg?.baking === null && q5.bakes === q4.bakes && q5.made === q4.made, [q4.dbg, q4.bakes, q5.bakes, q4.made, q5.made]);
}

S.done();
