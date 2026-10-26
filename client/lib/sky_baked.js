// baked sky — the clouds as a banded, double-buffered equirect bake (bakeEnv) instead of a per-pixel march; two targets
// cross-dissolve, and the freshest feeds scene.environment. No in-cloud lightning ('high' keeps the live march).
// Reaches through skyApi._internals: if they move, attachBakedDome() returns false and sky.js stays on the live march.
// Why bake: docs/research/baked-sky.md.

import { THREE, TSL, scene, camera, renderer } from './core.js';
import { tee, bus, CONFIG } from './base.js';
import { warm, P_AMBIENT } from './warmqueue.js';
import { bandCuts } from './sky_bands.js';
import { ask, spent, turn } from './framebudget.js';

let dome = null;
let mat = null;
let parked = null;     // the live domes we pulled out of the scene graph
let xrHeld = null;     // [dome, parent] pairs held out of the scene in a headset until a baked dome takes over

/** In a headset the live march differs per eye and runs ~13 fps while compiling: hold the domes out until the baked
 *  dome attaches (cloudless meanwhile). Idempotent. */
export function holdLiveDomes(skyApi, why = 'in a headset until the baked dome is ready') {
  if (dome || xrHeld) return false;
  const s = skyApi?._internals?.sky;
  const live = (s?.domes ?? []).filter((d) => d?.parent);
  if (!live.length) return false;
  xrHeld = live.map((d) => [d, d.parent]);
  for (const [d, p] of xrHeld) p.remove(d);
  tee(`[sky] ${xrHeld.length} live sky dome(s) held out ${why}`);
  return true;
}
export function releaseLiveDomes() {
  if (!xrHeld) return;
  for (const [d, p] of xrHeld) if (!d.parent) p.add(d);
  xrHeld = null;
}
export const liveDomesHeld = () => !!xrHeld;
/** Teardown: hand back the held domes WITHOUT re-adding them: never compiled, they must not reach the render path. */
export function takeHeldDomes() { const out = (xrHeld ?? []).map(([d]) => d); xrHeld = null; return out; }
export const holdLiveDomesInXR = (skyApi) => holdLiveDomes(skyApi);   // probe name
let sys = null;        // sky_system internals
let targets = null;    // [A, B] — A is the engine's _envTarget, B is ours
let blendU = null;     // 0 → targets[0] on the dome, 1 → targets[1]
let front = 0;         // index the blend currently rests on
let bakeGen = 0;       // bumped at teardown, so an older sky's band loop stops instead of drawing into freed targets
export const bakeGeneration = () => bakeGen;
let bandScene = null;
let bandMeshes = null;
let bandGeos = null;
let bakeCam = null;
let pinnedCloudsOn = null;   // whether the pinned bake graph HAS a cloud branch
/** For sky.js's §18b fence: compiling the ~1.5MB-WGSL cloud graph stalls the GPU process (~9 s), so pin it lazily, once. */
export const bakedCloudsPinned = () => pinnedCloudsOn === true;

// §19a: arrival gates on the first bake's band pipeline being warm (the big compile hides behind the splash); baked tiers only
let _bakeReadyResolve = null;
const _bakeReady = new Promise((r) => { _bakeReadyResolve = r; });
export const whenBakeReady = () => _bakeReady;
function resolveBakeReady() { _bakeReadyResolve?.(); _bakeReadyResolve = null; }
// scene.environment is one small PERSISTENT target: a different texture object recompiles every PBR material.
// Every bake BLITS into it (PMREM from the full 4096 bake stalled ~150 ms).
let envRT = null;
let blitScene = null;
let blitTexNode = null;
let blitGeo = null;
let blitMat = null;
let blitCam = null;    // own copy of the engine's bake cam, so the rig works before any sky exists

