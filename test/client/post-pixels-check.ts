// post-pixels — the post-processing pipeline (client/lib/render/post.js) as pixels, in a real headless browser on the
// client's own renderer: the picture the pipeline draws for a scene with nothing above the bloom threshold is the plain
// path's picture (tone mapping and the output colour space applied once, after bloom: three moves both into the
// pipeline's output pass), a bright emitter does glow round its edge, the pipeline's targets exist only while it does,
// and its scene pass follows the drawing buffer when the pixel ratio changes.
//   bun test/client/post-pixels-check.ts   (its own scratch server, world and Chromium)
// WebGL 2 only: headless Chromium here has a WebGPU adapter but destroys its device at once (the harness's GPU guard
// says the same), so the WebGPU picture is the live check's; post-test pins the WebGPU-specific shape (the error scope).
// The world is held (render.js setWorldHold) and a scene of our own is drawn into the canvas, then read back in the same
// task (drawImage), so no frame of the page's own lands between a draw and its read.
// Mutations (must go red, by hand): outputColorTransform = false, or a second renderOutput round the output (PX1);
// bloom threshold 0 (PX1); strength not applied (PX2); targets not disposed at strength 0 (PX3).
import { scratchBench, mkCheck } from "../harness/harness.ts";
import { until } from "../gate/wait.ts";

