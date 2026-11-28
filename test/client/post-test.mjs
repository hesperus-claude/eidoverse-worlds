// post-test — the post-processing pipeline (client/lib/render/post.js) as the live frame meets it: the REAL render.js
// renderWorld, the REAL draw_batches.js and post.js, real three r186 node objects (RenderPipeline, pass, BloomNode),
// and a recording renderer in place of the GPU. What a pipeline DRAWS is not visible here (no GPU): the picture is
// post-pixels' (a real headless browser on both backends). What is pinned here is the shape of every frame:
//   · sky.bloom absent / 0 / junk, or the viewer's ew-bloom off: the frame is main's renderer.render(scene, camera), and
//     no pipeline is built (none constructed, nothing held)
//   · a world that sets it: one pipeline, the world's strength in its BloomNode, a live edit changes the uniform and
//     builds nothing; back to none disposes the pipeline and its targets
//   · an XR session draws plain and keeps the pipeline for the desktop after it
//   · tone mapping and the output colour space are applied once, in the pipeline's output pass (the renderer's own
//     output transform is off while the pipeline's quad draws)
//   · a pipeline that throws, or whose first frame raises a WebGPU validation error, is dropped and the frame drawn plain;
//     postDebug() says why
//   · on WebGL, the pipeline's scene pass is the world's own pass for syncgate (its links defer, as the plain frame's do)
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/post-test.mjs
// Mutations (each must go red, run by hand): build on strength 0 (P1); ignore ew-bloom (P1c); rebuild on a strength edit
// (P2b); keep the pipeline at strength 0 (P2c); XR through the pipeline (P3); dispose on XR (P3b); batching off bypasses
// the pipeline (P4); outputColorTransform false (P2t); no fallback on a throw (P6); the renderer's state not put back after a throw (P6d, P6e);
// error scope ignored (P6b); a stale scope
// fails the newer pipeline (P6c); a scene or camera change keeps the old pipeline (P10); world-pass mark dropped (P7).
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });
const S = suite("post");
const check = (n, ok, d) => S.check(n, ok, d);
const lib = (f) => fileURLToPath(new URL(`../../client/lib/${f}`, import.meta.url));
// the client's own three (the root install is a second copy): the nodes post.js builds and the pipeline class below
// must be one instance
const THREE_RAW = await import('../../client/node_modules/three/build/three.webgpu.js');

// RenderPipeline counted: "no pipeline is built" is a constructor that never ran
let pipelinesMade = 0;
class RenderPipeline extends THREE_RAW.RenderPipeline { constructor(...a) { super(...a); pipelinesMade++; } }
const THREE = { ...THREE_RAW, RenderPipeline };

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
let bound = null, throwOnQuad = null;
const draws = [];
const device = { scopes: 0, nextError: null, pushErrorScope() { this.scopes++; }, popErrorScope() { this.scopes--; const e = this.nextError; this.nextError = null; return Promise.resolve(e); } };
const passState = (r, sc, cam) => ({ mrt: r._mrt, ctx: r.contextNode, transparent: r.transparent, opaque: r.opaque, lighting: r.lighting,
  autoClear: [r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil], layers: camera.layers.mask, override: scene.overrideMaterial });
const renderer = {
  backend: { isWebGPUBackend: true, device },
  xr: { enabled: false, isPresenting: false, updateCamera() {}, getCamera: () => null },
  toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1,
  info: { render: { drawCalls: 0, triangles: 0, points: 0, lines: 0, calls: 0 } },
  getRenderTarget: () => bound, setRenderTarget(t) { bound = t; },
  // the rest of the state a pass sets around its draw (three PassNode.updateBefore) and puts back only if nothing throws
  _mrt: null, getMRT() { return this._mrt; }, setMRT(m) { this._mrt = m; }, contextNode: { ctx: 'the renderer\'s own' },
  transparent: true, opaque: true, lighting: true, autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
  render(sc, cam) {
    draws.push({ sc, cam, toneMapping: this.toneMapping, colorSpace: this.outputColorSpace, xr: this.xr.enabled, pass: passState(this, sc, cam) });
    if (sc?.isQuadMesh && sc.name === 'Render Pipeline' && throwOnQuad) {
      // a throw inside a nested pass (the AO pre-pass's MRT, the scene pass's AO context): its state is left as it set it
      const e = throwOnQuad; throwOnQuad = null; bound = { stale: true };
      this._mrt = { stale: 'mrt' }; this.contextNode = { stale: 'ao context' }; this.transparent = false; this.opaque = false; this.lighting = false;
      this.autoClear = this.autoClearColor = this.autoClearDepth = this.autoClearStencil = false;
      camera.layers.mask = 0x4; scene.overrideMaterial = { stale: 'override' };
      throw e;
    }
  },
  compileAsync: async () => {},
};
const tees = [];
let params = new URLSearchParams('');
mock.module(lib('core.js'), () => ({ THREE, TSL: {}, scene, renderer, camera }));
mock.module(lib('base.js'), () => ({ bus: { on() {}, emit() {} }, tee: (l) => tees.push(String(l)), teeNow: (l) => tees.push(String(l)), report() {}, CONFIG: { get params() { return params; } } }));
mock.module(lib('render/warmqueue.js'), () => ({ warm: async (_n, fn) => fn(), warmDepth: async () => {}, P_AMBIENT: 2 }));
mock.module(lib('debug/gputime.js'), () => ({ gpuBegin() {}, gpuEnd() {} }));
mock.module(lib('xr/quadcolour.js'), () => ({ quadMaterial() {} }));

