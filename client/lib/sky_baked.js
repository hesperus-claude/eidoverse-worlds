// baked sky — the clouds as a banded, double-buffered equirect bake (bakeEnv) instead of a per-pixel march: the sky
// is a function of view direction, so no visible parallax is lost. Two targets cross-dissolve so clouds keep evolving;
// the freshest bake feeds scene.environment so IBL agrees. Trades: no in-cloud lightning, no march shimmer ('high'
// keeps the live march).
// Reaches through skyApi._internals (domes, _envTarget, _envBake): if they move, attach() returns false and sky.js
// stays on the live march.
// degraded performance, never a broken sky.

import { THREE, TSL, scene, camera, renderer } from './core.js';
import { tee, bus, CONFIG } from './base.js';
import { warm, P_AMBIENT } from './warmqueue.js';
import { bandCuts } from './sky_bands.js';
import { ask, spent, turn } from './framebudget.js';

let dome = null;
let mat = null;
let parked = null;     // the live domes we pulled out of the scene graph
let xrHeld = null;     // [dome, parent] pairs held out of the scene in a headset until a baked dome takes over

/** In a headset the live domes are the full per-eye cloud march: different noise in each eye, and
 *  ~13 fps while a first compile runs. When a baked tier is coming, hold them out until the baked dome attaches;
 *  the sky meanwhile is the atmosphere without clouds. Safe to call repeatedly. */
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
/** Put held domes back (the baked dome is attaching, the sky is being torn down, or the session ended). */
export function releaseLiveDomes() {
  if (!xrHeld) return;
  for (const [d, p] of xrHeld) if (!d.parent) p.add(d);
  xrHeld = null;
}
export const liveDomesHeld = () => !!xrHeld;
/** Teardown: hand back the held domes WITHOUT re-adding them. Held from birth, they may never have been compiled, and a
 *  build that failed before claiming them would otherwise leave them in the scene for the render path (audit M5). */
export function takeHeldDomes() { const out = (xrHeld ?? []).map(([d]) => d); xrHeld = null; return out; }
export const holdLiveDomesInXR = (skyApi) => holdLiveDomes(skyApi);   // probe name
let sys = null;        // sky_system internals
let targets = null;    // [A, B] — A is the engine's _envTarget, B is ours
let blendU = null;     // 0 → targets[0] on the dome, 1 → targets[1]
let front = 0;         // index the blend currently rests on
let bakeGen = 0;       // bumped at teardown: a band loop or refresh from an older sky stops instead of drawing into freed targets
export const bakeGeneration = () => bakeGen;
let bandScene = null;
let bandMeshes = null;
let bandGeos = null;
let bakeCam = null;
let pinnedCloudsOn = null;   // whether the pinned bake graph HAS a cloud branch
/** The §18b fence in sky.js consults this: 'clear' is respelled as an empty cumulus only once a cloud graph is
 *  pinned, because even an async compile of the ~1.5MB-WGSL cloud graph stalls the GPU process (~9s); lazy pinning
 *  pays it at most once, at the first cloudy change. */
export const bakedCloudsPinned = () => pinnedCloudsOn === true;

// §19a: arrival gates on the FIRST bake's band pipeline being warm (the
// boot pays the one big cloud-graph compile behind the splash — tel0s's
// call). Single-shot; only meaningful on baked tiers (sky.js guards).
let _bakeReadyResolve = null;
const _bakeReady = new Promise((r) => { _bakeReadyResolve = r; });
export const whenBakeReady = () => _bakeReady;
function resolveBakeReady() { _bakeReadyResolve?.(); _bakeReadyResolve = null; }
// scene.environment is a dedicated small target, PERSISTENT and never replaced: a DIFFERENT texture object there
// recompiles every PBR material in the world. It boots assigned (black) and every bake, takeover and tier switch BLITS
// into it (PMREM from the full 4096 bake stalled ~150 ms).
let envRT = null;
let blitScene = null;
let blitTexNode = null;
let blitGeo = null;
let blitMat = null;
let blitCam = null;    // own ortho cam — identical to the engine's bake cam,
                       // so the rig works before any sky exists

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

/** The persistent environment texture — assign this to scene.environment at
 *  boot (black until a sky bakes) and never assign anything else. */
export function envTexture() {
  ensureEnvRig();
  return envRT.texture;
}

