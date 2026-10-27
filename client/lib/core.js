// core — the PRESENTATION substrate: renderer, scene, camera, base lights, stage floor, eidoverse module host.
// Imports nothing from the client but base.js, so the load graph stays acyclic; GPU-free modules import base.js.

import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { CONFIG, tee, teeNow, bus } from './base.js';
import { installGpuLostRecovery } from './gpulost.js';
import { decideBackend } from './backend_choice.js';
import { headsetSeenRecently as _headsetSeenRecently, migrateHeadsetSeen as _migrateHeadsetSeen } from './headset_seen.js';
import { guardPixelRatioInXR } from './xrpixelratio.js';
import { separateXRPass } from './xrpass.js';
import { tolerateNullXRFramebuffer } from './xr_nullfb.js';
import { patchShadowNodeForXR } from './xrshadow.js';
import { installSyncGate } from './syncgate.js';

export { THREE, TSL };

// ------------------------------------------------------------ wgsl debug
// ?wgsldebug: surface Tint's real diagnostics from getCompilationInfo (Chrome logs only "invalid due to a previous error").
if (CONFIG.params.has('wgsldebug') && globalThis.GPUDevice) {
  const orig = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const mod = orig.call(this, desc);
    mod.getCompilationInfo?.().then((info) => {
      const errs = info.messages.filter((m) => m.type === 'error');
      if (!errs.length) return;
      for (const m of errs.slice(0, 3)) {
        console.error(`[wgsl] ${m.lineNum}:${m.linePos} ${m.message}`);
        const lines = desc.code.split('\n');
        console.error('[wgsl-src]\n' + lines.slice(Math.max(0, m.lineNum - 3), m.lineNum + 2)
          .map((l, i) => `${Math.max(0, m.lineNum - 3) + i + 1}: ${l}`).join('\n'));
      }
    });
    return mod;
  };
}

// ------------------------------------------------------------ renderer
export const canvas = document.createElement('canvas');
// focusable: Chrome's pointer-lock re-entry after Esc needs a focused target
canvas.tabIndex = -1;
canvas.style.outline = 'none';
document.body.prepend(canvas);

// MSAA stays on by default (§22n/§22r: ~4ms/frame at 2× retina, but vanished AA reads as a bug); ?msaa=0 opts out.
// ?webgl=1 forces WebGL 2. Both apply at construction (next load): the URL param wins, else the saved preference.
export const PREF_MSAA = 'ew-msaa', PREF_BACKEND = 'ew-backend';
// the stored headset bit is HISTORY, not presence, and it expires (headset_seen.js)
export const PREF_HEADSET_SEEN = 'ew-headset-seen';   // ms timestamp of the last granted session (legacy: '1')
const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };   // a storage throw must not kill boot
export const headsetSeenRecently = () => {
  // WRITE the legacy '1' back as a timestamp, so it ages out instead of being permanent
  const now = Date.now(); let raw = pref(PREF_HEADSET_SEEN);
  const migrated = _migrateHeadsetSeen(now, raw);
  if (migrated !== null) { try { localStorage.setItem(PREF_HEADSET_SEEN, migrated); } catch {} raw = migrated; }
  return _headsetSeenRecently(now, raw);
};

