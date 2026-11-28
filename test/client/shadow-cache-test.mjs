// A CASTING SLOT'S CUBE MAP IS REDRAWN ONLY WHEN SOMETHING IT SHOWS HAS CHANGED (client/lib/render/lightrig.js, the
// shadow cache: shadowCacheCheck).
//
// Before: gateShadow set shadow.autoUpdate on every casting slot whose holder asked, and three's ShadowNode redraws
// whenever needsUpdate || autoUpdate, so every casting cube (six depth passes, 90 to 160 draw calls in the greybox
// room) was drawn every frame, the cost that keeps the "shadowed lamps" dial at 1. Godot redraws a positional shadow
// only when it is dirty (renderer_scene_cull.cpp at 8f2e46bca3, :230-232, :1738-1746, :3635-3670). Here the rig
// compares, once a frame at scene.onBeforeRender, what each casting slot would draw against what it drew, hands three
// needsUpdate only on a difference, and caps how many slots redraw in one frame (the budget, oldest-stale first).
//
// A frame here is what the client does: updateRig (arms the check), the renderer's matrix update, the first view
// render's scene.onBeforeRender (the check), then three's shadow node, which draws a map whose needsUpdate is set and
// clears it (`frame()` below plays that part and counts the draws). Rows read rigDebug().shadows.slots[k].cache, the
// readout the lab's probes read. Each boot state runs as a child (`--case <name>`), lamp-cast's house pattern.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { suite } from '../gate/suite.ts';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
const ARGV = process.argv.slice(2);
const argOf = (f) => { const i = ARGV.indexOf(f); return i < 0 ? null : ARGV[i + 1]; };
const CASE = argOf('--case');

// main: four casting slots; default: today's dial (one); nocache: ?shadowcache=0, the lab's A/B switch
const CASES = { main: { dial: '4', url: '' }, default: { dial: null, url: '' }, nocache: { dial: '4', url: '?shadowcache=0' }, convert: { dial: null, url: '' }, born: { dial: '4', url: '' }, bornoff: { dial: '4', url: '', shadows: 'off' }, convertoff: { dial: null, url: '', shadows: 'off' } };