let post = {}, R = {}, imported = null;
try { post = await import(lib('render/post.js')); } catch (e) { imported = `post.js: ${e?.message ?? e}`; }
try { R = await import(lib('render/render.js')); } catch (e) { imported = (imported ? imported + '; ' : '') + `render.js: ${e?.message ?? e}`; }
check('P0 post.js and render.js import headless', !imported, imported);

// one live frame through renderWorld; what reached the renderer
const frame = () => { draws.length = 0; try { R.renderWorld?.(); } catch (e) { draws.push({ threw: e?.message ?? String(e) }); } return draws.slice(); };
const plain = (d) => d.length === 1 && d[0].sc === scene && d[0].cam === camera;
const viaPipe = (d) => d.length >= 1 && d.every((x) => x.sc?.isQuadMesh && x.sc.name === 'Render Pipeline') && !d.some((x) => x.sc === scene);
// the readout without its live objects: a row's detail goes through JSON.stringify (suite.ts), and _pipe is cyclic (a
// failing row that carried it threw inside the reporter, and every row after it went unrun)
const dbg = () => { try { const { _pipe, ...r } = post.postDebug(); return r; } catch (e) { return { error: e?.message ?? String(e) }; } };
const live = () => { try { return post.postDebug()._pipe ?? null; } catch { return null; } };
const show = (d) => d.map((x) => x.threw ? `threw ${x.threw}` : x.sc === scene ? 'scene' : x.sc?.name ?? x.sc?.type ?? '?');
const setBloom = (s) => { try { post.setBloom(s); } catch (e) { return e; } };
const setPref = (on) => { try { post.setBloomPref(on); } catch (e) { return e; } };