function ensureEnvRig() {
  if (envRT) return;
  envRT = new THREE.RenderTarget(512, 256, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false,
  });
  envRT.texture.mapping = THREE.EquirectangularReflectionMapping;
  envRT.texture.minFilter = THREE.LinearFilter;
  envRT.texture.magFilter = THREE.LinearFilter;
  envRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
  envRT.texture.name = 'sky_baked_env';
  envRT.texture.userData._pmremPreInit = true;
  blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  blitCam.position.z = 0.5;
  blitScene = new THREE.Scene();
  blitGeo = new THREE.PlaneGeometry(2, 2);
  blitMat = new THREE.MeshBasicNodeMaterial();
  blitMat.toneMapped = false;              // environment must stay linear HDR
  blitTexNode = TSL.texture(envRT.texture); // real source set per blit
  blitMat.colorNode = blitTexNode;
  blitScene.add(new THREE.Mesh(blitGeo, blitMat));
}

/** Assign to scene.environment at boot (black until a sky bakes) and never assign anything else. */
export function envTexture() {
  ensureEnvRig();
  return envRT.texture;
}

/** Copy anything else assigned to scene.environment into the persistent target and restore it, so graphs never see a change. */
export function adoptEnvironment() {
  ensureEnvRig();
  const cur = scene.environment;
  if (!cur) { scene.environment = envRT.texture; return; }
  if (cur === envRT.texture) return;
  blitTexNode.value = cur;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(envRT);
  renderer.render(blitScene, blitCam);
  renderer.setRenderTarget(prev ?? null);
  envRT.texture.needsPMREMUpdate = true;
  scene.environment = envRT.texture;
}

// cycle state machine: idle → baking (a band per frame) → fading → idle
// ('refreshing' while a preset flip rebuilds the engine's bake graph)
let state = 'idle';
let bandIdx = 0;
let cycleStart = 0;
let cycleForced = false;
let fade = null;       // { from, to, t0, dur }
let nextAt = 0;
let lastCycleMs = 0;   // how long the last bake cycle took (bands + pump spacing)
let refreshing = false;
export const bakedRefreshing = () => refreshing;
// DRIFT (?skydrift=1): rays shift by wind × time since that bake, so clouds move between bakes; off since the stars drift too
const DRIFT = CONFIG.params.get('skydrift') === '1';
let sysRef = null, cycleSkyT = 0, cycleSnap = null;
const bakeSkyT = [0, 0];               // sky time each target's picture shows (mid-bake)
let driftDt = null;                    // [uniform, uniform]: dt for A and B
const skyTimeNow = () => sysRef?.uniforms?.time?.value ?? 0;
// one sky state per bake: strips span frames, so every strip draws with the uniforms snapshotted at start, or edges show
function skySnapshot(sys) {
  const U = sys?.uniforms; if (!U) return null;
  const snap = [];
  for (const [k, u] of Object.entries(U)) {
    const v = u?.value;
    if (typeof v === 'number' || typeof v === 'boolean') snap.push([u, v, false]);
    else if (v && (v.isVector2 || v.isVector3 || v.isVector4 || v.isColor || v.isQuaternion)) snap.push([u, v.clone(), true]);
  }
  return snap;
}
function atSkySnapshot(snap, draw) {
  if (!snap) return draw();
  const keep = snap.map(([u, , obj]) => (obj ? u.value.clone() : u.value));
  for (const [u, v, obj] of snap) { if (obj) u.value.copy(v); else u.value = v; }
  try { return draw(); } finally { snap.forEach(([u, , obj], i) => { if (obj) u.value.copy(keep[i]); else u.value = keep[i]; }); }
}
/** A bake option `() => restore`, installed INSIDE the bake lock: patched outside, it catches whichever bake holds the lock. */
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');
let bootBakeSkyT = null;   // sky time the last banded boot bake was pinned to (attach adopts it for A)
/** null when off, else the seconds each texture has drifted. */
export const bakedDrift = () => (driftDt ? [driftDt[0].value, driftDt[1].value] : null);
// never shorter than a bake plus its dissolve (a headset bake can take ~6.2 s at the pump's 40 ms spacing)
const cadenceMs = () => Math.max(cfg.intervalMs, lastCycleMs > 0 ? lastCycleMs + 2500 : 0);
let pendingForce = false;

let cfg = {
  intervalMs: 9000,        // cycle start → next cycle start
  forcedFadeMs: 2500,      // verb-driven changes ease in faster
  // band size in TEXELS × MARCH PASSES per frame, the unit GPU cost roughly follows
  passTexelBudget: 0.4e6,
  cloudPasses: 8,
};