/** If anything else was assigned to scene.environment, copy its content into the persistent target and put the
 *  persistent texture back, so the graphs never see the object change. Idempotent; one 512x256 quad. */
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
// DRIFT (opt-in, ?skydrift=1): each view ray is carried to the cloud layer and shifted by wind × (sky time since that
// texture was baked), so clouds move between bakes. Off by default because the bake is one picture and the stars
// drift too. Fades out toward the horizon and around the sun.
const DRIFT = CONFIG.params.get('skydrift') === '1';   // opt-in since 10-01 (the stars drifted with the clouds)
let sysRef = null, cycleSkyT = 0, cycleSnap = null;
const bakeSkyT = [0, 0];               // sky time each target's picture shows (mid-bake)
let driftDt = null;                    // [uniform, uniform]: dt for A and B
const skyTimeNow = () => sysRef?.uniforms?.time?.value ?? 0;
// ONE SKY STATE PER BAKE: strips span many frames, so a bake snapshots the sky's scalar and vector uniforms when it
// begins and draws every strip with them (restoring the live values after each draw), or strip edges show as bands.
// Textures and matrices are left alone.
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
/** A bake option (symbol: the engine never reads it) carrying `() => restore`: installed INSIDE the bake lock, right
 *  before that bake runs (review 7, B1: a renderAsync interceptor patched outside the lock caught whichever bake held
 *  it, and its own bake then went out as one full-quad draw). Object spread copies it through the api's opts copy. */
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');
let bootBakeSkyT = null;   // the time the last banded boot/swap bake was pinned to (attach adopts it for target A)
/** Drift state (probes, the debug panel): null when off, else the seconds each texture has drifted. */
export const bakedDrift = () => (driftDt ? [driftDt[0].value, driftDt[1].value] : null);
// The re-bake interval, never shorter than a bake takes plus room to dissolve (audit M1: in a headset one 4096x2048
// 8-pass bake takes ~6.2 s at the pump's 40 ms band spacing, longer than the then-baked high's 6 s interval, so it baked
// back to back).
const cadenceMs = () => Math.max(cfg.intervalMs, lastCycleMs > 0 ? lastCycleMs + 2500 : 0);
let pendingForce = false;

let cfg = {
  intervalMs: 9000,        // cycle start → next cycle start
  forcedFadeMs: 2500,      // verb-driven changes ease in faster
  // band size in TEXELS × MARCH PASSES per frame, the unit GPU cost roughly follows (bands are also chord-weighted)
  passTexelBudget: 0.4e6,
  cloudPasses: 8,
};


export { bandCuts } from './sky_bands.js';   // pure maths, its own module so a unit test can load it

/** Render `fn` BETWEEN XR frames with the pump's discipline (see xrPumpTick): xr.enabled off, the stale eye contexts
 *  nulled (and never restored: null is the truth between frames). Awaits a macrotask first, so a caller woken from a
 *  frame callback (rAF is the session clock while presenting) is out of the frame before it renders. */
export async function renderBetweenXRFrames(r, fn) {
  await new Promise((res) => setTimeout(res, 0));
  const xrWas = r.xr.enabled;
  r.xr.enabled = false;
  if (r.backend) r.backend._currentContext = null;
  r._currentRenderContext = null;
  try { return fn(); } finally { r.xr.enabled = xrWas; }
}