const WORLD = "post-pixels";
const bench = await scratchBench("post-pixels", { worlds: [WORLD] });
const { cdp, evalJson, BASE } = bench;
const { check, tally } = mkCheck();
const errors: string[] = [];
bench.cws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 300));
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") errors.push(String(m.params.args?.map((a: any) => a.value ?? a.description).join(" ")).slice(0, 300));
});
const js = (body: string) => evalJson(`(async () => { ${body} })()`);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 180, deviceScaleFactor: 1, mobile: false });   // SwiftShader draws every pixel on the CPU
  await cdp.send("Page.navigate", { url: `${BASE}/?world=${WORLD}&spectate=1&name=pp&webgl=1` });
  await until("the client's render path", () => evalJson("import('/lib/render/render.js').then(() => true, () => false)").catch(() => false), { ms: 60000 });
  await until("the world hydrated", () => js("return (await import('/lib/state.js')).state.hydrated;"), { ms: 30000 });
  // the live page first: a world with no sky.bloom, a few real frames, no pipeline
  await js("for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r)); return true;");
  const first = await js("const p = await import('/lib/render/post.js'); return p.postDebug ? (({ _pipe, ...r }) => r)(p.postDebug()) : null;").catch((e: any) => ({ error: String(e).slice(0, 200) }));
  check("PX0 the live page, a world with no sky.bloom: 20 frames, no pipeline built", !!first && first.builds === 0 && first.active === false && first.built === false, JSON.stringify(first));

  const setup = await js(`const { THREE, renderer } = await import('/lib/core.js'), R = await import('/lib/render/render.js'), g = globalThis;
    R.setWorldHold(true);
    const cv = renderer.domElement, W = cv.width, H = cv.height;
    const S = new THREE.Scene(); S.background = new THREE.Color().setRGB(0.05, 0.06, 0.08, THREE.LinearSRGBColorSpace);
    const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100); cam.position.set(0, 0, 6); cam.lookAt(0, 0, 0);
    S.add(new THREE.AmbientLight(0xffffff, 0.4)); const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(2, 3, 4); S.add(sun);
    const lit = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.8, 0.35, 0.2), roughness: 0.5 }));
    lit.position.set(-1.6, 0, 0); S.add(lit);
    // the emitter: linear radiance 12 (well above the threshold of 2), added only for the glow rows
    const hot = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 16), new THREE.MeshStandardNodeMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 12 }));
    hot.position.set(1.6, 0, 0);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d', { willReadFrequently: true });
    const grab = () => { g2.clearRect(0, 0, W, H); g2.drawImage(cv, 0, 0); return g2.getImageData(0, 0, W, H).data; };
    // one frame of either path, read back in the same task
    const plainFrame = () => { renderer.setRenderTarget(null); renderer.render(S, cam); return grab(); };
    const postFrame = async () => { const post = await import('/lib/render/post.js'); const d = post.postPass(renderer, S, cam); if (d) d(); else renderer.render(S, cam); return grab(); };
    // frames until two in a row read the same (a WebGL program links in parallel and pops in a frame late, syncgate.js)
    const settle = async (f) => { let prev = null; for (let i = 0; i < 90; i++) { await new Promise((r) => requestAnimationFrame(r)); const px = await f(); if (prev && px.every((v, j) => v === prev[j])) return px; prev = px; } return null; };
    const diff = (a, b) => { let max = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); if (d > max) max = d; if (d > 1) n++; } return { max, over1: n }; };
    const lum = (px, cx, cy, r0, r1) => { let t = 0, n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - cx, y - cy); if (d >= r0 && d < r1) { const i = (y * W + x) * 4; t += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; } } return n ? t / n : 0; };
    const proj = (o) => { const v = o.position.clone().project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; };
    await renderer.compileAsync(S, cam);
    g.__pp = { THREE, renderer, S, cam, lit, hot, plainFrame, postFrame, settle, diff, lum, proj, W, H };
    return { backend: renderer.backend.isWebGLBackend ? 'webgl' : 'webgpu', W, H, samples: renderer.samples };`);
  console.log(`  · ${JSON.stringify(setup)}`);
  check("PX-setup the page runs WebGL 2, as asked", setup.backend === "webgl", JSON.stringify(setup));

  // PX1: nothing above threshold. The plain frame, then the pipeline at strength 1.5: the same picture
  const same = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js');
    post.setBloom(0); const a = await p.settle(p.plainFrame); const tex0 = p.renderer.info.memory.textures;
    post.setBloom(1.5); const b = await p.settle(p.postFrame);
    const d = post.postDebug(), tex1 = p.renderer.info.memory.textures;
    return { settled: !!a && !!b, diff: a && b ? p.diff(a, b) : null, active: d.active, why: d.why, bloom: d.bloom, tex0, tex1,
      litLum: a ? p.lum(a, ...p.proj(p.lit), 0, 20) : null, bgLum: a ? p.lum(a, p.W / 2, p.H / 2, 0, 6) : null };`);
  console.log(`  · ${JSON.stringify(same)}`);
  check("PX1 nothing above threshold: the pipeline's frame is the plain frame (every channel within 1 of 255), so tone mapping and colour space are applied once, after bloom",
    same.settled && same.active === true && same.diff && same.diff.max <= 1 && same.litLum > 40, JSON.stringify(same));
  check("PX3 the pipeline's targets exist while it does: more GPU textures with it than without", same.tex1 > same.tex0, JSON.stringify([same.tex0, same.tex1]));

  // PX2: an emitter at 12× white: with bloom the dark ring round it brightens; plain does not
  const glow = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js');
    p.S.add(p.hot); await p.renderer.compileAsync(p.S, p.cam);
    post.setBloom(0); const a = await p.settle(p.plainFrame);
    post.setBloom(1.5); const b = await p.settle(p.postFrame);
    post.setBloom(3); const c = await p.settle(p.postFrame);
    const [cx, cy] = p.proj(p.hot), r = 0.45 / (2 * Math.tan(25 * Math.PI / 180) * 6) * p.H;   // the emitter's radius on screen
    const ring = (px) => px ? p.lum(px, cx, cy, r * 1.4, r * 2.4) : null;
    p.S.remove(p.hot);
    return { settled: !!a && !!b && !!c, ring: [ring(a), ring(b), ring(c)], r };`);
  console.log(`  · ${JSON.stringify(glow)}`);
  const [r0, r1, r3] = glow.ring ?? [];
  check("PX2 an emitter at 12× white glows: the ring round it is brighter with bloom 1.5 than plain, and brighter still at 3", glow.settled && r1 > r0 + 4 && r3 > r1 + 2, JSON.stringify(glow));

  // PX3: back to none disposes the targets; PX4: the scene pass follows the drawing buffer
  const after = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js');
    post.setBloom(1.5); await p.settle(p.postFrame); const texOn = p.renderer.info.memory.textures;
    post.setBloom(0); p.plainFrame(); await p.postFrame(); const texOff = p.renderer.info.memory.textures, built = post.postDebug().built;
    post.setBloom(1.5); await p.postFrame();
    const pr = p.renderer.getPixelRatio(); p.renderer.setPixelRatio(pr * 0.5); await p.postFrame();
    const sz = p.renderer.getDrawingBufferSize(new p.THREE.Vector2()), rt = post.postDebug()._pipe?.scenePass?.renderTarget;
    const r = { texOn, texOff, built, buffer: [sz.x, sz.y], target: rt ? [rt.width, rt.height] : null };
    p.renderer.setPixelRatio(pr); post.setBloom(0); await p.postFrame();
    return r;`);
  console.log(`  · ${JSON.stringify(after)}`);
  check("PX3 …and at strength 0 they are gone: the texture count is back where the plain path had it, nothing held", after.texOff === same.tex0 && after.built === false, JSON.stringify({ tex0: same.tex0, ...after }));
  check("PX4 a pixel-ratio change (the render-scale governor's lever): the scene pass's target follows the drawing buffer", !!after.target && after.target[0] === after.buffer[0] && after.target[1] === after.buffer[1], JSON.stringify(after));

  const real = errors.filter((e) => !/popErrorScope|sky finish/.test(e));
  check("PX5 no page errors", real.length === 0, JSON.stringify(real.slice(0, 4)));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[post-pixels-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
