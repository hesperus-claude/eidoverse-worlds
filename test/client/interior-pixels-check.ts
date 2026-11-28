// interior-pixels — the `interior` zone effect (client/lib/render/interior.js; Godot ReflectionProbe.interior with ambient_mode
// Color) as pixels, in a real headless browser on the client's own renderer, WebGL 2 (the backend every headset runs):
// with no box the picture is the stock path's bit for bit (three's own HemisphereLight and scene.environment); a white
// surface inside a box is darker than the same surface outside under the same sky, and neutral where the sky made it blue;
// the box's colour reaches it; a metal sphere inside reflects a plain room, not the sky; a nested box of higher priority
// wins inside it; the blend fades outside the box; boxes coming and going build no render pipeline; the weight is one
// loop in the shader; and the live page's own world puts a placed box in a slot and takes it out.
//   bun test/client/interior-pixels-check.ts   (its own scratch server, world and Chromium)
// The world is held (render.js setWorldHold) and scenes of our own are drawn into the canvas and read back in the same
// task (drawImage). The environment is our own small equirect texture (blue sky over brown ground), so a bake of the
// page's sky never moves a row.
// Mutations (must go red, by hand; see the PR text for the run): the hemisphere not cut (IP2, IP5); the environment not
// cut (IP2, IP4); no stand-in (IP2's "not black", IP3); blend order reversed in zone.js (IP5); the blend unread (IP6); a
// the environment node set only while a box exists, in the realizer (IP9b).
import { scratchBench, mkCheck } from "../harness/harness.ts";
import { until } from "../gate/wait.ts";

