// sky-ambient: the world's constant ambient light, sky.ambientLightColor + sky.ambientLightEnergy (Godot's
// Environment.ambient_light_color / ambient_light_energy; three's AmbientLight), through the REAL client/lib/sky/sky.js on
// both of its paths (the basic sky, skymesh, and the detailed one, eidoverse, over sky-lifecycle's fakes: the renderer,
// sky_baked, the Skye module, the interim gradient, the boot gates; copied from test/client/sky-lifecycle-test.mjs).
//
// What it pins: the light is born with the module, at 0 (a light appearing later recompiles every lit material, as
// sky.js's fillLight says), so absent fields add nothing and change no other light; a set colour and energy reach the
// scene the same at noon and at night (the point of the field: sky.ambient scales the hemisphere, which is ~0 at night);
// a live edit and a preview update it, and taking the fields away puts it back to 0 and white; the per-frame update
// leaves it alone. The door's half (types, ranges, refusals) is shape-render's SK8.
// The rows that turn red, and the line of the product that turns them:
//   · no AmbientLight in sky.js                                   → AL1..AL6
//   · the light added on first use instead of at import          → AL1
//   · intensity scaled by the hour (× day)                        → AL3, AL4
//   · the colour read as sRGB (no LinearSRGBColorSpace)           → AL3
//   · set only when present (a removed field keeps the old value) → AL5b
//   · applied on one path only                                    → AL4 (eidoverse) or AL3 (skymesh)
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/sky-ambient-test.mjs
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { pause } from '../gate/wait.ts';
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });

const TS = 50;
const realST = globalThis.setTimeout.bind(globalThis), realCT = globalThis.clearTimeout.bind(globalThis);
globalThis.setTimeout = (fn, ms = 0, ...a) => realST(fn, Math.max(0, ms / TS), ...a);
globalThis.clearTimeout = (h) => realCT(h);

const S = suite("sky-ambient");
const check = (n, ok, d) => S.check(n, ok, d);

const THREE = await import('three');
const lib = (f) => fileURLToPath(new URL(`../../client/lib/${f}`, import.meta.url));

// ---- the bus, tee, the scene -------------------------------------------------------------------------------------
const handlers = new Map();
const bus = {
  on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev)?.delete(fn); },
  emit(ev, v) { for (const fn of [...(handlers.get(ev) ?? [])]) fn(v); },
};
const log = [];
const tee = (l) => log.push(String(l));
const reports = [];
const scene = new THREE.Scene();
const renderer = {
  backend: { isWebGLBackend: true },
  xr: { isPresenting: false, enabled: false },
  domElement: { width: 800, height: 600 },
  getRenderTarget: () => null, setRenderTarget() {}, renderAsync: async () => {}, compileAsync: async () => {}, render() {},
};
mock.module(lib('core.js'), () => ({ THREE, scene, renderer, camera: new THREE.PerspectiveCamera(),
  sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight() }));
mock.module(lib('base.js'), () => ({ bus, tee, teeNow: tee, report: (w, e) => reports.push(`${w}: ${e?.message ?? e}`),
  CONFIG: { params: new URLSearchParams('') } }));
mock.module(lib('boot.js'), () => ({ markPhase() {}, bootDone: () => true }));
mock.module(lib('render/loadwork.js'), () => ({ beginWork: () => ({ end() {} }) }));
mock.module(lib('render/framebudget.js'), () => ({ busy: () => false }));
mock.module(lib('render/lightrig.js'), () => ({ setDayness() {}, releaseForeignLights() {} }));
mock.module(lib('render/warmqueue.js'), () => ({ warm: async (_n, fn) => fn(), P_AMBIENT: 0 }));
mock.module(lib('terrain.js'), () => ({ rainSurfaceAt: () => null }));   // sky.js reads only the rain surface from terrain (main #254)
mock.module(lib('render/autohooks.js'), () => ({ claimUnowned: () => [], releaseHook() {}, autoHooks: [], ownHook: (fn) => fn }));

// ---- the interim gradient: a flag, announced as sky_interim does ---------------------------------------------------
let interim = false;
mock.module(lib('sky/sky_interim.js'), () => ({
  showInterimSky() { if (!interim) { interim = true; bus.emit('sky-interim', true); } },
  hideInterimSky() { if (interim) { interim = false; bus.emit('sky-interim', false); } },
  updateInterimSky() {}, interimSkyShown: () => interim, interimSkyObject: () => null,   // read only to hide the sky under water (main #254)
}));