// ?xr=1 is a boot flag: WebGPU-XR needs an xrCompatible adapter, read at init(), so xr.enabled is set before init.
// the backend rule is decideBackend (backend_choice.js)
export const WEBGPU_XR = 'XRGPUBinding' in globalThis;               // WebGPU can present VR here (Chrome flags)
export const WEBGPU_POSSIBLE = typeof navigator !== 'undefined' && !!navigator.gpu;   // WebGPU API exists at all
const _choice = decideBackend({ params: CONFIG.params, backendPref: pref(PREF_BACKEND), headsetSeen: headsetSeenRecently(), webgpuXR: WEBGPU_XR });
export const XR_BOOT = _choice.xrBoot;
const _forceWebGL = _choice.forceWebGL;
// Tolerant render list: in XR the per-eye list gets holes mid-session and one throws the whole frame; skip them.
// Patched on the class PROTOTYPE (some path binds at construction) and reimplemented, not wrapped (the list
// mutates mid-iteration). Installed at boot under ?xr=1, else by enterVR() (xr.js); desktop never runs it.
let renderListToleranceInstalled = false;
export function installRenderListTolerance() {
  if (renderListToleranceInstalled) return; renderListToleranceInstalled = true;
  globalThis.__renderListTolerance = true;   // harness: boot-check asserts this only under ?xr=1
  const proto = THREE.WebGPURenderer?.prototype;
  const orig = proto?._renderObjects;
  let logged = 0;
  if (orig) {
    proto._renderObjects = function (renderList, cam, scn, lightsNode, passId = null) {
      for (let i = 0; i < renderList.length; i++) {
        const item = renderList[i];
        if (!item) {
          if (logged < 5) {
            logged++;
            const err = new Error(`renderList hole at ${i}/${renderList.length}, pass=${passId}, xr=${this.xr?.isPresenting}`);
            globalThis.__errLog?.push?.(`${err.message} :: ${err.stack?.split('\n').slice(2, 5).join(' | ')}`);
            console.warn('[renderlist]', err.message);
          }
          continue;
        }
        const { object, geometry, material, group, clippingContext } = item;
        this._currentRenderObjectFunction(object, scn, cam, geometry, material, group, lightsNode, clippingContext, passId);
      }
    };
  }
}
if (_choice.installTolerance) installRenderListTolerance();

export const renderer = new THREE.WebGPURenderer({ canvas,
  antialias: (CONFIG.params.get('msaa') ?? pref(PREF_MSAA)) !== '0',
  forceWebGL: _forceWebGL });
/** 'webgpu' | 'webgl' — known once renderer.init() resolves. */
export const backendName = () => (renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu');
if (XR_BOOT) renderer.xr.enabled = true;   // must precede init(): xrCompatible adapter
renderer.setSize(innerWidth, innerHeight);
// Shadows from the sun, not the head: presenting, Renderer.render() swaps in the XR camera for every call, the
// shadow pass included. xr is turned off around that pass (as render.js renderAside does).
globalThis.__xrShadowPatched = patchShadowNodeForXR(THREE.ShadowNode?.prototype);   // the global lets boot-check assert it was APPLIED
// spectators start a notch lower: an audience laptop's job is 30fps for an hour
export const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, CONFIG.spectate ? 1.5 : 2);
renderer.setPixelRatio(BASE_PIXEL_RATIO);
// #32 split vision: while presenting, the pixel ratio belongs to the XR layer (xrpixelratio.js)
export const xrPixelRatio = guardPixelRatioInXR(renderer);
globalThis.__xrPixelRatioGuarded = !!xrPixelRatio;   // boot-check asserts the guard was APPLIED, not just importable
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Where a headset was seen, create the WebGL context xrCompatible (makeXRCompatible on entry can lose the context
// on multi-GPU laptops). Built here, after tone mapping zeroed currentSamples, so attributes match three's own.
// __xrCtx records the cost; ?xrctx=0 = off.
let _xrGl = null;
if (_forceWebGL && (XR_BOOT || headsetSeenRecently()) && CONFIG.params.get('xrctx') !== '0') {
  const t = performance.now();
  const gl = _xrGl = canvas.getContext('webgl2', { antialias: renderer.currentSamples > 0, alpha: true, depth: renderer.depth, stencil: renderer.stencil, xrCompatible: true });
  if (gl) renderer.backend.parameters.context = gl;
  globalThis.__xrCtx = { ms: +(performance.now() - t).toFixed(1), xrCompatible: gl?.getContextAttributes()?.xrCompatible ?? null };
}
await renderer.init();
if (globalThis.__xrCtx) { const a = _xrGl?.getContextAttributes(); Object.assign(globalThis.__xrCtx, { used: !!_xrGl && renderer.backend?.gl === _xrGl, antialias: a?.antialias ?? null, threeWanted: renderer.currentSamples > 0 }); }   // harness: three drew into OUR context, with the antialias it derives itself
// VR enter/exit: stereo renders keep their own render objects, so the switch never rebuilds either variant (xrpass.js).
// Inert without a stereo camera, so every boot gets it — sessions can start from a non-XR boot too.
globalThis.__xrPassSplit = separateXRPass(renderer);
// An emulator's null eye framebuffer is the default framebuffer, not a WeakMap key (xr_nullfb.js). Installs only for a session whose layer has one — never on hardware.
globalThis.__xrNullFb = tolerateNullXRFramebuffer(renderer);
// No pipeline links on the render path: a missed warm pops in late instead of freezing the browser (syncgate.js). ?syncgate=0 = census only.
globalThis.__syncGate = installSyncGate(renderer, { tee: (l, now) => (now ? teeNow(l) : tee(l)), gate: CONFIG.params.get('syncgate') !== '0' });
// A lost context (GPU watchdog reset, driver crash) goes back to the live world instead of a black canvas (gpulost.js).
globalThis.__gpuLost = installGpuLostRecovery({ canvas, renderer, tee, onStop: (why, rule) => bus.emit('gpu-lost-stop', { why, rule }) });
// the splash watchdog (index.html) stands down: past here everything reports its own failures
globalThis.__ewEngineUp = true;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f12);   // no sky yet: the page's own --bg, so the teal chrome is the only colour
scene.fog = new THREE.FogExp2(0x0b0f12, 0.018);