export { bandCuts } from './sky_bands.js';

/** Render `fn` BETWEEN XR frames (see xrPumpTick); eye contexts are nulled and never restored.
 *  Awaits a macrotask first, so a caller woken from a frame callback is out of the frame. */
export async function renderBetweenXRFrames(r, fn) {
  await new Promise((res) => setTimeout(res, 0));
  const xrWas = r.xr.enabled;
  r.xr.enabled = false;
  if (r.backend) r.backend._currentContext = null;
  r._currentRenderContext = null;
  try { return fn(); } finally { r.xr.enabled = xrWas; }
}

/** The boot bake as cost-weighted strips, one per frame: one 4096x2048 8-pass draw trips the GPU watchdog.
 *  Returns the band count. */
export async function bandedBakeRender(r, bakeScene, bakeCam, target, { cloudPasses = cfg.cloudPasses, passTexelBudget = cfg.passTexelBudget,
  nextFrame = () => new Promise((res) => requestAnimationFrame(res)), budget = false, alive = () => true, sys = null } = {}) {
  const bakeMat = bakeScene.children?.[0]?.material;
  if (!bakeMat) throw new Error('bandedBakeRender: bake scene has no quad');
  const cuts = bandCuts(target.width, target.height, cloudPasses, passTexelBudget);
  const bs = new THREE.Scene();
  const meshes = [], geos = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const v0 = cuts[i], v1 = cuts[i + 1];
    if (v1 - v0 < 1e-6) continue;
    const g = new THREE.PlaneGeometry(2, (v1 - v0) * 2);   // same construction as attachBakedDome's bands
    g.translate(0, -1 + (v0 + v1), 0);
    const uv = g.attributes.uv;
    for (let j = 0; j < uv.count; j++) uv.setY(j, v0 + uv.getY(j) * (v1 - v0));
    const m = new THREE.Mesh(g, bakeMat);
    m.frustumCulled = false;
    bs.add(m); meshes.push(m); geos.push(g);
  }
  try {
    { const prev = r.getRenderTarget(); r.setRenderTarget(target);
      const tc = performance.now();
      // compileAsync reads the target when CALLED: never hold it bound across the await, or every frame starts bound to it
      let compiling;
      try { compiling = r.compileAsync(bs, bakeCam); } finally { r.setRenderTarget(prev ?? null); }
      await compiling.catch((e) => tee(`[sky] band bake: compileAsync rejected: ${e?.message ?? e}`));
      // …and LINKED: a giant program the syncgate deferred may still be linking, and drawing now leaves the dome black
      const tl = performance.now();
      await globalThis.__syncGate?.whenGiantLinked?.();
      const waited = performance.now() - tl;
      tee(`[sky] band bake: compiled in ${(performance.now() - tc).toFixed(0)} ms${waited > 50 ? ` (waited ${waited.toFixed(0)} ms for a deferred link)` : ''}, ${meshes.length} bands to draw`); }
    const pinSnap = skySnapshot(sys), pinT = sys?.uniforms?.time?.value ?? null;
    bootBakeSkyT = pinT;
    for (let i = 0; i < meshes.length; i++) {
      // each band is a gpu unit of the shared frame budget; nothing is bound across this wait
      const g = budget ? await turn('sky', { gpu: true }) : null;
      if (!alive()) throw new Error('bake cancelled: the sky was torn down mid-bake');   // finally frees the strips
      const draw = () => {
        if (!alive()) throw new Error('bake cancelled: the sky was torn down mid-bake');   // a macrotask may have passed
        for (let j = 0; j < meshes.length; j++) meshes[j].visible = j === i;
        const prev = r.getRenderTarget(), autoClear = r.autoClear;
        r.autoClear = false;          // strips abut and each fully overdraws its own texels
        r.setRenderTarget(target);
        const t0 = performance.now();
        try { atSkySnapshot(pinSnap, () => r.render(bs, bakeCam)); } finally { r.setRenderTarget(prev ?? null); r.autoClear = autoClear; }
        if (g) spent('sky', performance.now() - t0, null, g);
      };
      // never render INSIDE an XR frame: it corrupts the per-eye render list (see xrPumpTick)
      if (r.xr?.isPresenting) await renderBetweenXRFrames(r, draw); else draw();
      if (i === 0 || i % 40 === 39) tee(`[sky] band bake: band ${i + 1}/${meshes.length} drawn`);
      if (i < meshes.length - 1) await nextFrame();
    }
  } finally { for (const g of geos) g.dispose(); }
  return meshes.length;
}

