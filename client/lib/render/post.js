// post — the passes after the scene: the post-processing pipeline (Godot's Environment glow and SSAO, Filament's View
// BloomOptions and AmbientOcclusionOptions). Two passes, each the world's look and each viewer's cost: bloom (sky.bloom:
// glow strength 0..3; ew-bloom on/off, default on) and ambient occlusion (sky.ao: Godot's ssao_intensity 0..3; ew-ao on/off,
// default off on WebGL 2 and on elsewhere); absent = none, every world's look before the fields. R: "the world owner should
// control *what* lighting, and the user should only control perf/quality of said lighting so they can run it".
//
// AO is GTAO (three's GTAONode, blurred) from a normal/depth pre-pass at half resolution, applied INSIDE lighting through a copy of three's
// builtinAOContext (aoContext below, which skips unlit materials): it feeds the material's ambientOcclusion, which only indirect light reads (indirect diffuse and
// specular), so direct light and its shadows are never darkened twice: Godot's ssao_light_affect 0, its default.
// One three RenderPipeline (TSL): [pre-pass → GTAO →] pass(scene, camera) [→ BloomNode] → the pipeline's output pass. three moves tone mapping
// and the output colour space into that output pass, so they are applied once, after bloom: the same place the plain
// path applies them (the renderer's own output pass after its framebuffer target).
//
// The plain path stays the plain path: with no pass asked for (sky.bloom absent or 0, or ew-bloom off) nothing is built
// and the frame is main's renderer.render(); losing the last pass disposes the pipeline and its targets. The scene pass
// and the bloom targets size themselves from the drawing buffer every frame (canvas resize, render scale). While an XR
// session presents the eye pass is the plain render; the pipeline is kept (not rebuilt) for the desktop after exit.
// A pipeline that fails (a throw building or drawing it; a WebGPU validation error in its first frames) is dropped for
// the rest of the page, the frame drawn plain, a clientlog line written; postDebug() says why. A reload tries again.
import { THREE, renderer as pageRenderer } from '../core.js';
import { tee } from '../base.js';
import { pass, mrt, normalView, screenUV, context, Fn, smoothstep, max, min, vec4, uniform, float, pow, clamp, texture } from 'three/tsl';
import { bloom as bloomNode } from 'three/addons/tsl/display/BloomNode.js';
import GTAONode from 'three/addons/tsl/display/GTAONode.js';
import { depthAwareBlur } from 'three/addons/tsl/display/depthAwareBlur.js';