if (process.argv.includes('--case')) {
  const rows = [];
  const row = (n, ok, d) => rows.push([n, !!ok, d]);
  const ctx0 = renderer.contextNode, layers0 = camera.layers.mask;
  setBloom(1); renderer.xr.enabled = true; frame();   // xr.enabled true: a page with a headset attached, not presenting
  throwOnQuad = new Error('simulated: the output pass failed');
  const d = frame();
  row('P6 the pipeline throws mid-frame: that same frame is drawn plain (renderer.render(scene, camera) after it)', d.some((x) => x.sc === scene && x.cam === camera) && !d.some((x) => x.threw), show(d));
  row('P6 …into the canvas: the target the failed pass left bound is unbound first', bound === null, String(bound));
  row('P6 …the readout: not active, failed, with the message; a clientlog line said it', dbg().active === false && /fail/i.test(String(dbg().why)) && /output pass failed/.test(String(dbg().why)) && tees.some((l) => /post/.test(l) && /output pass failed/.test(l)), { why: dbg().why, tees });
  // the pipeline swaps the renderer's output transform and xr.enabled around its quad (three RenderPipeline.render, no
  // try/finally): a throw there must not leave them swapped, or the fallback and every later plain frame are drawn wrong
  { const fb = d.find((x) => x.sc === scene);
    row('P6d the fallback frame is drawn with the renderer\'s tone curve and colour space (not the ones the pipeline swapped in)', fb?.toneMapping === THREE.ACESFilmicToneMapping && fb?.colorSpace === THREE.SRGBColorSpace, [fb?.toneMapping, fb?.colorSpace]);
    row('P6d …and xr.enabled as it was before the frame (true) while it draws', fb?.xr === true, fb?.xr);
    row('P6d …and the renderer keeps all three after it', renderer.toneMapping === THREE.ACESFilmicToneMapping && renderer.outputColorSpace === THREE.SRGBColorSpace && renderer.xr.enabled === true, [renderer.toneMapping, renderer.outputColorSpace, renderer.xr.enabled]); }
  // …and the rest of a pass's state (PassNode.updateBefore: MRT, contextNode, the opaque/transparent, lighting and autoClear
  // flags, the camera's layers, the scene's override material), which a throw inside the AO pre-pass or the scene pass leaves
  { const fb = d.find((x) => x.sc === scene)?.pass, now = passState(renderer), want = { mrt: null, ctx: ctx0, transparent: true, opaque: true, lighting: true, autoClear: [true, true, true, true], layers: layers0, override: null };
    const same = (x) => !!x && Object.keys(want).every((k) => JSON.stringify(x[k]) === JSON.stringify(want[k]) && (k !== 'ctx' || x.ctx === ctx0));
    const show2 = (x) => x && { ...x, ctx: x.ctx === ctx0 ? 'own' : x.ctx };
    row('P6e the fallback frame is drawn with no MRT, the renderer\'s own contextNode, opaque, transparent, lighting and autoClear on, the camera\'s layers and no override material', same(fb), show2(fb));
    row('P6e …and the renderer, camera and scene keep them after it', same(now), show2(now)); }
  const made = pipelinesMade, d2 = frame();
  row('P6 …later frames are plain and build nothing (dropped for this page)', plain(d2) && pipelinesMade === made && !live(), { d: show(d2), pipelinesMade });
  setBloom(2); const d3 = frame();
  row('P6 …a sky edit after the failure builds nothing either', plain(d3) && pipelinesMade === made, show(d3));
  console.log('CASE ' + JSON.stringify({ rows }));
  process.exit(0);
}

console.log('ABSENT — every existing world: main\'s plain frame, no pipeline');
{
  let d = frame();
  check('P1 sky.bloom absent (the boot value): the frame is renderer.render(scene, camera), once', plain(d), show(d));
  check('P1 …and no pipeline was built', pipelinesMade === 0 && !live(), { pipelinesMade, built: !!live() });
  for (const v of [undefined, null, 0, -1, NaN, 'x', '0']) {
    setBloom(1); setBloom(v); d = frame();
    check(`P1b sky.bloom ${JSON.stringify(v) ?? 'undefined'} reads as none: plain, nothing built`, plain(d) && pipelinesMade === 0 && dbg().bloom === 0, { d: show(d), pipelinesMade, bloom: dbg().bloom });
  }
  const r = dbg();
  check('P1d the readout says no pipeline, and why (the world asks for none)', r.active === false && /no pass|none|absent/i.test(String(r.why)), r);
}

console.log('PREF — ew-bloom off: the viewer pays nothing, whatever the world asks');
{
  localStorage.clear();
  check('P1e ew-bloom defaults on (absent in storage)', post.bloomPref?.() === true, post.bloomPref?.());
  setPref(false); setBloom(1.5);
  check('P1e …setBloomPref(false) stores off', localStorage.getItem('ew-bloom') === 'off', localStorage.getItem('ew-bloom'));
  const d = frame();
  check('P1c sky.bloom 1.5 with ew-bloom off: plain, nothing built', plain(d) && pipelinesMade === 0, { d: show(d), pipelinesMade });
  check('P1c …the readout names the viewer\'s setting', dbg().active === false && /ew-bloom/.test(String(dbg().why)) && dbg().bloom === 1.5 && dbg().pref === false, dbg());
  setPref(true);
}