export const bakedActive = () => Boolean(dome);
/** Draws unfogged: hidden under the world's water (sky.js hideSkyForWater). */
export const bakedDomeObject = () => dome;

/** Call AFTER the first full bakeEnv has rendered the target. */
export function attachBakedDome(skyApi, opts = {}) {
  const s = skyApi?._internals?.sky;
  const A = s?._envTarget;
  const bake = s?._envBake;
  const bakeMat = bake?.scene?.children?.[0]?.material;
  if (!s?.domes?.length || !A?.texture || !bakeMat || !bake.camera) return false;
  detachBakedDome();
  sys = s;
  cfg = { ...cfg, ...opts };
  bakeCam = bake.camera;

  // park the domes OUT of the scene graph rather than flipping .visible: sky.update() re-asserts cloudDome.visible
  releaseLiveDomes();   // so the park below (and teardown) can find them
  parked = s.domes.filter((d) => d?.parent);
  for (const d of parked) d.parent.remove(d);

  // same spec as sky_system's _ensureEnvTarget
  const B = new THREE.RenderTarget(A.width, A.height, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false,
  });
  B.texture.mapping = THREE.EquirectangularReflectionMapping;
  B.texture.minFilter = THREE.LinearFilter;
  B.texture.magFilter = THREE.LinearFilter;
  B.texture.colorSpace = THREE.LinearSRGBColorSpace;
  B.texture.name = 'sky_baked_back';
  B.texture.userData._pmremPreInit = true;
  targets = [A, B];
  // clear B once so it exists before the dome samples it: binding a never-rendered RT at pipeline compile races
  // texture init on the wgpu backend ("OutputType is invalid")
  {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(B);
    renderer.render(new THREE.Scene(), bake.camera);
    renderer.setRenderTarget(prev ?? null);
  }

  // strips with GLOBAL uvs, cut by equal march-chord WEIGHT (grazing horizon rows cost far more), not height
  const cuts = bandCuts(A.width, A.height, cfg.cloudPasses, cfg.passTexelBudget);
  bandScene = new THREE.Scene();
  bandMeshes = [];
  bandGeos = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const v0 = cuts[i];
    const v1 = cuts[i + 1];
    if (v1 - v0 < 1e-6) continue;
    // v runs 0→1 as quad y runs -1→+1 (PlaneGeometry's own uv convention)
    const g = new THREE.PlaneGeometry(2, (v1 - v0) * 2);
    g.translate(0, -1 + (v0 + v1), 0);
    const uv = g.attributes.uv;
    for (let j = 0; j < uv.count; j++) uv.setY(j, v0 + uv.getY(j) * (v1 - v0));
    const m = new THREE.Mesh(g, bakeMat);
    m.visible = false;
    m.frustumCulled = false;
    bandScene.add(m);
    bandMeshes.push(m);
    bandGeos.push(g);
  }
  // a 'clear' graph has no cloud branch: remember the flavour so a clear↔cloudy flip can rebuild (maybeRefreshGraph)
  pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');

  ensureEnvRig();
  blitEnvFrom(A);                          // boot bake → env, before its 4096 PMREM ever runs

  // one dome where two were; if ringworld leaves KNOWN_HEAVY it renders BETWEEN the live domes, and this must split
  const radius = (s.domes[0]?.geometry?.parameters?.radius ?? 15000) * 0.99;
  mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.toneMapped = true;   // the targets are linear HDR
  // a centred sphere's vertex IS its view direction; the bake's uv→dir is the exact inverse of three's equirectUV()
  blendU = TSL.uniform(0);
  const dirL = TSL.normalize(TSL.positionLocal);
  const U = s.uniforms ?? {};
  sysRef = s;
  let suvA, suvB;
  if (DRIFT && !cfg.noClouds && U.skyWind && U.time && U.sunDir && U.cloudStart && U.cloudHeight) {
    bakeSkyT[0] = bakeSkyT[1] = bootBakeSkyT ?? skyTimeNow();   // A holds the boot bake; B starts as its copy
    driftDt = [TSL.uniform(0), TSL.uniform(0)];
    const layerH = U.cloudStart.add(U.cloudHeight.mul(0.5)).sub(2);   // the bake's eye sits at y=2
    const sunKeep = TSL.smoothstep(Math.cos(14 * Math.PI / 180), Math.cos(6 * Math.PI / 180), TSL.dot(dirL, TSL.normalize(U.sunDir)));
    const w = TSL.smoothstep(0.03, 0.15, dirL.y).mul(TSL.float(1).sub(sunKeep));
    const shifted = (dt) => {
      const hit = dirL.mul(layerH.div(TSL.max(dirL.y, 0.03)));
      // capped at ~12% of the layer height (~7°), or a stale bake under storm wind pulls hazy horizon texels overhead
      const d = TSL.vec3(U.skyWind.x.mul(dt), 0, U.skyWind.z.mul(dt));
      const cap = layerH.mul(0.12);
      const moved = hit.add(d.mul(TSL.min(1, cap.div(TSL.max(TSL.length(d), 1e-3)))));
      return TSL.equirectUV(TSL.normalize(TSL.mix(dirL, TSL.normalize(moved), w)));
    };
    suvA = shifted(driftDt[0]); suvB = shifted(driftDt[1]);
    tee('[sky] drift on: the baked clouds follow the wind between bakes, the sun stays put');
  } else { suvA = suvB = TSL.equirectUV(dirL); }
  mat.colorNode = TSL.mix(
    TSL.texture(A.texture, suvA),
    TSL.texture(B.texture, suvB),
    blendU,
  ).rgb;

  dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  // after the opaques, before overlays (tools/dome-order-probe.mjs); an opaque that writes no depth must sit at >= 1
  dome.renderOrder = 0.5;
  dome.userData.odTag = 'sky';   // overdraw.js category
  dome.frustumCulled = false;
  dome.userData.noSupportCheck = true;
  dome.userData.noCamCollide = true;
  dome.userData.noWet = true;
  scene.add(dome);

  front = 0;
  // §18b: the band pipeline differs from the boot bake's; a cold first band blocks a frame on a ~1.5MB compile
  state = 'warming';
  warmBakePipeline().then(() => {
    if (state === 'warming') state = 'idle';
    resolveBakeReady();          // §19a: the boot gate may lift now
  });
  pendingForce = false;
  nextAt = performance.now() + cfg.intervalMs;
  console.log(`[sky] baked dome crossfade loop — ${A.width}x${A.height}, `
    + `${bandMeshes.length} bands/cycle, ${(cfg.intervalMs / 1000).toFixed(1)}s cadence`);
  return true;
}

