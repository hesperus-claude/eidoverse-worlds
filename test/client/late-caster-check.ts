// late-caster — a shadow map drawn late, or resized while it is not drawing, in a real headless browser on the client's
// own renderer (forced to WebGL 2) and rig (client/lib/render/lightrig.js). three r186 destroys and recreates a shadow
// map's depth texture at the map's first render, and a classic material's bind state (every GLB model's) kept the
// destroyed one: WebGL 2 reports GL_INVALID_OPERATION and the browser logs "bindTexture: attempt to use a deleted object"
// every frame (render lab 2026-11-27, RTX 4080; software WebGL shows the same). Each row boots its own page, with the
// shadow settings cleared first (ew-shadow-res and the rest persist across navigations on one origin).
//   LC0 the bench: WebGL 2; a classic-material model (loadGLB: MeshStandardMaterial) drawn by the page's own frames (the
//       frame with it differs from the frame without it); the casting slot unheld (spectating: no body lamp); no GL error
//   LC1 a light that asks for shadows arrives late: it takes the casting slot and casts, and the 90 frames after raise no
//       GL error and log no deleted-object bind
//   LC2 a resize while no light holds the casting slot (the Video resolution setting), then a late asker: no GL error,
//       and it casts (three refreshes a classic material's bind group only in the frame mapSize changes, and the map is
//       redrawn only when drawn: a map not drawing at the resize kept the two apart, render lab 2026-11-27 night)
//   LC3 shadows switched off, the resolution changed, shadows on again: no GL error
//   LC4 a lamp's cube map resized live (2048 -> 4096 setting: 256 -> 512) shows the picture a boot at that size shows,
//       against the noise floor of two boots at one size (three r186's RenderTarget.setSize writes the new size onto the
//       cube texture's image array but the faces are recreated at their birth size: cold read 2026-11-28, 10,306 of
//       57,600 pixels differed)
//   LC5 at dial 4 (ew-lamp-shadows 4), four unheld casting slots resized, then four late askers: no GL error, all four draw
//   LC6 a casting-shaped spot slot (?spotshadows=1) resized while unheld, then a late casting spot: no GL error, it casts
//   bun test/client/late-caster-check.ts   (its own scratch server, library, world and Chromium)
// Where there is no WebGL 2 to force (Windows: headless Chromium there gives a null forced context; any host whose
// browser falls back to nothing) it prints an OPTIONAL line and checks nothing: these rows need a GL context to read.
import { scratchBench, mkCheck } from "../harness/harness.ts";
import { until } from "../gate/wait.ts";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORLD = "late-caster";
const MODEL = "eidoverse/assets/models/late_caster_block.glb";
const LIB = mkdtempSync(join(tmpdir(), "ew-late-caster-lib-"));
{ // one untextured classic PBR box: loadGLB gives it a MeshStandardMaterial (a classic material, as every GLB model)
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document(); const buf = doc.createBuffer();
  const s = 0.5, P: number[] = [], N: number[] = [], I: number[] = [];
  const face = (n: number[], u: number[], v: number[]) => { const b = P.length / 3; for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { P.push(...[0, 1, 2].map((k) => s * (n[k] + a * u[k] + c * v[k]))); N.push(...n); } I.push(b, b + 1, b + 2, b + 2, b + 1, b + 3); };
  face([0, 0, 1], [1, 0, 0], [0, 1, 0]); face([0, 0, -1], [-1, 0, 0], [0, 1, 0]); face([1, 0, 0], [0, 0, -1], [0, 1, 0]); face([-1, 0, 0], [0, 0, 1], [0, 1, 0]); face([0, 1, 0], [1, 0, 0], [0, 0, -1]); face([0, -1, 0], [1, 0, 0], [0, 0, 1]);
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial("block").setBaseColorFactor([0.8, 0.7, 0.6, 1]).setMetallicFactor(0).setRoughnessFactor(0.7))
    .setIndices(doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint16Array(I)))
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array(P)))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array(N)));
  doc.createScene("s").addChild(doc.createNode("block").setMesh(doc.createMesh("block").addPrimitive(prim)));
  mkdirSync(join(LIB, "eidoverse/assets/models"), { recursive: true });
  writeFileSync(join(LIB, MODEL), await new NodeIO().writeBinary(doc));
}
const FORCE_WEBGL = process.platform !== "win32";
const bench = await scratchBench("late-caster", { worlds: [WORLD], serverEnv: { EIDOVERSE_DIR: LIB } });
const { cdp, evalJson, BASE } = bench;
const { check, tally } = mkCheck();
const consoleGl: string[] = [];
bench.cws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  const t = m.method === "Runtime.consoleAPICalled" ? String(m.params?.args?.map((a: any) => a.value ?? a.description).join(" ")) : m.method === "Log.entryAdded" ? String(m.params?.entry?.text ?? "") : "";
  if (/deleted object|INVALID_OPERATION/i.test(t)) consoleGl.push(t.slice(0, 200));   // not the software-fallback notices
});
const js = (body: string) => evalJson(`(async () => { ${body} })()`);
const LATE = "rig.requestLight('lab:late', { authored: true, intensity: 30, range: 6, shadows: true, pos: [0.8, 2.2, 1.2], color: 0xffffff });";
let warmed = false;
/** One page: the shadow settings cleared (and `store` set) before it boots, the bench's scene in, 60 frames drawn. */
async function page(tag: string, store: Record<string, string> = {}, url = "") {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 180, deviceScaleFactor: 1, mobile: false });
  if (warmed) await js(`for (const k of ['ew-shadows', 'ew-shadow-res', 'ew-lamp-shadows']) localStorage.removeItem(k);
    ${Object.entries(store).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(" ")} return 1;`);
  await cdp.send("Page.navigate", { url: `${BASE}/?world=${WORLD}&spectate=1&name=lc&webgl=1&run=${tag}${url}` });
  await until("the new page", () => evalJson(`location.search.includes('run=${tag}') && document.readyState !== 'loading'`).catch(() => false), { ms: 30000 });
  try { await until("the client's render path", () => evalJson("import('/lib/render/render.js').then(() => true, () => false)").catch(() => false), { ms: 60000 }); }
  catch (e) { const why = await evalJson("import('/lib/render/render.js').then(() => 'loaded', (x) => String(x?.stack ?? x).slice(0, 300))").catch((x: any) => String(x)); return { noGl: /getSupportedExtensions|WebGL|getContext|context/i.test(why), why }; }
  await until("the world hydrated", () => js("return (await import('/lib/state.js')).state.hydrated;"), { ms: 30000 });
  if (!warmed && Object.keys(store).length) { warmed = true; return page(tag, store, url); }   // storage is per origin: set it from a first page
  warmed = true;
  consoleGl.length = 0;
  return js(`const g = globalThis, { THREE, renderer, camera, scene, sun } = await import('/lib/core.js'), A = await import('/lib/assets.js'), rig = await import('/lib/render/lightrig.js');
    g.raf = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const P = new THREE.Vector3(0, 1.2, 3), L = new THREE.Vector3(0, 0.5, 0);
    const Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(P, L, new THREE.Vector3(0, 1, 0)));
    const pin = () => { camera.position.copy(P); camera.quaternion.copy(Q); };
    const a = camera.updateMatrixWorld.bind(camera); camera.updateMatrixWorld = (f) => { pin(); a(f); }; camera.updateMatrixWorld(true);
    const M = await A.loadGLB(${JSON.stringify(MODEL)}); M.position.set(0, 0.5, 0); scene.add(M);
    const floor = await A.loadGLB(${JSON.stringify(MODEL)}); floor.scale.set(6, 0.05, 6); floor.position.set(0, -0.03, 0); scene.add(floor);
    let classic = 0; M.traverse((o) => { if (o.isMesh && o.material?.isMeshStandardMaterial && !o.material.isNodeMaterial) classic++; o.castShadow = true; o.receiveShadow = true; });
    floor.traverse((o) => { o.receiveShadow = true; });
    const gl = renderer.backend?.isWebGLBackend ? renderer.backend.gl : null;
    g.errs = () => { let k = 0, codes = []; if (gl) for (let e = gl.getError(); e !== gl.NO_ERROR && k < 50; e = gl.getError()) { k++; codes.push(e); } return { k, codes: [...new Set(codes)] }; };
    const cv = renderer.domElement, W = cv.width, H = cv.height;
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d', { willReadFrequently: true });
    // a frame's luma, read right after one of the page's own frames
    g.luma = async () => { await g.raf(2); await new Promise((res) => requestAnimationFrame(() => { g2.clearRect(0, 0, W, H); g2.drawImage(cv, 0, 0); res(); })); const d = g2.getImageData(0, 0, W, H).data, o = new Uint8Array(d.length / 4); for (let j = 0; j < o.length; j++) o[j] = Math.round((d[4 * j] + d[4 * j + 1] + d[4 * j + 2]) / 3); return o; };
    g.diff = (x, y) => { let n = 0, mx = 0; for (let i = 0; i < x.length; i++) { const e = Math.abs(x[i] - y[i]); if (e > 2) n++; if (e > mx) mx = e; } return { n, mx, of: x.length }; };
    g.rig = rig; g.M = M; g.sun = sun;
    g.cast = () => { const d = rig.rigDebug(); return { holder: d.requests.find((r) => r.slot === d.shadows.castingSlot)?.key ?? null, casting: d.shadows.slotIsCaster }; };
    await g.raf(60); g.errs();
    return { backend: renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu', gl: !!gl, classic };`);
}
try {
  const b = FORCE_WEBGL ? await page("lc0") : null;
  if (!FORCE_WEBGL || !b || (b as any).noGl || !(b as any).gl) {
    console.log(`OPTIONAL late-caster: no WebGL 2 context to force and read here (${FORCE_WEBGL ? JSON.stringify(b).slice(0, 200) : "Windows: a forced WebGL 2 context is null headless"})`);
  } else {
    const s0 = await js(`const g = globalThis; const withM = await g.luma(); g.M.visible = false; const without = await g.luma(); g.M.visible = true; await g.raf(10);
      return { model: g.diff(withM, without), cast: g.cast(), errs: g.errs() };`);
    check("LC0 the bench: WebGL 2, a classic-material model the page's frames draw, the casting slot unheld, no GL error",
      b.backend === "webgl" && b.classic >= 1 && s0.model.n > 200 && s0.cast.holder === null && s0.cast.casting === false && s0.errs.k === 0, JSON.stringify({ b, s0 }));
    const s1 = await js(`const g = globalThis, rig = g.rig; ${LATE}
      await g.raf(60); const errs = g.errs(); await g.raf(30); return { cast: g.cast(), errs, errs2: g.errs() };`);
    check("LC1 a light that asks for shadows arrives late: it takes the casting slot and casts, and no GL error follows",
      s1.cast.holder === "lab:late" && s1.cast.casting === true && s1.errs.k === 0 && s1.errs2.k === 0 && consoleGl.length === 0, JSON.stringify({ ...s1, console: consoleGl.slice(0, 2) }));
    await page("lc2");
    const s2 = await js(`const g = globalThis, rig = g.rig; rig.setShadowRes(1024); await g.raf(20); const resized = g.errs(); ${LATE}
      await g.raf(60); const errs = g.errs(); await g.raf(30); return { resized, cast: g.cast(), errs, errs2: g.errs() };`);
    check("LC2 the casting slot resized while unheld, then a late asker: it casts, and no GL error follows",
      s2.cast.holder === "lab:late" && s2.cast.casting === true && s2.resized.k === 0 && s2.errs.k === 0 && s2.errs2.k === 0 && consoleGl.length === 0, JSON.stringify({ ...s2, console: consoleGl.slice(0, 2) }));
    await page("lc3");
    const s3 = await js(`const g = globalThis, rig = g.rig; ${LATE} await g.raf(30); g.errs();
      rig.setShadows(false); await g.raf(10); rig.setShadowRes(1024); await g.raf(20); const off = g.errs();
      rig.setShadows(true); await g.raf(40); const on = g.errs(); await g.raf(20); return { off, on, on2: g.errs(), cast: g.cast() };`);
    check("LC3 shadows off, the resolution changed, shadows on: it casts again, and no GL error follows",
      s3.cast.casting === true && s3.off.k === 0 && s3.on.k === 0 && s3.on2.k === 0 && consoleGl.length === 0, JSON.stringify({ ...s3, console: consoleGl.slice(0, 2) }));
    // LC4: three pages; the frames are kept in the page's storage between them (same origin)
    const LUMA = `const g = globalThis; g.keep = async (k) => { const d = await g.luma(); let t = ''; for (let i = 0; i < d.length; i++) t += String.fromCharCode(d[i]); localStorage.setItem('lc-' + k, t); return d; };
      g.kept = (k) => { const t = localStorage.getItem('lc-' + k) ?? ''; const d = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) d[i] = t.charCodeAt(i); return d; };`;
    await page("lc4a");
    const a = await js(`${LUMA} const rig = g.rig; ${LATE} await g.raf(60); const base = await g.keep('base');
      rig.updateRequest('lab:late', { shadows: false }); await g.raf(30); const seen = g.diff(base, await g.luma());
      rig.updateRequest('lab:late', { shadows: true }); await g.raf(30);
      rig.setShadowRes(4096); await g.raf(30); const live = await g.keep('live'); return { seen, liveVsBase: g.diff(base, live), errs: g.errs() };`);
    await page("lc4b", { "ew-shadow-res": "4096" });
    const b4 = await js(`${LUMA} const rig = g.rig; ${LATE} await g.raf(60); const boot = await g.luma(); const live = g.kept('live');
      return { bootVsLive: live.length === boot.length ? g.diff(boot, live) : { n: -1 } };`);
    await page("lc4c");
    const c4 = await js(`${LUMA} const rig = g.rig; ${LATE} await g.raf(60); const again = await g.luma(); const base = g.kept('base');
      const r = base.length === again.length ? g.diff(again, base) : { n: -1 }; for (const k of ['base', 'live']) localStorage.removeItem('lc-' + k); return { noise: r };`);
    check("LC4 a lamp's cube map resized live shows what a boot at that size shows (the lamp's shadow is in the frame; two boots at one size agree)",
      a.seen.n > 50 && c4.noise.n >= 0 && c4.noise.n < a.seen.n / 10 && b4.bootVsLive.n >= 0 && b4.bootVsLive.n <= Math.max(5, 2 * c4.noise.n) && a.errs.k === 0,
      JSON.stringify({ seen: a.seen, liveVsBase: a.liveVsBase, bootVsLive: b4.bootVsLive, noise: c4.noise, errs: a.errs }));
    await page("lc5", { "ew-lamp-shadows": "4" });
    const s5 = await js(`const g = globalThis, rig = g.rig; rig.setShadowRes(1024); await g.raf(20); const resized = g.errs();
      for (let i = 0; i < 4; i++) rig.requestLight('lab:late' + i, { authored: true, intensity: 30, range: 6, shadows: true, pos: [0.8 - i * 0.5, 2.2, 1.2], color: 0xffffff });
      await g.raf(60); const errs = g.errs(); await g.raf(30); const s = rig.rigDebug().shadows;
      return { n: s.castingSlots, drawing: (s.slots ?? []).map((x) => x.drawing), resized, errs, errs2: g.errs() };`);
    check("LC5 dial 4: four unheld casting slots resized, then four late askers: all four draw, and no GL error follows",
      s5.n === 4 && s5.drawing.length === 4 && s5.drawing.every(Boolean) && s5.resized.k === 0 && s5.errs.k === 0 && s5.errs2.k === 0 && consoleGl.length === 0, JSON.stringify({ ...s5, console: consoleGl.slice(0, 2) }));
    await page("lc6", {}, "&spotshadows=1");
    const s6 = await js(`const g = globalThis, rig = g.rig; rig.setShadowRes(1024); await g.raf(20); const resized = g.errs();
      rig.requestLight('lab:spot', { authored: true, intensity: 60, range: 8, shadows: true, pos: [0.8, 2.6, 1.2], q: [-0.5, 0, 0, 0.866], spot: { angle: 0.7, inner: 0.4 }, color: 0xffffff });
      await g.raf(60); const errs = g.errs(); await g.raf(30); const s = rig.rigDebug().shadows;
      return { spots: (s.spotSlots ?? []).map((x) => ({ holder: x.holder, drawing: x.drawing })), resized, errs, errs2: g.errs() };`);
    check("LC6 a casting-shaped spot slot resized while unheld, then a late casting spot: it casts, and no GL error follows",
      s6.spots.some((x) => x.holder === 'lab:spot' && x.drawing) && s6.resized.k === 0 && s6.errs.k === 0 && s6.errs2.k === 0 && consoleGl.length === 0, JSON.stringify({ ...s6, console: consoleGl.slice(0, 2) }));
  }
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[late-caster-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
try { rmSync(LIB, { recursive: true, force: true }); } catch { /* */ }
process.exit(tally.failed ? 1 : 0);