// ---- sky_baked: the dome contract sky.js relies on ------------------------------------------------------------------
// hold: take the live domes out of the scene (true if it took them); release: put held ones back, under their parent;
// attach: the baked dome goes up and PARKS the live domes (out of the scene) — refused when `attachRefuses`;
// detach: the baked dome comes down and the parked/held domes go back (sky_baked.detachBakedDome's documented order).
const SB = { held: null, parked: null, baked: null, attachRefuses: false, attaches: [], gen: 1 };
const putBack = (list) => { for (const [d, p] of list ?? []) if (!d.parent) p.add(d); };
const takeOut = (api) => { const ds = api?._internals?.sky?.domes ?? []; const l = ds.filter((d) => d.parent).map((d) => [d, d.parent]); for (const [d, p] of l) p.remove(d); return l; };
mock.module(lib('sky/sky_baked.js'), () => ({
  BAKE_INTERCEPT: Symbol('bake-intercept'),
  bakedDomeObject: () => null,   // read only to hide the sky under water (main #254)
  bandCuts: () => [0, 1], bandedBakeRender: async () => 1, bakeGeneration: () => SB.gen,
  holdLiveDomes(api) { if (SB.held || SB.parked) return false; const l = takeOut(api); if (!l.length) return false; SB.held = l; return true; },
  releaseLiveDomes() { putBack(SB.held); SB.held = null; },
  liveDomesHeld: () => !!SB.held,
  takeHeldDomes() { const l = (SB.held ?? []).map(([d]) => d); SB.held = null; return l; },
  attachBakedDome(api, opts) {
    if (SB.attachRefuses) return false;
    SB.parked = [...(SB.held ?? []), ...takeOut(api)]; SB.held = null;
    SB.baked = { api, opts }; SB.attaches.push({ tier: SB.tierAtAttach?.(), presenting: renderer.xr.isPresenting });
    return true;
  },
  detachBakedDome() { SB.baked = null; putBack(SB.parked); SB.parked = null; putBack(SB.held); SB.held = null; },
  updateBakedDome() {}, bakedActive: () => !!SB.baked, requestBake() {}, envTexture: () => null, adoptEnvironment() {},
  whenBakeReady: async () => {}, bakedRefreshing: () => false,
}));

// ---- the Skye module: makeSky + makeSkySystem, two domes, a controllable bake -----------------------------------
// BAKE.fail: the next N bakes throw. BAKE.gate: a promise every bake waits on (a slow bake, to act during it).
const BAKE = { fail: 0, gate: null, runs: [], builds: 0 };
function fakeSystem() {
  const domes = [new THREE.Mesh(), new THREE.Mesh()];
  for (const d of domes) scene.add(d);          // AT BIRTH, like the real system (sky.js's wrapper holds them)
  const sys = {
    domes, uniforms: {}, setClouds() {}, dispose() { for (const d of domes) d.removeFromParent(); },
    _envTarget: {}, _envFbNode: {}, _envBake: null,
    async bakeEnv(o = {}) {
      const run = { w: o.width ?? null, ok: null }; BAKE.runs.push(run);
      if (BAKE.gate) await BAKE.gate;
      if (BAKE.fail > 0) { BAKE.fail--; run.ok = false; throw new Error('fake bake failure'); }
      run.ok = true;
    },
  };
  return sys;
}
// LIB: what the asset library lists under eidoverse/assets/sky and what fails to prime (the weather sounds live there, not in the engine)
const LIB = { sky: [], missing: [] };
mock.module(lib('assets.js'), () => ({
  primeFiles: async (paths) => paths.filter((p) => LIB.missing.includes(p)), listLibrary: async (dir) => (dir.endsWith('/sky') ? LIB.sky.map((path) => ({ path })) : []), fetchBytes: async () => new Uint8Array(),
  async loadEidoModule() {
    globalThis.makeSkySystem = (args) => fakeSystem(args);   // through sky.js's setter, as sky_system's eval assigns it
    globalThis.makeSky = async (o = {}) => {
      BAKE.builds++; BAKE.audio = o.audio;
      const sys = await globalThis.makeSkySystem({ opts: {} });
      return { _internals: { sky: sys }, bakeEnv: (o) => sys.bakeEnv(o), enableReflections() {}, update() {},
        transitionTo() {}, setWeather() {}, setTime() {}, setColors() {}, setClouds() {}, dispose() {} };
    };
  },
}));


const sky = await import('../../client/lib/sky/sky.js');
const core = await import('../../client/lib/core.js');   // the mock: the same sun and hemi sky.js drives
const settle = () => pause("the sky's render chain and its scaled settle", 3000 / TS);