// The far plane must hold the SKY (cloud dome ~3200 out, ringworld band 4940 up); reversed-Z keeps depth precise.
export const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.15, 20000);
camera.position.set(3.5, 2.6, 5.5);
camera.lookAt(0, 1, 0);

addEventListener('resize', () => {
  // XR owns the framebuffer while presenting: resizing it tears the eye buffers
  if (!renderer.xr?.isPresenting) renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------ base lighting
// empty-world defaults; the sky module owns these once a sky verb lands
export const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x283024, 0.75);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(14, 22, 10);
scene.add(sun);

// The stage floor, replaced the moment a terrain verb lands.
export const ground = new THREE.Mesh(
  new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardNodeMaterial({ color: 0x2a3440, roughness: 0.9, metalness: 0.05 }),
);
ground.receiveShadow = true;
scene.add(ground);
// Monochrome grid: in one buffer bright centre lines dash where dark ones cross, so the axes are their own object.
export const grid = new THREE.GridHelper(160, 80, 0x242c36, 0x242c36);   // a shade under the plane (0x2a3440)
export const axisLines = new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-80, 0, 0), new THREE.Vector3(80, 0, 0), new THREE.Vector3(0, 0, -80), new THREE.Vector3(0, 0, 80)]),
  new THREE.LineBasicMaterial({ color: 0x6a7078 }));
// Floor lines don't write depth and sit 2 cm / 4 cm up: without reversed-Z (WebGL, VR) a 3 mm gap strobes.
axisLines.material.depthWrite = false;
grid.material.depthWrite = false;
axisLines.position.y = 0.04; axisLines.renderOrder = 2; axisLines.frustumCulled = false;
scene.add(axisLines);
// never cull these: XR per-eye frustum culling makes huge planes vanish at some head angles
ground.frustumCulled = false;
grid.frustumCulled = false;
grid.position.y = 0.02; grid.renderOrder = 1;
scene.add(grid);

// ---------------------------------------------------------- eidoverse host
// The browser as an eidoverse module host (render_scene.mjs's globalThis contract): toolkit files load unmodified.

globalThis.THREE = Object.assign({}, THREE, TSL); // engine merges three/tsl into THREE
// We render FORWARD: an mrtNode here emits an empty fragment output Tint rejects. Two belts: no THREE.mrt, and
// upstream's EANPA_NO_MRT opt-out.
delete globalThis.THREE.mrt;
globalThis.EANPA_NO_MRT = true;
globalThis._s = scene; globalThis._c = camera; globalThis._r = renderer;
globalThis._sun = sun; globalThis._hemi = hemi;
globalThis._sceneTime = 0;