/** Off-render compile (§16.2.A) with renderBand's scene, camera and formats, so it's a cache hit; band 0 covers all. */
function warmBakePipeline() {
  const m0 = bandMeshes[0];
  if (!m0) return Promise.resolve();
  return warm('sky bake pipeline', async () => {
    if (!bandMeshes[0] || !bakeCam) return;   // torn down while queued
    const prevRT = renderer.getRenderTarget();
    const saveVis = m0.visible;
    m0.visible = true;
    let compiled;
    try {
      renderer.setRenderTarget(targets[0]);
      compiled = renderer.compileAsync(m0, bakeCam, bandScene);
    } finally {
      renderer.setRenderTarget(prevRT);
      m0.visible = saveVis;
    }
    await (compiled?.catch(() => {}) ?? Promise.resolve());
  }, { p: P_AMBIENT });
}

/** A bake mid-flight re-runs after; a playing dissolve is shortened so the new look lands promptly. */
export function requestBake() {
  if (!dome) return;
  pendingForce = true;
  if (state === 'fading' && fade) {
    const now = performance.now();
    fade.dur = Math.min(fade.dur, (now - fade.t0) + 700);
  }
}

// in XR a setTimeout pump bakes between frames: a second render() inside an XR frame corrupts the per-eye list
const XR_BAKE_SPACING_MS = 40;
let skyWaited = 0;   // band asks age like any waiter (the pump asks last in a frame; it must not starve)
let xrPumpId = 0;
let xrBakeBroken = false;
// a new session gets the pump back (a lasting fault latches again at once)
bus.on('xr:state', (on) => { if (on) xrBakeBroken = false; });