const WORLD = "interior-pixels";
const bench = await scratchBench("interior-pixels", { worlds: [WORLD] });
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
  await cdp.send("Page.navigate", { url: `${BASE}/?world=${WORLD}&spectate=1&name=ip&webgl=1` });
  await until("the client's render path", () => evalJson("import('/lib/render/render.js').then(() => true, () => false)").catch(() => false), { ms: 60000 });
  await until("the world hydrated", () => js("return (await import('/lib/state.js')).state.hydrated;"), { ms: 30000 });
  await js("for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r)); return true;");

  // IP0: born at boot, in the live page: the sky's hemisphere is the interior class, mapped to its node; three's own
  // HemisphereLight still maps to three's node (another scene's hemisphere is never cut); the environment node is set
  const boot = await js(`const core = await import('/lib/core.js'), { THREE, renderer, scene, hemi } = core, I = core.interior;
    const d = globalThis.__interiorDebug?.();
    return { has: !!I, cls: !!I && hemi instanceof I.InteriorHemisphereLight, isHemi: hemi.isHemisphereLight === true,
      node: !!I && renderer.library.getLightNodeClass(hemi.constructor) === I.InteriorHemisphereLightNode,
      stock: renderer.library.getLightNodeClass(THREE.HemisphereLight) === THREE.HemisphereLightNode,
      env: scene.environmentNode != null, debug: d ?? null };`).catch((e: any) => ({ error: String(e).slice(0, 300) }));
  console.log(`  · ${JSON.stringify(boot)}`);
  check("IP0 born at boot: the sky's hemisphere is an InteriorHemisphereLight (still a HemisphereLight) mapped to its own node; three's HemisphereLight keeps three's node; scene.environmentNode is set; an empty world fills no slot",
    boot.has && boot.cls && boot.isHemi && boot.node && boot.stock && boot.env && boot.debug?.count === 0 && boot.debug?.slots === 4, JSON.stringify(boot));

  // IP9: the live page's own world: a placed thing with zone + interior takes a slot (through the fold, zone.js and the
  // realizer), and taking it away frees it
  const live = await js(`const S = await import('/lib/state.js'), g = globalThis, frames = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
    // every pipeline the backend builds, by the object it is for: an object already drawn before the box came that gets another is a recompile
    // three lit things of our own in the page's scene, in view, so lit materials are surely drawn before the box comes
    const { THREE, renderer, scene, camera } = await import('/lib/core.js'), be = renderer.backend, mk0 = be.createRenderPipeline.bind(be), again = [], ours = [];
    let built = 0, drawn = null; be.createRenderPipeline = (ro, p) => { built++; const o = ro.object;
      if (drawn?.has(o)) again.push((o?.name || o?.type) + ':' + (ro.material?.type ?? '?') + (ours.includes(o) ? ' (ours)' : '') + ' @' + (o?.position?.toArray?.().map((v) => v.toFixed(1)).join(',') ?? '')); return mk0(ro, p); };
    for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.3 + 0.3 * i, metalness: i === 2 ? 1 : 0 }));
      m.position.copy(camera.position).add(new THREE.Vector3(i - 1, 0, -3).applyQuaternion(camera.quaternion)); scene.add(m); ours.push(m); }
    // until the page is quiet: 30 frames in a row with no pipeline built (a WebGL program links in parallel and lands late)
    let quiet = 0, waited = 0; for (let last = built; quiet < 30 && waited < 900; waited++) { await frames(1); if (built !== last) { last = built; quiet = 0; } else quiet++; }
    // from here, a pipeline built for any object already in the scene is a recompile
    drawn = new Set(); scene.traverse((o) => drawn.add(o)); const before = drawn.size;
    const base = S.state.st, rec = { pos: [0, 1.5, 0], q: [0, 0, 0, 1], zone: { shape: 'box', size: [6, 3, 6] }, interior: { ambientColorEnergy: 0.5 } };
    S.applyView({ ...base, entities: { ...base.entities, 'ip-room': rec } }); await frames(5); const inn = g.__interiorDebug();
    S.applyView({ ...S.state.st, entities: Object.fromEntries(Object.entries(S.state.st.entities).filter(([k]) => k !== 'ip-room')) }); await frames(5); const out = g.__interiorDebug();
    be.createRenderPipeline = mk0; for (const m of ours) scene.remove(m);
    return { inn, out, before, again, waited, quiet };`).catch((e: any) => ({ error: String(e).slice(0, 300) }));
  console.log(`  · ${JSON.stringify(live)}`);
  check("IP9 the live world: a thing with zone {box} + interior placed in the page's own fold fills a slot (the realizer, zone.js interiorsOf and interiorSlots), and its removal empties it",
    live.inn?.count === 1 && live.inn?.ids?.[0] === "ip-room" && live.out?.count === 0, JSON.stringify(live));
  check("IP9b …and no object the page had already drawn gets a new render pipeline while the box comes and goes (the page's own lit materials do not recompile)",
    live.before >= 4 && Array.isArray(live.again) && live.again.length === 0, JSON.stringify({ before: live.before, again: live.again, waited: live.waited, quiet: live.quiet }));

  const setup = await js(`const core = await import('/lib/core.js'), { THREE, TSL, renderer } = core, I = core.interior, R = await import('/lib/render/render.js'), Z = await import('/shared/zone.js'), g = globalThis;
    R.setWorldHold(true);
    const cv = renderer.domElement, W = cv.width, H = cv.height;
    // the sky: a small equirect, blue above the horizon and brown below (linear, half float), PMREM'd by three as the page's is
    const EW = 64, EH = 32, data = new Uint16Array(EW * EH * 4), h = THREE.DataUtils.toHalfFloat;
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const up = y >= EH / 2, i = (y * EW + x) * 4, c = up ? [0.35, 0.55, 1.2] : [0.25, 0.2, 0.15]; data[i] = h(c[0]); data[i + 1] = h(c[1]); data[i + 2] = h(c[2]); data[i + 3] = h(1); }
    const env = new THREE.DataTexture(data, EW, EH, THREE.RGBAFormat, THREE.HalfFloatType); env.mapping = THREE.EquirectangularReflectionMapping;
    env.colorSpace = THREE.LinearSRGBColorSpace; env.minFilter = env.magFilter = THREE.LinearFilter; env.needsUpdate = true;
    const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100); cam.position.set(0, 0, 6); cam.lookAt(0, 0, 0);
    // one scene per path, the same things in each: two white walls facing the camera and a metal ball between them
    const build = (Hemi, envWay) => { const S = new THREE.Scene(); S.background = new THREE.Color().setRGB(0.02, 0.02, 0.02, THREE.LinearSRGBColorSpace);
      S.add(new Hemi(0x88aaff, 0x443322, 1.2)); envWay(S);
      const wall = (x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })); m.position.set(x, 0, 0); S.add(m); return m; };
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 24), new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.25, metalness: 1 }));
      S.add(ball); return { S, left: wall(-1.7), right: wall(1.7), ball }; };
    const stock = build(THREE.HemisphereLight, (S) => { S.environment = env; });
    const ours = build(I.InteriorHemisphereLight, (S) => { S.environmentNode = I.environmentNode(env); });
    // the control for IP7: a light joining the scene changes every lit material's light key, so the counter must see pipelines
    const extra = new THREE.PointLight(0xffffff, 0); g.__addLight = (on) => { if (on) ours.S.add(extra); else ours.S.remove(extra); };
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d', { willReadFrequently: true });
    const grab = () => { g2.clearRect(0, 0, W, H); g2.drawImage(cv, 0, 0); return g2.getImageData(0, 0, W, H).data; };
    // the render-scale governor may shrink the canvas under load between our frames: every frame of ours puts it back first
    g.__resized = 0; const hold = () => { if (cv.width !== W || cv.height !== H) { g.__resized++; renderer.setPixelRatio(1); renderer.setSize(W, H, false); } };
    const frame = (k) => () => { hold(); renderer.setRenderTarget(null); renderer.render(k.S, cam); return grab(); };
    const settle = async (f) => { let prev = null; for (let i = 0; i < 90; i++) { await new Promise((r) => requestAnimationFrame(r)); const px = f(); if (prev && px.every((v, j) => v === prev[j])) return px; prev = px; } return null; };
    const diff = (a, b) => { let max = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); if (d > max) max = d; if (d > 1) n++; } return { max, over1: n }; };
    const proj = (p) => { const v = new THREE.Vector3(...p).project(cam); return [Math.round((v.x + 1) / 2 * W), Math.round((1 - v.y) / 2 * H)]; };
    // the mean [r, g, b] (0..255) of a square of side 2r around a world point
    const at = (px, p, r = 4) => { const [cx, cy] = proj(p); const s = [0, 0, 0]; let n = 0; for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) { const i = (y * W + x) * 4; s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2]; n++; } return s.map((v) => v / n); };
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // boxes through the real chain: a fold of things, zone.js reads and ranks them, the slots take them
    const slots = (ents) => { const L = Z.interiorsOf({ entities: ents }); I.setSlots(Z.interiorSlots(L, cam.position.toArray(), 4)); return I.debug(); };
    const room = (pos, size, interior = {}, zone = {}) => ({ c: { transform: { pos, q: [0, 0, 0, 1], scale: [1, 1, 1] }, zone: { shape: 'box', size, ...zone }, interior } });
    // what the backend builds: every render pipeline asked for, from here on
    const be = renderer.backend, mk = be.createRenderPipeline.bind(be); g.__pipes = 0; be.createRenderPipeline = (ro, p) => { g.__pipes++; return mk(ro, p); };
    await renderer.compileAsync(stock.S, cam); await renderer.compileAsync(ours.S, cam);
    g.__ip = { THREE, I, renderer, stock, ours, cam, frame, settle, diff, at, lum, slots, room };
    return { backend: be.isWebGLBackend ? 'webgl' : 'webgpu', W, H };`);
  console.log(`  · ${JSON.stringify(setup)}`);
  check("IP-setup the page runs WebGL 2, as asked", setup.backend === "webgl", JSON.stringify(setup));

  // IP1: no box: the interior path's picture is the stock path's
  const none = await js(`const p = globalThis.__ip; p.slots({});
    const a = await p.settle(p.frame(p.stock)), b = await p.settle(p.frame(p.ours));
    return { settled: !!a && !!b, diff: a && b ? p.diff(a, b) : null, left: a ? p.at(a, [-1.7, 0, 0]) : null, ball: a ? p.at(a, [0, 0, 0.5], 3) : null };`);
  console.log(`  · ${JSON.stringify(none)}`);
  check("IP1 no box: the interior path draws the stock path's picture (three's HemisphereLight and scene.environment): no channel of any pixel differs by more than 1, and the walls are lit (a real picture)",
    none.settled && none.diff && none.diff.over1 === 0 && none.left && p0(none.left) > 60, JSON.stringify(none));

  // IP2: a box round the left wall (absent fields: white at 0.25): darker inside, neutral, not black; the right wall unchanged
  const boxed = await js(`const p = globalThis.__ip; const d = p.slots({ room: p.room([-1.7, 0, 0], [2, 2, 1]) });
    const b = await p.settle(p.frame(p.ours)); p.slots({}); const a = await p.settle(p.frame(p.ours));
    return { d, settled: !!a && !!b, before: p.at(a, [-1.7, 0, 0]), inside: p.at(b, [-1.7, 0, 0]), rightBefore: p.at(a, [1.7, 0, 0]), rightAfter: p.at(b, [1.7, 0, 0]), back: a && p.diff(a, await p.settle(p.frame(p.stock))) };`);
  console.log(`  · ${JSON.stringify(boxed)}`);
  const lumOf = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  check("IP2 a box round the left wall: the same white wall under the same sky is darker inside (under 60% of its outdoor luminance), the wall outside the box is unchanged (within 1)",
    boxed.settled && boxed.d?.count === 1 && lumOf(boxed.inside) < 0.6 * lumOf(boxed.before) && Math.max(...boxed.rightAfter.map((v: number, i: number) => Math.abs(v - boxed.rightBefore[i]))) <= 1, JSON.stringify(boxed));
  check("IP2 …and inside it reads as a dim neutral room: not black (luminance over 15 of 255) and grey where the sky made it blue (outdoors blue − red over 8; inside under 4)",
    boxed.settled && lumOf(boxed.inside) > 15 && boxed.before[2] - boxed.before[0] > 8 && Math.abs(boxed.inside[2] - boxed.inside[0]) < 4, JSON.stringify(boxed));
  check("IP2 …and taking the box away is the stock picture again (no channel off by more than 1)", boxed.back && boxed.back.over1 === 0, JSON.stringify(boxed.back));

  // IP3: the box's colour reaches the wall: red at energy 2
  const red = await js(`const p = globalThis.__ip; p.slots({ room: p.room([-1.7, 0, 0], [2, 2, 1], { ambientColor: [1, 0, 0], ambientColorEnergy: 2 }) });
    const b = await p.settle(p.frame(p.ours)); p.slots({}); return { c: p.at(b, [-1.7, 0, 0]) };`);
  console.log(`  · ${JSON.stringify(red)}`);
  check("IP3 ambientColor [1, 0, 0] at energy 2 reaches the wall: it is red (red over 3× green and over 3× blue)", red.c[0] > 3 * red.c[1] && red.c[0] > 3 * red.c[2], JSON.stringify(red));

  // IP4: specular: a metal ball reflects the blue sky outside; in a white box at energy 1 it reflects a plain room
  const metal = await js(`const p = globalThis.__ip; p.slots({}); const a = await p.settle(p.frame(p.ours));
    p.slots({ den: p.room([0, 0, 0], [1.6, 1.6, 1.6], { ambientColorEnergy: 1 }) }); const b = await p.settle(p.frame(p.ours)); p.slots({});
    return { out: p.at(a, [0, 0.25, 0.5], 2), inn: p.at(b, [0, 0.25, 0.5], 2) };`);
  console.log(`  · ${JSON.stringify(metal)}`);
  check("IP4 the environment's specular is cut too: a metal ball reflects blue sky outdoors (blue over 1.15× red) and, in a white box, a plain room (blue within 10% of red, and not black)",
    metal.out[2] > 1.15 * metal.out[0] && metal.inn[2] < 1.1 * metal.inn[0] && metal.inn[0] > 15, JSON.stringify(metal));

  // IP5: nesting: a cupboard (priority 1, energy 0) over the top of the wall inside a room (priority 0, energy 1)
  const nest = await js(`const p = globalThis.__ip;
    const d = p.slots({ room: p.room([-1.7, 0, 0], [2, 2, 1], { ambientColorEnergy: 1 }), cupboard: p.room([-1.7, 0.5, 0], [2, 1, 1], { ambientColorEnergy: 0 }, { priority: 1 }) });
    const b = await p.settle(p.frame(p.ours)); p.slots({}); return { d, top: p.at(b, [-1.7, 0.4, 0]), low: p.at(b, [-1.7, -0.4, 0]) };`);
  console.log(`  · ${JSON.stringify(nest)}`);
  check("IP5 nested boxes: inside the higher-priority cupboard (energy 0) the wall is black (luminance under 3), below it the room's light holds (over 30)",
    lumOf(nest.top) < 3 && lumOf(nest.low) > 30, JSON.stringify(nest));

  // IP6: the blend fades outside the box: a box over the wall's left half, blend 1 m
  const fade = await js(`const p = globalThis.__ip; p.slots({}); const a = await p.settle(p.frame(p.ours));
    p.slots({ half: p.room([-2.1, 0, 0], [0.8, 2, 1], { ambientColorEnergy: 0 }, { blend: 1 }) }); const b = await p.settle(p.frame(p.ours)); p.slots({});
    const L = (x) => p.lum(p.at(b, [x, 0, 0], 2));
    return { inside: L(-2.2), near: L(-1.5), far: L(-0.95), open: p.lum(p.at(a, [-0.95, 0, 0], 2)) };`);
  console.log(`  · ${JSON.stringify(fade)}`);
  check("IP6 zone.blend fades the cut outside the box: inside black, 0.2 m out darker than 0.75 m out, which is darker than with no box at all",
    fade.inside < 3 && fade.near < fade.far - 4 && fade.far < fade.open - 4, JSON.stringify(fade));

  // IP7: boxes coming and going build no render pipeline (values only); a new environment node object does (the counter sees one)
  const pipes = await js(`const p = globalThis.__ip, g = globalThis; p.slots({}); await p.settle(p.frame(p.ours)); const n0 = g.__pipes;
    for (const ents of [{ a: p.room([-1.7, 0, 0], [2, 2, 1]) }, { a: p.room([-1.7, 0, 0], [2, 2, 1]), b: p.room([1.7, 0, 0], [2, 2, 1]), c: p.room([0, 0, 0], [1, 1, 1]), d: p.room([0, 5, 0], [1, 1, 1]), e: p.room([0, -5, 0], [1, 1, 1]) }, {}])
      { p.slots(ents); await p.settle(p.frame(p.ours)); }
    const n1 = g.__pipes; g.__addLight(true); await p.settle(p.frame(p.ours)); const n2 = g.__pipes; g.__addLight(false); await p.settle(p.frame(p.ours));
    return { boxes: n1 - n0, control: n2 - n1, resized: g.__resized };`);
  console.log(`  · ${JSON.stringify(pipes)}`);
  check("IP7 one box, five (one more than the slots), none: no render pipeline is built (the slots are values born at boot); the control, a point light joining the scene, does build them (the counter sees a recompile)",
    pipes.boxes === 0 && pipes.control > 0, JSON.stringify(pipes));

  // IP8: the weight is one loop in the wall's fragment shader, read by the hemisphere and the environment both
  const shader = await js(`const p = globalThis.__ip; const s = await p.renderer.debug.getShaderAsync(p.ours.S, p.cam, p.ours.left); const f = s?.fragmentShader ?? '';
    const loops = (f.match(/for \\( int interiorBox/g) ?? []).length, uses = (f.match(/interiorTerm/g) ?? []).length;
    return { len: f.length, loops, uses, sample: f.slice(Math.max(0, f.indexOf('interiorBox') - 200), f.indexOf('interiorBox') + 200) };`);
  console.log(`  · ${JSON.stringify({ ...shader, sample: undefined })}`);
  check("IP8 the weight is computed once a fragment: one interior loop in the wall's fragment shader, its result read more than once (the hemisphere and the environment's diffuse and specular)",
    shader.loops === 1 && shader.uses >= 3, JSON.stringify(shader).slice(0, 600));

  const real = errors.filter((e) => !/popErrorScope|sky finish/.test(e));
  check("IP10 no page errors", real.length === 0, JSON.stringify(real.slice(0, 4)));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
function p0(c: number[]) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
console.log(`[interior-pixels-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