console.log('WORLD — a world that sets it gets a pipeline with its strength');
{
  setBloom(1.2);
  let d = frame();
  check('P2 sky.bloom 1.2: the frame goes through one RenderPipeline (its output quad), not a bare scene render', viaPipe(d) && pipelinesMade === 1, { d: show(d), pipelinesMade });
  const p = live();
  check('P2 …the pipeline\'s scene pass draws the live scene through the live camera', p?.scenePass?.isPassNode && p.scenePass.scene === scene && p.scenePass.camera === camera, p && Object.keys(p));
  check('P2 …its BloomNode holds the world\'s strength, radius 0.15 and, at exposure 1, threshold 1 (Godot glow_hdr_threshold)', p?.glow && Math.abs(p.glow.strength.value - 1.2) < 1e-9 && Math.abs(p.glow.radius.value - 0.15) < 1e-9 && Math.abs(p.glow.threshold.value - 1) < 1e-9,
    p?.glow && [p.glow.strength.value, p.glow.radius.value, p.glow.threshold.value]);
  check('P2 …the readout: active, the live strength, no reason', dbg().active === true && dbg().bloom === 1.2 && dbg().why == null, dbg());
  check('P2t tone mapping and colour space once, after bloom: the pipeline\'s output transform is on, with the renderer\'s curve', p?.pipe?.outputColorTransform === true && p.pipe._toneMapping === THREE.ACESFilmicToneMapping && p.pipe._outputColorSpace === THREE.SRGBColorSpace,
    p?.pipe && [p.pipe.outputColorTransform, p.pipe._toneMapping, p.pipe._outputColorSpace]);
  check('P2t …and the renderer\'s own output transform is off while the quad draws (not applied twice)', d.length > 0 && d.every((x) => x.toneMapping === THREE.NoToneMapping && x.colorSpace === THREE.ColorManagement.workingColorSpace), d.map((x) => [x.toneMapping, x.colorSpace]));
  check('P2t …and put back after (the plain paths that follow keep ACES / sRGB)', renderer.toneMapping === THREE.ACESFilmicToneMapping && renderer.outputColorSpace === THREE.SRGBColorSpace);

  setBloom(2.5); d = frame();
  check('P2b a live sky edit 1.2 → 2.5 changes the uniform and builds nothing', viaPipe(d) && pipelinesMade === 1 && live() === p && Math.abs(p.glow.strength.value - 2.5) < 1e-9, { pipelinesMade, same: live() === p, s: p?.glow?.strength.value });
  setBloom(7); frame();
  check('P2b …above 3 is held at 3 (the registry\'s range; a stale log can carry more)', dbg().bloom === 3 && Math.abs(p.glow.strength.value - 3) < 1e-9, dbg().bloom);

  const disposed = [];
  p?.scenePass?.renderTarget?.addEventListener('dispose', () => disposed.push('scene'));
  p?.glow?._renderTargetBright?.addEventListener('dispose', () => disposed.push('bright'));
  setBloom(0); d = frame();
  check('P2c back to none: the frame is plain again', plain(d), show(d));
  check('P2c …and the pipeline is gone, its scene target and bloom targets disposed', !live() && disposed.includes('scene') && disposed.includes('bright'), { built: !!live(), disposed });

  setBloom(1); frame();
  check('P2d none → 1 again builds one new pipeline', pipelinesMade === 2 && !!live(), pipelinesMade);
  const p2 = live(); let gone = false; p2?.scenePass?.renderTarget?.addEventListener('dispose', () => { gone = true; });
  setPref(false); d = frame();
  check('P2d ew-bloom switched off live: plain at once, the pipeline disposed', plain(d) && !live() && gone, { d: show(d), built: !!live(), gone });
  setPref(true); d = frame();
  check('P2d …and on again: through a new pipeline, the strength kept', viaPipe(d) && pipelinesMade === 3 && Math.abs(live()?.glow?.strength.value - 1) < 1e-9, { pipelinesMade });
}

console.log('CAP — Godot\'s glow first pass: threshold, knee and cap on the exposed colour');
{
  setBloom(1); frame();
  const p = live();
  const { bloom: bloomNode } = await import('../../client/node_modules/three/examples/jsm/tsl/display/BloomNode.js');
  const { vec4 } = await import('../../client/node_modules/three/build/three.tsl.js');
  const stockNode = bloomNode(vec4(0), 1, 0, 0), stock = stockNode.highPassFn; stockNode.dispose();
  check('P9 Godot\'s glow defaults, named: threshold 1 (glow_hdr_threshold), knee 2 (glow_hdr_scale), cap 12 (glow_hdr_luminance_cap)', post.BLOOM_THRESHOLD === 1 && post.BLOOM_KNEE === 2 && post.BLOOM_LUMINANCE_CAP === 12, [post.BLOOM_THRESHOLD, post.BLOOM_KNEE, post.BLOOM_LUMINANCE_CAP]);
  // Godot compares and caps the EXPOSED colour (copy.glsl: color *= glow_exposure, then the threshold and the cap); three
  // applies exposure later, in the output pass's tone curve, so the uniforms carry each value / exposure, every frame
  const at = (e, tm = THREE.ACESFilmicToneMapping) => { renderer.toneMappingExposure = e; renderer.toneMapping = tm; frame(); const g = live()?.glow, c = live()?.cap;
    return g && c ? [g.threshold.value, g.smoothWidth.value, c.value].map((v) => Math.round(v * 1e6) / 1e6) : null; };
  const made = pipelinesMade, e2 = at(2), eHalf = at(0.5), none = at(2, THREE.NoToneMapping), e1 = at(1);
  renderer.toneMappingExposure = 1; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const eq = (a, b) => !!a && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  check('P9b threshold, knee and cap apply after exposure: at exposure 2 the uniforms read 0.5 / 1 / 6, at 0.5 they read 2 / 4 / 24, at 1 they read 1 / 2 / 12', eq(e2, [0.5, 1, 6]) && eq(eHalf, [2, 4, 24]) && eq(e1, [1, 2, 12]), { e2, eHalf, e1 });
  check('P9b …with no tone curve three applies no exposure, so neither do they (1 / 2 / 12 at exposure 2)', eq(none, [1, 2, 12]), none);
  check('P9b …an exposure edit moves uniforms and builds nothing', live() === p && pipelinesMade === made, { same: live() === p, built: pipelinesMade - made });
  check('P9 …and the live BloomNode\'s high pass is ours (capped), not three\'s stock one', !!p?.glow && typeof p.glow.highPassFn === 'function' && p.glow.highPassFn !== stock, typeof p?.glow?.highPassFn);
}