/** The boot bake as bands: one 4096x2048 8-pass full-screen draw is past a GPU watchdog (context lost), so the quad
 *  renders into `target` as cost-weighted strips, one per frame, same material and uvs (same texels). The band
 *  pipeline is compiled off the render path first. Returns the band count. */
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
      // the target is read when compileAsync is CALLED; holding it bound across the await (seconds, cold) left every
      // frame meanwhile starting with the bake target bound (render.js: 'unbound a stale target at frame start')
      let compiling;
      try { compiling = r.compileAsync(bs, bakeCam); } finally { r.setRenderTarget(prev ?? null); }
      await compiling.catch((e) => tee(`[sky] band bake: compileAsync rejected: ${e?.message ?? e}`));
      // …and LINKED: a giant program the syncgate backstop deferred earlier (a render into this target during the
      // build) may still be linking; drawing now would skip every band and leave the dome black (09-27 18:10)
      const tl = performance.now();
      await globalThis.__syncGate?.whenGiantLinked?.();
      const waited = performance.now() - tl;
      tee(`[sky] band bake: compiled in ${(performance.now() - tc).toFixed(0)} ms${waited > 50 ? ` (waited ${waited.toFixed(0)} ms for a deferred link)` : ''}, ${meshes.length} bands to draw`); }
    const pinSnap = skySnapshot(sys), pinT = sys?.uniforms?.time?.value ?? null;   // every strip at the moment the drawing began
    bootBakeSkyT = pinT;
    for (let i = 0; i < meshes.length; i++) {
      // budget: each band is a gpu unit of the shared per-frame budget (the client's callers; the probe paces itself).
      // Nothing is bound across this wait: other frames render meanwhile.
      const g = budget ? await turn('sky', { gpu: true }) : null;
      if (!alive()) throw new Error('bake cancelled: the sky was torn down mid-bake');   // finally frees the strips
      const draw = () => {
        if (!alive()) throw new Error('bake cancelled: the sky was torn down mid-bake');   // again: a macrotask may have passed
        for (let j = 0; j < meshes.length; j++) meshes[j].visible = j === i;
        const prev = r.getRenderTarget(), autoClear = r.autoClear;
        r.autoClear = false;          // strips abut and each fully overdraws its own texels
        r.setRenderTarget(target);
        const t0 = performance.now();
        try { atSkySnapshot(pinSnap, () => r.render(bs, bakeCam)); } finally { r.setRenderTarget(prev ?? null); r.autoClear = autoClear; }
        if (g) spent('sky', performance.now() - t0, null, g);
      };
      // a bake that runs into a headset session (the VR cap's high→medium rebuild; a desktop bake still banding at
      // entry) must not render INSIDE an XR frame: that corrupts the per-eye render list (see xrPumpTick)
      if (r.xr?.isPresenting) await renderBetweenXRFrames(r, draw); else draw();
      if (i === 0 || i % 40 === 39) tee(`[sky] band bake: band ${i + 1}/${meshes.length} drawn`);
      if (i < meshes.length - 1) await nextFrame();
    }
  } finally { for (const g of geos) g.dispose(); }
  return meshes.length;
}

export const bakedActive = () => Boolean(dome);
/** The baked dome mesh while attached (it draws unfogged: hidden under the world's water — sky.js hideSkyForWater). */
export const bakedDomeObject = () => dome;

/** Swap the live march domes for the crossfading baked dome.
 *  Call AFTER the first full bakeEnv has rendered the target. */
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
  releaseLiveDomes();   // held in a headset: back in, so the park below takes them (and teardown can find them)
  parked = s.domes.filter((d) => d?.parent);
  for (const d of parked) d.parent.remove(d);

  // The back buffer — same spec as sky_system's _ensureEnvTarget.
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

  // band strips over the engine's cached bake material: horizontal slices with GLOBAL uvs, one per frame, cut by equal
  // march-chord WEIGHT rather than height (grazing horizon rows cost far more), so every band costs about the same
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
  // bakeEnv keys its cached graph on whether clouds existed at bake time (a 'clear' graph has no cloud branch);
  // remember the pinned flavour so a clear↔cloudy flip can rebuild it (maybeRefreshGraph)
  pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');

  // The persistent env rig (module-lifetime — see its comment above).
  ensureEnvRig();
  blitEnvFrom(A);                          // boot bake → env, before its 4096 PMREM ever runs

  // One dome where two were: the bake already composites clouds over the
  // atmosphere. (If ringworld ever comes off the KNOWN_HEAVY list its band
  // renders BETWEEN the live domes — this single dome would need splitting.)
  const radius = (s.domes[0]?.geometry?.parameters?.radius ?? 15000) * 0.99;
  mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  // Linear HDR in the targets; tone-map with the frame like the live domes.
  mat.toneMapped = true;
  // A vertex of a centred sphere IS its own view direction, and the bake's
  // uv→dir mapping is authored as the exact inverse of three's equirectUV()
  // (that is what lets the same texture serve as scene.environment).
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
      // capped at ~12% of the layer height (~7° overhead): a stale picture under a storm wind (VR cycles run ~20 s, the
      // storm scales the wind up) otherwise pulled hazy near-horizon texels overhead (owner's headset, 09-27 20:37)
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
  // AFTER the world's opaques (0.5): drawn first it shaded every eye pixel only to be overdrawn. Overlays (>= 1) still
  // draw after it (tools/dome-order-probe.mjs). Keep it so: an opaque that writes no depth must sit at renderOrder >= 1.
  dome.renderOrder = 0.5;
  dome.userData.odTag = 'sky';   // overdraw.js category
  dome.frustumCulled = false;
  dome.userData.noSupportCheck = true;
  dome.userData.noCamCollide = true;
  dome.userData.noWet = true;
  scene.add(dome);

  front = 0;
  // §18b: the BAND context is a different pipeline from the boot bake's, and a cold first band paid a blocking ~1.5MB
  // WGSL compile inside one frame; the cycle holds in 'warming' until the band pipeline exists
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