export const BLOOM_PREF = 'ew-bloom', AO_PREF = 'ew-ao';
export const BLOOM_MAX = 3, AO_MAX = 3;              // the registry's ranges (componentspec sky.bloom, sky.ao)
// AO at Godot 4.6's defaults where three's GTAO has the same dial: ssao_radius 1.0 m, half resolution, and Godot's mapping
// from occlusion to what lighting reads (ssao.glsl): visibility = pow(clamp(1 - min(intensity × obscurance, 0.98), 0, 1),
// power), with obscurance = 1 - GTAO's own visibility (its scale held at 1), intensity the world's sky.ao (Godot's
// ssao_intensity, a linear multiplier, default 2) and power Godot's ssao_power default, 1.5. Then a separable depth-aware
// blur (three's depthAwareBlur, horizontal and vertical, at the AO's half resolution) for Godot's edge-aware blur passes.
// Godot applies its intensity and power before its blur; here they are applied after it, when the AO is read.
export const AO_RADIUS = 1, AO_RESOLUTION = 0.5, AO_POWER = 1.5, AO_CLAMP = 0.98, AO_BLUR = true;
// three's GTAONode with a separable depth-aware blur of its result, as three's SSAONode blurs its own (horizontal into a
// second target, vertical back into the AO target), so the result has no dither on smooth surfaces
class BlurredGTAONode extends GTAONode {
  constructor(depthNode, normalNode, camera) {
    super(depthNode, normalNode, camera);
    this.blur = AO_BLUR; this._blurCamera = camera;
    this._blurTarget = new THREE.RenderTarget(1, 1, { depthBuffer: false, format: THREE.RedFormat });
    this._blurTarget.texture.name = 'GTAO.Blur';
    this._blurInput = texture(this._aoRenderTarget.texture);
    this._blurStep = uniform(new THREE.Vector2());
    this._blurMaterial = new THREE.NodeMaterial(); this._blurMaterial.name = 'GTAO.Blur';
    this._blurQuad = new THREE.QuadMesh(this._blurMaterial); this._blurQuad.name = 'GTAO.Blur';
    this._blurState = undefined;   // RendererUtils makes one on first use (a null would be written into)
  }
  setSize(width, height) { super.setSize(width, height); this._blurTarget.setSize(this._aoRenderTarget.width, this._aoRenderTarget.height); }
  updateBefore(frame) {
    super.updateBefore(frame);
    if (!this.blur) return;
    const r = frame.renderer, w = this._aoRenderTarget.width, h = this._aoRenderTarget.height;
    this._blurState = THREE.RendererUtils.resetRendererState(r, this._blurState);
    try {
      r.setClearColor(0xffffff, 1);
      this._blurInput.value = this._aoRenderTarget.texture; this._blurStep.value.set(1 / w, 0);
      r.setRenderTarget(this._blurTarget); this._blurQuad.render(r);
      this._blurInput.value = this._blurTarget.texture; this._blurStep.value.set(0, 1 / h);
      r.setRenderTarget(this._aoRenderTarget); this._blurQuad.render(r);
    } finally { THREE.RendererUtils.restoreRendererState(r, this._blurState); }
  }
  setup(builder) {
    const out = super.setup(builder);
    this._blurMaterial.contextNode = context(builder.getSharedContext());
    this._blurMaterial.fragmentNode = depthAwareBlur(this._blurInput, this.depthNode, this._blurStep, this._blurCamera, 2, this.radius);
    this._blurMaterial.needsUpdate = true;
    return out;
  }
  dispose() { super.dispose(); this._blurTarget.dispose(); this._blurMaterial.dispose(); }
}

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
// three's builtinAOContext, less the unlit materials: BasicLightingModel multiplies its indirect term by ambientOcclusion,
// so a MeshBasic(Node)Material (pictures, texts, quads, screens, the sky dome) would be darkened by AO. Transparents are
// skipped as three skips them (they are not in the pre-pass's depth).
// (MeshBasicNodeMaterial carries isMeshBasicMaterial too: NodeMaterial copies the classic material's defaults, flag included)
const unlit = (m) => m?.isMeshBasicMaterial === true;
const aoContext = (aoNode) => context({
  getAO: (input, { material }) => (material?.transparent === true || unlit(material) ? input : input !== null ? input.mul(aoNode) : aoNode),
});
const WATCH_FRAMES = 3;                             // a new pipeline's first frames run inside a WebGPU error scope

const readPref = (key) => { try { return localStorage.getItem(key) !== 'off'; } catch { return true; } };
const writePref = (key, on) => { try { localStorage.setItem(key, on ? 'on' : 'off'); } catch { /* private mode */ } };
let bloomOn = readPref(BLOOM_PREF);
export const bloomPref = () => bloomOn;
export function setBloomPref(on) { bloomOn = !!on; writePref(BLOOM_PREF, on); }
// ew-ao: what this viewer chose ('on' | 'off'), or nothing. Unchosen, it is off on the WebGL 2 backend (every headset's,
// and the fallback where WebGPU is missing) and on elsewhere: the pre-pass draws the scene a second time, and WebGL 2's
// frame tracks draw calls (render lab, RTX 4080, 11-27). Read at each frame, so a WebGPU page that falls back at init
// gets the WebGL 2 default.
let aoChosen = (() => { try { const v = localStorage.getItem(AO_PREF); return v === 'on' || v === 'off' ? v : null; } catch { return null; } })();
export const aoDefault = (r = pageRenderer) => !r?.backend?.isWebGLBackend;
export const aoPref = (r = pageRenderer) => (aoChosen ? aoChosen === 'on' : aoDefault(r));
export function setAoPref(on) { aoChosen = on ? 'on' : 'off'; writePref(AO_PREF, on); }