console.log('REBUILDS — exactly which changes build a pipeline (review 11-25: structure changes are rare, strength is a uniform)');
{
  setBloom(0); frame(); setBloom(1); frame();
  const steps = [
    ['strength 1 → 2.5', () => setBloom(2.5), 0],
    ['strength 2.5 → 3 (held)', () => setBloom(9), 0],
    ['XR in and out', () => { renderer.xr.isPresenting = true; frame(); renderer.xr.isPresenting = false; }, 0],
    ['batching off and on', () => { R.setDrawBatching?.(false); frame(); R.setDrawBatching?.(true); }, 0],
    ['the world loses bloom and gains it again', () => { setBloom(0); frame(); setBloom(1); }, 1],
    ['the viewer switches ew-bloom off and on', () => { setPref(false); frame(); setPref(true); }, 1],
  ];
  const got = steps.map(([name, act, want]) => { const n = pipelinesMade; act(); frame(); return [name, pipelinesMade - n, want]; });
  check('P8 a strength edit, XR and batching build nothing; a world gaining bloom or the viewer\'s switch builds exactly one', got.every(([, n, want]) => n === want), got);
}

console.log('XR — the eye pass is plain; the pipeline waits for the desktop');
{
  setBloom(1); frame();
  const p = live(), made = pipelinesMade; let gone = false;
  p?.scenePass?.renderTarget?.addEventListener('dispose', () => { gone = true; });
  renderer.xr.isPresenting = true;
  const d = frame();
  check('P3 presenting: renderWorld draws the scene with renderer.render (three\'s XR eye pass), not the pipeline', plain(d), show(d));
  check('P3 …the readout says the headset is why', dbg().active === false && /xr|headset/i.test(String(dbg().why)), dbg());
  check('P3b entering XR keeps the pipeline (not disposed, not rebuilt)', live() === p && !gone && pipelinesMade === made, { same: live() === p, gone, pipelinesMade });
  renderer.xr.isPresenting = false;
  const d2 = frame();
  check('P3b leaving XR: the next desktop frame is through the SAME pipeline, nothing rebuilt', viaPipe(d2) && live() === p && pipelinesMade === made, { d: show(d2), pipelinesMade });
  setBloom(2); renderer.xr.isPresenting = true; frame(); renderer.xr.isPresenting = false;
  check('P3c a sky edit while presenting reaches the pipeline\'s uniform for the desktop after', Math.abs(live()?.glow?.strength.value - 2) < 1e-9, live()?.glow?.strength.value);
}

console.log('BATCHING — ?batching=0 bypasses the draw batches, not the pipeline');
{
  // render.js reads ?batching at import; setDrawBatching is its live switch
  R.setDrawBatching?.(false);
  setBloom(1); const d = frame();
  check('P4 batching off, sky.bloom 1: still through the pipeline', viaPipe(d), show(d));
  R.setDrawBatching?.(true);
}

console.log('GPU LOST — nothing draws, nothing is built');
{
  setBloom(0); frame(); const made = pipelinesMade;
  globalThis.__gpuLost = { fired: true };
  setBloom(1); const d = frame();
  check('P5 a lost GPU: renderWorld draws nothing and builds no pipeline', d.length === 0 && pipelinesMade === made && !live(), { d: show(d), pipelinesMade });
  delete globalThis.__gpuLost;
}

