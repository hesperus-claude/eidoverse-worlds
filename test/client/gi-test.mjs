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
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
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

  const v = G.giVolumesOf(room({ strength: 2 }));
  check('G1 a thing with a box zone and gi-volume is one volume: its world centre, the zone\'s size, the fields read (absent: strength 1, spacing 1.5, bounces 1)',
    v.length === 1 && v[0].id === 'room' && same(v[0].center, [10, 1.5, 0]) && same(v[0].size, [6, 3, 9]) && v[0].strength === 2 && v[0].spacing === 1.5 && v[0].bounces === 1, v);
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
  check('G5 …strength 0: no grid either (nothing to light)', G.planGrid(G.giVolumesOf(room({ strength: 0 }))[0], 'high') === null, '');
  const wild = G.giVolumesOf(room({ spacing: 0.01, bounces: 9, strength: 99 }))[0];
  check('G6 a value past the registry\'s range reads at its bound (spacing ≥ 0.25 m, bounces ≤ 2, strength ≤ 16)', wild?.spacing === 0.25 && wild?.bounces === 2 && wild?.strength === 16, wild);
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
const core = await import('../stubs/core-stub.mjs'), St = await import('../../client/lib/state.js'), FB = await import('../../client/lib/render/framebudget.js'), LP = await import('../stubs/lightprobegrid-stub.mjs');
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
core.scene.add = (o) => { added.push(o); };
core.scene.remove = (o) => { removed.push(o); };
let objectReads = 0;
const roomMeshes = new Map();
{ const g = new core.THREE.Group(); g.parent = {}; const box = new core.THREE.Mesh(new core.THREE.BoxGeometry(3, 3, 3), new core.THREE.MeshStandardMaterial()); box.position.set(0, 1.5, 0); g.add(box); roomMeshes.set('walls', g); }
G?.setGiObjects?.(() => { objectReads++; return roomMeshes; });
core.renderer.isWebGPURenderer = true;
core.renderer.backend = { isWebGPUBackend: true };
let now = 1e6; performance.now = () => now;
const run = async (frames) => { for (let i = 0; i < frames; i++) { now += 20; FB.tick(now); G.updateGi(); await new Promise((r) => setImmediate(r)); } };
const giRoom = (gi, extra = {}) => ({ entities: { walls: { pos: [0, 0, 0] }, room: { pos: [0, 1.5, 0], zone: { shape: 'box', size: [3, 3, 3] }, ...(gi ? { 'gi-volume': gi } : {}), ...extra } } });
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
}
check('G10 Video settings carry the GI row through the dial\'s own module (videopanel.js reads render/gipref.js, not the bake)', /from '\.\.\/render\/gipref\.js'/.test(read('client/lib/ui/videopanel.js')) && /giPref\(\)/.test(read('client/lib/ui/videopanel.js')) && /setGiPref\(/.test(read('client/lib/ui/videopanel.js')), '');
check('G10 …the frame loop steps it, hands it the world\'s objects, and EW.gi reads giDebug (main.js)', /registerSystem\('gi', updateGi\)/.test(read('client/main.js')) && /setGiObjects\(\(\) => entities\)/.test(read('client/main.js')) && /\bgi: giDebug\b/.test(read('client/main.js')), '');

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