const strengthOf = (s, max) => { const n = typeof s === 'number' ? s : NaN; return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };
let bloomStrength = 0, aoStrength = 0;
/** The world's glow strength (sky.js applyTuning, like its exposure). A live edit moves the uniform; nothing rebuilds. */
export function setBloom(s) { bloomStrength = strengthOf(s, BLOOM_MAX); if (built?.glow) built.glow.strength.value = bloomStrength; }
/** The world's ambient occlusion intensity (sky.js applyTuning; Godot's ssao_intensity). A live edit moves a uniform; nothing rebuilds. */
export function setAo(s) { aoStrength = strengthOf(s, AO_MAX); if (built?.aoIntensity) built.aoIntensity.value = aoStrength; }

let built = null;          // { pipe, scenePass, pre, occl, aoIntensity, glow, cap, scene, camera, key, frames }
let failed = null;         // why the pipeline was dropped for this page
let builds = 0, active = false, why = 'no pass asked: the world sets no sky.bloom or sky.ao';

// the passes this frame asks for ('' = none, else 'bloom', 'ao' or 'ao+bloom'), or why none
function wanted(renderer) {
  const aoOn = aoPref(renderer);
  if (failed) return ['', `failed: ${failed}`];
  const bloomAsked = bloomStrength > 0, aoAsked = aoStrength > 0;
  if (!bloomAsked && !aoAsked) return ['', 'no pass asked: the world sets no sky.bloom or sky.ao'];
  const key = [aoAsked && aoOn && 'ao', bloomAsked && bloomOn && 'bloom'].filter(Boolean).join('+');
  if (!key) return ['', `off: this viewer's ${[bloomAsked && 'ew-bloom', aoAsked && (aoChosen ? 'ew-ao' : 'ew-ao (off by default on WebGL 2)')].filter(Boolean).join(' and ')}`];
  return [key, null];
}

// What the AO pre-pass draws: surfaces that write depth. Not lines or points (GridHelper, LineSegments, gizmo lines), sprites,
// a mesh whose material writes no depth (sky domes, overlay gizmos: in a depth/normal buffer it would paint normals over
// the depth of what is behind it), or anything marked userData.noPrePass (sky.js marks the sky it owns). Each skipped
// object is one draw call and one program variant the pre-pass no longer pays for.
export const inPrePass = (o, m) => !!o?.isMesh && !o.isLine2 && !o.isLineSegments2 && !o.isSprite && m?.depthWrite !== false && o.userData?.noPrePass !== true;
// the renderer's per-object hook (three Renderer.setRenderObjectFunction), for the pre-pass's own draw only: a shadow map
// drawn inside it installs and restores its own
const prePassObjects = (renderer, prev) => function (object, scene, camera, geometry, material, ...rest) {
  if (!inPrePass(object, material)) return;
  return prev ? prev.call(renderer, object, scene, camera, geometry, material, ...rest) : renderer.renderObject(object, scene, camera, geometry, material, ...rest);
};
function filterPrePass(pre) {
  const up = pre.updateBefore.bind(pre);
  pre.updateBefore = (frame) => {
    const r = frame.renderer, prev = r.getRenderObjectFunction();
    r.setRenderObjectFunction(prePassObjects(r, prev));
    try { return up(frame); } finally { r.setRenderObjectFunction(prev); }
  };
}

function teardown() {
  const b = built; built = null;
  if (!b) return;
  b.pipe.dispose(); b.glow?.dispose(); b.occl?.dispose(); b.pre?.dispose(); b.scenePass.dispose();
}

