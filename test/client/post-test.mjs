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
// the pipeline (P4); outputColorTransform false (P2t); no fallback on a throw (P6); error scope ignored (P6b); world-pass
// mark dropped (P7).
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
const renderer = {
  backend: { isWebGPUBackend: true, device },
  xr: { enabled: false, isPresenting: false, updateCamera() {}, getCamera: () => null },
  toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1,
  info: { render: { drawCalls: 0, triangles: 0, points: 0, lines: 0, calls: 0 } },
  getRenderTarget: () => bound, setRenderTarget(t) { bound = t; },
  render(sc, cam) {
    draws.push({ sc, cam, toneMapping: this.toneMapping, colorSpace: this.outputColorSpace, xr: this.xr.enabled });
    if (sc?.isQuadMesh && sc.name === 'Render Pipeline' && throwOnQuad) { const e = throwOnQuad; throwOnQuad = null; bound = { stale: true }; throw e; }
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
const dbg = () => { try { return post.postDebug(); } catch (e) { return { error: e?.message ?? String(e) }; } };
const live = () => dbg()._pipe ?? null;
const show = (d) => d.map((x) => x.threw ? `threw ${x.threw}` : x.sc === scene ? 'scene' : x.sc?.name ?? x.sc?.type ?? '?');
const setBloom = (s) => { try { post.setBloom(s); } catch (e) { return e; } };
const setPref = (on) => { try { post.setBloomPref(on); } catch (e) { return e; } };

if (process.argv.includes('--case')) {
  const rows = [];
  const row = (n, ok, d) => rows.push([n, !!ok, d]);
  setBloom(1); frame();
  throwOnQuad = new Error('simulated: the output pass failed');
  const d = frame();
  row('P6 the pipeline throws mid-frame: that same frame is drawn plain (renderer.render(scene, camera) after it)', d.some((x) => x.sc === scene && x.cam === camera) && !d.some((x) => x.threw), show(d));
  row('P6 …into the canvas: the target the failed pass left bound is unbound first', bound === null, String(bound));
  row('P6 …the readout: not active, failed, with the message; a clientlog line said it', dbg().active === false && /fail/i.test(String(dbg().why)) && /output pass failed/.test(String(dbg().why)) && tees.some((l) => /post/.test(l) && /output pass failed/.test(l)), { why: dbg().why, tees });
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
  check('P2 …its BloomNode holds the world\'s strength, radius 0.15 and threshold 2 (render lab 11-02)', p?.glow && Math.abs(p.glow.strength.value - 1.2) < 1e-9 && Math.abs(p.glow.radius.value - 0.15) < 1e-9 && Math.abs(p.glow.threshold.value - 2) < 1e-9,
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
