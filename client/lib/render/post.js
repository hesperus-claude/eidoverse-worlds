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
import { pass, Fn, smoothstep, max, vec4, uniform } from 'three/tsl';
import { bloom as bloomNode } from 'three/addons/tsl/display/BloomNode.js';

export const BLOOM_PREF = 'ew-bloom';
export const BLOOM_MAX = 3;                         // the registry's range (componentspec sky.bloom)
// What feeds the bloom is Godot's glow first pass at its defaults (servers/rendering/renderer_rd/shaders/effects/copy.glsl):
// on the EXPOSED colour, feedback = smoothstep(threshold, threshold + knee, max(r, g, b)), then min(colour × feedback, cap).
// Godot multiplies by exposure first; three applies toneMappingExposure later, inside the tone curve of the pipeline's output
// pass, so the uniforms carry each value / exposure, set every frame (exposure() below): sky.exposure moves what blooms,
// as it does in Godot. Not a physical luminance (no nits).
// threshold 1 (glow_hdr_threshold), knee 2 (glow_hdr_scale). Render lab 11-02 saw lamp halos spread over whole shelves at
// radius 0.4 / threshold 1 on three's 0.01 knee, before exposure, and moved to 0.15 / 2; Godot's knee is far softer (a
// value of 1.5 feeds 16% of itself). radius 0.15 is ours (three's BloomNode radius, not a Godot field).
export const BLOOM_RADIUS = 0.15, BLOOM_THRESHOLD = 1, BLOOM_KNEE = 2;
// glow_hdr_luminance_cap at its default, per channel AFTER the threshold, so one specular firefly can't light a halo many
// times its size (lab 11-02: the armchair's highlight). A constant until a world needs another.
export const BLOOM_LUMINANCE_CAP = 12;
// the high pass BloomNode calls with its own threshold and smoothWidth uniforms (here: threshold / exposure and knee /
// exposure), and the cap / exposure uniform of this pipeline
const godotHighPass = (cap) => Fn(({ input, threshold, smoothWidth }) =>
  input.mul(smoothstep(threshold, threshold.add(smoothWidth), max(input.r, max(input.g, input.b)))).min(vec4(cap)));
// what three multiplies the scene colour by before its curve: toneMappingExposure, or nothing with no curve (ToneMappingNode)
const exposure = (r) => (r.toneMapping === THREE.NoToneMapping ? 1 : Math.max(r.toneMappingExposure ?? 1, 1e-4));
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
  const cap = uniform(BLOOM_LUMINANCE_CAP);
  glow.highPassFn = godotHighPass(cap);   // read when the node is set up, at its first frame
  pipe.outputNode = color.add(glow);
  builds++;
  built = { pipe, scenePass, glow, cap, scene, camera, key, frames: 0 };
}

function fail(e) {
  failed = String(e?.message ?? e).slice(0, 300);
  tee(`[post] the post pipeline failed, drawing plain for this page: ${failed}`);
  teardown();
}

// The renderer state a pipeline frame changes and puts back only when nothing throws (three's RenderPipeline.render and
// PassNode.updateBefore have no try/finally). Read before the frame; written back if it throws, so the fallback frame and
// every plain frame after it draw as main does.
const STATE = [
  ['target', (r) => r.getRenderTarget?.() ?? null, (r, v) => r.setRenderTarget?.(v)],
  ['toneMapping', (r) => r.toneMapping, (r, v) => { r.toneMapping = v; }],
  ['outputColorSpace', (r) => r.outputColorSpace, (r, v) => { r.outputColorSpace = v; }],
  ['xr', (r) => r.xr?.enabled, (r, v) => { if (r.xr) r.xr.enabled = v; }],
];
const snapshot = (renderer) => STATE.map(([, get]) => get(renderer));
const restore = (renderer, saved) => STATE.forEach(([, , set], i) => set(renderer, saved[i]));

function draw(renderer, scene, camera, key) {
  const saved = snapshot(renderer);
  try {
    if (!built) build(renderer, scene, camera, key);
    const b = built, device = renderer.backend?.device, e = exposure(renderer);
    b.glow.threshold.value = BLOOM_THRESHOLD / e; b.glow.smoothWidth.value = BLOOM_KNEE / e; b.cap.value = BLOOM_LUMINANCE_CAP / e;
    const watch = !!device?.pushErrorScope && b.frames++ < WATCH_FRAMES;
    if (watch) device.pushErrorScope('validation');
    try { b.pipe.render(); }
    finally { if (watch) device.popErrorScope().then((err) => { if (err && built === b) fail(err); }, () => {}); }
    active = true; why = null;
  } catch (e) {
    restore(renderer, saved);   // a pass that threw can leave its target bound and the output transform swapped
    fail(e);
    active = false; why = `failed: ${failed}`;
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