function build(renderer, scene, camera, key) {
  const pipe = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  // the world's own pass for syncgate: a WebGL link met here defers a frame, as it does on the plain frame's canvas pass
  scenePass.renderTarget.isWorldPass = true;
  let pre = null, occl = null, glow = null, aoIntensity = null;
  if (key.includes('ao')) {
    // samples 0: GTAO gathers depth, and a multisampled depth texture can't be gathered (lab 11-06: WGSL validation
    // failed and the page hung at msaa=1). Opaque only, as three's GTAO example and Godot's depth pre-pass draw it.
    pre = pass(scene, camera, { samples: 0 });
    pre.renderTarget.isWorldPass = true;
    pre.transparent = false;
    pre.setMRT(mrt({ output: normalView }));
    filterPrePass(pre);
    occl = new BlurredGTAONode(pre.getTextureNode('depth'), pre.getTextureNode(), camera);
    occl.resolutionScale = AO_RESOLUTION; occl.radius.value = AO_RADIUS; occl.scale.value = 1;
    aoIntensity = uniform(aoStrength);
    const obscurance = float(1).sub(occl.getTextureNode().sample(screenUV).r);
    scenePass.contextNode = aoContext(pow(clamp(float(1).sub(min(aoIntensity.mul(obscurance), AO_CLAMP)), 0, 1), AO_POWER));
  }
  const color = scenePass.getTextureNode('output');
  let cap = null;
  if (key.includes('bloom')) {
    glow = bloomNode(color, bloomStrength, BLOOM_RADIUS, BLOOM_THRESHOLD);
    cap = uniform(BLOOM_LUMINANCE_CAP);
    glow.highPassFn = godotHighPass(cap);   // read when the node is set up, at its first frame
    pipe.outputNode = color.add(glow);
  } else pipe.outputNode = color;
  builds++;
  built = { pipe, scenePass, pre, occl, aoIntensity, glow, cap, scene, camera, key, frames: 0 };
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
  // what a pass sets around its draw (PassNode.updateBefore): the AO pre-pass's MRT, the scene pass's AO context, the
  // pre-pass's transparent = false, and the flags beside them
  ['mrt', (r) => r.getMRT?.() ?? null, (r, v) => r.setMRT?.(v)],
  ['contextNode', (r) => r.contextNode, (r, v) => { r.contextNode = v; }],
  ...['transparent', 'opaque', 'lighting', 'autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil'].map((k) => [k, (r) => r[k], (r, v) => { r[k] = v; }]),
];
// …and on the camera and scene the pass drew (its layers, the scene's override material)
const snapshot = (renderer, scene, camera) => [...STATE.map(([, get]) => get(renderer)), camera?.layers?.mask, scene?.overrideMaterial];
const restore = (renderer, scene, camera, saved) => {
  STATE.forEach(([, , set], i) => set(renderer, saved[i]));
  if (camera?.layers) camera.layers.mask = saved[STATE.length];
  if (scene) scene.overrideMaterial = saved[STATE.length + 1];
};

function draw(renderer, scene, camera, key) {
  const saved = snapshot(renderer, scene, camera);
  try {
    if (!built) build(renderer, scene, camera, key);
    const b = built, device = renderer.backend?.device, e = exposure(renderer);
    if (b.glow) { b.glow.threshold.value = BLOOM_THRESHOLD / e; b.glow.smoothWidth.value = BLOOM_KNEE / e; b.cap.value = BLOOM_LUMINANCE_CAP / e; }
    const watch = !!device?.pushErrorScope && b.frames++ < WATCH_FRAMES;
    if (watch) device.pushErrorScope('validation');
    try { b.pipe.render(); }
    finally { if (watch) device.popErrorScope().then((err) => { if (err && built === b) fail(err); }, () => {}); }
    active = true; why = null;
  } catch (e) {
    restore(renderer, scene, camera, saved);   // a pass that threw can leave its target bound and the output transform swapped
    fail(e);
    active = false; why = `failed: ${failed}`;
    renderer.render(scene, camera);
  }
}

/** The live frame's main pass through the pipeline, or null for main's plain renderer.render (render.js renderWorld,
 *  through DrawBatches.render's `draw`). Builds, keeps or disposes the pipeline as the world and viewer ask. */
export function postPass(renderer, scene, camera) {
  const [key, whyNot] = wanted(renderer);
  if (!key) { teardown(); active = false; why = whyNot; return null; }
  if (renderer.xr?.isPresenting) { active = false; why = 'xr: the headset\'s eye pass draws plain'; return null; }
  if (built && (built.key !== key || built.scene !== scene || built.camera !== camera)) teardown();
  return () => draw(renderer, scene, camera, key);
}

/** Debug readout (EW.post): is the pipeline drawing, why not, the live strength. `_pipe`: the live objects, for tests. */
export const postDebug = () => ({
  active, why, bloom: bloomStrength, pref: bloomOn, ao: aoStrength, aoPref: aoPref(), aoChosen, built: !!built, passes: built?.key ?? '', builds, failed,
  target: built ? [built.scenePass.renderTarget.width, built.scenePass.renderTarget.height] : null,
  _pipe: built,
});