/** Compile the band pipeline off the render path through the conductor (§16.2.A), with renderBand's scene, camera
 *  and target formats so the real band render is a cache hit; all bands share one material, so band 0 covers all. */
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

/** Ask for a fresh bake soon (verb changed the sky's look). If one is
 *  mid-flight it re-runs after; if a dissolve is playing it is shortened so
 *  the new look lands promptly. */
export function requestBake() {
  if (!dome) return;
  pendingForce = true;
  if (state === 'fading' && fade) {
    const now = performance.now();
    fade.dur = Math.min(fade.dur, (now - fade.t0) + 700);
  }
}

// In XR, bakes run from a setTimeout pump between frames, one band per XR_BAKE_SPACING_MS: a second render() inside
// an XR frame corrupts the per-eye render list, and rAF is parked in immersive sessions. On the crash signature,
// baking freezes for the session.
const XR_BAKE_SPACING_MS = 40;
let skyWaited = 0;   // band asks age like any waiter (the pump asks last in a frame; it must not starve)
let xrPumpId = 0;
let xrBakeBroken = false;
// 'frozen for this session' means THIS session: a new one gets the pump back (a lasting fault latches again at once)
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
  // between frames, route nothing through XR state (it exists only inside a session rAF): xr.enabled off around the bake
  const xrWas = renderer.xr.enabled;
  renderer.xr.enabled = false;
  // PINNED-VERSION SURGERY (re-check at every three bump): between XR frames _currentContext still names the last XR
  // frame's, and finishRender would restore a dead framebuffer. Null it for the off-frame render and do NOT restore it
  // (that poisons the next XR frame); the catch's freeze-latch is the backstop.
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
/** Per frame from updateSky(): follow the camera (x/z only, like the live domes) and advance the bake/fade cycle. */
export function updateBakedDome(now = performance.now()) {
  if (!dome) return;
  // the eye's WORLD position — in XR camera.position is rig-local, which left the dome centred near the world origin
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

// a weather/cloud verb can cross the clear↔cloudy line, where the pinned graph is the wrong flavour: rebuild through
// the engine's own bakeEnv (one full-quad render + a recompile) and re-pin its fresh material
let refreshHeldLogged = false;
let refreshStats = { held: 0, bands: null };
/** Harness: force the clear→cloudy graph refresh on the next cadence cycle (normally unreachable — sky.js pins the
 *  cloud graph at boot) and read what it did. tools/sky-refresh-probe.mjs. */
// ??= : a second instance of this module (a probe's own import at another URL) must not replace the live one's seam
globalThis.__skyRefresh ??= {
  force: () => { pinnedCloudsOn = false; refreshStats = { held: 0, bands: null }; requestBake(); },
  stats: () => ({ ...refreshStats, state, pinnedCloudsOn, pendingForce, xrBakeBroken, dome: !!dome, presenting: !!renderer.xr?.isPresenting }),
};
/** A frame to wait for between bake strips that never lands inside a headset session: the strips render
 *  with plain renderer.render, which must not run while XR owns the frame (see xrPumpTick). */
export const nextDesktopFrame = () => new Promise(function wait(res) {
  requestAnimationFrame(() => (renderer.xr?.isPresenting ? setTimeout(() => wait(res), 250) : res()));
});
function maybeRefreshGraph() {
  const wantClouds = !cfg.noClouds && sys.state?.preset !== 'clear';   // the off tier never grows a cloud branch (M3)
  if (wantClouds === pinnedCloudsOn) return false;
  // one direction only (§18b): a c1 graph with finalMul→0 draws a correct clear sky, so cloudy→clear never rebakes;
  // only c0→c1 needs a rebuild, and sky.js's §18b fence normally keeps capable tiers pinned c1 anyway
  if (!wantClouds) return false;
  // Never inside a headset: this rebuilds the whole cloud graph and re-bakes it, the class of work that
  // held one XR frame for seconds and tripped the GPU watchdog. The cadence keeps the current (clear)
  // graph running until the session ends; the flip then happens on the desktop.
  if (renderer.xr?.isPresenting) {
    refreshStats.held++;
    if (!refreshHeldLogged) { refreshHeldLogged = true; tee('[sky] clear→cloudy graph refresh held until VR exit'); }
    return false;
  }
  refreshHeldLogged = false;
  state = 'refreshing';
  // the clear→cloudy graph refresh compiles the cloud program (seconds; minutes cold): the sky panel's 'loading…'
  // should say so (review 3, M4). sky.js folds this into 'sky-busy'.
  refreshing = true; bus.emit('sky-refreshing', true);
  const A = targets[0];
  const gen = bakeGen, alive = () => gen === bakeGen;
  // bakeEnv's single full-quad renderAsync becomes cost-weighted strips (the boot bake's treatment, sky.js):
  // one 4096x2048 multi-pass draw is past what a GPU watchdog tolerates. Strips pause while presenting.
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
    if (!alive()) return;             // torn down meanwhile: this dome, its targets and its state are someone else's now
    const bake = sys._envBake;
    const bakeMat = bake?.scene?.children?.[0]?.material;
    if (!bakeMat) throw new Error('bake graph missing after refresh');
    for (const m of bandMeshes) m.material = bakeMat;
    bakeCam = bake.camera;
    pinnedCloudsOn = /\|c1$/.test(bake.key ?? '');
    // the full bake landed in A: show it and take the env back from it; the fresh graph's band pipeline warms
    // first (§18b), since the re-pinned material is cold in the band context
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

// Downsample a fresh bake into the small env target and keep it installed —
// PMREM then reads 512x256 every cycle instead of stalling on the full bake.
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
  // try/finally: a throw inside the band render used to leave BOTH the 4096x2048 back target bound (render.js's
  // self-heal then logs "unbound a stale target … frame aborted mid-render" — seen once per boot on the owner's GPU,
  // 09-24) AND autoClear off for the main pass. The error still propagates; now it is also named.
  try { atSkySnapshot(cycleSnap, () => renderer.render(bandScene, bakeCam)); }
  catch (e) { tee(`[sky] dome band ${i}/${bandMeshes.length} render threw: ${String(e?.message ?? e).slice(0, 300)}`); throw e; }
  finally { renderer.setRenderTarget(prev ?? null); renderer.autoClear = autoClear; }
}

function finishBake(now) {
  lastCycleMs = now - cycleStart;
  const back = targets[1 - front];
  bakeSkyT[1 - front] = cycleSkyT;   // every strip was drawn at this time
  blitEnvFrom(back);   // IBL + reflection fallback follow the freshest bake

  // Dissolve toward the fresh bake across the remainder of the interval so
  // the sky reads as continuously evolving, never stepping. Verb-driven
  // bakes land faster.
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

/** Restore the live domes and drop everything of ours. Safe when inactive.
 *  sky.js's teardown diff claimed the real domes at build time, so putting
 *  them back in the scene lets its disposal pass find them again. */
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
    dome = null; driftDt = null; sysRef = null; bootBakeSkyT = null;   // a later one-shot attach mustn't adopt this build's bake time (review 7, L3)
    mat = null;
  }
  if (bandGeos) {
    for (const g of bandGeos) g.dispose();   // the material is the engine's — leave it
    bandGeos = null;
    bandMeshes = null;
    bandScene = null;
  }
  if (envRT) {
    // the persistent env target SURVIVES teardown (a different scene.environment object recompiles every PBR
    // material): refill it from the engine's own target so a live-tier sky keeps correct reflections
    if (targets) {
      blitTexNode.value = targets[0].texture;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(envRT);
      renderer.render(blitScene, blitCam);
      renderer.setRenderTarget(prev ?? null);
      envRT.texture.needsPMREMUpdate = true;
      if (sys?._envFbNode) sys._envFbNode.value = targets[0].texture;
    }
    // rig stays alive — it is the world's environment now and forever
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