console.log('AO — sky.ao, the world\'s ambient occlusion: a normal/depth pre-pass, GTAO, applied to indirect light only');
{
  const setAo = (s) => { try { post.setAo(s); } catch (e) { return e; } };
  const setAoPref = (on) => { try { post.setAoPref(on); } catch (e) { return e; } };
  setBloom(0); setAo(0); frame(); localStorage.removeItem('ew-ao');
  check('A0 ew-ao defaults on (absent in storage)', post.aoPref?.() === true, post.aoPref?.());
  setBloom(1); frame();
  let p = live();
  check('A1 sky.ao absent with bloom on: no pre-pass, no AO node, the scene pass carries no AO context', !!p && !p.pre && !p.occl && p.scenePass.contextNode == null, p && { pre: !!p.pre, occl: !!p.occl, ctx: !!p.scenePass.contextNode });
  setBloom(0);
  for (const v of [undefined, null, 0, -2, NaN, 'x']) {
    setAo(1); setAo(v); const d = frame();
    check(`A1b sky.ao ${JSON.stringify(v) ?? 'undefined'} reads as none: plain, nothing built`, plain(d) && !live() && dbg().ao === 0, { d: show(d), ao: dbg().ao });
  }
  setAoPref(false); setAo(1.5); let d = frame();
  check('A1c sky.ao 1.5 with ew-ao off: plain, nothing built; the readout names the viewer\'s setting', plain(d) && !live() && /ew-ao/.test(String(dbg().why)) && dbg().ao === 1.5, { d: show(d), why: dbg().why });
  check('A1c …setAoPref(false) stores off', localStorage.getItem('ew-ao') === 'off', localStorage.getItem('ew-ao'));
  setAoPref(true);
  const made0 = pipelinesMade; d = frame(); p = live();
  check('A2 sky.ao 1.5 (no bloom): one pipeline, through its output quad', viaPipe(d) && pipelinesMade === made0 + 1 && !!p, { d: show(d), made: pipelinesMade - made0 });
  check('A2 …a pre-pass of the live scene through the live camera, without MSAA (GTAO gathers depth; a multisampled depth hung the page, lab 11-06)',
    p?.pre?.isPassNode && p.pre.scene === scene && p.pre.camera === camera && p.pre.options?.samples === 0 && p.pre.renderTarget.samples === 0, p?.pre && { samples: p.pre.options?.samples, rt: p.pre.renderTarget.samples });
  check('A2 …its MRT writes the view normal as its output, and it draws opaque only (three\'s GTAO example: prePass.transparent = false)', !!p?.pre?._mrt?.has?.('output') && p.pre.transparent === false, p?.pre && { mrt: [...(p.pre._mrt?.outputNodes ? Object.keys(p.pre._mrt.outputNodes) : [])], transparent: p.pre.transparent });
  check('A2 …GTAO reads the pre-pass\'s depth and normal: strength 1.5 as its scale (an exponent on visibility), radius 0.5 m, half resolution',
    !!p?.occl && Math.abs(p.occl.scale.value - 1.5) < 1e-9 && Math.abs(p.occl.radius.value - 0.5) < 1e-9 && p.occl.resolutionScale === 0.5 && p.occl.depthNode?.value === p.pre.renderTarget.depthTexture,
    p?.occl && [p.occl.scale.value, p.occl.radius.value, p.occl.resolutionScale]);
  const ctx = p?.scenePass?.contextNode?.getFlowContextData?.() ?? p?.scenePass?.contextNode?.value;
  check('A2 …and the scene pass carries the AO into lighting (three\'s builtinAOContext: getAO, the ambientOcclusion that only indirect light reads)', typeof ctx?.getAO === 'function', ctx && Object.keys(ctx));
  {
    // three's BasicLightingModel multiplies its indirect term by the material's ambientOcclusion, so an unlit material
    // (pictures, texts, quads, screens, the sky dome) would be darkened by AO; three's own context already skips transparents
    const getAO = ctx?.getAO, ask = (m) => { try { return getAO?.(null, { material: m }); } catch (e) { return 'threw ' + e?.message; } };
    const lit = ask(new THREE.MeshStandardNodeMaterial()), unlitNode = ask(new THREE.MeshBasicNodeMaterial()), unlitClassic = ask(new THREE.MeshBasicMaterial()), glass = ask(new THREE.MeshStandardNodeMaterial({ transparent: true }));
    check('AU1 the AO context darkens a lit material (MeshStandardNodeMaterial: an AO node)', !!lit?.isNode, typeof lit);
    check('AU1 …and leaves unlit ones alone: MeshBasicNodeMaterial and MeshBasicMaterial get no AO (the input, null), as a transparent one does', unlitNode === null && unlitClassic === null && glass === null, [unlitNode, unlitClassic, glass].map((x) => x === null ? 'null' : typeof x));
  }
  check('A2 …no bloom asked: the output is the scene pass\'s colour, no BloomNode', !p?.glow, !!p?.glow);
  check('A2 …the readout: active, the live AO strength', dbg().active === true && dbg().ao === 1.5 && dbg().why == null, dbg());
  setAo(2.5); frame();
  check('A2b a live sky edit 1.5 → 2.5 moves the scale uniform and builds nothing', live() === p && Math.abs(p.occl.scale.value - 2.5) < 1e-9 && pipelinesMade === made0 + 1, { same: live() === p, s: p?.occl?.scale.value });
  setAo(9); frame();
  check('A2b …above 3 is held at 3', dbg().ao === 3 && Math.abs(p.occl.scale.value - 3) < 1e-9, dbg().ao);
  const m1 = pipelinesMade; setBloom(1); frame(); const pb = live();
  check('A2c bloom joins: one rebuild, the new pipeline carries both (pre-pass, AO, BloomNode)', pipelinesMade === m1 + 1 && !!pb?.pre && !!pb?.occl && !!pb?.glow && pb.glow.inputNode?.value === pb.scenePass.renderTarget.texture, { made: pipelinesMade - m1 });
  const disposed = [];
  pb?.pre?.renderTarget?.addEventListener('dispose', () => disposed.push('pre'));
  const occlRt = pb?.occl?._aoRenderTarget ?? pb?.occl?.renderTarget ?? null; occlRt?.addEventListener?.('dispose', () => disposed.push('ao'));
  const m2 = pipelinesMade; setAo(0); frame(); const po = live();
  check('A2d AO leaves a blooming world: one rebuild, no pre-pass or AO node left, the scene pass has no AO context', pipelinesMade === m2 + 1 && !!po && !po.pre && !po.occl && po.scenePass.contextNode == null, po && { made: pipelinesMade - m2, pre: !!po.pre });
  check('A2d …the pre-pass and AO targets are disposed', disposed.includes('pre') && (!occlRt || disposed.includes('ao')), { disposed, occlRt: !!occlRt });
  setBloom(0); setAo(1); frame(); const pa = live(), m3 = pipelinesMade;
  renderer.xr.isPresenting = true; d = frame(); renderer.xr.isPresenting = false;
  check('A3 presenting: the eye pass is plain, with AO too; the pipeline kept, nothing rebuilt', plain(d) && live() === pa && pipelinesMade === m3, { d: show(d) });
  const steps = [['ao strength 1 → 2', () => setAo(2), 0], ['ew-ao off and on', () => { setAoPref(false); frame(); setAoPref(true); }, 1], ['the world loses AO and regains it', () => { setAo(0); frame(); setAo(1); }, 1]];
  const got = steps.map(([name, act, want]) => { const n = pipelinesMade; act(); frame(); return [name, pipelinesMade - n, want]; });
  check('A4 rebuilds: an AO strength edit builds nothing; the viewer\'s ew-ao switch or the world gaining AO builds exactly one', got.every(([, n, want]) => n === want), got);
  setAo(0); frame();
}

