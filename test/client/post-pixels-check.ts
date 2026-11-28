// post-pixels — the post-processing pipeline (client/lib/render/post.js) as pixels, in a real headless browser on the
// client's own renderer: the picture the pipeline draws for a scene with nothing above the bloom threshold is the plain
// path's picture (tone mapping and the output colour space applied once, after bloom: three moves both into the
// pipeline's output pass), a bright emitter does glow round its edge, the pipeline's targets exist only while it does,
// and its scene pass follows the drawing buffer when the pixel ratio changes.
// Godot's glow first pass (copy.glsl): threshold 1, knee 2, cap 12, on the brightest channel of the EXPOSED colour (PX6-PX8).
//   bun test/client/post-pixels-check.ts   (its own scratch server, world and Chromium)
// WebGL 2 only: headless Chromium here has a WebGPU adapter but destroys its device at once (the harness's GPU guard
// says the same), so the WebGPU picture is the live check's; post-test pins the WebGPU-specific shape (the error scope).
// The world is held (render.js setWorldHold) and a scene of our own is drawn into the canvas, then read back in the same
// task (drawImage), so no frame of the page's own lands between a draw and its read.
// Mutations (must go red, by hand): outputColorTransform = false, or a second renderOutput round the output (PX1);
// bloom threshold 0 (PX1); strength not applied (PX2); targets not disposed at strength 0 (PX3: teardown skipped, or
// only the pipeline's own dispose).
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
    // the emitter: linear radiance 12 (well above the knee's top, 3, at exposure 1), added only for the glow rows
    const hot = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 16), new THREE.MeshStandardNodeMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 12 }));
    hot.position.set(1.6, 0, 0);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d', { willReadFrequently: true });
    const grab = () => { g2.clearRect(0, 0, W, H); g2.drawImage(cv, 0, 0); return g2.getImageData(0, 0, W, H).data; };
    // one frame of either path, read back in the same task
    // exposure held the same way (sky.js applyTuning rewrites it ~1 Hz): null = whatever the page has
    const holdE = () => { if (g.__want?.exposure != null) renderer.toneMappingExposure = g.__want.exposure; };
    const plainFrame = () => { holdE(); renderer.setRenderTarget(null); renderer.render(S, cam); return grab(); };
    // the test's strengths, held: a ticking sky re-applies its tuning ~1 Hz (sky.js updateSky → render → applyTuning), and
    // that hands post.js the WORLD's bloom (none here) between our frames; every frame of ours re-asserts the test's value
    const post = await import('/lib/render/post.js'); g.__want = { bloom: 0, ao: 0, exposure: 1 };
    g.__setB = (v) => { g.__want.bloom = v; post.setBloom(v); }; g.__setA = (v) => { g.__want.ao = v; post.setAo?.(v); };
    const hold = () => { post.setBloom(g.__want.bloom); post.setAo?.(g.__want.ao); holdE(); };
    const postFrame = async () => { hold(); const d = post.postPass(renderer, S, cam); if (d) d(); else renderer.render(S, cam); return grab(); };
    // frames until two in a row read the same (a WebGL program links in parallel and pops in a frame late, syncgate.js)
    const settle = async (f) => { let prev = null; for (let i = 0; i < 90; i++) { await new Promise((r) => requestAnimationFrame(r)); const px = await f(); if (prev && px.every((v, j) => v === prev[j])) return px; prev = px; } return null; };
    const diff = (a, b) => { let max = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); if (d > max) max = d; if (d > 1) n++; } return { max, over1: n }; };
    const lum = (px, cx, cy, r0, r1) => { let t = 0, n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - cx, y - cy); if (d >= r0 && d < r1) { const i = (y * W + x) * 4; t += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; } } return n ? t / n : 0; };
    const proj = (o) => { const v = o.position.clone().project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; };
    await renderer.compileAsync(S, cam);
    g.__pp = { THREE, renderer, S, cam, lit, hot, hold, grab, plainFrame, postFrame, settle, diff, lum, proj, W, H };
    return { backend: renderer.backend.isWebGLBackend ? 'webgl' : 'webgpu', W, H, samples: renderer.samples };`);
  console.log(`  · ${JSON.stringify(setup)}`);
  check("PX-setup the page runs WebGL 2, as asked", setup.backend === "webgl", JSON.stringify(setup));

  // PX1: nothing above threshold. The plain frame, then the pipeline at strength 1.5: the same picture
  const same = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js');
    globalThis.__setB(0); const a = await p.settle(p.plainFrame); const tex0 = p.renderer.info.memory.textures;
    globalThis.__setB(1.5); const b = await p.settle(p.postFrame);
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
    globalThis.__setB(0); const a = await p.settle(p.plainFrame);
    globalThis.__setB(1.5); const b = await p.settle(p.postFrame);
    globalThis.__setB(3); const c = await p.settle(p.postFrame);
    const [cx, cy] = p.proj(p.hot), r = 0.45 / (2 * Math.tan(25 * Math.PI / 180) * 6) * p.H;   // the emitter's radius on screen
    const ring = (px) => px ? p.lum(px, cx, cy, r * 1.4, r * 2.4) : null;
    p.S.remove(p.hot);
    return { settled: !!a && !!b && !!c, ring: [ring(a), ring(b), ring(c)], r };`);
  console.log(`  · ${JSON.stringify(glow)}`);
  const [r0, r1, r3] = glow.ring ?? [];
  check("PX2 an emitter at 12× white glows: the ring round it is brighter with bloom 1.5 than plain, and brighter still at 3", glow.settled && r1 > r0 + 4 && r3 > r1 + 2, JSON.stringify(glow));

  // PX3: back to none disposes the targets (every render-target texture the pipeline made is destroyed; a bare texture
  // count is not the measure: the page creates its own textures between frames); PX4: the scene pass follows the buffer
  const after = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), be = p.renderer.backend, made = new Map();
    const c0 = be.createTexture.bind(be), d0 = be.destroyTexture.bind(be);
    be.createTexture = (t, o) => { if (t.isRenderTargetTexture || t.isDepthTexture) made.set(t, (t.isDepthTexture ? 'depth ' : 'colour ') + t.image?.width + 'x' + t.image?.height); return c0(t, o); };
    be.destroyTexture = (t, ...a) => { made.delete(t); return d0(t, ...a); };
    let built, ofPipe;
    try {
      globalThis.__setB(0); p.plainFrame(); await p.postFrame();
      globalThis.__setB(1.5); await p.settle(p.postFrame); ofPipe = made.size;
      globalThis.__setB(0); p.plainFrame(); await p.postFrame(); built = post.postDebug().built;
    } finally { be.createTexture = c0; be.destroyTexture = d0; }
    const left = [...made.values()];
    globalThis.__setB(1.5); await p.postFrame();
    const pr = p.renderer.getPixelRatio(); p.renderer.setPixelRatio(pr * 0.5);
    await new Promise((r) => requestAnimationFrame(r)); await p.postFrame();   // a pass resizes in updateBefore, once per frame (three's NodeUpdateType.FRAME)
    const sz = p.renderer.getDrawingBufferSize(new p.THREE.Vector2()), rt = post.postDebug()._pipe?.scenePass?.renderTarget;
    const r = { ofPipe, left, built, failed: post.postDebug().failed, buffer: [sz.x, sz.y], target: rt ? [rt.width, rt.height] : null };
    p.renderer.setPixelRatio(pr); globalThis.__setB(0); await p.postFrame();
    return r;`);
  console.log(`  · ${JSON.stringify(after)}`);
  check("PX3 …and at strength 0 they are gone: every render-target texture the pipeline made (its scene pass, colour and depth, and its bloom mips) is destroyed, nothing held", after.ofPipe >= 12 && after.left.length === 0 && after.built === false, JSON.stringify(after));
  check("PX4 a pixel-ratio change (the render-scale governor's lever): the scene pass's target follows the drawing buffer", !!after.target && after.target[0] === after.buffer[0] && after.target[1] === after.buffer[1], JSON.stringify(after));

  // PX6: an emitter at 60× white: the bloom's bright target (BloomNode's high-pass output, half resolution, half float) holds
  // 12 / exposure at its centre (Godot's glow_hdr_luminance_cap, on the exposed colour), per channel after the threshold;
  // uncapped it would hold 60
  const cap = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), T = p.THREE;
    const hot = new T.Mesh(new T.SphereGeometry(0.8, 32, 16), new T.MeshStandardNodeMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 60 }));
    p.S.add(hot); await p.renderer.compileAsync(p.S, p.cam);
    globalThis.__want.exposure = 2;   // the cap is on the exposed colour (Godot): at exposure 2 the scene-linear target holds 12 / 2
    globalThis.__setB(1.5); await p.settle(p.postFrame);
    globalThis.__want.exposure = 1;
    const rt = post.postDebug()._pipe?.glow?._renderTargetBright; if (!rt) return { error: 'no bright target' };
    const [cx, cy] = p.proj(hot), x = Math.round(cx * rt.width / p.W), y = Math.round(rt.height / 2);   // the emitter sits at the vertical centre: either y origin reads it
    const raw = await p.renderer.readRenderTargetPixelsAsync(rt, x - 1, y - 1, 3, 3);
    const v = [...raw].map((h) => (raw instanceof Uint16Array ? T.DataUtils.fromHalfFloat(h) : h));
    const rgb = []; for (let i = 0; i < v.length; i += 4) rgb.push(Math.max(v[i], v[i + 1], v[i + 2]));
    p.S.remove(hot); globalThis.__setB(0); await p.postFrame();
    return { failed: post.postDebug().failed, size: [rt.width, rt.height], at: [x, y], max: Math.max(...rgb), rgb, type: raw?.constructor?.name };`);
  console.log(`  · ${JSON.stringify(cap)}`);
  check("PX6 an emitter at 60× white, exposure 2, feeds the bloom 6 per channel (12 exposed: Godot's glow_hdr_luminance_cap, on the exposed colour after the threshold), not 60 or 12", !cap.error && Math.abs(cap.max - 6) < 0.05, JSON.stringify(cap));

  // PX7, PX8: Godot's glow first pass on the exposed colour: feedback = smoothstep(1, 3, max(r, g, b) × exposure).
  // The glow is the ring round an emitter, with the pipeline, less the same ring plain, at the same exposure.
  const knee = await js(`const p = globalThis.__pp, T = p.THREE;
    const ringGlow = async (emissive, k, e) => {
      const m = new T.Mesh(new T.SphereGeometry(0.45, 32, 16), new T.MeshStandardNodeMaterial({ color: 0x000000, emissive, emissiveIntensity: k }));
      m.position.set(1.6, 0, 0); p.S.add(m); await p.renderer.compileAsync(p.S, p.cam); globalThis.__want.exposure = e;
      globalThis.__setB(0); const a = await p.settle(p.plainFrame); globalThis.__setB(3); const b = await p.settle(p.postFrame);
      const [cx, cy] = p.proj(m), r = 0.45 / (2 * Math.tan(25 * Math.PI / 180) * 6) * p.H, ring = (px) => p.lum(px, cx, cy, r * 1.4, r * 2.4);
      p.S.remove(m); globalThis.__want.exposure = 1; globalThis.__setB(0); await p.postFrame();
      return a && b ? Math.round((ring(b) - ring(a)) * 100) / 100 : null; };
    return { red25: await ringGlow(0xff0000, 2.5, 1), white07e1: await ringGlow(0xffffff, 0.7, 1), white07e4: await ringGlow(0xffffff, 0.7, 4) };`);
  console.log(`  · ${JSON.stringify(knee)}`);
  check("PX7 the threshold reads the brightest channel (Godot), not luminance: a pure red emitter at 2.5 glows (its luminance, 0.53, is under the threshold)", knee.red25 != null && knee.red25 > 2, JSON.stringify(knee));
  check("PX8 the threshold is on the exposed colour: a white emitter at 0.7 does not glow at exposure 1 and does at exposure 4 (2.8 exposed)", knee.white07e1 != null && Math.abs(knee.white07e1) <= 1 && knee.white07e4 > 2, JSON.stringify(knee));

  // AO: a box on a floor. Lit by a directional light only (no ambient, black ground and sky), AO changes nothing: three's
  // builtinAOContext feeds the ambientOcclusion that only indirect light reads. Lit by an ambient light only, the floor at
  // the box's foot darkens with AO, and the open floor far from it barely moves.
  const ao = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), T = p.THREE;
    const S = new T.Scene(); S.background = new T.Color(0, 0, 0);
    const cam = new T.PerspectiveCamera(50, p.W / p.H, 0.1, 100); cam.position.set(0, 2.2, 4.2); cam.lookAt(0, 0.3, 0); cam.updateMatrixWorld(true);   // project() reads matrixWorldInverse
    const mat = new T.MeshStandardNodeMaterial({ color: new T.Color(0.7, 0.7, 0.7), roughness: 0.9 });
    const floor = new T.Mesh(new T.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), mat); S.add(floor);
    const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), mat); box.position.set(0, 0.5, 0); S.add(box);
    const sun = new T.DirectionalLight(0xffffff, 3); sun.position.set(-1, 4, 3); const amb = new T.AmbientLight(0xffffff, 1.5);
    const plainF = () => { p.renderer.setRenderTarget(null); p.renderer.render(S, cam); return p.grab(); };
    const postF = async () => { p.hold(); const d = post.postPass(p.renderer, S, cam); if (d) d(); else p.renderer.render(S, cam); return p.grab(); };
    const at = (v3) => { const v = v3.clone().project(cam); return [(v.x + 1) / 2 * p.W, (1 - v.y) / 2 * p.H]; };
    const foot = at(new T.Vector3(0, 0.02, 0.56)), open = at(new T.Vector3(2.2, 0, 1.0));
    const shot = async (light) => { S.add(light); await p.renderer.compileAsync(S, cam);
      globalThis.__setA(0); const a = await p.settle(plainF); globalThis.__setA(3); const b = await p.settle(postF); const dbg = post.postDebug();
      globalThis.__setA(0); await postF(); S.remove(light);
      return { a, b, active: dbg.active, why: dbg.why, passes: dbg.passes }; };
    const D = await shot(sun), I = await shot(amb);
    return { direct: { settled: !!D.a && !!D.b, active: D.active, why: D.why, passes: D.passes, diff: D.a && D.b ? p.diff(D.a, D.b) : null, foot: D.a ? [p.lum(D.a, ...foot, 0, 3), p.lum(D.b, ...foot, 0, 3)] : null },
      indirect: { settled: !!I.a && !!I.b, active: I.active, why: I.why, passes: I.passes, foot: I.a ? [p.lum(I.a, ...foot, 0, 3), p.lum(I.b, ...foot, 0, 3)] : null, open: I.a ? [p.lum(I.a, ...open, 0, 3), p.lum(I.b, ...open, 0, 3)] : null }, at: { foot, open } };`);
  console.log(`  · ${JSON.stringify(ao)}`);
  check("PA1 AO in direct light only (a directional light, no ambient): the AO frame is the plain frame (every channel within 1 of 255): the direct term is not darkened",
    ao.direct.settled && ao.direct.active === true && ao.direct.passes === 'ao' && ao.direct.diff && ao.direct.diff.max <= 1 && ao.direct.foot[0] > 20, JSON.stringify(ao.direct));
  const [f0, f1] = ao.indirect.foot ?? [], [o0, o1] = ao.indirect.open ?? [];
  check("PA2 AO in ambient light only: the floor at the box's foot darkens (by more than a tenth), the open floor moves far less", ao.indirect.settled && ao.indirect.active === true && f1 < f0 * 0.9 && (f0 - f1) > 3 * Math.abs(o0 - o1), JSON.stringify(ao.indirect));

  // PA3: AO on keeps every shadow. A see-through caster (transparent: true, opacity 1) above the floor, lit by a shadowing
  // sun only (so, per PA1, the AO frame should be the plain frame), against an opaque one as the control
  const shadows = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), T = p.THREE, r = p.renderer, out = {};
    const was = r.shadowMap.enabled; r.shadowMap.enabled = true;
    try { for (const transparent of [false, true]) {
      const S = new T.Scene(); S.background = new T.Color(0, 0, 0);
      const cam = new T.PerspectiveCamera(50, p.W / p.H, 0.1, 100); cam.position.set(0, 2.2, 4.2); cam.lookAt(0, 0.3, 0); cam.updateMatrixWorld(true);
      const floor = new T.Mesh(new T.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), new T.MeshStandardNodeMaterial({ color: 0xb0b0b0, roughness: 0.9 })); floor.receiveShadow = true; S.add(floor);
      const caster = new T.Mesh(new T.BoxGeometry(1, 0.1, 1), new T.MeshStandardNodeMaterial({ color: 0x808080, transparent, opacity: 1 })); caster.position.set(0, 1.2, 0); caster.castShadow = true; S.add(caster);
      const sun = new T.DirectionalLight(0xffffff, 3); sun.position.set(0, 6, 0.001); sun.castShadow = true;
      Object.assign(sun.shadow.camera, { left: -4, bottom: -4, right: 4, top: 4, near: 0.5, far: 12 }); sun.shadow.camera.updateProjectionMatrix(); S.add(sun);
      const at = (v3) => { const v = v3.clone().project(cam); return [(v.x + 1) / 2 * p.W, (1 - v.y) / 2 * p.H]; };
      const under = at(new T.Vector3(0, 0, 0.42)), open = at(new T.Vector3(2.2, 0, 1.0));
      const plainF = () => { p.hold(); r.setRenderTarget(null); r.render(S, cam); return p.grab(); };
      const postF = async () => { p.hold(); const d = post.postPass(r, S, cam); if (d) d(); else r.render(S, cam); return p.grab(); };
      await r.compileAsync(S, cam); globalThis.__setA(0); const a = await p.settle(plainF); globalThis.__setA(3); const b = await p.settle(postF);
      out[transparent ? 'seeThrough' : 'opaque'] = { passes: post.postDebug().passes, under: a && b ? [p.lum(a, ...under, 0, 2), p.lum(b, ...under, 0, 2)].map(Math.round) : null, open: a && b ? [p.lum(a, ...open, 0, 3), p.lum(b, ...open, 0, 3)].map(Math.round) : null };
      globalThis.__setA(0); await postF(); sun.shadow.map?.dispose?.(); sun.dispose?.();
    } } finally { r.shadowMap.enabled = was; }
    return out;`);
  console.log(`  · ${JSON.stringify(shadows)}`);
  const sh = (k: string) => shadows[k] ?? {};
  check("PA3 control: an opaque caster's shadow is the same with AO on (the floor under it is dark in both, far darker than the open floor)",
    sh("opaque").passes === "ao" && !!sh("opaque").under && sh("opaque").under[0] < sh("opaque").open[0] * 0.5 && Math.abs(sh("opaque").under[1] - sh("opaque").under[0]) <= 2, JSON.stringify(shadows));
  check("PA3 a see-through caster (transparent: true) keeps its shadow with AO on: the floor under it stays dark (the shadow map is not drawn opaque-only inside the pre-pass)",
    sh("seeThrough").passes === "ao" && !!sh("seeThrough").under && sh("seeThrough").under[0] < sh("seeThrough").open[0] * 0.5 && Math.abs(sh("seeThrough").under[1] - sh("seeThrough").under[0]) <= 2, JSON.stringify(shadows));

  // PA4: AO leaves unlit materials alone (pictures, texts, quads, screens, the sky dome): a basic-material box on a
  // basic-material floor, no lights at all, AO at 3; the floor at the box's foot is the plain frame's
  const unlit = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), T = p.THREE, r = p.renderer, out = {};
    for (const [k, Mat] of [['node', T.MeshBasicNodeMaterial], ['classic', T.MeshBasicMaterial]]) {
      const S = new T.Scene(); S.background = new T.Color(0, 0, 0);
      const cam = new T.PerspectiveCamera(50, p.W / p.H, 0.1, 100); cam.position.set(0, 2.2, 4.2); cam.lookAt(0, 0.3, 0); cam.updateMatrixWorld(true);
      const mat = new Mat({ color: new T.Color(0.5, 0.5, 0.5) });
      S.add(new T.Mesh(new T.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), mat)); const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), mat); box.position.set(0, 0.5, 0); S.add(box);
      const at = (v3) => { const v = v3.clone().project(cam); return [(v.x + 1) / 2 * p.W, (1 - v.y) / 2 * p.H]; };
      const foot = at(new T.Vector3(0, 0.02, 0.56));
      const plainF = () => { p.hold(); r.setRenderTarget(null); r.render(S, cam); return p.grab(); };
      const postF = async () => { p.hold(); const d = post.postPass(r, S, cam); if (d) d(); else r.render(S, cam); return p.grab(); };
      await r.compileAsync(S, cam); globalThis.__setA(0); const a = await p.settle(plainF); globalThis.__setA(3); const b = await p.settle(postF);
      out[k] = { passes: post.postDebug().passes, foot: a && b ? [p.lum(a, ...foot, 0, 3), p.lum(b, ...foot, 0, 3)].map(Math.round) : null, diff: a && b ? p.diff(a, b) : null };
      globalThis.__setA(0); await postF(); }
    return out;`);
  console.log(`  · ${JSON.stringify(unlit)}`);
  check("PA4 AO leaves unlit materials alone: MeshBasicNodeMaterial and MeshBasicMaterial, AO at 3, draw the plain frame (every channel within 1 of 255), the box's foot included",
    ["node", "classic"].every((k) => unlit[k]?.passes === "ao" && !!unlit[k]?.diff && unlit[k].diff.max <= 1 && unlit[k].foot[0] > 60), JSON.stringify(unlit));

  // PA7: the pre-pass draws only depth-writing surfaces: no grid, line segments, sprite or depthWrite-false mesh, and
  // nothing the sky marks noPrePass; the scene pass still draws them all
  const kept = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), T = p.THREE, r = p.renderer;
    const S = new T.Scene(); S.background = new T.Color(0, 0, 0); S.add(new T.AmbientLight(0xffffff, 1.5));
    const cam = new T.PerspectiveCamera(50, p.W / p.H, 0.1, 100); cam.position.set(0, 2.2, 4.2); cam.lookAt(0, 0.3, 0); cam.updateMatrixWorld(true);
    const add = (o, name) => { o.name = name; S.add(o); return o; };
    add(new T.Mesh(new T.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), new T.MeshStandardNodeMaterial({ color: 0x999999 })), 'floor');
    add(new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardNodeMaterial({ color: 0x888888 })), 'box').position.set(0, 0.5, 0);
    add(new T.GridHelper(6, 6), 'grid');
    add(new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(1.2, 1.2, 1.2)), new T.LineBasicNodeMaterial({ color: 0xffff00 })), 'edges').position.set(0, 0.6, 0);
    add(new T.Sprite(new T.SpriteNodeMaterial({ color: 0xff00ff })), 'sprite').position.set(1.5, 1, 0);
    add(new T.Mesh(new T.SphereGeometry(30, 16, 8), new T.MeshBasicNodeMaterial({ color: 0x223344, side: T.BackSide, depthWrite: false })), 'dome');
    const sky = add(new T.Mesh(new T.SphereGeometry(25, 16, 8), new T.MeshBasicNodeMaterial({ color: 0x334455, side: T.BackSide })), 'sky'); sky.userData.noPrePass = true;
    const seen = { pre: new Set(), scene: new Set() }, ro0 = r.renderObject;
    r.renderObject = function (o, ...a) { const pipe = post.postDebug()._pipe, rt = r.getRenderTarget(); if (pipe && rt === pipe.pre?.renderTarget) seen.pre.add(o.name); else if (pipe && rt === pipe.scenePass.renderTarget) seen.scene.add(o.name); return ro0.call(this, o, ...a); };
    const postF = async () => { p.hold(); const d = post.postPass(r, S, cam); if (d) d(); else r.render(S, cam); return p.grab(); };
    try { await r.compileAsync(S, cam); globalThis.__setA(3); for (let i = 0; i < 4; i++) { await new Promise((q) => requestAnimationFrame(q)); await postF(); } }
    finally { r.renderObject = ro0; globalThis.__setA(0); await postF(); }
    return { pre: [...seen.pre].sort(), scene: [...seen.scene].sort() };`);
  console.log(`  · ${JSON.stringify(kept)}`);
  check("PA7 the AO pre-pass draws the floor and the box, and none of the grid, the line segments, the sprite, a depthWrite-false dome or a mesh the sky marks noPrePass",
    JSON.stringify(kept.pre) === JSON.stringify(["box", "floor"]), JSON.stringify(kept));
  check("PA7 …while the scene pass draws all seven", ["box", "dome", "edges", "floor", "grid", "sky", "sprite"].every((n) => kept.scene?.includes(n)), JSON.stringify(kept));

  // PA9 LAST (a failure drops the pipeline for the page): a throw inside the AO pre-pass. post.js draws the frame plain;
  // the renderer must be left as the plain path expects it (three's PassNode.updateBefore has no try/finally: MRT, the AO
  // context, renderer.transparent would stay as the pass set them), so the next plain frame is the plain picture
  const thrown = await js(`const p = globalThis.__pp, post = await import('/lib/render/post.js'), T = p.THREE, r = p.renderer;
    const S = new T.Scene(); S.background = new T.Color(0, 0, 0);
    const cam = new T.PerspectiveCamera(50, p.W / p.H, 0.1, 100); cam.position.set(0, 2.2, 4.2); cam.lookAt(0, 0.3, 0); cam.updateMatrixWorld(true);
    S.add(new T.AmbientLight(0xffffff, 1.5));
    const floor = new T.Mesh(new T.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), new T.MeshStandardNodeMaterial({ color: 0x999999 })); S.add(floor);
    const glass = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardNodeMaterial({ color: 0xff2020, transparent: true, opacity: 0.9 })); glass.position.set(0, 0.5, 0); S.add(glass);
    const plainF = () => { p.hold(); r.setRenderTarget(null); r.render(S, cam); return p.grab(); };
    const postF = async () => { p.hold(); const d = post.postPass(r, S, cam); if (d) d(); else r.render(S, cam); return p.grab(); };
    await r.compileAsync(S, cam); globalThis.__setA(0); const ref = await p.settle(plainF); globalThis.__setA(3); await p.settle(postF);
    const ctx0 = r.contextNode, pipe0 = post.postDebug()._pipe; let threw = false;
    floor.onBeforeRender = () => { if (r.getRenderTarget() === pipe0?.pre?.renderTarget) { floor.onBeforeRender = () => {}; threw = true; throw new Error('simulated: a throw inside the AO pre-pass'); } };
    let escaped = null, tries = 0;   // the pre-pass may skip a frame (a program still linking): try until it draws the floor
    for (; !threw && tries < 30; tries++) { await new Promise((q) => requestAnimationFrame(q)); try { await postF(); } catch (e) { escaped = String(e); } }
    const st = { threw, tries, escaped, failed: post.postDebug().failed, mrt: r.getMRT() !== null, ctxSame: r.contextNode === ctx0, transparent: r.transparent, opaque: r.opaque, target: r.getRenderTarget() === null };
    const after = await p.settle(postF);
    const gx = (px) => { const v = glass.position.clone().project(cam), x = Math.round((v.x + 1) / 2 * p.W), y = Math.round((1 - v.y) / 2 * p.H), i = (y * p.W + x) * 4; return px ? [px[i], px[i + 1], px[i + 2]] : null; };
    st.diff = ref && after ? p.diff(ref, after) : null; st.glass = [gx(ref), gx(after)];
    r.setMRT(null); r.transparent = true; r.opaque = true; r.contextNode = ctx0; globalThis.__setA(0);
    return st;`);
  console.log(`  · ${JSON.stringify(thrown)}`);
  check("PA9 a throw inside the AO pre-pass: post.js catches it, drops the pipeline, and leaves the renderer plain (no MRT, its own contextNode, opaque and transparent drawn, canvas bound)",
    thrown.threw && !thrown.escaped && /pre-pass/.test(String(thrown.failed)) && !thrown.mrt && thrown.ctxSame && thrown.transparent === true && thrown.opaque === true && thrown.target, JSON.stringify(thrown));
  check("PA9 …so the next plain frame is the plain picture: the see-through box is drawn (every channel within 1 of 255)", !!thrown.diff && thrown.diff.max <= 1, JSON.stringify(thrown));

  const real = errors.filter((e) => !/popErrorScope|sky finish|simulated: a throw inside the AO pre-pass/.test(e));
  check("PX5 no page errors", real.length === 0, JSON.stringify(real.slice(0, 4)));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[post-pixels-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