const ambients = () => scene.children.filter((o) => o.isAmbientLight);
const amb = () => ambients()[0];
const rgb = (c) => c && [c.r, c.g, c.b];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// every light in the scene but the world's ambient: what absent fields must leave as main draws them
const others = () => [core.sun, core.hemi, ...scene.children.filter((o) => o.isLight && !o.isAmbientLight && o !== core.sun && o !== core.hemi)]
  .map((l) => ({ type: l.type, i: l.intensity, c: rgb(l.color), g: rgb(l.groundColor) }));
const state = () => ({ n: ambients().length, i: amb()?.intensity, c: rgb(amb()?.color), hemi: core.hemi.intensity });
let T = 0;
const at = async (args) => { await sky.applySky({ rate: 0, ...args, ts: ++T }); await settle(); return state(); };
const COL = [0.2, 0.3, 0.5], E = 0.8;

try {
  check('AL1 the scene holds one AmbientLight from the moment sky.js loads, before any sky arrives (born eagerly: a light appearing later recompiles every lit material)',
    ambients().length === 1 && amb().parent === scene, { n: ambients().length });

  for (const system of ['skymesh', 'eidoverse']) {
    const P = system === 'skymesh' ? 'AL3' : 'AL4';
    const base = { system, world: 'earth', clouds: 'cumulus', weather: 'clear' };
    const absNoon = await at({ ...base, hours: 12 }), othersAbs = others();
    check(`(setup) ${system}: the sky runs on that path`, sky.skyImpl() === system, sky.skyImpl());
    check(`AL2 ${system}: absent fields add nothing: the ambient's intensity is exactly 0 (and its colour white)`, absNoon.n === 1 && absNoon.i === 0 && same(absNoon.c, [1, 1, 1]), absNoon);
    const setNoon = await at({ ...base, hours: 12, ambientLightColor: COL, ambientLightEnergy: E }), othersSet = others();
    check(`AL2b ${system}: …and the fields change no other light (sun, hemisphere, fill: the same with and without them)`, same(othersAbs, othersSet), { othersAbs, othersSet });
    const setNight = await at({ ...base, hours: 0, ambientLightColor: COL, ambientLightEnergy: E });
    check(`${P} ${system}: at noon the ambient is the set energy (${E}) and colour, linear [${COL}]`, setNoon.n === 1 && setNoon.i === E && same(setNoon.c, COL), setNoon);
    check(`${P} ${system}: …and at midnight the SAME, whatever the hour`, setNight.n === 1 && setNight.i === E && same(setNight.c, COL), setNight);
    if (system === 'skymesh') check(`${P} (control) ${system}: the sky's own hemisphere did change with the hour (noon ${setNoon.hemi}, night ${setNight.hemi})`, setNoon.hemi > setNight.hemi, [setNoon.hemi, setNight.hemi]);
    for (let f = 0; f < 3; f++) sky.updateSky(performance.now(), f / 60);
    check(`${P}b ${system}: the per-frame update leaves it alone`, amb()?.intensity === E && same(rgb(amb()?.color), COL), state());
  }

  const base = { system: 'skymesh', world: 'earth', hours: 21 };
  await at({ ...base, ambientLightColor: COL, ambientLightEnergy: E });
  const edit = await at({ ...base, ambientLightColor: [1, 0.5, 0.25], ambientLightEnergy: 2 });
  check('AL5 a live sky edit updates it (energy 2, colour [1, 0.5, 0.25])', edit.i === 2 && same(edit.c, [1, 0.5, 0.25]), edit);
  await sky.previewSky({ ...base, rate: 0, ambientLightColor: [0, 1, 0], ambientLightEnergy: 0.5 }); await settle();
  check('AL5 …and so does the sky panel\'s preview', amb()?.intensity === 0.5 && same(rgb(amb()?.color), [0, 1, 0]), state());
  const gone = await at({ ...base });
  check('AL5b taking the fields away puts it back to 0 and white (the look every world had)', gone.i === 0 && same(gone.c, [1, 1, 1]), gone);
  const colourOnly = await at({ ...base, ambientLightColor: COL });
  check('AL6 a colour with no energy adds nothing (energy absent = 0)', colourOnly.i === 0, colourOnly);
  const energyOnly = await at({ ...base, ambientLightEnergy: 1.5 });
  check('AL6 …an energy with no colour is white at that energy', energyOnly.i === 1.5 && same(energyOnly.c, [1, 1, 1]), energyOnly);
  check('AL6 …and there is still one ambient light (an edit never adds another)', ambients().length === 1, ambients().length);
  check('no reported errors', reports.length === 0, reports.slice(0, 3));
} catch (e) { check('ran', false, e?.stack ?? String(e)); }

if (S.fail) { console.log('\n  last sky lines:'); for (const l of log.slice(-15)) console.log(`    ${l.slice(0, 170)}`); }
S.done();