console.log('SYNCGATE — on WebGL the pipeline\'s scene pass is the world\'s own pass: its links defer, as the plain frame\'s do');
{
  setBloom(1); frame();
  const sg = await import(lib('render/syncgate.js'));
  const asked = [];
  let rt = null;
  const be = { isWebGLBackend: true, parallel: { COMPLETION_STATUS_KHR: 1 }, createRenderPipeline(ro, promises) { asked.push(promises); if (promises) promises.push(Promise.resolve()); } };
  const fake = { backend: be, getRenderTarget: () => rt };
  sg.installSyncGate(fake, { tee() {} });
  const ro = { object: { name: 'thing', type: 'Mesh' }, material: { type: 'MeshStandardNodeMaterial' }, pipeline: { fragmentProgram: { code: 'x' } } };
  rt = null; be.createRenderPipeline(ro, null);
  rt = live()?.scenePass?.renderTarget ?? { stand: 'no pipeline' }; be.createRenderPipeline(ro, null);
  rt = { isRenderTarget: true, name: 'a bake' }; be.createRenderPipeline(ro, null);
  check('P7 a link met on the canvas pass defers (the plain frame, control)', Array.isArray(asked[0]), asked.map(Array.isArray));
  check('P7 …a link met in the pipeline\'s scene pass defers the same way', Array.isArray(asked[1]), asked.map(Array.isArray));
  check('P7 …a link met in someone\'s own target still blocks (a bake, control)', asked[2] === null, asked.map(Array.isArray));
}