if (CASE) {
  const C = CASES[CASE];
  if (C.url) globalThis.happyDOM?.setURL?.(`http://localhost/${C.url}`);
  plugin({ name: 'core-stub', setup(build) {
    stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
    stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
    stubResolve(build, /^(\.\.?\/)+(render\/)?warmqueue\.js$/, () => ({ path: here('../stubs/lod-client-stub.mjs') }));   // warmDepth resolves at once
  } });
  if (C.shadows) localStorage.setItem('ew-shadows', C.shadows); else localStorage.removeItem('ew-shadows');
  localStorage.removeItem('ew-shadow-res');
  if (C.dial == null) localStorage.removeItem('ew-lamp-shadows'); else localStorage.setItem('ew-lamp-shadows', C.dial);
  const stub = await import('../stubs/core-stub.mjs');
  const { THREE, camera, renderer } = stub;
  // the stub's scene is inert; this one is a real graph, so the rig's rigGroup and the test's things live in it
  const world = new THREE.Scene();
  Object.assign(stub.scene, { add: (...o) => world.add(...o), remove: (...o) => world.remove(...o), children: world.children, visible: true, layers: world.layers });
  const scene = stub.scene;
  const rig = await import('../../client/lib/render/lightrig.js');
  const rows = [];
  const check = (name, ok, note = '') => rows.push([name, Boolean(ok), typeof note === 'string' ? note : JSON.stringify(note)]);
  const out = () => { console.log(`__RESULT__${JSON.stringify(rows)}`); process.exit(0); };

  camera.position.set(0, 1.6, 0); camera.updateMatrixWorld(true);   // looking down -Z
  const slots = rig.rigDebug()._slots;
  // what each casting-shaped slot asked of three at birth, before any frame and any light (the BD rows)
  const bornAsking = { points: slots.filter((pl) => pl.castShadow).map((pl) => pl.shadow.needsUpdate === true), spots: (rig.rigDebug()._spotSlots ?? []).filter((sl) => sl.castShadow).map((sl) => sl.shadow.needsUpdate === true) };
  const drawsSeen = slots.map(() => 0);
  const spotDrawsSeen = new Map();   // spot slot -> maps drawn (the convertoff rows)
  let t = 1000;
  /** One client frame (see the header); `cams` are the frame's view renders (an XR mirror is a second one). */
  const frame = (ms = 16, cams = [camera]) => {
    rig.updateRig(t += ms);
    world.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    for (const cam of cams) {
      scene.onBeforeRender?.(renderer, scene, cam, null);
      // three's PointShadowNode: a map draws when needsUpdate || autoUpdate, with far = light.distance || camera.far,
      // and clears needsUpdate
      slots.forEach((pl, i) => { if (pl.castShadow && (pl.shadow.needsUpdate || pl.shadow.autoUpdate)) { pl.shadow.camera.far = pl.distance || pl.shadow.camera.far; pl.shadow.needsUpdate = false; drawsSeen[i]++; } });
      for (const sl of rig.rigDebug()._spotSlots ?? []) if (sl.castShadow && (sl.shadow.needsUpdate || sl.shadow.autoUpdate)) { sl.shadow.needsUpdate = false; spotDrawsSeen.set(sl, (spotDrawsSeen.get(sl) ?? 0) + 1); }
    }
  };
  const frames = (n, ms) => { for (let i = 0; i < n; i++) frame(ms); };
  const settle = () => { frames(3, 700); frames(4); };   // past a re-rank and a hand-over, then a few frames
  const d = () => rig.rigDebug();
  const slotOf = (k) => (d().requests.find((r) => r.key === k) || {}).slot ?? -1;
  const cache = (k) => d().shadows.slots?.[slotOf(k)]?.cache ?? {};   // {} before the cache exists: its rows read red, not throw
  const ho = (k) => cache(k)?.handoffs ?? NaN;
  /** handoffs per key over `fn` (which runs frames) */
  const over = (keys, fn) => { const a = keys.map(ho); fn(); return keys.map((k, i) => ho(k) - a[i]); };
  const box = (pos, s = 0.5) => { const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshStandardMaterial()); m.position.set(...pos); m.castShadow = true; world.add(m); return m; };

  if (CASE === 'nocache') {
    rig.requestLight('room:a', { authored: true, intensity: 20, range: 5, shadows: true, pos: [0, 2, -4] });
    settle();
    const pl = slots[slotOf('room:a')];
    check('N0 ?shadowcache=0: the slots are drawn once at birth all the same', bornAsking.points.length === 4 && bornAsking.points.every(Boolean) && bornAsking.spots.every(Boolean), bornAsking);
    check('N1 ?shadowcache=0: a casting slot redraws every frame as before (autoUpdate on)', pl.shadow.autoUpdate === true && rig.shadowCacheOn?.() === false, { autoUpdate: pl.shadow.autoUpdate });
    check('N2 ...and it is casting', d().shadows.slots[slotOf('room:a')].drawing === true);
    out();
  }

  if (CASE === 'bornoff') {
    // the viewer's shadows switch off at boot: the maps are drawn at birth all the same, or switching it on later would be
    // the late first draw
    check('BO1 with ew-shadows off at boot every casting-shaped slot still asks for its draw at birth', bornAsking.points.length === 4 && bornAsking.points.every(Boolean) && bornAsking.spots.length === 2 && bornAsking.spots.every(Boolean), bornAsking);
    frame(); frames(10);
    check('BO2 ...drawn once, and nothing casts while the switch is off', drawsSeen.slice(0, 4).every((n) => n === 1) && d().shadows.anyCasting === false, { drawsSeen });
    out();
  }

  if (CASE === 'born') {
    // A CASTING-SHAPED SLOT'S MAP IS DRAWN ONCE AT BIRTH, WHOEVER HOLDS IT. three r186 destroys and recreates a shadow
    // map's depth texture at the map's first render, and the bind groups built before that (every classic-material
    // model's) keep the destroyed one. So a slot whose first asker arrives after the world's models have drawn broke
    // every later frame: black on WebGPU ("Destroyed texture [ShadowDepthTexture] used in a submit", each frame),
    // refused draws and missing models on WebGL2 (render lab 2026-11-27, probes/late-caster.js, late-point-x4.js,
    // destroyed-tex.ts). Drawn at birth, the texture is the render target's own before anything samples it. The mock
    // cannot show the GPU half; these rows pin the ask, and that it is one draw and not a standing one.
    const spots = (rig.rigDebug()._spotSlots ?? []).filter((sl) => sl.castShadow);
    check('BD0 (setup) dial 4: four casting point slots and two casting-shaped spot slots, none holding a light', bornAsking.points.length === 4 && bornAsking.spots.length === 2 && d().shadows.slots.every((s) => s.holder === null), bornAsking);
    check('BD1 every casting point slot asks three for one draw at birth', bornAsking.points.length === 4 && bornAsking.points.every(Boolean), bornAsking.points);
    check('BD2 ...and every casting-shaped spot slot', bornAsking.spots.length === 2 && bornAsking.spots.every(Boolean), bornAsking.spots);
    frame();
    check('BD3 the first frame draws each of them once, with no light asking', drawsSeen.slice(0, 4).every((n) => n === 1) && spots.every((sl) => sl.shadow.needsUpdate === false), { drawsSeen, spots: spots.map((sl) => sl.shadow.needsUpdate) });
    const seen = drawsSeen.slice(); frames(30);
    check('BD4 ...once: thirty idle frames draw nothing more, and no slot is left on autoUpdate', drawsSeen.every((n, i) => n === seen[i]) && slots.slice(0, 4).every((pl) => pl.shadow.autoUpdate === false) && spots.every((sl) => sl.shadow.autoUpdate === false && sl.shadow.needsUpdate === false), { drawsSeen, seen });
    check('BD5 ...and it is not "casting": no shadow is shown for a slot nobody asked', d().shadows.slots.every((s) => s.drawing === false) && d().shadows.anyCasting === false, d().shadows.slots.map((s) => s.drawing));
    rig.requestLight('room:late', { authored: true, intensity: 20, range: 5, shadows: true, pos: [0, 2, -4] });
    settle();
    check('BD6 (control) a light that asks later still gets its own draw', (cache('room:late').handoffs ?? 0) >= 1 && d().shadows.slots[slotOf('room:late')].drawing === true, cache('room:late'));
    out();
  }

  if (CASE === 'convertoff') {
    // the viewer's shadows switch is off when the first spot asks: the slot still converts (pipeline shape follows the
    // world's ask), and its map must be drawn once then, at its birth as a caster, or switching shadows on later would
    // be its late first draw (the born-drawn why is in the born case)
    rig.requestLight('spot:desk', { authored: true, intensity: 30, range: 5, shadows: true, pos: [1, 3, -5], q: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], spot: { angle: 0.6, inner: 0.4 } });
    box([1.2, 0.25, -5.2]);
    settle();
    const sl = (rig.rigDebug()._spotSlots ?? [])[0];
    const srow = () => d().shadows.spotSlots?.find((r) => r.holder === 'spot:desk') ?? null;
    check('VO1 (setup) shadows off at boot: the asking spot converts a slot all the same, and it does not cast', (d().shadows.spotConversions ?? []).length === 1 && sl?.castShadow === true && srow()?.drawing === false, { c: d().shadows.spotConversions, row: srow() });
    check('VO2 ...and the converted slot\'s map is drawn once at its conversion, before shadows come on', spotDrawsSeen.get(sl) === 1, { draws: spotDrawsSeen.get(sl) ?? 0 });
    rig.setShadows(true); settle();
    check('VO3 (control) switching shadows on: the spot casts', srow()?.drawing === true, srow());
    out();
  }

  if (CASE === 'convert') {
    // at the default dial no spot slot is born casting-shaped; the first spot that asks converts one, and the cache and
    // the budget cover it from then on
    const down = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    rig.requestLight('spot:desk', { authored: true, intensity: 30, range: 5, shadows: true, pos: [1, 3, -5], q: down, spot: { angle: 0.6, inner: 0.4 } });
    const chair = box([1.2, 0.25, -5.2]);
    settle();
    const srow = () => d().shadows.spotSlots?.find((r) => r.holder === 'spot:desk') ?? null;
    const sho = () => srow()?.cache?.handoffs ?? NaN;
    check('CV1 (setup) the asking spot converted a slot and casts', (d().shadows.spotConversions ?? []).length === 1 && srow()?.drawing === true, { c: d().shadows.spotConversions, row: srow() });
    const h0 = sho(); frames(30);
    check('CV2 a converted spot is cached: still, no redraw over 30 frames', sho() - h0 === 0, srow());
    chair.position.x += 0.2; const h1 = sho(); frame();
    check('CV3 ...a caster moved in its range: one redraw, reason matrix', sho() - h1 === 1 && srow().cache.reason === 'matrix', srow());
    check('CV4 ...inside the update budget (it counts with the point slots)', d().shadows.cache?.budget === 2 && srow().cache.deferred === 0, srow());
    out();
  }

  if (CASE === 'default') {
    // the body lamp in today's one casting slot, its skinned body round it: no world light asks
    const bones = [new THREE.Bone()]; const skel = new THREE.Skeleton(bones);
    const geo = new THREE.BoxGeometry(0.4, 1.6, 0.3);
    const n = geo.attributes.position.count;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const body = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()); body.add(bones[0]); body.bind(skel);
    body.position.set(0, 0.8, -1.5); body.castShadow = true; world.add(body);
    rig.requestLight('lamp:body:me:0', { keep: true, intensity: 8, range: 12, shadows: true, body: true, pos: [0, 1.3, -1.5] });
    rig.requestLight('complight:room', { authored: true, intensity: 10, range: 6, pos: [2, 2, -3] });   // a world lamp that did not ask
    box([0.5, 0.25, -2]);
    settle();
    const k = 'lamp:body:me:0';
    check('D0 at the default dial the one casting slot asks for its draw at birth too, and no spot slot is casting-shaped', bornAsking.points.length === 1 && bornAsking.points[0] === true && bornAsking.spots.length === 0, bornAsking);
    check('D1 (setup) one casting slot, held by the body lamp', d().shadows.castingSlots === 1 && slotOf(k) === 0, { n: d().shadows.castingSlots, slot: slotOf(k) });
    const [n30] = over([k], () => frames(30));
    check('D2 the body lamp lights a skinned, moving body: it redraws every frame, as today', n30 === 30 && cache(k).reason === 'deforming', { n30, c: cache(k) });
    check('D3 ...and three still sees it as casting (drawing), with autoUpdate held off by the cache', d().shadows.slots[0].drawing === true && slots[0].shadow.autoUpdate === false);
    check('D4 the default budget never delays today\'s one slot', cache(k).deferred === 0 && rig.shadowUpdateBudget?.() >= 1, cache(k));
    out();
  }

  // ---- CASE main: four casting slots ----
  check('M0 (setup) four casting slots, the cache on, budget 2', d().shadows.castingSlots === 4 && d().shadows.cache?.on === true && d().shadows.cache?.budget === 2, d().shadows.cache);
  rig.setShadowUpdateBudget?.(4);   // the rows below are about the dirty rule; the budget has its own section
  rig.requestLight('room:a', { authored: true, intensity: 20, range: 5, shadows: true, pos: [0, 2, -4] });
  rig.requestLight('room:b', { authored: true, intensity: 20, range: 5, shadows: true, pos: [3, 2, -12] });
  const chair = box([0, 0.25, -4]);          // under lamp a, out of b's reach (8.5 m off, range 5)
  const crate = box([-30, 0.25, -6]);        // out of every lamp's range
  frame();
  check('M9 the first frame a slot holds an asker, it draws', (cache('room:a')?.handoffs ?? 0) >= 1 && (cache('room:b')?.handoffs ?? 0) >= 1, { a: cache('room:a'), b: cache('room:b') });
  settle();

  console.log('STILL ROOM');
  { const seen0 = drawsSeen.reduce((x, y) => x + y, 0);
    const [a, b] = over(['room:a', 'room:b'], () => frames(60));
    const seen = drawsSeen.reduce((x, y) => x + y, 0) - seen0;
    check('M1c ...and three draws no lamp map in those frames (needsUpdate never set, autoUpdate off)', seen === 0, { seen });
    check('M1 a still room: neither casting slot redraws over 60 frames', a === 0 && b === 0, { a, b, ca: cache('room:a') });
    check('M1b ...and both still cast (rigDebug drawing), autoUpdate off', d().shadows.slots.filter((s) => s.holder?.startsWith('room:')).every((s) => s.drawing) && slots.filter((pl) => pl.castShadow).every((pl) => !pl.shadow.autoUpdate), d().shadows.slots.map((s) => s.drawing)); }

  console.log('A CHAIR MOVED UNDER LAMP A');
  { chair.position.x += 0.3;
    const [a1, b1] = over(['room:a', 'room:b'], () => frame());
    check('M2 the chair moved: lamp a redraws that frame, lamp b does not', a1 === 1 && b1 === 0, { a1, b1 });
    check('M2b ...the reason is its matrix', cache('room:a').reason === 'matrix', cache('room:a'));
    const [a2] = over(['room:a'], () => frames(30));
    check('M2c ...and then it stops', a2 === 0, { a2 });
    chair.rotation.y = 0.4;
    const [a3] = over(['room:a'], () => frame());
    check('M2d a turn in place is a move', a3 === 1, { a3 }); }

  console.log('A CRATE MOVED OUT OF EVERY LAMP\'S RANGE');
  { crate.position.x += 2;
    const [a, b] = over(['room:a', 'room:b'], () => frames(5));
    check('M3 nothing redraws', a === 0 && b === 0, { a, b });
    crate.position.set(-0.5, 0.25, -14.5);   // into b's range (12 m, 3 m to the side)
    const [a2, b2] = over(['room:a', 'room:b'], () => frames(3));
    check('M3b moved INTO lamp b\'s range: b redraws once, a not', b2 === 1 && a2 === 0 && cache('room:b').reason === 'casters', { a2, b2, c: cache('room:b') });
    crate.position.set(-30, 0.25, -6);
    const [b3] = over(['room:b'], () => frames(3));
    check('M3c ...and out of it again: b redraws once (the shadow it left must go)', b3 === 1, { b3 }); }

  console.log('THE HOLDER');
  { rig.updateRequest('room:a', { pos: [0.2, 2, -4] });
    const [a] = over(['room:a'], () => frames(3));
    check('M4 the holder moves: a redraw, reason light', a === 1 && cache('room:a').reason === 'light', { a, c: cache('room:a') });
    rig.updateRequest('room:a', { range: 4 });
    const [a2] = over(['room:a'], () => frames(3));
    check('M4b its range changes (the far plane): a redraw', a2 === 1 && cache('room:a').reason === 'range', { a2, c: cache('room:a') });
    rig.updateRequest('room:a', { range: 5 }); frames(3);
    const k = slotOf('room:a');
    rig.releaseLight('room:a');
    rig.requestLight('room:a2', { authored: true, intensity: 20, range: 5, shadows: true, pos: [0.2, 2, -4] });   // the same place
    const before = d().shadows.slots[k].cache?.handoffs;
    settle();
    const s = d().shadows.slots.find((r) => r.holder === 'room:a2');
    check('M4c another lamp takes the slot in the same place: it redraws (the holder changed)', s?.cache && s.cache.handoffs > before, { s, before });
    const [a3] = over(['room:a2'], () => frames(20));
    check('M4d ...and settles', a3 === 0, { a3 }); }
  const A = 'room:a2';

  console.log('A CASTER APPEARS, LEAVES, FLIPS, FADES');
  { const stool = box([0.5, 0.25, -3.5]);
    const [a] = over([A], () => frames(3));
    check('M5 a caster appears in range: one redraw', a === 1 && cache(A).reason === 'casters', { a, c: cache(A) });
    stool.castShadow = false;
    const [a2] = over([A], () => frames(3));
    check('M5b it stops casting (castShadow false): one redraw', a2 === 1, { a2 });
    stool.castShadow = true; frames(2);
    stool.visible = false;
    const [a3] = over([A], () => frames(3));
    check('M5c it is hidden: one redraw', a3 === 1, { a3 });
    stool.visible = true; frames(2);
    const g = new THREE.Group(); world.add(g); g.add(stool); frames(2);
    g.visible = false;
    const [a4] = over([A], () => frames(3));
    check('M5d its parent is hidden: one redraw', a4 === 1, { a4 });
    g.visible = true; frames(2);
    world.remove(g);
    const [a5] = over([A], () => frames(3));
    check('M5e it is removed: one redraw', a5 === 1, { a5 });
    // the caster budget's own fade: a registered thing dithers in over FADE_MS through userData.shadowFade
    const thing = new THREE.Group(); thing.position.set(-0.6, 0.25, -4.2);
    const mat = new THREE.MeshStandardMaterial(); mat.userData.shadowFade = true;
    thing.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), mat)); world.add(thing); thing.updateMatrixWorld(true);
    rig.registerCaster('fade-thing', thing);
    const tick = async (ms) => { frame(ms); for (let i = 0; i < 4; i++) await Promise.resolve(); };
    for (let i = 0; i < 10 && !d().casterList.find((c) => c.id === 'fade-thing')?.casting; i++) await tick(310);   // warm, then flip (the fade starts at 0)
    const casting = () => d().casterList.find((c) => c.id === 'fade-thing');
    check('M5f (setup) the budget flips it on and it fades in', casting()?.casting === true, casting());
    let n = 0, fading = 0; const h0 = ho(A);
    for (let i = 0; i < 30; i++) { const f0 = casting().fade; await tick(16); if (casting().fade !== f0) fading++; }
    n = ho(A) - h0;
    check('M5g it redraws through the fade (every frame the dither moves), then stops', fading > 3 && n >= fading - 1 && n <= fading + 1 && casting().fade === 1, { n, fading, fade: casting().fade, reason: cache(A).reason });
    const [a6] = over([A], () => frames(20));
    check('M5h ...and holds once it is in', a6 === 0, { a6 });
    rig.releaseCaster('fade-thing'); world.remove(thing); frames(3); }

  console.log('THINGS THAT MOVE WITHOUT THEIR MATRIX');
  { const geo = new THREE.BoxGeometry(0.4, 1.6, 0.3); const n = geo.attributes.position.count;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const bone = new THREE.Bone(); const sk = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()); sk.add(bone); sk.bind(new THREE.Skeleton([bone]));
    sk.castShadow = true; sk.position.set(1, 0.8, -4); world.add(sk);
    const [a, b] = over([A, 'room:b'], () => frames(20));
    check('M6 a skinned caster in range: its lamp redraws every frame', a === 20 && cache(A).reason === 'deforming', { a, c: cache(A) });
    check('M6b ...the lamp it is not in range of does not', b === 0, { b });
    sk.position.set(40, 0.8, -4); frames(2);
    const [a2] = over([A], () => frames(20));
    check('M6c the skinned caster walks out of range: no redraws', a2 === 0, { a2 });
    world.remove(sk);
    const wind = new THREE.MeshStandardMaterial(); wind.positionNode = { isNode: true };   // a vertex-stage position node (wind)
    const bush = box([-1, 0.3, -4]); bush.material = wind; frames(2);
    const [a3] = over([A], () => frames(10));
    check('M6d a wind (vertex position node) caster in range: every frame', a3 === 10, { a3 });
    bush.position.set(-40, 0.3, -4); frames(2);
    const [a4] = over([A], () => frames(10));
    check('M6e ...out of range: none', a4 === 0, { a4 });
    world.remove(bush); frames(2);
    const mgeo = new THREE.BoxGeometry(0.5, 0.5, 0.5); mgeo.morphAttributes.position = [mgeo.attributes.position.clone()];
    const blob = new THREE.Mesh(mgeo, new THREE.MeshStandardMaterial()); blob.castShadow = true; blob.position.set(1, 0.3, -3.6); blob.updateMorphTargets(); world.add(blob); frames(3);
    blob.morphTargetInfluences[0] = 0.5;
    const [a5] = over([A], () => frames(3));
    check('M6f a morph influence changes: one redraw', a5 === 1 && cache(A).reason === 'morph', { a5, c: cache(A) });
    world.remove(blob); frames(2); }

  console.log('SWAPS');
  { chair.geometry = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    const [a] = over([A], () => frames(3));
    check('M7 a geometry swap on a caster (a load finishing, a reshape): one redraw', a === 1 && cache(A).reason === 'geometry', { a, c: cache(A) });
    chair.geometry.attributes.position.needsUpdate = true;
    const [a2] = over([A], () => frames(3));
    check('M7b its positions edited in place: one redraw', a2 === 1 && cache(A).reason === 'geometry', { a2, c: cache(A) });
    chair.material = new THREE.MeshPhysicalMaterial();   // the transmission upgrade swaps a material
    const [a3] = over([A], () => frames(3));
    check('M7c a material swap: one redraw', a3 === 1 && cache(A).reason === 'material', { a3, c: cache(A) });
    chair.material.alphaTest = 0.5;
    const [a4] = over([A], () => frames(3));
    check('M7d an alpha-test change on its material: one redraw', a4 === 1, { a4 });
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial(), 4);
    inst.castShadow = true; for (let i = 0; i < 4; i++) inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 0.3, 0.1, -4.5)); inst.computeBoundingSphere(); world.add(inst); frames(3);
    inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-0.3, 0.1, -4.5)); inst.instanceMatrix.needsUpdate = true;
    const [a5] = over([A], () => frames(3));
    check('M7e an InstancedMesh\'s copies move: one redraw', a5 === 1 && cache(A).reason === 'instances', { a5, c: cache(A) });
    world.remove(inst); frames(2); }

  console.log('THE VIEWER\'S DIALS');
  { rig.setShadows(false); frames(3);
    rig.setShadows(true);
    const [a] = over([A], () => frames(10));
    check('M8 shadows off and on: one redraw, no stale map', a === 1 && slots[slotOf(A)].shadow.needsUpdate === false, { a, c: cache(A) });
    rig.setShadowRes(4096);
    const [a2] = over([A], () => frames(10));
    check('M8b the resolution dial: one redraw at the new size', a2 === 1 && cache(A).reason === 'map' && slots[slotOf(A)].shadow.mapSize.x === 512, { a2, c: cache(A), map: slots[slotOf(A)].shadow.mapSize.x });
    rig.setShadowRes(2048); frames(3); }

  console.log('SMALL LAMPS, LAYERS, HOLDS');
  { rig.requestLight('room:tiny', { authored: true, intensity: 5, range: 1.5, shadows: true, pos: [-1.5, 1, -6] });
    settle();
    const [n] = over(['room:tiny'], () => frames(30));
    const pl = slots[slotOf('room:tiny')];
    check('M11 a lamp of range 1.5 holds still (its far plane is the far three draws with, not raised to 2)', n === 0 && Math.abs(pl.shadow.camera.far - 1.5) < 1e-6, { n, far: pl.shadow.camera.far, c: cache('room:tiny') });
    rig.releaseLight('room:tiny'); settle();
    camera.layers.enable(3);
    const [a] = over([A], () => frames(3));
    check('M12 the view camera\'s layers change (three\'s shadow camera borrows them): one redraw', a === 1 && cache(A).reason === 'layers', { a, c: cache(A) });
    camera.layers.disable(3); frames(3);
    chair.layers.set(5);
    const [a2] = over([A], () => frames(3));
    check('M12b a caster moved onto a layer the view does not see: one redraw', a2 === 1, { a2 });
    chair.layers.set(0); frames(3);
    rig.holdShadowCache?.(true);
    chair.position.z -= 0.2;
    const [a3] = over([A], () => frames(5));
    check('M13 held (a debug A/B): no redraw is handed out', a3 === 0 && d().shadows.cache?.held === 1, { a3 });
    rig.holdShadowCache?.(false);
    const [a4, b4] = over([A, 'room:b'], () => frames(5));
    check('M13b released: every casting slot redraws once', a4 === 1 && b4 === 1 && cache('room:b').reason === 'release', { a4, b4, c: cache('room:b') }); }

  console.log('ONE DECISION A FRAME (XR: the eyes, then the desktop mirror)');
  { chair.position.z += 0.2;
    const desk = new THREE.PerspectiveCamera(); desk.position.set(0, 3, 3); desk.updateMatrixWorld(true);
    const wind = new THREE.MeshStandardMaterial(); wind.positionNode = { isNode: true };
    const fern = box([0.8, 0.3, -4.4]); fern.material = wind;   // dirty every frame: a second check WOULD redraw it
    const before = drawsSeen[slotOf(A)], h0 = ho(A);
    frame(16, [camera, desk]);
    check('M14 a second view camera in the same frame (the XR desktop mirror) draws no second map', drawsSeen[slotOf(A)] - before === 1 && ho(A) - h0 === 1, { drawn: drawsSeen[slotOf(A)] - before });
    world.remove(fern);
    scene.overrideMaterial = new THREE.MeshBasicMaterial(); rig.updateRig(t += 16); chair.position.z -= 0.2; world.updateMatrixWorld(true);
    scene.onBeforeRender?.(renderer, scene, camera, null);   // a shadow pass renders the scene with an override material
    const decidedInShadowPass = slots[slotOf(A)].shadow.needsUpdate;
    scene.overrideMaterial = null;
    scene.onBeforeRender?.(renderer, scene, camera, null); slots.forEach((pl) => { pl.shadow.needsUpdate = false; });
    check('M14b a shadow pass is never the deciding render', !decidedInShadowPass && cache(A).reason === 'matrix', { decidedInShadowPass, c: cache(A) });
    check('M14c draws three confirmed are counted (the readout)', cache(A).draws > 0 && cache(A).draws <= cache(A).handoffs, cache(A));
    frames(3); }

  console.log('THE CASTER BUDGET\'S REACH RULE READS "CASTING" FROM THE GATE, NOT autoUpdate');
  { rig.requestLight('far:lamp', { authored: true, intensity: 40, range: 6, shadows: true, pos: [150, 1, 0] });   // outside the sun's ±46 m box
    settle();
    const g = new THREE.Group(); g.position.set(150.5, 0.5, 0); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial())); world.add(g); g.updateMatrixWorld(true);
    rig.registerCaster('by-far', g);
    for (let i = 0; i < 6; i++) { frame(310); for (let j = 0; j < 4; j++) await Promise.resolve(); }
    const c = d().casterList.find((x) => x.id === 'by-far');
    check('M15 a thing by a cached casting lamp is in shadow reach and casts', c?.casting === true && slots[slotOf('far:lamp')].shadow.autoUpdate === false, c);
    rig.releaseCaster('by-far'); world.remove(g); rig.releaseLight('far:lamp'); settle(); }

  console.log('OUT OF VIEW');
  { rig.requestLight('room:behind', { authored: true, intensity: 20, range: 3, shadows: true, pos: [0, 1, 8] });   // 8 m behind the eye
    settle();
    const k = 'room:behind', near = box([0.3, 0.25, 8]); frames(2);
    check('M10 (setup) the lamp behind the viewer holds a casting slot', slotOf(k) >= 0 && slotOf(k) < 4, slotOf(k));
    near.position.x += 0.2;
    const o0 = cache(k)?.outOfView ?? 0;
    const [n] = over([k], () => frames(10));
    check('M10b a caster moves by a lamp whose whole range is behind the viewer: no redraw, it waits dirty', n === 0 && cache(k).stale === true && cache(k).outOfView > o0, cache(k));
    camera.rotation.y = Math.PI; camera.updateMatrixWorld(true);
    const [n2] = over([k], () => frame());
    check('M10c the viewer turns round: it redraws that frame', n2 === 1 && cache(k).stale === false, cache(k));
    camera.rotation.y = 0; camera.updateMatrixWorld(true);
    world.remove(near); rig.releaseLight(k); settle(); }

  console.log('A CASTING SPOT IS CACHED TOO');
  { const down = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];   // -Z turned to point straight down
    rig.requestLight('spot:desk', { authored: true, intensity: 30, range: 5, shadows: true, pos: [1, 3, -5], q: down, spot: { angle: 0.6, inner: 0.4 } });
    settle();
    const srow = () => d().shadows.spotSlots?.find((r) => r.holder === 'spot:desk') ?? null;
    const sho = () => srow()?.cache?.handoffs ?? NaN;
    check('SC0 (setup) the spot holds a casting spot slot and draws', srow()?.drawing === true, d().shadows.spotSlots);
    const h0 = sho(); frames(30);
    check('SC1 a still spot: no redraw over 30 frames', sho() - h0 === 0, srow());
    const lamp = box([1.2, 0.25, -5.2]); frames(1); const h1 = sho(); frames(3);
    lamp.position.x += 0.2; const h2 = sho(); frame();
    check('SC2 a caster moved in its range: one redraw, reason matrix', sho() - h2 === 1 && srow().cache.reason === 'matrix', { c: srow()?.cache, settled: h2 - h1 });
    rig.updateRequest('spot:desk', { q: [-0.6, 0, 0, 0.8] }); frames(1); const h3 = sho(); void h3;
    check('SC3 the spot turns (its cone points elsewhere): a redraw, reason cone', srow()?.cache?.reason === 'cone', srow());
    frames(5); const h4 = sho();
    rig.updateRequest('spot:desk', { spot: { angle: 0.4, inner: 0.3 } }); frames(3);
    check('SC4 its angle changes: one redraw, reason cone', sho() - h4 === 1 && srow().cache.reason === 'cone', srow());
    world.remove(lamp); rig.releaseLight('spot:desk'); settle(); }

  console.log('THE BUDGET');
  { // four slots, each kept dirty by a skinned body walking among them
    for (const [i, p] of [[0, [-1.5, 2, -6]], [1, [1.5, 2, -6]], [2, [-1.5, 2, -12]], [3, [1.5, 2, -12]]]) rig.requestLight(`bud:${i}`, { authored: true, keep: true, intensity: 30, range: 4, shadows: true, pos: p });
    rig.releaseLight(A); rig.releaseLight('room:b');
    settle();
    const keys = [0, 1, 2, 3].map((i) => `bud:${i}`);
    check('B0 (setup) the four lamps hold the four casting slots', keys.every((k) => slotOf(k) >= 0 && slotOf(k) < 4), keys.map(slotOf));
    const geo = new THREE.BoxGeometry(0.4, 1.6, 0.3); const n = geo.attributes.position.count;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const bone = new THREE.Bone(); const walker = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()); walker.add(bone); walker.bind(new THREE.Skeleton([bone]));
    walker.castShadow = true; walker.position.set(0, 0.8, -9); world.add(walker);
    rig.setShadowUpdateBudget?.(1);
    frames(4);
    const seq = [];
    for (let f = 0; f < 8; f++) { const h = keys.map(ho); frame(); seq.push(keys.map((k, i) => ho(k) - h[i])); }
    const per = keys.map((_, i) => seq.reduce((s, r) => s + r[i], 0));
    check('B1 four dirty slots, budget 1: one redraw a frame', seq.every((r) => r.reduce((a, b) => a + b, 0) === 1), seq);
    check('B1b ...each redraws once every 4 frames, in turn, none starved', per.every((p) => p === 2) && seq.slice(0, 4).every((r, f) => r.indexOf(1) === seq[f + 4].indexOf(1)), { per, seq });
    check('B1c ...the readout shows it (redraws and deferrals in the last second)', keys.every((k) => cache(k).deferred1s > 0 && cache(k).redraws1s > 0), keys.map((k) => cache(k)));
    rig.setShadowUpdateBudget?.(4);
    const [x0, x1, x2, x3] = over(keys, () => frames(5));
    check('B2 budget = N: every dirty slot redraws every frame (the unbudgeted rule)', [x0, x1, x2, x3].every((v) => v === 5), [x0, x1, x2, x3]);
    world.remove(walker);
    rig.setShadowUpdateBudget?.(1); frames(10);
    // a crate in reach of bud:0 and bud:1 (not 2 and 3) moves one frame and back the next: the one that waited is clean again
    const crate2 = box([0, 0.25, -6]); frames(10);
    crate2.position.x += 0.3;
    const h = keys.map(ho); frame();
    const first = keys.findIndex((k, i) => ho(k) - h[i] === 1);
    const waiting = keys.filter((k, i) => i !== first && cache(k).stale);
    crate2.position.x -= 0.3;
    const h2 = keys.map(ho); frames(4);
    const after = keys.map((k, i) => ho(k) - h2[i]);
    check('B3 (setup) the move dirtied two slots, one drew and one waited', first >= 0 && waiting.length === 1, { first, waiting });
    check('B3b the waiting slot, clean again when the crate went back, does not redraw', after[keys.indexOf(waiting[0])] === 0 && !cache(waiting[0]).stale, { after, w: cache(waiting[0]) });
    check('B3c the one that drew the moved crate redraws once more (it went back)', after[first] === 1, { after });
    check('B4 the budget never goes below 1', (rig.setShadowUpdateBudget?.(0), rig.shadowUpdateBudget?.()) === 1);
    rig.setShadowUpdateBudget?.(4); }
  out();
}

// ---- the parent: every case, as a child process ----
const S = suite('shadow-cache');
for (const name of Object.keys(CASES)) {
  const p = Bun.spawnSync([process.execPath, import.meta.path, '--case', name], { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const text = p.stdout.toString();
  const line = text.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line || p.exitCode !== 0) { S.check(`case ${name} ran`, false, `exit ${p.exitCode}: ${(text + p.stderr.toString()).slice(-1500)}`); continue; }
  for (const [what, ok, note] of JSON.parse(line.slice('__RESULT__'.length))) S.check(`[${name}] ${what}`, ok, note);
}
S.done();