function xrPumpDue() {
  return state === 'baking'
    || (state === 'idle' && (pendingForce || performance.now() >= nextAt));
}

function scheduleXrPump() {
  if (xrPumpId || xrBakeBroken || !xrPumpDue()) return;
  xrPumpId = setTimeout(xrPumpTick, XR_BAKE_SPACING_MS);
}

function xrPumpTick() {
  xrPumpId = 0;
  if (!dome || xrBakeBroken) return;
  if (!renderer.xr?.isPresenting) return;   // session ended: frame path resumes
  const now = performance.now();
  // XR state exists only inside a session rAF
  const xrWas = renderer.xr.enabled;
  renderer.xr.enabled = false;
  // PINNED-VERSION SURGERY (re-check at every three bump): null the stale XR _currentContext and do NOT restore it
  // (a dead framebuffer poisons the next XR frame); the catch's freeze-latch is the backstop
  const bk = renderer.backend;
  if (bk) bk._currentContext = null;
  renderer._currentRenderContext = null;
  try {
    if (state === 'idle' && (pendingForce || now >= nextAt)) {
      if (!maybeRefreshGraph()) {
        cycleForced = pendingForce;
        pendingForce = false;
        cycleStart = now; cycleSkyT = skyTimeNow(); cycleSnap = skySnapshot(sysRef);
        nextAt = now + cadenceMs();
        bandIdx = 0;
        state = 'baking';
      }
    } else if (state === 'baking') {
      const g = ask('sky', { gpu: true, waited: skyWaited });
      if (!g) skyWaited++;
      else {
        skyWaited = 0;
        const t0 = performance.now();
        renderBand(bandIdx);                // one band per tick, off-frame
        spent('sky', performance.now() - t0, null, g);
        bandIdx += 1;
        if (bandIdx >= bandMeshes.length) finishBake(now);
      }
    }
  } catch (e) {
    xrBakeBroken = true;
    console.error('[sky] XR off-frame bake failed — sky frozen for this '
      + 'session (please report):', e?.message ?? e,
      '\nSTACK:', String(e?.stack ?? '').slice(0, 600));
    return;
  } finally {
    renderer.xr.enabled = xrWas;
  }
  scheduleXrPump();
}