console.log('STALE SCOPE — a WebGPU error scope from a pipeline already gone does not drop the one built after it');
{
  setBloom(0); frame(); setBloom(1);
  const pop0 = device.popErrorScope; let release = null; device.popErrorScope = function () { this.scopes--; return new Promise((q) => { release = q; }); };
  frame();                                          // pipeline A's first frame: its scope is still open (not resolved)
  const a = live(); device.popErrorScope = pop0;
  setBloom(0); frame(); setBloom(1); frame();       // A is torn down, B built and drawing
  const b = live();
  release?.({ message: 'simulated: a late validation error from the pipeline before' });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const d = frame();
  check('P6c a late error from a torn-down pipeline\'s scope leaves the newer pipeline drawing (not failed, not rebuilt)', !!a && !!b && a !== b && live() === b && viaPipe(d) && !dbg().failed, { aB: !!a && !!b && a !== b, same: live() === b, d: show(d), failed: dbg().failed });
}

console.log('SCENE / CAMERA — a pass asked for another scene or camera builds a pipeline for them');
{
  setBloom(1); frame();
  const p = live(), made = pipelinesMade, cam2 = new THREE.PerspectiveCamera(), scene2 = new THREE.Scene();
  let gone = false; p?.scenePass?.renderTarget?.addEventListener('dispose', () => { gone = true; });
  const run = (sc, cam) => { draws.length = 0; try { post.postPass(renderer, sc, cam)?.(); } catch (e) { draws.push({ threw: e?.message ?? String(e) }); } return draws.slice(); };
  run(scene, cam2);
  const q = live();
  check('P10 another camera: the old pipeline is disposed and one new one draws through the new camera', gone && q !== p && q?.scenePass?.camera === cam2 && pipelinesMade === made + 1, { gone, cam: q?.scenePass?.camera === cam2, built: pipelinesMade - made });
  run(scene2, cam2);
  check('P10 …another scene: the same, through the new scene', live() !== q && live()?.scenePass?.scene === scene2 && pipelinesMade === made + 2, { scene: live()?.scenePass?.scene === scene2, built: pipelinesMade - made });
  frame();
  check('P10 …and the live frame again: its own scene and camera', live()?.scenePass?.scene === scene && live()?.scenePass?.camera === camera && pipelinesMade === made + 3, { built: pipelinesMade - made });
}

console.log('WEBGPU — a validation error in a new pipeline\'s first frame drops it');
{
  setBloom(0); frame(); setBloom(1);
  device.nextError = { message: 'simulated: textureGather on a multisampled depth texture' };
  const d = frame();
  check('P6b the first frame of a new pipeline is drawn inside a WebGPU validation error scope, popped', viaPipe(d) && device.scopes === 0 && device.nextError === null, { d: show(d), scopes: device.scopes, pending: device.nextError });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const made = pipelinesMade, d2 = frame();
  check('P6b …the error drops the pipeline: the next frame is plain, nothing rebuilt', plain(d2) && !live() && pipelinesMade === made, { d: show(d2), built: !!live(), pipelinesMade });
  check('P6b …the readout says it failed, with the GPU\'s message, and a clientlog line said it', /fail/i.test(String(dbg().why)) && /textureGather/.test(String(dbg().why)) && tees.some((l) => /textureGather/.test(l)), { why: dbg().why, tees });
}

// a throw drops the pipeline for the page, so it runs in a child of its own
console.log('FALLBACK — a pipeline that throws is dropped, the frame drawn plain, and the readout says so (child)');
{
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), '--case', 'throw'], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const line = child.stdout.toString().split('\n').find((l) => l.startsWith('CASE '));
  let r = null; try { r = JSON.parse(line.slice(5)); } catch {}
  check('P6 the child ran', !!r, child.stdout.toString().slice(-400) + child.stderr.toString().slice(-400));
  for (const [name, ok, detail] of r?.rows ?? []) check(name, ok, detail);
}

S.done();
