// post — the passes after the scene: the post-processing pipeline (Godot's Environment glow, Filament's View
// BloomOptions). Bloom is its first pass. The world owns the look (sky.bloom: glow strength 0..3, absent = none, every
// world's look before the field); each viewer owns the cost (ew-bloom on/off, default on). R: "the world owner should
// control *what* lighting, and the user should only control perf/quality of said lighting so they can run it".
//
// One three RenderPipeline (TSL): pass(scene, camera) → BloomNode → the pipeline's output pass. three moves tone mapping
// and the output colour space into that output pass, so they are applied once, after bloom: the same place the plain
// path applies them (the renderer's own output pass after its framebuffer target).
//
// The plain path stays the plain path: with no pass asked for (sky.bloom absent or 0, or ew-bloom off) nothing is built
// and the frame is main's renderer.render(); losing the last pass disposes the pipeline and its targets. The scene pass
// and the bloom targets size themselves from the drawing buffer every frame (canvas resize, render scale). While an XR
// session presents the eye pass is the plain render; the pipeline is kept (not rebuilt) for the desktop after exit.
// A pipeline that fails (a throw building or drawing it; a WebGPU validation error in its first frames) is dropped for
// the rest of the page, the frame drawn plain, a clientlog line written; postDebug() says why. A reload tries again.
import { THREE } from '../core.js';
import { tee } from '../base.js';
import { pass } from 'three/tsl';
import { bloom as bloomNode } from 'three/addons/tsl/display/BloomNode.js';

export const BLOOM_PREF = 'ew-bloom';
export const BLOOM_MAX = 3;                         // the registry's range (componentspec sky.bloom)
// radius 0.15, threshold 2: only what is well above white in the linear scene (emitters, lamp bodies, fire) blooms
// (render lab 11-02: 0.4 / 1 spread lamp halos over whole shelves)
export const BLOOM_RADIUS = 0.15, BLOOM_THRESHOLD = 2;
const WATCH_FRAMES = 3;                             // a new pipeline's first frames run inside a WebGPU error scope

const readPref = (key) => { try { return localStorage.getItem(key) !== 'off'; } catch { return true; } };
let bloomOn = readPref(BLOOM_PREF);
export const bloomPref = () => bloomOn;
export function setBloomPref(on) { bloomOn = !!on; try { localStorage.setItem(BLOOM_PREF, on ? 'on' : 'off'); } catch { /* private mode */ } }

const strengthOf = (s) => { const n = typeof s === 'number' ? s : NaN; return Number.isFinite(n) && n > 0 ? Math.min(n, BLOOM_MAX) : 0; };
let bloomStrength = 0;
/** The world's glow strength (sky.js applyTuning, like its exposure). A live edit moves the uniform; nothing rebuilds. */
export function setBloom(s) { bloomStrength = strengthOf(s); if (built?.glow) built.glow.strength.value = bloomStrength; }

let built = null;          // { pipe, scenePass, glow, scene, camera, key, frames }
let failed = null;         // why the pipeline was dropped for this page
let builds = 0, active = false, why = 'no pass asked: the world sets no sky.bloom';

// the passes this frame asks for ('' = none), or why none
function wanted() {
  if (failed) return ['', `failed: ${failed}`];
  if (!(bloomStrength > 0)) return ['', 'no pass asked: the world sets no sky.bloom'];
  if (!bloomOn) return ['', 'off: this viewer\'s ew-bloom'];
  return ['bloom', null];
}

function teardown() {
  const b = built; built = null;
  if (!b) return;
  b.pipe.dispose(); b.glow?.dispose(); b.scenePass.dispose();
}

function build(renderer, scene, camera, key) {
  const pipe = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  // the world's own pass for syncgate: a WebGL link met here defers a frame, as it does on the plain frame's canvas pass
  scenePass.renderTarget.isWorldPass = true;
  const color = scenePass.getTextureNode('output');
  const glow = bloomNode(color, bloomStrength, BLOOM_RADIUS, BLOOM_THRESHOLD);
  pipe.outputNode = color.add(glow);
  builds++;
  built = { pipe, scenePass, glow, scene, camera, key, frames: 0 };
}

function fail(e) {
  failed = String(e?.message ?? e).slice(0, 300);
  tee(`[post] the post pipeline failed, drawing plain for this page: ${failed}`);
  teardown();
}

function draw(renderer, scene, camera, key) {
  try {
    if (!built) build(renderer, scene, camera, key);
    const b = built, device = renderer.backend?.device;
    const watch = !!device?.pushErrorScope && b.frames++ < WATCH_FRAMES;
    if (watch) device.pushErrorScope('validation');
    try { b.pipe.render(); }
    finally { if (watch) device.popErrorScope().then((err) => { if (err && built === b) fail(err); }, () => {}); }
    active = true; why = null;
  } catch (e) {
    fail(e);
    active = false; why = `failed: ${failed}`;
    renderer.setRenderTarget(null);   // a pass that threw can leave its target bound
    renderer.render(scene, camera);
  }
}

/** The live frame's main pass through the pipeline, or null for main's plain renderer.render (render.js renderWorld,
 *  through DrawBatches.render's `draw`). Builds, keeps or disposes the pipeline as the world and viewer ask. */
export function postPass(renderer, scene, camera) {
  const [key, whyNot] = wanted();
  if (!key) { teardown(); active = false; why = whyNot; return null; }
  if (renderer.xr?.isPresenting) { active = false; why = 'xr: the headset\'s eye pass draws plain'; return null; }
  if (built && (built.key !== key || built.scene !== scene || built.camera !== camera)) teardown();
  return () => draw(renderer, scene, camera, key);
}

/** Debug readout (EW.post): is the pipeline drawing, why not, the live strength. `_pipe`: the live objects, for tests. */
export const postDebug = () => ({
  active, why, bloom: bloomStrength, pref: bloomOn, built: !!built, passes: built?.key ?? '', builds, failed,
  target: built ? [built.scenePass.renderTarget.width, built.scenePass.renderTarget.height] : null,
  _pipe: built,
});