const _domeEye = new THREE.Vector3();
/** Per frame: follow the camera (x/z only) and advance the bake/fade cycle. */
export function updateBakedDome(now = performance.now()) {
  if (!dome) return;
  // WORLD position: in XR camera.position is rig-local
  camera.getWorldPosition(_domeEye);
  dome.position.set(_domeEye.x, 0, _domeEye.z);
  if (driftDt) { const t = skyTimeNow(); driftDt[0].value = t - bakeSkyT[0]; driftDt[1].value = t - bakeSkyT[1]; }

  const presenting = Boolean(renderer.xr?.isPresenting);
  if (presenting) scheduleXrPump();        // renders happen between XR frames
  if (state === 'baking') {
    if (presenting) return;                // the pump owns this state in XR
    const g = ask('sky', { gpu: true, waited: skyWaited });   // a band is a gpu unit: at most one per frame, in the shared budget
    if (!g) { skyWaited++; return; }
    skyWaited = 0;
    const t0 = performance.now();
    renderBand(bandIdx);
    spent('sky', performance.now() - t0, null, g);
    bandIdx += 1;
    if (bandIdx >= bandMeshes.length) finishBake(now);
    return;
  }
  if (state === 'fading') {
    const k = Math.min(1, (now - fade.t0) / fade.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;   // easeInOut
    blendU.value = fade.from + (fade.to - fade.from) * e;
    if (k >= 1) {
      front = fade.to;
      fade = null;
      state = 'idle';
    }
    return;
  }
  if (state !== 'idle') return;        // 'refreshing': a graph rebuild is in flight
  if (presenting) return;              // idle→baking is the pump's too
  if (pendingForce || now >= nextAt) {
    if (maybeRefreshGraph()) return;   // clear↔cloudy flip: rebuild first
    cycleForced = pendingForce;
    pendingForce = false;
    cycleStart = now; cycleSkyT = skyTimeNow(); cycleSnap = skySnapshot(sysRef);
    nextAt = now + cadenceMs();
    bandIdx = 0;
    state = 'baking';
  }
}

// across the clear↔cloudy line the pinned graph is the wrong flavour: rebuild through the engine's bakeEnv and re-pin
let refreshHeldLogged = false;
let refreshStats = { held: 0, bands: null };
/** Harness (tools/sky-refresh-probe.mjs): force the normally unreachable clear→cloudy refresh and read what it did. */
// ??= : a second instance of this module (a probe's import at another URL) must not replace the live seam
globalThis.__skyRefresh ??= {
  force: () => { pinnedCloudsOn = false; refreshStats = { held: 0, bands: null }; requestBake(); },
  stats: () => ({ ...refreshStats, state, pinnedCloudsOn, pendingForce, xrBakeBroken, dome: !!dome, presenting: !!renderer.xr?.isPresenting }),
};
/** Never lands inside a headset session: the strips' plain render() must not run while XR owns the frame. */
export const nextDesktopFrame = () => new Promise(function wait(res) {
  requestAnimationFrame(() => (renderer.xr?.isPresenting ? setTimeout(() => wait(res), 250) : res()));
});
function maybeRefreshGraph() {
  const wantClouds = !cfg.noClouds && sys.state?.preset !== 'clear';   // the off tier never grows a cloud branch
  if (wantClouds === pinnedCloudsOn) return false;
  // one direction only (§18b): a c1 graph draws a correct clear sky, so only c0→c1 rebuilds
  if (!wantClouds) return false;
  // never inside a headset: a whole-graph rebuild held an XR frame for seconds and tripped the GPU watchdog
  if (renderer.xr?.isPresenting) {
    refreshStats.held++;
    if (!refreshHeldLogged) { refreshHeldLogged = true; tee('[sky] clear→cloudy graph refresh held until VR exit'); }
    return false;
  }
  refreshHeldLogged = false;
  state = 'refreshing';
  // the compile takes seconds (minutes cold): the sky panel shows it; sky.js folds this into 'sky-busy'
  refreshing = true; bus.emit('sky-refreshing', true);
  const A = targets[0];
  const gen = bakeGen, alive = () => gen === bakeGen;
  // bakeEnv's full-quad renderAsync becomes strips, as the boot bake (one draw trips the GPU watchdog)
  let origRA = renderer.renderAsync;
  let outer = renderer.getRenderTarget();
  const interceptor = function (sc, cam) {
    if (sc !== sys?._envBake?.scene) return origRA.call(this, sc, cam);
    renderer.renderAsync = origRA;
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(outer ?? null);
    const t0 = performance.now();
    return bandedBakeRender(renderer, sc, cam, target, { cloudPasses: cfg.cloudPasses, passTexelBudget: cfg.passTexelBudget, nextFrame: nextDesktopFrame, budget: true, alive, sys })
      .then((n) => { const ti = targets?.indexOf?.(target) ?? -1; if (ti >= 0 && bootBakeSkyT != null) bakeSkyT[ti] = bootBakeSkyT; refreshStats.bands = n; tee(`[sky] graph refresh baked in ${n} bands over ${(performance.now() - t0).toFixed(0)} ms`); renderer.setRenderTarget(target); });
  };
  const install = () => { origRA = renderer.renderAsync; outer = renderer.getRenderTarget(); renderer.renderAsync = interceptor;
    return () => { if (renderer.renderAsync === interceptor) renderer.renderAsync = origRA; }; };
  Promise.resolve(sys.bakeEnv(renderer, {
    width: A.width, height: A.height, cloudPasses: cfg.cloudPasses, [BAKE_INTERCEPT]: install,
  })).then(() => {
    if (!alive()) return;             // torn down meanwhile: the state is someone else's now
    const bake = sys._envBake;
    const bakeMat = bake?.scene?.children?.[0]?.material;
    if (!bakeMat) throw new Error('bake graph missing after refresh');
    for (const m of bandMeshes) m.material = bakeMat;
    bakeCam = bake.camera;
    pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');
    // the bake landed in A; the re-pinned material is cold in the band context, so warm first (§18b)
    blitEnvFrom(A);
    blendU.value = 0;
    front = 0;
    fade = null;
    nextAt = performance.now() + cfg.intervalMs;
    state = 'warming';
    return warmBakePipeline().then(() => { if (state === 'warming') state = 'idle'; });
  }).catch((e) => {
    if (!alive()) return;
    console.warn('[sky] bake graph refresh failed', e?.message ?? e);
    pinnedCloudsOn = wantClouds;   // stop retrying every cycle
    state = 'idle';
  }).finally(() => { refreshing = false; bus.emit('sky-refreshing', false); });
  return true;
}

// PMREM reads 512x256 every cycle instead of stalling on the full bake
function blitEnvFrom(target) {
  blitTexNode.value = target.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(envRT);
  renderer.render(blitScene, blitCam);   // rig cam — identical to the engine's bake cam
  renderer.setRenderTarget(prev ?? null);
  envRT.texture.needsPMREMUpdate = true;
  if (sys._envFbNode) sys._envFbNode.value = envRT.texture;
  const env = scene.environment;
  if (!env || env === envRT.texture
      || env === targets[0].texture || env === targets[1].texture) {
    scene.environment = envRT.texture;
  }
}

function renderBand(i) {
  const back = targets[1 - front];
  for (let j = 0; j < bandMeshes.length; j++) bandMeshes[j].visible = j === i;
  const prev = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;          // bands accumulate; each strip fully overdraws its own texels
  renderer.setRenderTarget(back);
  // a throw must not leave the back target bound and autoClear off for the main pass
  try { atSkySnapshot(cycleSnap, () => renderer.render(bandScene, bakeCam)); }
  catch (e) { tee(`[sky] dome band ${i}/${bandMeshes.length} render threw: ${String(e?.message ?? e).slice(0, 300)}`); throw e; }
  finally { renderer.setRenderTarget(prev ?? null); renderer.autoClear = autoClear; }
}

function finishBake(now) {
  lastCycleMs = now - cycleStart;
  const back = targets[1 - front];
  bakeSkyT[1 - front] = cycleSkyT;   // every strip was drawn at this time
  blitEnvFrom(back);   // IBL + reflection fallback follow the freshest bake

  // dissolve across the rest of the interval, so the sky never steps; verb-driven bakes land faster
  fade = {
    from: blendU.value,
    to: 1 - front,
    t0: now,
    dur: cycleForced
      ? cfg.forcedFadeMs
      : Math.max(2500, cfg.intervalMs - (now - cycleStart) - 250),
  };
  state = 'fading';
}

/** Restore the live domes (so sky.js's disposal pass finds them) and drop everything of ours. Safe when inactive. */
export function detachBakedDome() {
  bakeGen++;
  releaseLiveDomes();
  if (parked) {
    for (const d of parked) scene.add(d);
    parked = null;
  }
  if (dome) {
    scene.remove(dome);
    dome.geometry.dispose();
    mat.dispose();
    dome = null; driftDt = null; sysRef = null; bootBakeSkyT = null;   // a later attach mustn't adopt this build's bake time
    mat = null;
  }
  if (bandGeos) {
    for (const g of bandGeos) g.dispose();   // the material is the engine's — leave it
    bandGeos = null;
    bandMeshes = null;
    bandScene = null;
  }
  if (envRT) {
    // the env target SURVIVES teardown: refill it from the engine's target so a live-tier sky keeps reflections
    if (targets) {
      blitTexNode.value = targets[0].texture;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(envRT);
      renderer.render(blitScene, blitCam);
      renderer.setRenderTarget(prev ?? null);
      envRT.texture.needsPMREMUpdate = true;
      if (sys?._envFbNode) sys._envFbNode.value = targets[0].texture;
    }
  }
  if (targets) {
    targets[1].dispose();                    // A is the engine's _envTarget — leave it
    targets = null;
  }
  sys = null;
  blendU = null;
  fade = null;
  state = 'idle';
  pendingForce = false;
  pinnedCloudsOn = null;
}
